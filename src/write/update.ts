// src/write/update.ts
//
// The only supported way to change an existing note.
//
// A note is canonical: agents and humans both read it and both want to rewrite
// it, from different processes, on machines that sync the folder behind our
// back. Last-write-wins there means one of those edits disappears without a
// trace, so an update is a compare-and-swap on the file's bytes: the caller
// says which revision it read (`get --json`), and the write happens only if the
// file is still exactly that. It never creates a missing note, never touches
// identity (`name`, `scope`, `type`, `created`), and never truncates the target
// in place — a new file is written beside it and renamed over it.
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { EngramSchema, FACT_TYPES } from "../schema.js";
import { parseFrontmatter, serializeFrontmatter } from "../frontmatter.js";
import { revisionOf } from "../revision.js";
import { storePaths } from "../store.js";
import { findSlugClaims } from "./claims.js";
import { withScopeLock } from "./lock.js";
import { assertNoSecrets, assertOwnsScope, resolveWriteScope } from "./validation.js";

// The scope/owner/secret gates are shared with `add`, but their errors are part
// of `update`'s contract too — re-exported so callers map them in one place.
export {
  ScopeUnresolvedError,
  NotOwnerError,
  SecretDetectedError,
} from "./validation.js";

export class NoChangesError extends Error {
  constructor() {
    super("nothing to update: pass a new body (positional or --file), --description or --importance");
    this.name = "NoChangesError";
  }
}
export class UnknownSupersederError extends Error {
  constructor(readonly slug: string, readonly scope: string) {
    super(`no note named '${slug}' in scope '${scope}' to supersede with`);
    this.name = "UnknownSupersederError";
  }
}
export class NoteNotFoundError extends Error {
  constructor(readonly slug: string, readonly scope: string) {
    super(`no note named '${slug}' in scope '${scope}'`);
    this.name = "NoteNotFoundError";
  }
}
/**
 * Two files in one scope claim the same `name`. The index enforces (scope, slug)
 * uniqueness, but it is derived state that may be stale or missing, so this is
 * decided from the Markdown itself.
 */
export class DuplicateSlugError extends Error {
  constructor(readonly slug: string, readonly paths: string[]) {
    super(`'${slug}' is claimed by more than one file: ${paths.join(", ")}`);
    this.name = "DuplicateSlugError";
  }
}
/** Feedback is an append-only observation: rewriting one would erase evidence. */
export class NotEditableError extends Error {
  constructor(readonly path: string) {
    super(`refusing to edit an append-only feedback fact: ${path}`);
    this.name = "NotEditableError";
  }
}
/**
 * The file on disk is not the memory it says it is: wrong filename for its
 * `name`, a `scope` that disagrees with the folder it lives in, or frontmatter
 * the schema rejects. Updating any of those would either move a memory's
 * identity or bless an invalid document.
 */
export class IdentityMismatchError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`${path} is not a valid note for this update: ${detail}`);
    this.name = "IdentityMismatchError";
  }
}
export class RevisionMismatchError extends Error {
  constructor(readonly path: string, readonly expected: string, readonly actual: string) {
    super(`revision mismatch for ${path}: on disk ${actual}, --if-match ${expected}`);
    this.name = "RevisionMismatchError";
  }
}
/** A symlink, directory or device where a note should be — never written through. */
export class NotRegularFileError extends Error {
  constructor(readonly path: string) {
    super(`refusing to write ${path}: not a regular file`);
    this.name = "NotRegularFileError";
  }
}

export interface UpdateDeps {
  root: string;
  cwd: string;
  home: string;
}

export interface UpdateOptions {
  slug: string;
  /** The revision the caller read, from `mneme get <slug> --json`. */
  ifMatch: string;
  content?: string;
  description?: string;
  importance?: number;
  scope?: string;
  /** Lifecycle of the claim. `active` clears both fields — absent means active. */
  status?: "active" | "superseded" | "flagged";
  /** Implies `status: superseded`. The note named must exist in the same scope. */
  supersededBy?: string;
}

export interface UpdateResult {
  path: string;
  scope: string;
  slug: string;
  /** The revision of the bytes now on disk — what a follow-up update must match. */
  revision: string;
}

/**
 * Locates the single file in `scope` whose frontmatter `name` is `slug`.
 *
 * The search itself lives in `claims.ts`, shared with `add` — which asks the
 * same question to refuse a slug that is already taken. Here the answer must be
 * exactly one file: two claims are a defect on disk that only a human can undo.
 */
function locateBySlug(root: string, scope: string, slug: string): { path: string; isFact: boolean } {
  const matches = findSlugClaims(root, scope, slug);
  if (matches.length > 1) throw new DuplicateSlugError(slug, matches.map((m) => m.path));
  if (matches.length === 1) return { path: matches[0]!.path, isFact: matches[0]!.isFact };

  // The walker only yields regular files, so a symlinked note is invisible to
  // it. Say what is actually there instead of "not found".
  const expected = join(storePaths(root).scopeDir(scope), `${slug}.md`);
  statRegularFile(expected, () => undefined);
  throw new NoteNotFoundError(slug, scope);
}

/**
 * Stats `path`, insisting it is a plain file. `onMissing` says what an absent
 * path means to the caller — a domain error to raise, or `undefined` when the
 * caller wants to handle it itself. Node's raw ENOENT never escapes.
 */
function statRegularFile(path: string, onMissing: () => Error | undefined): Stats | undefined {
  let stat: Stats;
  try {
    stat = lstatSync(path); // lstat, not stat: a symlink must be seen as a symlink
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const missing = onMissing();
    if (missing) throw missing;
    return undefined;
  }
  if (!stat.isFile()) throw new NotRegularFileError(path);
  return stat;
}

function isFactType(type: unknown): boolean {
  return (FACT_TYPES as readonly string[]).includes(String(type));
}

/**
 * Reads, checks and rewrites one note. Gates first (scope → owner), then
 * location and identity, then the compare-and-swap under the scope lock.
 */
export function updateNote(deps: UpdateDeps, opts: UpdateOptions): UpdateResult {
  if (opts.content === undefined && opts.description === undefined && opts.importance === undefined
      && opts.status === undefined && opts.supersededBy === undefined) {
    throw new NoChangesError();
  }
  const scope = resolveWriteScope(deps, opts.scope);
  // Checked BEFORE taking the lock: a pointer at a note that does not exist is
  // worse than no pointer at all — the note drops out of the ranking and names
  // a replacement nobody can read. Cheap to verify, and nothing is held while
  // we do it.
  if (opts.supersededBy !== undefined && opts.supersededBy !== opts.slug) {
    try {
      locateBySlug(deps.root, scope, opts.supersededBy);
    } catch {
      throw new UnknownSupersederError(opts.supersededBy, scope);
    }
  }
  assertOwnsScope(deps.root, scope);

  const found = locateBySlug(deps.root, scope, opts.slug);
  if (found.isFact) throw new NotEditableError(found.path);
  const target = join(storePaths(deps.root).scopeDir(scope), `${opts.slug}.md`);
  if (found.path !== target) {
    throw new IdentityMismatchError(found.path, `it claims name '${opts.slug}' but is not ${target}`);
  }

  return withScopeLock(dirname(target), () => swap(target, scope, opts));
}

/** Everything under the lock: read bytes → compare → rebuild → validate → rename. */
function swap(target: string, scope: string, opts: UpdateOptions): UpdateResult {
  // Re-checked while holding the lock: between the walk and here the file could
  // have been deleted, or replaced by a symlink pointing anywhere.
  const stat = statRegularFile(target, () => new NoteNotFoundError(opts.slug, scope))!;
  const bytes = readFileSync(target);
  const actual = revisionOf(bytes);
  if (actual !== opts.ifMatch) throw new RevisionMismatchError(target, opts.ifMatch, actual);

  const raw = bytes.toString("utf8");
  const { data, body } = parseFrontmatter(raw);
  const current = EngramSchema.safeParse(data);
  if (!current.success) {
    throw new IdentityMismatchError(target, `frontmatter does not satisfy the schema (${current.error.issues[0]?.message ?? "invalid"})`);
  }
  if (current.data.scope !== scope) {
    throw new IdentityMismatchError(target, `frontmatter says scope '${current.data.scope}' but it lives in '${scope}'`);
  }
  if (isFactType(current.data.type)) throw new NotEditableError(target);

  // Spread the RAW frontmatter, not the parsed copy: key order survives, and
  // anything the schema accepts but this command does not touch (links, sources)
  // is carried over verbatim. Identity fields are never in the override list.
  const next: Record<string, unknown> = { ...data };
  if (opts.description !== undefined) next.description = opts.description.trim();
  if (opts.importance !== undefined) next.importance = opts.importance;
  const status = opts.status ?? (opts.supersededBy !== undefined ? "superseded" : undefined);
  if (status !== undefined) {
    // `active` writes nothing: absent IS active, so a note that was never
    // superseded and one that stopped being superseded look identical on disk.
    // Anything else would make "absent means active" a rule with exceptions.
    if (status === "active") { delete next.status; delete next.superseded_by; }
    else next.status = status;
  }
  if (opts.supersededBy !== undefined) next.superseded_by = opts.supersededBy;
  else if (status === "flagged") delete next.superseded_by;
  EngramSchema.parse(next); // the RESULT must be valid too — bad importance, or an incoherent pair, stops here

  const nextBody = opts.content === undefined
    ? body
    : (opts.content.endsWith("\n") ? opts.content : `${opts.content}\n`);
  const serialized = serializeFrontmatter(next, nextBody);
  assertNoSecrets(serialized); // on the whole document, so a new description cannot smuggle one

  // `parseFrontmatter` normalizes CRLF to LF and this rewrites the whole
  // document even for a one-word change to the description, so without this the
  // note would come back with every line ending altered — an edit nobody asked
  // for, in a store that is synced and hand-editable. The file's own convention
  // wins, including over `--content` typed with LF.
  const fileContent = raw.includes("\r\n") ? serialized.replace(/\r?\n/g, "\r\n") : serialized;

  writeAtomic(target, fileContent, stat.mode & 0o7777); // permission bits only; the type bits are not ours to set
  // Over the bytes actually written: a revision taken from the pre-conversion
  // text would not match the file, and the next compare-and-swap would refuse.
  return { path: target, scope, slug: opts.slug, revision: revisionOf(Buffer.from(fileContent, "utf8")) };
}

/**
 * Replaces `target` by writing a sibling temporary and renaming over it.
 *
 * Truncating in place would leave a half-written note behind if anything failed
 * mid-write — and this store is synced, so that half-file would propagate. A
 * reader therefore only ever sees the old file or the new one, never a partial
 * one.
 *
 * The rename alone is atomic against other processes but not against a power
 * cut: the directory entry can reach the disk before the data it names, and the
 * note comes back as a file full of zeros. So the temporary's bytes are fsync'd
 * BEFORE the rename publishes them, and the directory is fsync'd after, so the
 * entry itself survives too. Residual limitation: on macOS `fsync` only hands
 * the data to the drive, and forcing it past the drive cache needs
 * `F_FULLFSYNC`, which Node does not expose.
 *
 * The temporary is hidden and does NOT end in `.md`, so the index walker never
 * picks it up even if a crash strands one; it is created with `wx` so two
 * writers can never share one; and the original's mode is carried over, because
 * a rename brings the new file's permissions with it.
 *
 * `writeFileSync` on the descriptor rather than a hand-rolled `writeSync`:
 * `writeSync` does not loop, so a short write returns a smaller count with NO
 * error and the rename would install a silently truncated note.
 */
function writeAtomic(target: string, content: string, mode?: number): void {
  const dir = dirname(target);
  const tmp = join(dir, `.${basename(target)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    // Opened by hand instead of written by path: only a descriptor can be
    // fsync'd, and reopening the path afterwards would sync whatever is at that
    // name by then rather than the bytes we just wrote.
    const fd = mode !== undefined ? openSync(tmp, "wx", mode) : openSync(tmp, "wx");
    try {
      writeFileSync(fd, content);
      if (mode !== undefined) fchmodSync(fd, mode); // the create mode is masked by umask; this is not
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
    syncDir(dir);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never created, or already renamed away: nothing to clean.
    }
    throw e;
  }
}

/**
 * Flushes the directory entry created by the rename.
 *
 * Best effort on purpose: the swap has already happened and is visible to every
 * reader, so a filesystem that refuses to open a directory (Windows) or to sync
 * one must not turn a successful update into an error the caller would retry —
 * and the retry could not succeed anyway, because the revision it matched on is
 * no longer the one on disk.
 */
function syncDir(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // See above: durability of the entry is a bonus, not part of the contract.
  } finally {
    closeSync(fd);
  }
}
