// src/import/claude.ts
//
// `mneme import-claude`: one explicit native-memory directory → one explicit
// scope, idempotently.
//
// Claude Code keeps its own memory in `~/.claude/projects/<slug>/memory/*.md`.
// This brings a chosen directory into the canonical store ONCE per file and
// stays safe to re-run: identity is a deterministic slug and sameness is a
// content fingerprint, both derived from the files themselves, so there is no
// manifest that can drift from what is on disk. Nothing is ever overwritten —
// a slug that already exists with different content is a visible conflict, not
// a silent second version — and the source directory is only ever read.
//
// Which source frontmatter fields do NOT travel is documented in `plan.ts`
// (`OMITTED_SOURCE_FIELDS`) and printed in the report summary.
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ZodError } from "zod";
import type { Clock } from "../clock.js";
import { storePaths } from "../store.js";
import { listEngramFiles } from "../index/walk.js";
import {
  FactExistsError, NoteExistsError, SlugTakenError, addMemoryUnderLock, buildDocument, type AddDeps,
} from "../write/add.js";
import { NotOwnerError, SecretDetectedError, assertOwnsScope } from "../write/validation.js";
import { withScopeLock } from "../write/lock.js";
import {
  OMITTED_SOURCE_FIELDS, decide, emptyInventory, inventoryEntryOf, isKebabSlug, normalizeSourceFile,
  rememberInInventory, toLocalIso, type Inventory, type SourceCandidate,
} from "./plan.js";

/** Native index files: derived listings, not memories. Matched case-insensitively. */
const IGNORED_FILES = new Set(["memory.md", "index.md"]);

/** Case-insensitive `.md`, so `NOTE.MD` is not silently dropped as "not markdown". */
const MARKDOWN_RE = /\.md$/i;

export type ImportStatus =
  | "imported"
  | "importable"
  | "skipped-identical"
  | "conflict"
  | "failed"
  | "ignored";

export interface ImportFileResult {
  filename: string;
  status: ImportStatus;
  /** Safe category (`unknown-type`, `not-owner`, `symlink`…) — never source content. */
  reason?: string;
  /** Masked scanner findings only; nothing else ever lands here. */
  details?: string[];
  slug?: string;
  /** Where it went (imported) or would go (importable). */
  dest?: string;
  /** Existing documents that already hold this content or this slug. */
  existing?: string[];
  warnings: string[];
}

export interface ImportReport {
  source: string;
  sourceId: string;
  scope: string;
  apply: boolean;
  files: ImportFileResult[];
  counts: Record<ImportStatus, number>;
  /** Documents already in the scope that could not be read as engrams. */
  inventoryErrors: string[];
  omittedFields: readonly string[];
}

export interface ImportDeps {
  root: string;
  home: string;
  /** Last-resort `created` when a source file has neither stamp nor usable times. */
  now?: string;
  /** Stamps telemetry only. */
  clock?: Clock;
}

export interface ImportOptions {
  /** Absolute path of the native memory directory. */
  source: string;
  /** Stable operator-chosen id for this logical origin; part of every slug. */
  sourceId: string;
  /** Explicit destination scope: never inferred from a path or defaulted. */
  scope: string;
  apply: boolean;
}

/** Bad invocation — reported as usage, not as a per-file failure. */
export class ImportUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportUsageError";
  }
}

/**
 * Why a file is skipped without being a failure. A closed union so the categories
 * are compiler-checked at every `classify` return — the exported `FailureReason`
 * covered only the normalize path, leaving these literals as free-form strings
 * that a typo could slip through (MNE-40).
 */
export type IgnoreReason = "dotfile" | "native index file" | "not markdown" | "symlink" | "not a regular file";

/** One source file, already parsed and gated, waiting for a decision. */
type Prepared =
  | { filename: string; kind: "ignored"; reason: IgnoreReason }
  // `failed` reasons stay a string on purpose: some carry specifics
  // (`invalid-schema (fields)`), and the fixed ones come from several gates.
  | { filename: string; kind: "failed"; reason: string; details?: string[]; warnings: string[] }
  | { filename: string; kind: "ready"; candidate: SourceCandidate };

function assertUsable(opts: ImportOptions): void {
  if (!opts.source || !isAbsolute(opts.source)) {
    throw new ImportUsageError("--source must be an absolute directory path");
  }
  if (!isKebabSlug(opts.sourceId)) {
    throw new ImportUsageError(`--source-id must be a kebab-case slug: ${opts.sourceId || "(empty)"}`);
  }
  // Fail-closed, like every other write path: an unknown origin never lands in
  // `personal` just because nobody said otherwise.
  if (!isKebabSlug(opts.scope)) {
    throw new ImportUsageError(`--scope is required and must be a kebab-case slug: ${opts.scope || "(empty)"}`);
  }
  let stats;
  try {
    stats = statSync(opts.source);
  } catch {
    throw new ImportUsageError(`cannot read source directory: ${opts.source}`);
  }
  if (!stats.isDirectory()) throw new ImportUsageError(`--source is not a directory: ${opts.source}`);
}

/**
 * Whether a directory entry is a candidate at all. No recursion: one level.
 * `null` means "it is a candidate"; anything else is already its own outcome —
 * including the file that disappeared between the `readdir` and the `lstat`,
 * which is one file's problem and never the batch's.
 */
function classify(dir: string, name: string): Prepared | null {
  if (name.startsWith(".")) return { filename: name, kind: "ignored", reason: "dotfile" };
  if (IGNORED_FILES.has(name.toLowerCase())) return { filename: name, kind: "ignored", reason: "native index file" };
  if (!MARKDOWN_RE.test(name)) return { filename: name, kind: "ignored", reason: "not markdown" };
  let stats;
  try {
    stats = lstatSync(join(dir, name));
  } catch {
    return { filename: name, kind: "failed", reason: "stat-error", warnings: [] };
  }
  if (stats.isSymbolicLink()) return { filename: name, kind: "ignored", reason: "symlink" };
  if (!stats.isFile()) return { filename: name, kind: "ignored", reason: "not a regular file" };
  return null;
}

/** Parse, normalize and gate every source file. Stable order: by filename. */
function prepare(deps: ImportDeps, opts: ImportOptions): Prepared[] {
  return readdirSync(opts.source).sort().map(
    (filename) => classify(opts.source, filename) ?? prepareFile(deps, opts, filename),
  );
}

function prepareFile(deps: ImportDeps, opts: ImportOptions, filename: string): Prepared {
  const path = join(opts.source, filename);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { filename, kind: "failed", reason: "read-error", warnings: [] };
  }
  // Birthtime, else mtime, else the caller's clock: a `created` that is roughly
  // when the memory appeared beats one that is when the import ran.
  let fallbackCreated = deps.now ?? toLocalIso(new Date());
  try {
    const info = statSync(path);
    fallbackCreated = toLocalIso(info.birthtime.getTime() ? info.birthtime : info.mtime);
  } catch {
    // Unreadable times only: the file itself was read fine, so import it anyway.
  }

  const normalized = normalizeSourceFile({ raw, filename, sourceId: opts.sourceId, fallbackCreated });
  if (!normalized.ok) {
    return { filename, kind: "failed", reason: normalized.reason, warnings: normalized.warnings };
  }
  const candidate = normalized.candidate;

  // Schema + secret gates now, in BOTH modes: a dry run that promised an import
  // and an apply that then refused it would be worse than useless. The built
  // document is DISCARDED on purpose — this call is here for its gates only, and
  // the write path builds its own from the same inputs, so the bytes that reach
  // disk are always the ones `addMemoryUnderLock` validated itself.
  try {
    buildDocument(addDeps(deps, opts, candidate), addOptions(candidate), opts.scope);
    return { filename, kind: "ready", candidate };
  } catch (e) {
    if (e instanceof SecretDetectedError) {
      return {
        filename, kind: "failed", reason: "secret-detected", warnings: candidate.warnings,
        // The scanner already masked these; nothing else from the file travels.
        details: e.findings.map((f) => `${f.pattern} (line ${f.line}): ${f.masked}`),
      };
    }
    if (e instanceof ZodError) {
      // Field names only: a zod message can quote the offending value.
      const fields = [...new Set(e.issues.map((i) => i.path.join(".") || "(root)"))];
      return { filename, kind: "failed", reason: `invalid-schema (${fields.join(", ")})`, warnings: candidate.warnings };
    }
    throw e;
  }
}

function addDeps(deps: ImportDeps, opts: ImportOptions, candidate: SourceCandidate): AddDeps {
  return {
    root: deps.root,
    // The source dir is never consulted for a scope (it is explicit), but `add`
    // wants a cwd; giving it the source keeps the value honest.
    cwd: opts.source,
    home: deps.home,
    now: candidate.created,
    ...(deps.clock ? { clock: deps.clock } : {}),
  };
}

function addOptions(candidate: SourceCandidate) {
  return {
    content: candidate.body,
    type: candidate.type,
    description: candidate.description,
    importance: candidate.importance,
    slug: candidate.slug,
  };
}

/** What the scope already holds, read from the Markdown — never from the index. */
/**
 * Why a candidate conflicts, and — when the store already holds the note under
 * its bare slug — which side has more body. With a dozen conflicts at once,
 * "the store is longer in 11 of them" is the difference between a decision and
 * a file-by-file diff. Length is a hint, not a verdict: a note can be improved
 * by being cut.
 */
function conflictReason(candidate: SourceCandidate, existingPath: string | undefined, inv: Inventory): string {
  const migrated = existingPath !== undefined && inv.bySlug.get(candidate.baseSlug) === existingPath;
  if (!migrated) return "slug exists with different content";
  const theirs = inv.bodyLengthByPath.get(existingPath);
  const sizes = theirs === undefined ? "" : ` (store ${theirs} B vs source ${candidate.body.length} B)`;
  return `already in the store as '${candidate.baseSlug}', with different content${sizes}`;
}

function buildInventory(root: string, scope: string): { inventory: Inventory; errors: string[] } {
  const inventory = emptyInventory();
  const errors: string[] = [];
  for (const file of listEngramFiles(root, [scope])) {
    let entry: { slug: string; fingerprint: string } | null = null;
    try {
      entry = inventoryEntryOf(readFileSync(file.path, "utf8"));
    } catch {
      entry = null;
    }
    // A document we cannot read is reported and skipped; it never blocks the
    // batch, and `O_EXCL` still keeps us from writing over anything.
    if (!entry) errors.push(file.path);
    else rememberInInventory(inventory, { ...entry, path: file.path });
  }
  return { inventory, errors };
}

function emptyCounts(): Record<ImportStatus, number> {
  return { imported: 0, importable: 0, "skipped-identical": 0, conflict: 0, failed: 0, ignored: 0 };
}

/**
 * Imports one native memory directory into one scope.
 *
 * Dry run (the default) does everything except mkdir, lock, write, telemetry and
 * index. Apply rebuilds the inventory UNDER the scope lock — it never trusts a
 * previous dry run — and imports file by file: a failure is per file, there is
 * no batch transaction, and re-running is safe.
 */
export function importClaudeMemory(deps: ImportDeps, opts: ImportOptions): ImportReport {
  assertUsable(opts);
  const prepared = prepare(deps, opts);
  const report: ImportReport = {
    source: opts.source,
    sourceId: opts.sourceId,
    scope: opts.scope,
    apply: opts.apply,
    files: [],
    counts: emptyCounts(),
    inventoryErrors: [],
    omittedFields: OMITTED_SOURCE_FIELDS,
  };

  // Gate 2 — owner — in both modes: a machine that may not write this scope
  // should hear so from a dry run too, not after typing --apply.
  try {
    assertOwnsScope(deps.root, opts.scope);
  } catch (e) {
    if (!(e instanceof NotOwnerError)) throw e;
    return finish(report, prepared.map((p) =>
      p.kind === "ignored"
        ? ignored(p)
        : { filename: p.filename, status: "failed" as const, reason: "not-owner", warnings: warningsOf(p) }));
  }

  if (!opts.apply) {
    const { inventory, errors } = buildInventory(deps.root, opts.scope);
    report.inventoryErrors = errors;
    return finish(report, settle(deps, opts, prepared, inventory, false));
  }

  // Creating the scope directory MEANS materializing the scope (`listScopes`
  // then reports it as real), so it happens only once something is actually
  // writable — the same invariant `addMemory` holds for a rejected write. With
  // no scope directory the inventory is empty, so every ready candidate is a
  // create: "nothing ready" is exactly "nothing to create".
  if (!prepared.some((p) => p.kind === "ready")) {
    const { inventory, errors } = buildInventory(deps.root, opts.scope);
    report.inventoryErrors = errors;
    return finish(report, settle(deps, opts, prepared, inventory, true));
  }

  const scopeDir = storePaths(deps.root).scopeDir(opts.scope);
  mkdirSync(scopeDir, { recursive: true });
  return withScopeLock(scopeDir, () => {
    const { inventory, errors } = buildInventory(deps.root, opts.scope);
    report.inventoryErrors = errors;
    return finish(report, settle(deps, opts, prepared, inventory, true));
  });
}

function warningsOf(p: Prepared): string[] {
  if (p.kind === "ready") return p.candidate.warnings;
  if (p.kind === "failed") return p.warnings;
  return [];
}

function ignored(p: Prepared & { kind: "ignored" }): ImportFileResult {
  return { filename: p.filename, status: "ignored", reason: p.reason, warnings: [] };
}

/**
 * Decide (and, when applying, write) each candidate in order, updating the
 * in-memory inventory after every write and skip so two identical files in the
 * SAME batch dedupe against each other too.
 */
function settle(
  deps: ImportDeps,
  opts: ImportOptions,
  prepared: Prepared[],
  inventory: Inventory,
  apply: boolean,
): ImportFileResult[] {
  const paths = storePaths(deps.root);
  return prepared.map((p) => {
    if (p.kind === "ignored") return ignored(p);
    if (p.kind === "failed") {
      return {
        filename: p.filename, status: "failed" as const, reason: p.reason,
        ...(p.details ? { details: p.details } : {}), warnings: p.warnings,
      };
    }

    const { candidate } = p;
    const base = { filename: p.filename, slug: candidate.slug, warnings: candidate.warnings };
    const decision = decide(candidate, inventory);
    if (decision.kind === "skip") {
      return { ...base, status: "skipped-identical" as const, existing: decision.paths };
    }
    if (decision.kind === "conflict") {
      return {
        ...base, status: "conflict" as const,
        reason: conflictReason(candidate, decision.paths[0], inventory),
        existing: decision.paths,
      };
    }

    const isFact = candidate.type === "feedback";
    if (!apply) {
      // Fact filenames are ULIDs minted at write time, so a dry run can only
      // name the stream they would join.
      const dest = isFact
        ? join(paths.factsDir(opts.scope), "<ulid>.md")
        : join(paths.scopeDir(opts.scope), `${candidate.slug}.md`);
      rememberInInventory(inventory, { slug: candidate.slug, fingerprint: candidate.fingerprint, path: dest });
      return { ...base, status: "importable" as const, dest };
    }

    try {
      const res = addMemoryUnderLock(addDeps(deps, opts, candidate), addOptions(candidate), opts.scope);
      rememberInInventory(inventory, { slug: candidate.slug, fingerprint: candidate.fingerprint, path: res.path });
      return { ...base, status: "imported" as const, dest: res.path };
    } catch (e) {
      // Something appeared where we were about to write (the lock only covers
      // our own processes). Report it; never clobber it.
      if (e instanceof NoteExistsError || e instanceof FactExistsError) {
        return { ...base, status: "conflict" as const, reason: "destination already exists", existing: [e.path] };
      }
      // The inventory above normally answers this first; this is the case it
      // cannot see — a document already claiming the slug that it could not read
      // (reported as an inventory error). Still a conflict for a human, never a
      // crash and never a second document under one identity.
      if (e instanceof SlugTakenError) {
        return { ...base, status: "conflict" as const, reason: "slug already claimed", existing: [e.path] };
      }
      if (e instanceof SecretDetectedError) {
        return {
          ...base, status: "failed" as const, reason: "secret-detected",
          details: e.findings.map((f) => `${f.pattern} (line ${f.line}): ${f.masked}`),
        };
      }
      // One file's failure never aborts the rest: there is no batch transaction.
      return { ...base, status: "failed" as const, reason: "write-error" };
    }
  });
}

function finish(report: ImportReport, files: ImportFileResult[]): ImportReport {
  report.files = files;
  for (const f of files) report.counts[f.status]++;
  return report;
}

/** Non-zero exit territory: something needs a human. */
export function importFailed(report: ImportReport): boolean {
  return report.counts.conflict > 0 || report.counts.failed > 0;
}

/** The CLI's rendering: one line per file, then counters. Never any content. */
export function formatImportReport(report: ImportReport): string[] {
  const lines: string[] = [`source ${report.source}  →  scope ${report.scope}  (source-id ${report.sourceId})`];
  for (const f of report.files) {
    const where = f.dest ? `  → ${f.dest}` : f.existing?.length ? `  → ${f.existing.join(", ")}` : "";
    const why = f.reason ? `  [${f.reason}]` : "";
    const extra = (f.details ?? []).map((d) => `  {${d}}`).join("");
    const warn = f.warnings.map((w) => `  (warning: ${w})`).join("");
    lines.push(`${f.status.padEnd(17)}  ${f.filename}${where}${why}${extra}${warn}`);
  }
  for (const path of report.inventoryErrors) {
    lines.push(`inventory-error      ${path}  [not a readable engram; skipped]`);
  }
  const c = report.counts;
  lines.push("");
  lines.push(
    `summary: ${report.apply ? "imported" : "importable"} ${report.apply ? c.imported : c.importable}, ` +
    `skipped-identical ${c["skipped-identical"]}, conflict ${c.conflict}, ` +
    `failed ${c.failed}, ignored ${c.ignored}, inventory-errors ${report.inventoryErrors.length}`,
  );
  lines.push(`not copied from the source: ${report.omittedFields.join("; ")}`);
  // On disk is not the same as retrievable: `get` and `context` read the index,
  // and the importer deliberately does not touch it.
  if (c.imported > 0) lines.push("run `mneme reindex` to make the imported memories retrievable.");
  if (!report.apply) lines.push("DRY RUN — nothing written. Re-run with --apply to import.");
  return lines;
}
