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
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * Every temp directory this run creates, in one place, so `teardown` can delete
 * the lot.
 *
 * 34 of the 37 test files that call `mkdtempSync` never remove what they made,
 * and each store they leave behind carries a SQLite index. Left alone that is
 * half a megabyte per directory, thousands of directories over a few weeks of
 * runs, and eventually a machine with no disk — which is exactly how this was
 * found. Fixing it file by file would work until the next test file forgets;
 * moving `os.tmpdir()` itself makes forgetting harmless, because
 * `mkdtempSync(join(tmpdir(), …))` then lands inside a directory that goes away
 * on its own.
 */
let runTmpDir: string | undefined;

export async function setup(): Promise<void> {
  // Set before any worker starts, so every worker inherits it: `os.tmpdir()`
  // reads these on each call and does not cache.
  runTmpDir = mkdtempSync(join(tmpdir(), "mneme-run-"));
  process.env.TMPDIR = runTmpDir;
  process.env.TMP = runTmpDir;
  process.env.TEMP = runTmpDir;

  const cli = join(repoRoot, "dist", "bin", "mneme.js");
  const built = existsSync(cli) ? statSync(cli).mtimeMs : 0;
  // A fresh dist is left alone: this runs before every `vitest`, and rebuilding
  // an up-to-date tree would only add seconds to each run.
  if (built < newestSrcMtime(join(repoRoot, "src"))) {
    await execFileAsync("npm", ["run", "build"], { cwd: repoRoot });
  }
}

export async function teardown(): Promise<void> {
  // Best-effort: a run that cannot clean up must not turn a green suite red.
  // The directory is named so a human can find and delete it if this fails.
  if (runTmpDir === undefined) return;
  try {
    rmSync(runTmpDir, { recursive: true, force: true });
  } catch {
    // Left on disk under `mneme-run-*`; nothing here is worth failing a run for.
  }
}
