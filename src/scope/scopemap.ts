// src/scope/scopemap.ts
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SCOPE, storePaths } from "../store.js";

export interface ScopeMapEntry {
  prefix: string;
  /**
   * `prefix` with symlinks resolved, present only when it resolved to something
   * different. A `.scopemap` is written by a human naming a path they can `cd`
   * into, but `process.cwd()` hands back that path with symlinks ALREADY
   * resolved — on macOS `/tmp` is a symlink to `/private/tmp`. So a map naming
   * `/tmp/client` could never match the directory it plainly names, and the miss
   * was silent: reads fell back to the default scope, writes refused outright.
   */
  canonical?: string;
  scope: string;
}

/**
 * Resolves a path to its canonical form, or undefined when it cannot — which is
 * a legitimate answer, not an error: a map may name a directory that is not
 * there yet (a repo not cloned, a volume not mounted), and such an entry has to
 * keep working as a literal prefix.
 */
export type Canonicalize = (path: string) => string | undefined;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

export function parseScopeMap(text: string, home: string, canonicalize?: Canonicalize): ScopeMapEntry[] {
  const entries: ScopeMapEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const prefix = line.slice(0, eq).trim();
    const scope = line.slice(eq + 1).trim();
    if (!prefix || !KEBAB.test(scope)) continue;
    const expanded = expandTilde(prefix, home);
    const canonical = canonicalize?.(expanded);
    // Only when it differs: a second identical copy would just make a reader
    // wonder which one wins.
    entries.push({ prefix: expanded, ...(canonical && canonical !== expanded ? { canonical } : {}), scope });
  }
  return entries;
}

/** Length of the match, or undefined if `prefix` does not contain `cwd`. */
function matchLength(prefix: string, cwd: string): number | undefined {
  return cwd === prefix || cwd.startsWith(`${prefix}/`) ? prefix.length : undefined;
}

function bestMatch(entries: ScopeMapEntry[], cwd: string): ScopeMapEntry | undefined {
  let best: ScopeMapEntry | undefined;
  let bestLength = -1;
  for (const e of entries) {
    // Both spellings of the same entry are candidates, so the map matches
    // whichever form the caller happens to hand us.
    for (const form of [e.prefix, e.canonical]) {
      if (form === undefined) continue;
      const length = matchLength(form, cwd);
      // Longest MATCHING form wins, not the longest written prefix: `/tmp/client`
      // is shorter than `/private/tmp` as written but longer once canonicalized,
      // and ranking by the written text would hand a client's directory to the
      // more general entry.
      if (length !== undefined && length > bestLength) {
        best = e;
        bestLength = length;
      }
    }
  }
  return best;
}

export function resolveScope(entries: ScopeMapEntry[], cwd: string, fallback = DEFAULT_SCOPE): string {
  return bestMatch(entries, cwd)?.scope ?? fallback;
}

export function resolveScopeStrict(entries: ScopeMapEntry[], cwd: string): string | null {
  return bestMatch(entries, cwd)?.scope ?? null;
}

export function scopeMapPath(root: string): string {
  return storePaths(root).scopeMap;
}

/** Best-effort: a prefix that is not on disk stays a literal prefix. */
export function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export function loadScopeMap(path: string, home: string): ScopeMapEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return parseScopeMap(text, home, realpathOrUndefined);
}
