// src/index/walk.ts
import { readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { storePaths, isFactFilename } from "../store.js";

export interface EngramFile {
  path: string;
  scope: string;
  isFact: boolean;
}

const NON_SCOPE = new Set(["archive"]);

/** Scope dir names must be a kebab-case slug — mirrors `assertSafeScope` in store.ts. */
const KEBAB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function listScopes(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        !d.name.startsWith(".") &&
        !NON_SCOPE.has(d.name) &&
        KEBAB_SLUG_RE.test(d.name),
    )
    .map((d) => d.name);
}

function mdFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((d) => d.isFile() && d.name.endsWith(".md")).map((d) => join(dir, d.name));
}

export function listEngramFiles(root: string, scopes?: string[]): EngramFile[] {
  const paths = storePaths(root);
  const targets = scopes ?? listScopes(root);
  const out: EngramFile[] = [];
  for (const scope of targets) {
    for (const p of mdFiles(paths.scopeDir(scope))) {
      out.push({ path: p, scope, isFact: false });
    }
    for (const p of mdFiles(paths.factsDir(scope))) {
      if (isFactFilename(p.split("/").slice(-1)[0] ?? "")) out.push({ path: p, scope, isFact: true });
    }
  }
  return out;
}
