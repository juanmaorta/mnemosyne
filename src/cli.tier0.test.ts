// src/cli.tier0.test.ts
//
// Tier 0 end-to-end (MNE-19): with MNEMOSYNE_EMBEDDER=none the CLI must index
// and search with no embedder at all — no Ollama, no fake — using BM25 over FTS.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { openDb } from "./index/db.js";
import { storePaths } from "./store.js";

let prevEmbedder: string | undefined;
let prevFake: string | undefined;

beforeEach(() => {
  prevEmbedder = process.env.MNEMOSYNE_EMBEDDER;
  prevFake = process.env.MNEMOSYNE_FAKE_EMBED;
  process.env.MNEMOSYNE_EMBEDDER = "none";
  delete process.env.MNEMOSYNE_FAKE_EMBED; // prove it is not leaning on the fake embedder
});

afterEach(() => {
  if (prevEmbedder === undefined) delete process.env.MNEMOSYNE_EMBEDDER; else process.env.MNEMOSYNE_EMBEDDER = prevEmbedder;
  if (prevFake === undefined) delete process.env.MNEMOSYNE_FAKE_EMBED; else process.env.MNEMOSYNE_FAKE_EMBED = prevFake;
});

function storeWith(slug: string): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-tier0-cli-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, "personal", `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${slug} desc`, "scope: personal", "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", `body of ${slug}`, ""].join("\n"));
  return root;
}

describe("tier 0 CLI (MNEMOSYNE_EMBEDDER=none)", () => {
  test("reindex_then_search_without_an_embedder_finds_the_note", async () => {
    const root = storeWith("fermentor");
    const lines: string[] = [];
    const out = (s: string) => lines.push(s);
    expect(await runCli(["reindex", "--root", root], out)).toBe(0);
    // Decisive: this machine may have Ollama running, so a green search alone
    // would not prove tier 0 was used. The absence of vectors proves it: in
    // tier 0 the FTS table is filled but vec_engrams stays empty.
    const db = openDb(storePaths(root).indexDb);
    expect((db.prepare("select count(*) as n from engrams").get() as { n: number }).n).toBe(1);
    expect((db.prepare("select count(*) as n from vec_engrams").get() as { n: number }).n).toBe(0);
    db.close();
    expect(await runCli(["search", "fermentor", "--root", root], out)).toBe(0);
    expect(lines.join("\n")).toMatch(/fermentor/);
  });
});
