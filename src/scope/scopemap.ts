// src/scope/scopemap.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ScopeMapEntry {
  prefix: string;
  scope: string;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

export function parseScopeMap(text: string, home: string): ScopeMapEntry[] {
  const entries: ScopeMapEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const prefix = line.slice(0, eq).trim();
    const scope = line.slice(eq + 1).trim();
    if (!prefix || !KEBAB.test(scope)) continue;
    entries.push({ prefix: expandTilde(prefix, home), scope });
  }
  return entries;
}

export function resolveScope(entries: ScopeMapEntry[], cwd: string, fallback = "personal"): string {
  let best: ScopeMapEntry | undefined;
  for (const e of entries) {
    if (cwd === e.prefix || cwd.startsWith(`${e.prefix}/`)) {
      if (!best || e.prefix.length > best.prefix.length) best = e;
    }
  }
  return best?.scope ?? fallback;
}

export function scopeMapPath(root: string): string {
  return join(root, ".scopemap");
}

export function loadScopeMap(path: string, home: string): ScopeMapEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return parseScopeMap(text, home);
}
