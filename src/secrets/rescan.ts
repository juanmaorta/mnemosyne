// src/secrets/rescan.ts
import { readFileSync } from "node:fs";
import { listEngramFiles, listScopes } from "../index/walk.js";
import { scanForSecrets, type SecretFinding } from "./scanner.js";

/**
 * Detection for what prevention never sees.
 *
 * The write-path gate (`mneme add` / `mneme update`) only inspects content that
 * goes through this tool. A note edited by hand in Obsidian — the normal way
 * these files get touched — never crosses that gate, so a secret pasted there
 * lands in the store unseen. This module re-reads what is already on disk and
 * reports; it NEVER rewrites a note. Repairing someone's memory automatically
 * would be a worse failure than the leak it chased.
 */
export interface StoreFinding extends SecretFinding {
  /** Absolute path of the file the finding came from. */
  path: string;
  scope: string;
}

export interface RescanSummary {
  /** Scopes actually walked, sorted — the echo of `--scope`/`--all`. */
  scopes: string[];
  filesScanned: number;
  filesWithFindings: number;
  rejectCount: number;
  warnCount: number;
  /**
   * Files that could not be read (permissions, a file removed mid-walk). Never
   * fatal, never silent: a file this command could not look at is exactly the
   * one a reader must not assume clean.
   */
  unreadable: string[];
}

export interface RescanOptions {
  /** Defaults to every scope in the store. */
  scopes?: string[];
}

/** A scope named on the command line that has no directory in this store. */
export class UnknownScopeError extends Error {
  constructor(public readonly scope: string, public readonly known: string[]) {
    super(
      `unknown scope '${scope}' in this store. Known scopes: ${known.length > 0 ? known.join(", ") : "(none)"}`,
    );
    this.name = "UnknownScopeError";
  }
}

/**
 * Re-scan every engram file of the given scopes, handing each finding to
 * `onFinding` as it is produced.
 *
 * Streaming by callback rather than returning an array is deliberate: a store
 * is walked one file at a time, so peak memory is a single note regardless of
 * how many there are, and a long scan prints as it goes instead of after.
 */
export function rescanStore(
  root: string,
  onFinding: (finding: StoreFinding) => void,
  opts: RescanOptions = {},
): RescanSummary {
  const known = listScopes(root).sort();
  let scopes: string[];
  if (opts.scopes === undefined) {
    scopes = known;
  } else {
    // A typo'd scope reporting "0 files, clean" is the one failure mode a
    // security tool cannot have: refuse instead of reassuring.
    for (const s of opts.scopes) {
      if (!known.includes(s)) throw new UnknownScopeError(s, known);
    }
    scopes = [...new Set(opts.scopes)].sort();
  }

  const summary: RescanSummary = {
    scopes,
    filesScanned: 0,
    filesWithFindings: 0,
    rejectCount: 0,
    warnCount: 0,
    unreadable: [],
  };

  // Sorted so two runs over the same store print the same report; readdir order
  // is not guaranteed, and a diffable report is half the value of a re-scan.
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
    const findings = scanForSecrets(text);
    if (findings.length === 0) continue;
    summary.filesWithFindings++;
    for (const f of findings) {
      if (f.severity === "reject") summary.rejectCount++;
      else summary.warnCount++;
      onFinding({ ...f, path: file.path, scope: file.scope });
    }
  }
  return summary;
}

/** Findings are ordered by file, so the report line carries the file itself. */
export function formatStoreFinding(f: StoreFinding): string {
  return `${f.severity}  ${f.pattern}  ${f.path}:${f.line}  ${f.masked}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function formatRescanSummary(s: RescanSummary): string {
  const scopes = s.scopes.length > 0 ? s.scopes.join(", ") : "(no scopes)";
  const lines = [
    `scanned ${plural(s.filesScanned, "file", "files")} in ${scopes} — ${s.rejectCount} reject, ${s.warnCount} warn in ${plural(s.filesWithFindings, "file", "files")}`,
  ];
  if (s.unreadable.length > 0) {
    lines.push(`  ${s.unreadable.length} file(s) could not be read and were NOT scanned:`);
    for (const p of s.unreadable) lines.push(`    ${p}`);
  }
  if (s.rejectCount > 0) {
    // Say what this command deliberately does not do, where the reader is.
    lines.push(`  read-only: nothing was rewritten. Edit the files above by hand, then re-run.`);
  }
  return lines.join("\n");
}
