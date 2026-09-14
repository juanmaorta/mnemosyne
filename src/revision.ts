// src/revision.ts
import { createHash } from "node:crypto";

/**
 * A note's revision: the SHA-256 of the EXACT bytes of its `.md` file.
 *
 * Deliberately not a value from the index and not a hash of the body: the index
 * is derived state that can be stale or absent, and a body hash would let a
 * frontmatter-only change slip past a compare-and-swap. Reader and writer both
 * hash the same thing — the file — so `get --json` and `update --if-match` are
 * talking about the same object.
 *
 * Takes bytes, never a string, so the value never depends on how someone
 * decoded the file first.
 */
export function revisionOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
