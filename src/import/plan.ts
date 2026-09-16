// src/import/plan.ts
//
// The pure half of `import-claude`: everything that decides WHAT would be
// written, with no filesystem underneath. Kept apart from the execution half so
// the interesting rules — identity, fingerprint, dedupe — are unit-testable
// without a store, and so a dry-run and an apply provably take the same
// decisions (they call these same functions).
//
// Fields of a native Claude memory file that are deliberately NOT copied into
// the canonical schema (the schema is strict; arbitrary metadata cannot travel):
//
//   name        → replaced by the deterministic import slug (see `importSlug`)
//   scope       → comes from the explicit --scope, never from the source
//   modified    → not part of the canonical schema (hot state is derived)
//   metadata.*  → dropped except `metadata.type`, used as a type fallback
//   links       → non-empty ones FAIL the file (they point at old identities)
//   sources     → same
//   anything else (unknown keys) → dropped
import { createHash } from "node:crypto";
import { parseFrontmatter } from "../frontmatter.js";
import { extractType, slugify, typeFromFilename } from "../migrate.js";
import { FACT_TYPES, NOTE_TYPES, Slug } from "../schema.js";
import type { EngramType } from "../write/add.js";

/** Documented in the report so the operator knows what was left behind. */
export const OMITTED_SOURCE_FIELDS = [
  "name (replaced by the deterministic slug)",
  "scope (comes from --scope)",
  "modified",
  "metadata.* (except metadata.type)",
  "links/sources (a non-empty one fails the file instead)",
] as const;

const ENGRAM_TYPES: readonly string[] = [...NOTE_TYPES, ...FACT_TYPES];

/** Importance the canonical store gives an engram whose source says nothing usable. */
const DEFAULT_IMPORTANCE = 5;

const MAX_DERIVED_DESCRIPTION = 120;

/** Why a source file cannot be imported. Category only — never source content. */
export type FailureReason =
  | "unknown-type"
  | "missing-description"
  | "relations-need-review"
  | "invalid-slug"
  | "parse-error";

export interface SourceCandidate {
  filename: string;
  /** Deterministic destination identity. */
  slug: string;
  /**
   * The slug this file would have WITHOUT the source prefix and hash — i.e.
   * the identity an earlier migration would have given it.
   *
   * The destination slug can never collide with an already-migrated copy,
   * because the prefix and digest make it unique by construction. Without this
   * second identity, "same note, different version" is invisible and lands as
   * `create`: on the real store that meant 13 duplicates reported as
   * `conflict 0`, each older than the note it duplicated.
   */
  baseSlug: string;
  type: EngramType;
  description: string;
  /** Normalized body, preserved verbatim otherwise (links are NOT rewritten). */
  body: string;
  importance: number;
  created: string;
  fingerprint: string;
  warnings: string[];
}

export type NormalizeResult =
  | { ok: true; candidate: SourceCandidate }
  | { ok: false; reason: FailureReason; warnings: string[] };

/** Local ISO datetime without timezone, matching the `CreatedAt` schema. */
export function toLocalIso(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  );
}

/**
 * The imported identity of a source file.
 *
 * Namespaced by an operator-chosen `source-id` (a logical origin that outlives
 * its absolute path) and suffixed with a hash of the filename, so two sources
 * with the same filename never collide and re-running with the same source-id
 * always lands on the same slug — which is what makes the import idempotent
 * without a manifest.
 */
export function importSlug(sourceId: string, filename: string): string {
  const digest = createHash("sha256").update(filename, "utf8").digest("hex").slice(0, 12);
  return `claude-${sourceId}-${baseSlugOf(filename)}-${digest}`;
}

/**
 * The bare slug of a source file, as an earlier migration would have named it.
 * Used to detect a note that is already in the store under its own identity.
 */
export function baseSlugOf(filename: string): string {
  return slugify(filename.replace(/\.md$/i, ""));
}

export function isKebabSlug(value: string): boolean {
  return Slug.safeParse(value).success;
}

/** CRLF → LF and exactly one trailing newline. Inner whitespace is content. */
export function normalizeBody(body: string): string {
  return `${body.replace(/\r\n/g, "\n").replace(/\n+$/, "")}\n`;
}

export interface FingerprintInput {
  type: string;
  description: string;
  body: string;
}

/**
 * Semantic identity of a memory: `(type, description, body)`.
 *
 * Deliberately excludes slug, dates and importance — the same content imported
 * under the old migration's slug, or re-imported after a clock change, must
 * still be recognized as already present. This is the whole dedupe mechanism:
 * there is no manifest to fall out of sync with the Markdown.
 */
export function fingerprintOf(input: FingerprintInput): string {
  const serialized = [input.type, input.description.trim(), normalizeBody(input.body)].join("\n");
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
 * A source `created` if it is usable, else the caller's fallback (birthtime or
 * mtime). A stamp without timezone is already local wall-clock time and is kept
 * verbatim; a zoned one is converted, because the schema is local-only.
 */
export function normalizeCreated(value: unknown, fallback: string): string {
  const raw = value instanceof Date ? value.toISOString() : typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback;
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(raw);
  if (local && !/(Z|[+-]\d{2}:?\d{2})$/.test(raw)) return `${local[1]}T${local[2]}`;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? fallback : toLocalIso(new Date(ms));
}

function importanceOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10
    ? value
    : DEFAULT_IMPORTANCE;
}

/** A frontmatter list that actually points at something. */
function hasRelations(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return Array.isArray(value) ? value.length > 0 : true;
}

const WIKILINK_RE = /\[\[[^\]\r\n]+\]\]/;
const NATIVE_PATH_RE = /(~\/\.claude\/projects|\bMEMORY\.md\b|[\w./~-]+\.md\b)/;

/**
 * Bodies travel verbatim — the new namespace changes every target, so rewriting
 * links would invent destinations. Say so instead, per file, and let a human
 * repair the ones that matter. The warning names the problem, never the text.
 */
function linkWarnings(body: string): string[] {
  const out: string[] = [];
  if (WIKILINK_RE.test(body)) out.push("body has [[wikilinks]] whose targets were not rewritten; may need manual repair");
  if (NATIVE_PATH_RE.test(body)) out.push("body references native memory files (.md paths); may need manual repair");
  return out;
}

function firstBodyLine(body: string): string {
  return (body.split("\n").find((l) => l.trim().length > 0) ?? "").trim().slice(0, MAX_DERIVED_DESCRIPTION);
}

export interface NormalizeInput {
  raw: string;
  filename: string;
  sourceId: string;
  /** Used when the source carries no usable `created` (birthtime, else mtime). */
  fallbackCreated: string;
}

/** One native memory file → the engram it would become, or why it cannot. */
export function normalizeSourceFile(input: NormalizeInput): NormalizeResult {
  let data: Record<string, unknown>;
  let rawBody: string;
  try {
    ({ data, body: rawBody } = parseFrontmatter(input.raw));
  } catch {
    // The YAML error text can quote the source; only the category travels.
    return { ok: false, reason: "parse-error", warnings: [] };
  }

  const type = extractType(data) ?? typeFromFilename(input.filename);
  if (typeof type !== "string" || !ENGRAM_TYPES.includes(type)) {
    return { ok: false, reason: "unknown-type", warnings: [] };
  }
  if (hasRelations(data.links) || hasRelations(data.sources)) {
    return { ok: false, reason: "relations-need-review", warnings: [] };
  }

  const body = normalizeBody(rawBody);
  const warnings = linkWarnings(body);

  const given = typeof data.description === "string" ? data.description.trim() : "";
  const description = given || firstBodyLine(body);
  if (!description) return { ok: false, reason: "missing-description", warnings };
  if (!given) warnings.push("no description in the source; derived from the first body line");

  const slug = importSlug(input.sourceId, input.filename);
  if (!isKebabSlug(slug)) return { ok: false, reason: "invalid-slug", warnings };

  return {
    ok: true,
    candidate: {
      filename: input.filename,
      slug,
      baseSlug: baseSlugOf(input.filename),
      type: type as EngramType,
      description,
      body,
      importance: importanceOf(data.importance),
      created: normalizeCreated(data.created, input.fallbackCreated),
      fingerprint: fingerprintOf({ type, description, body }),
      warnings,
    },
  };
}

/**
 * What already lives in the destination scope, read from the Markdown itself —
 * never from the index, which is derived state that can be stale or absent.
 */
export interface Inventory {
  /** fingerprint → every document that already has this exact content. */
  byFingerprint: Map<string, string[]>;
  /** slug → the document that already claims that identity. */
  bySlug: Map<string, string>;
  /** path → body length, so a conflict can say which side holds more. */
  bodyLengthByPath: Map<string, number>;
}

export function emptyInventory(): Inventory {
  return { byFingerprint: new Map(), bySlug: new Map(), bodyLengthByPath: new Map() };
}

export function rememberInInventory(
  inv: Inventory,
  entry: { slug: string; fingerprint: string; path: string; bodyLength?: number },
): void {
  const existing = inv.byFingerprint.get(entry.fingerprint);
  if (existing) existing.push(entry.path);
  else inv.byFingerprint.set(entry.fingerprint, [entry.path]);
  if (!inv.bySlug.has(entry.slug)) inv.bySlug.set(entry.slug, entry.path);
  if (entry.bodyLength !== undefined) inv.bodyLengthByPath.set(entry.path, entry.bodyLength);
}

/** An existing document's identity, or null when it is not a readable engram. */
export function inventoryEntryOf(raw: string): { slug: string; fingerprint: string; bodyLength: number } | null {
  let data: Record<string, unknown>;
  let body: string;
  try {
    ({ data, body } = parseFrontmatter(raw));
  } catch {
    return null;
  }
  const { name, description, type } = data;
  if (typeof name !== "string" || typeof description !== "string" || typeof type !== "string") return null;
  return { slug: name, fingerprint: fingerprintOf({ type, description, body }), bodyLength: body.length };
}

export type Decision =
  | { kind: "create" }
  /** Same content already present, under any slug. */
  | { kind: "skip"; paths: string[] }
  /** Same identity, different content: never overwritten, never auto-versioned. */
  | { kind: "conflict"; paths: string[] };

export function decide(candidate: SourceCandidate, inv: Inventory): Decision {
  // Identical content first: it is the cheaper and stronger signal, and a
  // re-import of an untouched file must stay a skip rather than become a
  // conflict just because the store already holds it under its bare slug.
  const identical = inv.byFingerprint.get(candidate.fingerprint);
  if (identical && identical.length > 0) return { kind: "skip", paths: [...identical] };
  // Two identities can already be taken: the destination slug (a previous run
  // of this importer) and the bare slug (an earlier migration of the same
  // file). Missing the second one is what silently duplicates a note.
  const claimed = inv.bySlug.get(candidate.slug) ?? inv.bySlug.get(candidate.baseSlug);
  if (claimed) return { kind: "conflict", paths: [claimed] };
  return { kind: "create" };
}
