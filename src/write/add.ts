// src/write/add.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EngramSchema, FACT_TYPES } from "../schema.js";
import { serializeFrontmatter } from "../frontmatter.js";
import { storePaths, newFactId, factFilename } from "../store.js";
import { createHash } from "node:crypto";
import { emitEvent } from "../telemetry/events.js";
import { systemClock, type Clock } from "../clock.js";
import { assertNoSecrets, assertOwnsScope, resolveWriteScope } from "./validation.js";
import type { SecretFinding } from "../secrets/scanner.js";
import { findSlugClaims } from "./claims.js";
import { withScopeLock } from "./lock.js";

// The gates moved to validation.ts (every write path shares them), but their
// errors are the public contract of `add` — re-exported so callers and tests
// keep importing them from here.
export {
  ScopeUnresolvedError,
  NotOwnerError,
  SecretDetectedError,
} from "./validation.js";

export type EngramType = "feedback" | "reference" | "project" | "user";
export interface AddDeps {
  root: string;
  cwd: string;
  home: string;
  /** Stamped into the engram's `created` frontmatter. */
  now: string;
  /** Stamps telemetry only; defaults to the system clock. */
  clock?: Clock;
}
export interface AddOptions {
  content: string;
  type: EngramType;
  scope?: string;
  description?: string;
  importance?: number;
  slug?: string;
}
export interface AddResult { path: string; scope: string; slug: string; kind: "fact" | "note" }

export class NoteExistsError extends Error {
  constructor(readonly path: string) {
    super(`note already exists: ${path}`);
    this.name = "NoteExistsError";
  }
}
/**
 * A ULID collision, or a clock jumped far enough back to replay one. Vanishingly
 * rare, but facts are append-only: overwriting one would lose an observation, so
 * `O_EXCL` guards them too and the caller hears about it.
 */
export class FactExistsError extends Error {
  constructor(readonly path: string) {
    super(`fact already exists: ${path}`);
    this.name = "FactExistsError";
  }
}
/**
 * Another document in the scope already claims this slug.
 *
 * `O_EXCL` alone cannot catch this: a fact's filename is a fresh ULID, so a
 * second fact reusing a claimed slug lands happily on disk — and then loses the
 * index's UNIQUE(scope, slug), which leaves it retrievable by nothing (`reindex`
 * reports it as one more `errors`). A memory nobody can read is worse than a
 * refused write, so the write is refused.
 */
export class SlugTakenError extends Error {
  constructor(readonly slug: string, readonly scope: string, readonly path: string) {
    super(`slug '${slug}' is already claimed in scope '${scope}' by ${path}`);
    this.name = "SlugTakenError";
  }
}

const DEFAULT_IMPORTANCE = 5;

/** Coerce text into a kebab-case slug (mirrors the migration's slugify). */
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function deriveDescription(content: string): string {
  const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
  return firstLine.trim().slice(0, 120);
}

/**
 * Creates one engram. Gates first (scope → owner), then the scope directory,
 * then the write under the scope lock.
 */
export function addMemory(deps: AddDeps, opts: AddOptions): AddResult {
  const scope = resolveWriteScope(deps, opts.scope);
  assertOwnsScope(deps.root, scope);
  // Schema + secret gate BEFORE touching the filesystem: a rejected write must
  // not leave even an empty scope directory behind.
  const doc = buildDocument(deps, opts, scope);

  // The lock file lives in the scope directory, so it has to exist to be locked.
  const scopeDir = storePaths(deps.root).scopeDir(scope);
  mkdirSync(scopeDir, { recursive: true });

  return withScopeLock(scopeDir, () => writeDocument(deps, opts, scope, doc));
}

function isFact(type: EngramType): boolean {
  return (FACT_TYPES as readonly string[]).includes(type);
}

/** The validated, serialized document plus what the write and the telemetry need. */
export interface BuiltDocument {
  slug: string;
  importance: number;
  fileContent: string;
  findings: SecretFinding[];
}

/**
 * Frontmatter → schema → serialize → secret gate on the WHOLE document.
 *
 * Exported and free of I/O so a dry run (the importer's) can apply exactly the
 * same schema and secret gates a real write would, instead of a lookalike that
 * could disagree with `apply`.
 */
export function buildDocument(deps: AddDeps, opts: AddOptions, scope: string): BuiltDocument {
  const description = (opts.description ?? deriveDescription(opts.content)).trim();
  const slug = opts.slug ?? slugify(description);
  const frontmatter = {
    name: slug,
    description,
    scope,
    type: opts.type,
    created: deps.now,
    importance: opts.importance ?? DEFAULT_IMPORTANCE,
  };
  const engram = EngramSchema.parse(frontmatter); // validates kebab slug, importance range, type
  const body = opts.content.endsWith("\n") ? opts.content : `${opts.content}\n`;
  const fileContent = serializeFrontmatter(engram, body);
  // Gate 3: secrets — on the full document, so `description` cannot smuggle one past.
  const findings = assertNoSecrets(fileContent);
  return { slug, importance: engram.importance, fileContent, findings };
}

function writeDocument(deps: AddDeps, opts: AddOptions, scope: string, doc: BuiltDocument): AddResult {
  const { root, now, clock = systemClock } = deps;
  const paths = storePaths(root);
  const notePath = join(paths.scopeDir(scope), `${doc.slug}.md`);

  // Uniqueness of (scope, slug), decided from the Markdown — the index is
  // derived and disposable, so it is never the authority here. A NOTE colliding
  // with ITSELF is left to `O_EXCL` below, whose error tells the caller how to
  // update the existing note instead; a fact is written under a fresh ULID and
  // never owns `<slug>.md`, so it has no own target to exclude — a note sitting
  // there is somebody else's claim and must stop the write.
  const claim = findSlugClaims(root, scope, doc.slug)
    .find((c) => isFact(opts.type) || c.path !== notePath);
  if (claim) throw new SlugTakenError(doc.slug, scope, claim.path);

  /**
   * Records that an engram was written, never WHAT was written: only a content
   * hash, so the log can correlate and dedupe without becoming a second copy of
   * the store. `origin` is always "agent" here — hand edits bypass addMemory
   * entirely and surface later as `engram.indexed` with reason mtime/hash.
   */
  const emitCreated = (): void => emitEvent(root, clock, {
    kind: "engram.created",
    scope,
    type: opts.type,
    importance: doc.importance,
    origin: "agent",
    contentHash: createHash("sha256").update(doc.fileContent).digest("hex").slice(0, 16),
    scannerVerdict: doc.findings.length > 0 ? "warn" : "clean",
  });

  if (isFact(opts.type)) {
    // Created here, not before the lock: a rejected write leaves no new directory either.
    const dir = paths.factsDir(scope);
    mkdirSync(dir, { recursive: true });
    const seedMs = Date.parse(now);
    const path = join(dir, factFilename(newFactId(Number.isNaN(seedMs) ? undefined : seedMs)));
    writeExclusive(path, doc.fileContent, (p) => new FactExistsError(p));
    emitCreated();
    return { path, scope, slug: doc.slug, kind: "fact" };
  }

  writeExclusive(notePath, doc.fileContent, (p) => new NoteExistsError(p));
  emitCreated();
  return { path: notePath, scope, slug: doc.slug, kind: "note" };
}

/**
 * The write itself, slug-uniqueness check included. ASSUMES the caller holds the
 * scope lock and has already passed the scope and owner gates — the importer
 * reuses it under its own lock, which is why the public operation and this
 * primitive are separate: nesting `withScopeLock` would deadlock on the same
 * file.
 */
export function addMemoryUnderLock(deps: AddDeps, opts: AddOptions, scope: string): AddResult {
  return writeDocument(deps, opts, scope, buildDocument(deps, opts, scope));
}

/**
 * `O_EXCL` on create, always. The scope lock only covers our own processes; a
 * file that appeared some other way must still never be clobbered.
 */
function writeExclusive(path: string, content: string, onExists: (path: string) => Error): void {
  try {
    writeFileSync(path, content, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw onExists(path);
    throw e;
  }
}
