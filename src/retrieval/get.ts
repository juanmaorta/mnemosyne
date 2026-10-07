import { readFileSync } from "node:fs";
import type { Db } from "../index/db.js";
import { recordAccess } from "../hotstate.js";
import { revisionOf } from "../revision.js";
import type { Clock } from "../clock.js";

export interface EngramDoc { slug: string; scope: string; path: string; content: string }

/** An engram plus the revision of the very bytes `content` was decoded from. */
export interface RevisionedEngramDoc extends EngramDoc { revision: string }

export class NotFoundError extends Error {
  constructor(slug: string) { super(`No engram named '${slug}'.`); this.name = "NotFoundError"; }
}
export class AmbiguousSlugError extends Error {
  constructor(slug: string, readonly scopes: string[]) {
    super(`Engram '${slug}' exists in multiple scopes: ${scopes.join(", ")}. Pass --scope.`);
    this.name = "AmbiguousSlugError";
  }
}

/** The index row for one unambiguous slug. Throws rather than picking a winner. */
function locateRow(db: Db, slug: string, scope?: string): Omit<EngramDoc, "content"> {
  const rows = db.prepare(
    `select slug, scope, path from engrams where slug = ?${scope ? " and scope = ?" : ""}`,
  ).all(...(scope ? [slug, scope] : [slug])) as Omit<EngramDoc, "content">[];
  if (rows.length === 0) throw new NotFoundError(slug);
  if (rows.length > 1) throw new AmbiguousSlugError(slug, rows.map((r) => r.scope));
  return rows[0]!;
}

export function getEngram(db: Db, slug: string, scope?: string): EngramDoc {
  const row = locateRow(db, slug, scope);
  return { ...row, content: readFileSync(row.path, "utf8") };
}

/**
 * Same lookup and the same reinforcement, but the file is read ONCE as bytes:
 * `content` is that buffer decoded and `revision` is its hash. Reading twice
 * would open a window in which the caller is handed a revision that no longer
 * describes the content it also got — which is precisely the conflict
 * `update --if-match` exists to detect.
 */
export function getEngramWithRevision(db: Db, root: string, slug: string, clock: Clock, scope?: string): RevisionedEngramDoc {
  const row = locateRow(db, slug, scope);
  const bytes = readFileSync(row.path);
  const doc = { ...row, content: bytes.toString("utf8"), revision: revisionOf(bytes) };
  recordAccess(db, root, doc.scope, doc.slug, clock.nowIso());
  return doc;
}
