import { join } from "node:path";
import { ulid } from "ulid";

/**
 * Store layout (plan.md — "Layout del store"):
 *
 *   <root>/<scope>/facts/*.md   append-only fact stream (observed, immutable)
 *   <root>/<scope>/*.md         notes: derived + authored
 *   <root>/archive/             decayed memories (moved, never deleted) — lethe
 *   <root>/INDEX.md             derived, regenerated
 *   <root>/.index/store.db      derived, local, NEVER synced
 *
 * Scope = folder (Syncthing routing) + `scope` frontmatter field (authoritative).
 */
export interface StorePaths {
  readonly root: string;
  scopeDir(scope: string): string;
  factsDir(scope: string): string;
  readonly archiveDir: string;
  readonly indexDir: string;
  readonly indexDb: string;
  readonly indexMd: string;
}

/** A scope maps to a directory name; reject anything that could escape the root. */
function assertSafeScope(scope: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scope)) {
    throw new Error(`unsafe scope (must be a kebab-case slug): ${scope}`);
  }
}

export function storePaths(root: string): StorePaths {
  return {
    root,
    scopeDir: (scope) => {
      assertSafeScope(scope);
      return join(root, scope);
    },
    factsDir: (scope) => {
      assertSafeScope(scope);
      return join(root, scope, "facts");
    },
    archiveDir: join(root, "archive"),
    indexDir: join(root, ".index"),
    indexDb: join(root, ".index", "store.db"),
    indexMd: join(root, "INDEX.md"),
  };
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FACT_FILE_RE = /^[0-9A-HJKMNP-TV-Z]{26}\.md$/;

/**
 * Fact files are named with a ULID so two machines creating facts offline can
 * never collide on a filename (append-only, conflict-free by construction).
 * The ULID's timestamp prefix makes filenames sort chronologically, so pass
 * `seedMs` (e.g. the source file's birthtime) when the creation time is known.
 */
export function newFactId(seedMs?: number): string {
  return seedMs === undefined ? ulid() : ulid(seedMs);
}

export function factFilename(id: string): string {
  if (!ULID_RE.test(id)) {
    throw new Error(`invalid ULID fact id: ${id}`);
  }
  return `${id}.md`;
}

export function isFactFilename(name: string): boolean {
  return FACT_FILE_RE.test(name);
}
