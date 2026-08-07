// src/write/add.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EngramSchema, FACT_TYPES } from "../schema.js";
import { serializeFrontmatter } from "../frontmatter.js";
import { storePaths, newFactId, factFilename } from "../store.js";
import { loadScopeMap, scopeMapPath, resolveScopeStrict } from "../scope/scopemap.js";
import { loadOwnerPolicy, ownsScope } from "../scope/owner.js";
import { scanForSecrets, hasRejectFinding, type SecretFinding } from "../secrets/scanner.js";
import { createHash } from "node:crypto";
import { emitEvent } from "../telemetry/events.js";
import { systemClock, type Clock } from "../clock.js";

export type EngramType = "feedback" | "reference" | "project" | "user";
export interface AddDeps {
  root: string;
  cwd: string;
  home: string;
  /** Stamped into the engram's `created` frontmatter. */
  now: string;
  /** Stamps telemetry only; defaults to the system clock. */
  clock?: Clock;
}
export interface AddOptions {
  content: string;
  type: EngramType;
  scope?: string;
  description?: string;
  importance?: number;
  slug?: string;
}
export interface AddResult { path: string; scope: string; slug: string; kind: "fact" | "note" }

export class ScopeUnresolvedError extends Error {
  constructor() {
    super("cannot resolve a scope for this cwd");
    this.name = "ScopeUnresolvedError";
  }
}
export class NotOwnerError extends Error {
  constructor(readonly scope: string) {
    super(`this machine does not own scope '${scope}'`);
    this.name = "NotOwnerError";
  }
}
export class SecretDetectedError extends Error {
  constructor(readonly findings: SecretFinding[]) {
    super("possible secret(s) detected");
    this.name = "SecretDetectedError";
  }
}
export class NoteExistsError extends Error {
  constructor(readonly path: string) {
    super(`note already exists: ${path}`);
    this.name = "NoteExistsError";
  }
}

const DEFAULT_IMPORTANCE = 5;

/** Coerce text into a kebab-case slug (mirrors the migration's slugify). */
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function deriveDescription(content: string): string {
  const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
  return firstLine.trim().slice(0, 120);
}

export function addMemory(deps: AddDeps, opts: AddOptions): AddResult {
  const { root, cwd, home, now, clock = systemClock } = deps;

  // Gate 1: scope (fail-closed — never defaults to personal on write).
  const scope = opts.scope ?? resolveScopeStrict(loadScopeMap(scopeMapPath(root), home), cwd);
  if (!scope) throw new ScopeUnresolvedError();

  const paths = storePaths(root);

  // Gate 2: owner (refuse to materialize a scope this machine doesn't own).
  if (!ownsScope(loadOwnerPolicy(paths.ownerPolicy), scope)) throw new NotOwnerError(scope);

  // Gate 3: secrets.
  const findings = scanForSecrets(opts.content);
  if (hasRejectFinding(findings)) {
    throw new SecretDetectedError(findings.filter((f) => f.severity === "reject"));
  }

  // Build + validate the engram frontmatter.
  const description = (opts.description ?? deriveDescription(opts.content)).trim();
  const slug = opts.slug ?? slugify(description);
  const frontmatter = {
    name: slug,
    description,
    scope,
    type: opts.type,
    created: now,
    importance: opts.importance ?? DEFAULT_IMPORTANCE,
  };
  const engram = EngramSchema.parse(frontmatter); // validates kebab slug, importance range, type
  const body = opts.content.endsWith("\n") ? opts.content : `${opts.content}\n`;
  const fileContent = serializeFrontmatter(engram, body);

  /**
   * Records that an engram was written, never WHAT was written: only a content
   * hash, so the log can correlate and dedupe without becoming a second copy of
   * the store. `origin` is always "agent" here — hand edits bypass addMemory
   * entirely and surface later as `engram.indexed` with reason mtime/hash.
   */
  const emitCreated = (): void => emitEvent(root, clock, {
    kind: "engram.created",
    scope,
    type: opts.type,
    importance: engram.importance,
    origin: "agent",
    contentHash: createHash("sha256").update(fileContent).digest("hex").slice(0, 16),
    scannerVerdict: findings.length > 0 ? "warn" : "clean",
  });

  const isFact = (FACT_TYPES as readonly string[]).includes(opts.type);
  if (isFact) {
    const dir = paths.factsDir(scope);
    mkdirSync(dir, { recursive: true });
    const seedMs = Date.parse(now);
    const path = join(dir, factFilename(newFactId(Number.isNaN(seedMs) ? undefined : seedMs)));
    writeFileSync(path, fileContent);
    emitCreated();
    return { path, scope, slug, kind: "fact" };
  }

  const dir = paths.scopeDir(scope);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug}.md`);
  try {
    writeFileSync(path, fileContent, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new NoteExistsError(path);
    throw e;
  }
  emitCreated();
  return { path, scope, slug, kind: "note" };
}
