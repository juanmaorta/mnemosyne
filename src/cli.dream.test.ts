// src/cli.dream.test.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { buildPlan, persistPlan, dreamsDir } from "./dreaming/plan.js";

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });

function storeWithPlan(runId = "run-1"): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-clidream-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns: ["personal"] }));
  writeFileSync(join(root, "personal", "src-a.md"),
    ["---", "name: src-a", "description: src-a source", "scope: personal", "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", "body src-a", ""].join("\n"));
  const plan = buildPlan({
    root, scope: "personal", model: { id: "m" }, now: "2026-06-10T09:00:00", runId,
    proposals: [{ slug: "dream-a", type: "reference", description: "derived a", importance: 6, sources: ["src-a"], body: "synthesis" }],
  });
  persistPlan(root, plan);
  return root;
}

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const o: string[] = []; const e: string[] = [];
  return runCli(args, (s) => o.push(s), (s) => e.push(s)).then((code) => ({ code, out: o.join("\n"), err: e.join("\n") }));
}

describe("mneme dream apply", () => {
  test("preview (no --apply) writes nothing and shows the plan", async () => {
    const root = storeWithPlan();
    const r = await run(["dream", "apply", "--run", "run-1", "--scope", "personal", "--root", root]);
    expect(r.code).toBe(0);
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(false);
    expect(r.out).toMatch(/dream-a/);
    expect(r.out).toMatch(/--apply/); // tells the user how to commit
  });

  test("--apply writes the derived note and reports it", async () => {
    const root = storeWithPlan();
    const r = await run(["dream", "apply", "--run", "run-1", "--scope", "personal", "--root", root, "--apply"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(true);
    expect(r.out).toMatch(/applied.*dream-a|dream-a/);
  });

  test("preview recomputes the budget for an edited artifact", async () => {
    const root = storeWithPlan();
    const pj = join(dreamsDir(root, "personal"), "run-1.json");
    const t = JSON.parse(readFileSync(pj, "utf8"));
    t.proposals[0].body = "x".repeat(5000); // over the 4000-char cap
    t.budgetVerdict.within = true;           // stale/lying verdict in the artifact
    writeFileSync(pj, JSON.stringify(t));

    const r = await run(["dream", "apply", "--run", "run-1", "--scope", "personal", "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/OVER BUDGET \(recomputed\)/);
  });

  test("preview tolerates a malformed proposal in the artifact", async () => {
    const root = storeWithPlan();
    const pj = join(dreamsDir(root, "personal"), "run-1.json");
    const t = JSON.parse(readFileSync(pj, "utf8"));
    t.proposals = [null, t.proposals[0]]; // a null slipped into the artifact
    writeFileSync(pj, JSON.stringify(t));

    const r = await run(["dream", "apply", "--run", "run-1", "--scope", "personal", "--root", root]);
    expect(r.code).toBe(0); // does not crash renderPlan
    expect(r.out).toMatch(/dream-a/);
  });

  test("preview tolerates a malformed link in the artifact", async () => {
    const root = storeWithPlan();
    const pj = join(dreamsDir(root, "personal"), "run-1.json");
    const t = JSON.parse(readFileSync(pj, "utf8"));
    t.links = [{ slugs: ["only-one"], similarity: "not a number" }]; // malformed link
    writeFileSync(pj, JSON.stringify(t));

    const r = await run(["dream", "apply", "--run", "run-1", "--scope", "personal", "--root", root]);
    expect(r.code).toBe(0); // renderPlan does not crash on the bad link
    expect(r.out).toMatch(/dream-a/);
  });

  test("missing --run is a usage error", async () => {
    const root = storeWithPlan();
    const r = await run(["dream", "apply", "--scope", "personal", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/usage/i);
  });

  test("an unknown run exits non-zero", async () => {
    const root = storeWithPlan();
    const r = await run(["dream", "apply", "--run", "nope", "--scope", "personal", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not found/i);
  });
});

describe("mneme dream revert", () => {
  test("--apply removes the notes the run applied", async () => {
    const root = storeWithPlan();
    await run(["dream", "apply", "--run", "run-1", "--scope", "personal", "--root", root, "--apply"]);
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(true);

    const r = await run(["dream", "revert", "--run", "run-1", "--scope", "personal", "--root", root, "--apply"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(false);
  });

  test("preview (no --apply) shows what it would remove and deletes nothing", async () => {
    const root = storeWithPlan();
    await run(["dream", "apply", "--run", "run-1", "--scope", "personal", "--root", root, "--apply"]);
    const r = await run(["dream", "revert", "--run", "run-1", "--scope", "personal", "--root", root]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/would revert dream-a/);
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(true);
  });

  test("preview of an unknown run exits non-zero", async () => {
    const root = storeWithPlan();
    const r = await run(["dream", "revert", "--run", "nope", "--scope", "personal", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not found/i);
  });
});
