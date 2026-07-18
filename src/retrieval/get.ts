import { readFileSync } from "node:fs";
import type { Db } from "../index/db.js";
import { recordAccess } from "../hotstate.js";

export interface EngramDoc { slug: string; scope: string; path: string; content: string }

export class NotFoundError extends Error {
  constructor(slug: string) { super(`No engram named '${slug}'.`); this.name = "NotFoundError"; }
}
export class AmbiguousSlugError extends Error {
  constructor(slug: string, readonly scopes: string[]) {
    super(`Engram '${slug}' exists in multiple scopes: ${scopes.join(", ")}. Pass --scope.`);
    this.name = "AmbiguousSlugError";
  }
}

export function getEngram(db: Db, slug: string, scope?: string): EngramDoc {
  const rows = db.prepare(
    `select slug, scope, path from engrams where slug = ?${scope ? " and scope = ?" : ""}`,
  ).all(...(scope ? [slug, scope] : [slug])) as Omit<EngramDoc, "content">[];
  if (rows.length === 0) throw new NotFoundError(slug);
  if (rows.length > 1) throw new AmbiguousSlugError(slug, rows.map((r) => r.scope));
  const row = rows[0]!;
  return { ...row, content: readFileSync(row.path, "utf8") };
}

/** Reads the engram and records a `get` access event, reinforcing its hot state. */
export function getEngramAndRecord(db: Db, root: string, slug: string, scope?: string): EngramDoc {
  const doc = getEngram(db, slug, scope);
  recordAccess(db, root, doc.scope, doc.slug, new Date().toISOString());
  return doc;
}
