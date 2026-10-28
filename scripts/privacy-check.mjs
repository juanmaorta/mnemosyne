#!/usr/bin/env node
// Privacy check: fail if any tracked file contains a term from a denylist.
//
// The denylist is deliberately NOT in the repository — a list of the private
// terms to keep out of a public repo would itself publish them. It is read from:
//
//   1. the MNEMOSYNE_PRIVACY_DENYLIST environment variable (CI: a repo secret), or
//   2. `.privacy-denylist.local` at the repository root (local; ignored by git,
//      see .gitignore), or
//   3. `--denylist <file>`, which takes precedence over both.
//
// One case-insensitive regular expression per line (a plain term is a valid
// one; escape `.` and friends when you mean them literally). Blank lines and
// lines starting with `#` are ignored.
//
// With no denylist available — a pull request from a fork gets no secrets — the
// check warns and passes: it is a guard for the maintainers' own pushes, not a
// gate an outside contributor can satisfy.
//
// The output never prints a matched term or the matching line, only
// `path:line` (with any match in the path masked as `***`) and the denylist
// entry number: CI logs of a public repository are
// public, and echoing the term would leak exactly what the check protects.
//
// Usage: node scripts/privacy-check.mjs [--denylist <file>]
// Exit: 0 clean (or no denylist), 1 findings, 2 usage/config error.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { argv, env, exit, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";

export const LOCAL_DENYLIST = ".privacy-denylist.local";

// Internal working documents that are removed from the tree when the repository
// is published (they are history, written against the author's own setup), so
// they are not held to the denylist. Do not add a file here to silence a
// finding: neutralize the finding instead. Entries ending in `/` are directory
// prefixes, entries ending in `*` are filename prefixes, anything else is an
// exact path.
export const EXCLUDED = [
  "docs/tasks.md",
  "docs/plan.md",
  "docs/estado-*",
  "docs/diagnostico-retrieval-*",
  "docs/native-memory-gap.md",
  "docs/superpowers/",
  "docs/integrations/canonical-memory-cutover.md",
];

export function isExcluded(path) {
  return EXCLUDED.some((rule) => {
    if (rule.endsWith("/") || rule.endsWith("*")) return path.startsWith(rule.replace(/\*$/, ""));
    return path === rule;
  });
}

/** Parse denylist text into case-insensitive regexes. Throws on an invalid entry (by number, never by content). */
export function parseDenylist(text) {
  const patterns = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    try {
      patterns.push({ entry: i + 1, re: new RegExp(line, "i") });
    } catch {
      throw new Error(`denylist line ${i + 1} is not a valid regular expression`);
    }
  }
  return patterns;
}

/** Findings for one file's text: [{ line, entry }]. A match in the path itself is reported as line 0. */
export function scanText(path, text, patterns) {
  const findings = [];
  for (const { entry, re } of patterns) if (re.test(path)) findings.push({ line: 0, entry });
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    for (const { entry, re } of patterns) if (re.test(lines[n])) findings.push({ line: n + 1, entry });
  }
  return findings;
}

/** The path with every denylist match masked, so a finding never echoes the term through a file name. */
export function redactPath(path, patterns) {
  let out = path;
  for (const { re } of patterns) out = out.replace(new RegExp(re.source, "gi"), "***");
  return out;
}

function loadDenylist(root, args) {
  const i = args.indexOf("--denylist");
  if (i !== -1) {
    const file = args[i + 1];
    if (!file) throw new Error("--denylist needs a file");
    return { source: "--denylist", text: readFileSync(file, "utf8") };
  }
  if (env.MNEMOSYNE_PRIVACY_DENYLIST && env.MNEMOSYNE_PRIVACY_DENYLIST.trim() !== "") {
    return { source: "MNEMOSYNE_PRIVACY_DENYLIST", text: env.MNEMOSYNE_PRIVACY_DENYLIST };
  }
  const local = join(root, LOCAL_DENYLIST);
  if (existsSync(local)) return { source: LOCAL_DENYLIST, text: readFileSync(local, "utf8") };
  return undefined;
}

function main() {
  const args = argv.slice(2);
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

  let denylist;
  let patterns;
  try {
    denylist = loadDenylist(root, args);
    patterns = denylist ? parseDenylist(denylist.text) : [];
  } catch (e) {
    stderr.write(`privacy-check: ${e.message}\n`);
    return 2;
  }
  if (!denylist || patterns.length === 0) {
    const msg = `no denylist available (set MNEMOSYNE_PRIVACY_DENYLIST or create ${LOCAL_DENYLIST}); skipping the privacy check`;
    stdout.write(env.GITHUB_ACTIONS ? `::warning::${msg}\n` : `privacy-check: ${msg}\n`);
    return 0;
  }

  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && !isExcluded(f));

  let total = 0;
  let scanned = 0;
  for (const file of files) {
    let buf;
    try {
      buf = readFileSync(join(root, file));
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (buf.includes(0)) continue; // binary
    scanned++;
    for (const { line, entry } of scanText(file, buf.toString("utf8"), patterns)) {
      total++;
      stdout.write(`${redactPath(file, patterns)}:${line}: matches denylist entry #${entry}\n`);
    }
  }

  if (total > 0) {
    stdout.write(`privacy-check: ${total} finding(s) in ${scanned} file(s) (denylist: ${denylist.source}, ${patterns.length} entries)\n`);
    return 1;
  }
  stdout.write(`privacy-check: clean — ${scanned} file(s), ${patterns.length} denylist entries (${denylist.source}), ${EXCLUDED.length} excluded path rule(s)\n`);
  return 0;
}

// Run only as a script, so the test suite can import the helpers.
if (argv[1] && import.meta.url === pathToFileURL(realpathSync(argv[1])).href) exit(main());
