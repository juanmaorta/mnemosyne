// src/dreaming/apply.reindex.test.ts
//
// MNE-56: integration check that a derived note applied by `mneme dream apply`
// becomes retrievable through the real reindex + search path, and that a revert
// leaves NO stale rows or vectors behind — not a new subsystem, the acceptance
// criterion of apply (MNE-46) exercised end to end: apply → reindex → search →
// revert → reindex. Runs against an ephemeral store with the fake embedder, the
// same one the CLI uses under MNEMOSYNE_FAKE_EMBED=1, so index and query agree.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../cli.js";
import { buildPlan, persistPlan } from "./plan.js";
import { openDb } from "../index/db.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { search } from "../retrieval/search.js";
import { systemClock } from "../clock.js";

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });

// The derived note's text and query share this topic so a hit proves indexing,
// not luck. The source note carries the same terms (it is the material the
// synthesis is drawn from), which is realistic for a dreaming derivative.
const TOPIC = "riego de plantas de interior en maceta";

function storeWithPlan(runId = "run-1"): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-apply-reindex-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns: ["personal"] }));
  writeFileSync(join(root, "personal", "src-a.md"),
    ["---", "name: src-a", `description: ${TOPIC}`, "scope: personal", "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", `cuerpo sobre ${TOPIC}`, ""].join("\n"));
  const plan = buildPlan({
    root, scope: "personal", model: { id: "m" }, now: "2026-06-10T09:00:00", runId,
    proposals: [{ slug: "dream-a", type: "reference", description: `síntesis sobre ${TOPIC}`,
      importance: 6, sources: ["src-a"], body: `nota derivada: ${TOPIC}` }],
  });
  persistPlan(root, plan);
  return root;
}

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const o: string[] = []; const e: string[] = [];
  return runCli(args, (s) => o.push(s), (s) => e.push(s)).then((code) => ({ code, out: o.join("\n"), err: e.join("\n") }));
}

async function slugsFor(root: string, query: string): Promise<string[]> {
  const db = openDb(join(root, ".index", "store.db"));
  const hits = await search(
    { db, root, embedder: createFakeEmbedder(), clock: systemClock },
    { query, minCos: -1, k: 10 },
  );
  const slugs = hits.map((h) => h.slug);
  db.close();
  return slugs;
}

function indexCounts(root: string): { engrams: number; vec: number; fts: number; derivedRows: number; derivedFileState: number } {
  const db = openDb(join(root, ".index", "store.db"));
  const one = (sql: string, ...p: unknown[]): number =>
    (db.prepare(sql).get(...p) as { n: number }).n;
  const counts = {
    engrams: one("select count(*) as n from engrams"),
    vec: one("select count(*) as n from vec_engrams"),
    fts: one("select count(*) as n from fts_engrams"),
    derivedRows: one("select count(*) as n from engrams where slug = ?", "dream-a"),
    derivedFileState: one("select count(*) as n from file_state where path = ?", join(root, "personal", "dream-a.md")),
  };
  db.close();
  return counts;
}

describe("MNE-56 — reindex round-trip for dream apply/revert", () => {
  test("apply makes the derived note retrievable through search", async () => {
    const root = storeWithPlan();

    const r = await run(["consolidate", "apply", "--run", "run-1", "--scope", "personal", "--root", root, "--apply"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(true);

    // The CLI reindexed after applying; the note must now surface from the index.
    expect(await slugsFor(root, TOPIC)).toContain("dream-a");
  });

  test("revert removes the note and leaves no stale rows or vectors", async () => {
    const root = storeWithPlan();
    await run(["consolidate", "apply", "--run", "run-1", "--scope", "personal", "--root", root, "--apply"]);
    expect(await slugsFor(root, TOPIC)).toContain("dream-a");

    const r = await run(["consolidate", "revert", "--run", "run-1", "--scope", "personal", "--root", root, "--apply"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(false);

    // Gone from search...
    expect(await slugsFor(root, TOPIC)).not.toContain("dream-a");

    // ...and gone from the index: no orphan engram/vec/fts/file_state row. The
    // source note remains, so counts settle at exactly one, with vec and fts
    // in lockstep (a stranded vector would show as vec > engrams).
    const c = indexCounts(root);
    expect(c.derivedRows).toBe(0);
    expect(c.derivedFileState).toBe(0);
    expect(c.engrams).toBe(1);
    expect(c.vec).toBe(c.engrams);
    expect(c.fts).toBe(c.engrams);
  });
});
