// src/compliance/lint.ts
//
// Compliance-lint (MNE-47): detection for a leak that prevention never sees.
//
// A personal note that quotes a client entity is a scope leak, and the write
// path cannot catch it — a note edited by hand never crosses the gate, and the
// gate does not know what belongs to a client anyway. This re-reads a target
// scope (default `personal`) and matches its text against EXPLICITLY-configured
// client entities (literal terms and/or regex), with no LLM. It is read-only: it
// reports a location and a MASKED value and NEVER rewrites a note — repairing
// someone's memory automatically would be a worse failure than the leak.
//
// Independent of synthesis. Reuses the store-walk surface of the secrets re-scan
// (MNE-48) without duplicating that scanner: this looks for client entities, not
// secrets.
import { readFileSync, readdirSync } from "node:fs";
import { listEngramFiles, listScopes } from "../index/walk.js";
import { storePaths } from "../store.js";
import { UnknownScopeError } from "../secrets/rescan.js";

/**
 * One client entity to look for. `label` is a NON-sensitive name of the client
 * scope/entity, safe to print in a report; `terms` and `patterns` ARE the
 * sensitive matter and are never echoed unmasked.
 */
export interface ComplianceRule {
  label: string;
  /** Literal terms, matched case-insensitively on ASCII word boundaries. */
  terms?: string[];
  /** Regex sources, matched case-insensitively and globally. */
  patterns?: string[];
}

export interface ComplianceConfig {
  rules: ComplianceRule[];
}

export interface ComplianceFinding {
  /** The client scope/entity that leaked — the only safe-to-print identifier. */
  label: string;
  kind: "term" | "pattern";
  path: string;
  scope: string;
  line: number;
  /** Masked matched text — the sensitive value is never echoed in full. */
  masked: string;
}

export interface ComplianceSummary {
  /** Scopes actually walked, sorted — the echo of the request. */
  scopes: string[];
  filesScanned: number;
  filesWithFindings: number;
  findings: number;
  /** Files that could not be read, and so were NOT scanned (never silent). */
  unreadable: string[];
}

export interface ComplianceOptions {
  /** Target scopes; defaults to `personal`. */
  scopes?: string[];
}

/** An invalid configuration is an error, never a clean scan. */
export class ComplianceConfigError extends Error {
  constructor(message: string) {
    super(`invalid compliance config: ${message}`);
    this.name = "ComplianceConfigError";
  }
}

interface CompiledRule {
  label: string;
  kind: "term" | "pattern";
  re: RegExp;
}

const DEFAULT_TARGET_SCOPE = "personal";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Reveal a short prefix only; the full value is in the note at the reported line. */
function maskMatch(matched: string): string {
  const flat = matched.replace(/\s+/g, " ").trim();
  return flat.length <= 3 ? "****" : `${flat.slice(0, 2)}…****`;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * Validate and compile a config into ready-to-run matchers. Fails loudly on an
 * empty rule set, a rule with no label, a rule with neither terms nor patterns,
 * or a pattern that is not a valid regex — none of which may degrade into a
 * silent "clean" scan.
 */
export function compileComplianceConfig(config: ComplianceConfig): CompiledRule[] {
  if (!config || !Array.isArray(config.rules) || config.rules.length === 0) {
    throw new ComplianceConfigError("at least one rule is required");
  }
  const compiled: CompiledRule[] = [];
  for (const rule of config.rules) {
    // The config crosses a JSON boundary; a TypeScript cast is not runtime
    // validation. A non-object rule, or a string where an array is expected
    // (terms: "Acme" would otherwise compile as four single-char terms and let a
    // real leak pass), must be rejected — never degraded into a quiet scan.
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      throw new ComplianceConfigError("every rule must be an object");
    }
    if (typeof rule.label !== "string" || rule.label.trim() === "") {
      throw new ComplianceConfigError("every rule needs a non-empty label");
    }
    if (rule.terms !== undefined && !Array.isArray(rule.terms)) {
      throw new ComplianceConfigError(`rule '${rule.label}': terms must be an array`);
    }
    if (rule.patterns !== undefined && !Array.isArray(rule.patterns)) {
      throw new ComplianceConfigError(`rule '${rule.label}': patterns must be an array`);
    }
    const terms = rule.terms ?? [];
    const patterns = rule.patterns ?? [];
    if (terms.length === 0 && patterns.length === 0) {
      throw new ComplianceConfigError(`rule '${rule.label}' has neither terms nor patterns`);
    }
    for (const term of terms) {
      if (typeof term !== "string" || term.trim() === "") {
        throw new ComplianceConfigError(`rule '${rule.label}' has an empty term`);
      }
      // ASCII word boundaries: a term matches a whole word, not a fragment of
      // another (so 'acme' does not fire on 'acmecorp'). Predictable, not exact.
      compiled.push({ label: rule.label, kind: "term", re: new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`, "gi") });
    }
    for (let i = 0; i < patterns.length; i++) {
      const source = patterns[i];
      if (typeof source !== "string" || source === "") {
        throw new ComplianceConfigError(`rule '${rule.label}' has an empty pattern`);
      }
      try {
        compiled.push({ label: rule.label, kind: "pattern", re: new RegExp(source, "gi") });
      } catch {
        // The source may itself be a client entity — never echo it. Reference it
        // by position, and keep the underlying regex error out of the message too.
        throw new ComplianceConfigError(`rule '${rule.label}' has an invalid regex at pattern index ${i}`);
      }
    }
  }
  return compiled;
}

/** The finding fields produced from text alone, before the file is known. */
type TextFinding = Pick<ComplianceFinding, "label" | "kind" | "line" | "masked">;

/** Scan one note's text against the compiled rules. Pure; no filesystem. */
export function scanTextForCompliance(text: string, compiled: CompiledRule[]): TextFinding[] {
  const findings: TextFinding[] = [];
  for (const rule of compiled) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      findings.push({
        label: rule.label,
        kind: rule.kind,
        line: lineOf(text, m.index),
        masked: maskMatch(m[0]),
      });
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++; // guard zero-width matches
    }
  }
  // Deterministic order: by line, then label, then kind — a diffable report.
  return findings.sort((a, b) => a.line - b.line || a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind));
}

/**
 * Re-scan every engram file of the target scopes, streaming each finding to
 * `onFinding`. A scope named that has no directory in this store is an error
 * (reusing the secrets re-scan's `UnknownScopeError`), never a silent clean.
 */
export function complianceLintStore(
  root: string,
  config: ComplianceConfig,
  onFinding: (finding: ComplianceFinding) => void,
  opts: ComplianceOptions = {},
): ComplianceSummary {
  const compiled = compileComplianceConfig(config); // validate before walking
  const known = listScopes(root).sort();
  const requested = opts.scopes ?? [DEFAULT_TARGET_SCOPE];
  for (const s of requested) {
    if (!known.includes(s)) throw new UnknownScopeError(s, known);
  }
  const scopes = [...new Set(requested)].sort();

  const summary: ComplianceSummary = { scopes, filesScanned: 0, filesWithFindings: 0, findings: 0, unreadable: [] };

  // `listEngramFiles` turns a directory it cannot read into an empty list, which
  // would make an unreadable scope look clean. Probe each target directory first
  // and record an access failure as unreadable — an ABSENT facts dir (ENOENT) is
  // normal and not an error, but a permission failure makes the scan incomplete.
  const paths = storePaths(root);
  for (const scope of scopes) {
    for (const dir of [paths.scopeDir(scope), paths.factsDir(scope)]) {
      try {
        readdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") summary.unreadable.push(dir);
      }
    }
  }

  const files = listEngramFiles(root, scopes).sort((a, b) => a.path.localeCompare(b.path));
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file.path, "utf8");
    } catch {
      summary.unreadable.push(file.path);
      continue;
    }
    summary.filesScanned++;
    const found = scanTextForCompliance(text, compiled);
    if (found.length === 0) continue;
    summary.filesWithFindings++;
    for (const f of found) {
      summary.findings++;
      onFinding({ ...f, path: file.path, scope: file.scope });
    }
  }
  return summary;
}

export function formatComplianceFinding(f: ComplianceFinding): string {
  // Only the label and matcher kind are printed; the matched value is masked and
  // the (possibly sensitive) regex source is never surfaced.
  return `${f.label}  ${f.kind}  ${f.path}:${f.line}  ${f.masked}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function formatComplianceSummary(s: ComplianceSummary): string {
  const scopes = s.scopes.length > 0 ? s.scopes.join(", ") : "(no scopes)";
  const lines = [
    `scanned ${plural(s.filesScanned, "file", "files")} in ${scopes} — ${plural(s.findings, "finding", "findings")} in ${plural(s.filesWithFindings, "file", "files")}`,
  ];
  if (s.unreadable.length > 0) {
    lines.push(`  ${s.unreadable.length} file(s) could not be read and were NOT scanned:`);
    for (const p of s.unreadable) lines.push(`    ${p}`);
  }
  if (s.findings > 0) {
    lines.push("  read-only: nothing was rewritten. Review the files above by hand.");
  }
  return lines.join("\n");
}
