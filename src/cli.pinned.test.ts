// src/cli.pinned.test.ts — pins end to end through the CLI (MNE-62).
// Tier 0 (MNEMOSYNE_EMBEDDER=none) so the test needs no Ollama.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { openDb } from "./index/db.js";
import { storePaths } from "./store.js";
import { parseFrontmatter } from "./frontmatter.js";

let prevEmbedder: string | undefined;
beforeEach(() => { prevEmbedder = process.env.MNEMOSYNE_EMBEDDER; process.env.MNEMOSYNE_EMBEDDER = "none"; });
afterEach(() => { if (prevEmbedder === undefined) delete process.env.MNEMOSYNE_EMBEDDER; else process.env.MNEMOSYNE_EMBEDDER = prevEmbedder; });

function store(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-cli-pin-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns: ["personal"] }));
  return root;
}

function note(root: string, slug: string, pinned = false): string {
  const fm = ["---", `name: ${slug}`, `description: ${slug} desc`, "scope: personal", "type: reference",
    "created: 2026-06-01T10:00:00", "importance: 5", ...(pinned ? ["pinned: true"] : []), "---", `body of ${slug}`, ""];
  const path = join(root, "personal", `${slug}.md`);
  writeFileSync(path, fm.join("\n"));
  return path;
}

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const o: string[] = []; const e: string[] = [];
  return runCli(args, (s) => o.push(s), (s) => e.push(s)).then((code) => ({ code, out: o.join("\n"), err: e.join("\n") }));
}

describe("mneme pins (MNE-62)", () => {
  test("reindex records the pinned column and stats counts it", async () => {
    const root = store();
    note(root, "keepme", true);
    note(root, "ordinary", false);
    expect((await run(["reindex", "--root", root])).code).toBe(0);

    const db = openDb(storePaths(root).indexDb);
    expect((db.prepare("select count(*) as n from engrams where pinned = 1").get() as { n: number }).n).toBe(1);
    db.close();

    const stats = await run(["stats", "--root", root]);
    expect(stats.code).toBe(0);
    expect(stats.out).toMatch(/pinned.*1/);
  });

  test("update --pinned sets the flag on an existing note", async () => {
    const root = store();
    const path = note(root, "keepme", false);
    const rev = createHash("sha256").update(readFileSync(path)).digest("hex");
    const r = await run(["update", "keepme", "--if-match", rev, "--pinned", "--scope", "personal", "--root", root]);
    expect(r.code).toBe(0);
    expect(parseFrontmatter(readFileSync(path, "utf8")).data.pinned).toBe(true);
  });

  test("--pinned and --unpinned together is an error", async () => {
    const root = store();
    const path = note(root, "keepme", true);
    const rev = createHash("sha256").update(readFileSync(path)).digest("hex");
    const r = await run(["update", "keepme", "--if-match", rev, "--pinned", "--unpinned", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/pinned/i);
  });
});
