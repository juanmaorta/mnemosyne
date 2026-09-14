// src/test-support/ensure-dist.ts
//
// Builds `dist` ONCE, before any test file runs (vitest `globalSetup`).
//
// Several suites spawn the compiled CLI as a real child process, and vitest runs
// test FILES in parallel. A per-file build guard therefore races: two workers
// would run `tsc` into the same output tree while a third `execFile`s
// `dist/bin/mneme.js`, and a reader that catches a half-written emit fails for
// reasons that have nothing to do with what it was testing. Building here makes
// that impossible — a per-file guard still present can only ever find `dist`
// already fresh and do nothing.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Newest mtime under src/, so a stale dist is rebuilt instead of silently tested. */
function newestSrcMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSrcMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

export async function setup(): Promise<void> {
  const cli = join(repoRoot, "dist", "bin", "mneme.js");
  const built = existsSync(cli) ? statSync(cli).mtimeMs : 0;
  // A fresh dist is left alone: this runs before every `vitest`, and rebuilding
  // an up-to-date tree would only add seconds to each run.
  if (built < newestSrcMtime(join(repoRoot, "src"))) {
    await execFileAsync("npm", ["run", "build"], { cwd: repoRoot });
  }
}
