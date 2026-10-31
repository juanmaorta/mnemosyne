import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { storePaths } from "./store.js";

export function resolveRoot(flag?: string): string {
  const root = flag ?? process.env.MNEMOSYNE_ROOT ?? join(homedir(), "memory");
  // MNE-106: a root like `--help` is a flag that landed in the wrong place, and
  // the first write would create a store under a directory of that name.
  if (root.startsWith("-")) {
    const source = flag !== undefined ? "--root" : "MNEMOSYNE_ROOT";
    throw new Error(`${source} expects a path, got '${root}'. A path that starts with '-' must be written as './${root}'.`);
  }
  return root;
}

/**
 * What `mneme init` persists for one store (MNE-20, MNE-97).
 *
 * These exist so the normal case needs no environment variables: a hook or an
 * agent's non-interactive shell does not inherit `~/.zshrc`, and a process that
 * misses `OLLAMA_MODEL` falls back to a default model that disagrees with the
 * index — which `mneme` then refuses to use. The env vars still work and win
 * over every field here; a CLI flag wins over both.
 */
export interface StoreConfig {
  /** `"none"` is tier 0 (BM25 only); `"ollama"` the embedder tier. */
  embedder?: string;
  /** Embedding model (`OLLAMA_MODEL` overrides it). */
  model?: string;
  /** Raw cosine floor (`MNEMOSYNE_MIN_COS` overrides it). */
  minCos?: number;
  /** Raw-BM25 lexical rescue floor (`MNEMOSYNE_LEXICAL_FLOOR` overrides it). */
  lexicalFloor?: number;
}

/**
 * The store's persisted settings. A missing or unparseable file reads as empty —
 * the store predates `init`, and every field has a working default. A field of
 * the WRONG TYPE throws instead: a floor nobody can read silently becoming "no
 * floor" would change what search returns without a word.
 */
export function loadStoreConfig(root: string): StoreConfig {
  const path = storePaths(root).config;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const cfg: StoreConfig = {};
  if (typeof obj.embedder === "string") cfg.embedder = obj.embedder;
  if (obj.model !== undefined) {
    if (typeof obj.model !== "string" || obj.model.trim() === "") throw new Error(`${path}: "model" must be a non-empty string.`);
    cfg.model = obj.model.trim();
  }
  for (const key of ["minCos", "lexicalFloor"] as const) {
    if (obj[key] === undefined) continue;
    const v = obj[key];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${path}: "${key}" must be a number, got ${JSON.stringify(v)}.`);
    cfg[key] = v;
  }
  return cfg;
}
