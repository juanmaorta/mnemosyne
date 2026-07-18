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
/**
 * Default scope: the lenient read fallback and the migration default. NOT a list
 * of known scopes — scopes are extensible user data (a string + a folder), so no
 * specific scope name (e.g. a client's) ever appears as a constant in the engine.
 */
export const DEFAULT_SCOPE = "personal";

/** Machine-local directory→scope map (never synced); see `.stignore` in Phase 4. */
export const SCOPEMAP_FILE = ".scopemap";

/** Machine-local owner policy (never synced); see `.stignore` in Phase 4. */
export const OWNER_FILE = ".owner";

export interface StorePaths {
  readonly root: string;
  scopeDir(scope: string): string;
  factsDir(scope: string): string;
  readonly archiveDir: string;
  readonly indexDir: string;
  readonly indexDb: string;
  readonly indexMd: string;
  readonly scopeMap: string;
  readonly ownerPolicy: string;
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
    scopeMap: join(root, SCOPEMAP_FILE),
    ownerPolicy: join(root, OWNER_FILE),
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
