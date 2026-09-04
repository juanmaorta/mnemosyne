// src/concurrency.test.ts
//
// Two harnesses (Claude Code + OpenCode, say) each invoke the `mneme` binary as
// a short-lived process against ONE store. The markdown layer is safe by
// construction — notes are created with O_EXCL, facts are ULID-named, nothing is
// mutated in place — but the SQLite index has exactly one writer lock, so these
// tests exercise the only layer that can actually lose data under concurrency.
//
// They must run as real child processes: better-sqlite3 is synchronous, so two
// connections inside one process cannot contend the way two processes do (the
// holder can never release while the waiter blocks).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist", "bin", "mneme.js");

/** Newest mtime under src/, so a stale dist is rebuilt instead of silently tested. */
function newestSrcMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSrcMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

beforeAll(async () => {
  const built = existsSync(cli) ? statSync(cli).mtimeMs : 0;
  if (built < newestSrcMtime(join(repoRoot, "src"))) {
    await execFileAsync("npm", ["run", "build"], { cwd: repoRoot });
  }
}, 180_000);

const ENGRAMS = 40;

/** A store of `ENGRAMS` notes and a COLD index — every process races to index all of them. */
function coldStore(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-conc-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  for (let i = 0; i < ENGRAMS; i++) {
    const slug = `nota-${String(i).padStart(2, "0")}`;
    writeFileSync(join(root, "personal", `${slug}.md`),
      ["---", `name: ${slug}`, `description: ${slug} sobre riego y plantas`, "scope: personal",
        "type: reference", "created: 2026-06-01T10:00:00", "importance: 5", "---",
        `cuerpo de ${slug} con texto suficiente para embeber`, ""].join("\n"));
  }
  return root;
}

/** Run K copies of one command at once, as the two harnesses would. */
function race(k: number, args: string[]): Promise<{ stdout: string; stderr: string }[]> {
  return Promise.all(Array.from({ length: k }, () =>
    execFileAsync(process.execPath, [cli, ...args], {
      env: { ...process.env, MNEMOSYNE_FAKE_EMBED: "1" },
    })));
}

describe("concurrent harnesses on one store", () => {
  test("concurrent_reindex_indexes_every_engram_without_swallowed_errors", async () => {
    const root = coldStore();

    const runs = await race(8, ["reindex", "--root", root]);

    // reindex counts a failed upsert and carries on, so a lock storm surfaces
    // here and nowhere else: exit 0, empty stderr, and a store that never got
    // indexed. No run may report an error, and the store must end up complete.
    for (const { stdout } of runs) expect(stdout).toMatch(/errors 0$/m);
    const { stdout: after } = await execFileAsync(process.execPath, [cli, "search", "riego plantas", "--root", root, "-k", String(ENGRAMS)],
      { env: { ...process.env, MNEMOSYNE_FAKE_EMBED: "1" } });
    // Deduped: a hit prints both the slug and a description containing it.
    expect(new Set(after.match(/nota-\d\d/g)).size).toBe(ENGRAMS);
  }, 120_000);

  test("concurrent_context_never_serves_a_truncated_digest", async () => {
    const root = coldStore();

    // --budget is set far above the store so truncation can only come from lock
    // loss, never from the token budget legitimately cutting the tail.
    const runs = await race(8, ["context", "--root", root, "--budget", "100000"]);

    // The SessionStart path swallows every failure to avoid breaking session
    // start, so a losing process serves a SHORT OR EMPTY digest with exit 0 —
    // the session simply begins with no memory and nobody is told.
    for (const { stdout } of runs) {
      expect(stdout).not.toMatch(/no memory in this scope yet/);
      expect(stdout.match(/^- \[nota-\d\d\]/gm)?.length ?? 0).toBe(ENGRAMS);
    }
  }, 120_000);
});
