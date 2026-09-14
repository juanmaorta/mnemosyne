// src/write/claims.ts
//
// "Who already claims this slug in this scope?" — asked of the Markdown, never
// of `.index`.
//
// The index enforces UNIQUE(scope, slug), but it is derived state: it can be
// stale, absent, or rebuilt from scratch. The truth is the frontmatter, so both
// writers that need this answer (`update`, locating the note it must rewrite;
// `add`, refusing to mint a document nobody could ever retrieve) read it from
// the files themselves.
//
// Cost: one `readdir` plus a frontmatter parse per document in the scope, on
// every write. That is the price of not trusting derived state; a scope is a
// person's memories, not a table with millions of rows.
import { readFileSync } from "node:fs";
import { parseFrontmatter } from "../frontmatter.js";
import { listEngramFiles } from "../index/walk.js";

export interface SlugClaim {
  path: string;
  isFact: boolean;
}

/**
 * Every document in `scope` whose frontmatter `name` is `slug`.
 *
 * Searched by frontmatter and not by filename: `name` is the identity, so a file
 * whose name disagrees with its path, and a second file that copied the same
 * `name`, both show up here. More than one is already a defect on disk — the
 * caller decides what to do about it.
 */
export function findSlugClaims(root: string, scope: string, slug: string): SlugClaim[] {
  return listEngramFiles(root, [scope])
    .filter((f) => {
      try {
        return parseFrontmatter(readFileSync(f.path, "utf8")).data.name === slug;
      } catch {
        return false; // unreadable or unparseable: not a claim on this slug
      }
    })
    .map((f) => ({ path: f.path, isFact: f.isFact }));
}
