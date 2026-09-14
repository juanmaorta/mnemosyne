// src/write/validation.ts
//
// The three gates every CLI write goes through — `add`, `update`, import. They
// live here, not in `add.ts`, so no write path can quietly skip one.
import { storePaths } from "../store.js";
import { loadScopeMap, scopeMapPath, resolveScopeStrict } from "../scope/scopemap.js";
import { loadOwnerPolicy, ownsScope } from "../scope/owner.js";
import { scanForSecrets, hasRejectFinding, type SecretFinding } from "../secrets/scanner.js";

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

export interface WriteScopeDeps {
  root: string;
  cwd: string;
  home: string;
}

/**
 * Gate 1 — scope. Fail-closed: an unmapped cwd is refused, never silently
 * defaulted to `personal`, because the scope folder is the compliance boundary.
 */
export function resolveWriteScope(deps: WriteScopeDeps, explicit?: string): string {
  const scope = explicit ?? resolveScopeStrict(loadScopeMap(scopeMapPath(deps.root), deps.home), deps.cwd);
  if (!scope) throw new ScopeUnresolvedError();
  return scope;
}

/** Gate 2 — owner. A machine never materializes a scope it doesn't own. */
export function assertOwnsScope(root: string, scope: string): void {
  if (!ownsScope(loadOwnerPolicy(storePaths(root).ownerPolicy), scope)) throw new NotOwnerError(scope);
}

/**
 * Gate 3 — secrets. Deliberately document-agnostic: callers hand over the FULL
 * text about to hit disk (frontmatter included), so a key pasted into
 * `description` is caught like one in the body. Returns every finding — warn
 * ones included — so the caller can record a scanner verdict; only reject-level
 * findings abort, and they travel masked.
 */
export function assertNoSecrets(text: string): SecretFinding[] {
  const findings = scanForSecrets(text);
  if (hasRejectFinding(findings)) {
    throw new SecretDetectedError(findings.filter((f) => f.severity === "reject"));
  }
  return findings;
}
