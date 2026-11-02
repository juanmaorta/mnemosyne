// src/dreaming/apply.test.ts
//
// MNE-46: apply the reviewed Dreaming plan, reversibly. These scripts build a
// real plan with buildPlan/persistPlan (pure, no model), then apply it against
// an ephemeral store — NEVER the real one. The apply only ever CREATES derived
// notes; it never edits facts or authored notes, never marks originals
// superseded, never archives, and (v1) never writes links.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildPlan, persistPlan, dreamsDir, type ProposedNote } from "./plan.js";
import { revisionOf } from "../revision.js";
import { parseFrontmatter } from "../frontmatter.js";
import { readTelemetry } from "../telemetry/events.js";
import {
  loadPlan,
  applyPlan,
  revertPlan,
  PlanNotFoundError,
  StalePlanError,
  PlanOverBudgetError,
  MalformedPlanError,
} from "./apply.js";

const NOW = "2026-06-10T09:00:00";

/** An owned store with `scope` materialized and the given source notes on disk. */
function store(scope = "personal"): string {
  const root = mkdtempSync(join(tmpdir(), "mne-apply-"));
  mkdirSync(join(root, scope), { recursive: true });
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns: [scope] }));
  return root;
}

function sourceNote(root: string, scope: string, slug: string, body = `body ${slug}`): void {
  writeFileSync(join(root, scope, `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${slug} source`, `scope: ${scope}`, "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", body, ""].join("\n"));
}

function proposal(slug: string, sources: string[], over = false): ProposedNote {
  return {
    slug, type: "reference", description: `derived ${slug}`, importance: 6,
    sources, body: over ? "x".repeat(5000) : `synthesis of ${sources.join(" + ")}`,
  };
}

/** Build + persist a plan over the given proposals, returning its runId. */
function plannedRun(root: string, scope: string, proposals: ProposedNote[], runId = "run-1"): string {
  const plan = buildPlan({ root, scope, model: { id: "test-model" }, now: NOW, proposals, runId });
  persistPlan(root, plan);
  return plan.runId;
}

describe("loadPlan", () => {
  test("reads back exactly what persistPlan wrote", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);

    const plan = loadPlan(root, "personal", runId);
    expect(plan.runId).toBe(runId);
    expect(plan.scope).toBe("personal");
    expect(plan.proposals.map((p) => p.slug)).toEqual(["dream-a"]);
  });

  test("refuses_a_run_id_that_is_not_a_plain_file_name", () => {
    // MNE-115: `--run` becomes a path component under .telemetry/dreams/<scope>/.
    const root = store();
    for (const bad of ["../personal/x", "a/b", "..", ".", ""]) {
      expect(() => loadPlan(root, "personal", bad), bad).toThrow(/run id/i);
      expect(() => revertPlan({ root, now: NOW }, "personal", bad), bad).toThrow(/run id/i);
    }
  });

  test("throws PlanNotFoundError for an unknown run", () => {

    const root = store();
    expect(() => loadPlan(root, "personal", "nope")).toThrow(PlanNotFoundError);
  });

  test("rejects a structurally malformed artifact (proposals not an array)", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    const pj = join(dreamsDir(root, "personal"), `${runId}.json`);
    const t = JSON.parse(readFileSync(pj, "utf8"));
    t.proposals = "not an array";
    writeFileSync(pj, JSON.stringify(t));
    expect(() => loadPlan(root, "personal", runId)).toThrow(MalformedPlanError);
  });

  test("rejects an artifact whose embedded scope/runId differs from the request", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    plannedRun(root, "personal", [proposal("dream-a", ["src-a"])], "run-1");
    // the same plan copied under a different run filename keeps runId "run-1"
    const dir = dreamsDir(root, "personal");
    writeFileSync(join(dir, "run-2.json"), readFileSync(join(dir, "run-1.json"), "utf8"));
    expect(() => loadPlan(root, "personal", "run-2")).toThrow(PlanNotFoundError);
  });
});

describe("applyPlan — creating derived notes", () => {
  test("writes each non-duplicate proposal as a derived note with sources frontmatter", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    sourceNote(root, "personal", "src-b");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a", "src-b"])]);

    const res = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));

    expect(res.applied.map((a) => a.slug)).toEqual(["dream-a"]);
    const path = join(root, "personal", "dream-a.md");
    expect(existsSync(path)).toBe(true);
    const { data } = parseFrontmatter(readFileSync(path, "utf8"));
    expect(data.type).toBe("reference");
    expect(data.sources).toEqual(["src-a", "src-b"]);
    expect(data.created).toBe(NOW);               // stamped at apply time
    expect(data.scope).toBe("personal");
  });

  test("skips a proposal whose slug already exists (no overwrite) and reports it", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    sourceNote(root, "personal", "dream-a"); // slug already taken
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);

    const res = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));

    expect(res.applied).toHaveLength(0);
    expect(res.skipped).toEqual([{ slug: "dream-a", reason: "duplicate" }]);
    // the pre-existing note is untouched — still the original, not the proposal
    const onDisk = readFileSync(join(root, "personal", "dream-a.md"), "utf8");
    expect(onDisk).toContain("dream-a source"); // original description
    expect(onDisk).not.toContain("derived dream-a"); // the proposal never landed
  });

  test("emits a dream.applied event per written note, carrying its scope", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);

    applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));

    const applied = readTelemetry(root).filter((e) => e.kind === "dream.applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ scope: "personal", slug: "dream-a", runId });
  });

  test("refuses a plan whose sources changed since it was built (stale plan)", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    // A human edits the source after the plan was reviewed.
    sourceNote(root, "personal", "src-a", "edited body");

    expect(() => applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId))).toThrow(StalePlanError);
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(false); // nothing written
  });

  test("refuses a plan that is over budget", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    // oversize body → budgetVerdict.within === false
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"], true)]);

    expect(() => applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId))).toThrow(PlanOverBudgetError);
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(false);
  });

  test("recomputes the budget, refusing an artifact hand-edited to smuggle an oversize note", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    // tamper the reviewable JSON: oversize body, but keep the stale within:true
    const pj = join(dreamsDir(root, "personal"), `${runId}.json`);
    const tampered = JSON.parse(readFileSync(pj, "utf8"));
    tampered.proposals[0].body = "x".repeat(5000);
    tampered.budgetVerdict.within = true;
    writeFileSync(pj, JSON.stringify(tampered));

    expect(() => applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId))).toThrow(PlanOverBudgetError);
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(false);
  });

  test("revalidates sources within the selected store (catches a changed source in a copy)", () => {
    const rootA = store();
    sourceNote(rootA, "personal", "src-a", "original source body");
    const runId = plannedRun(rootA, "personal", [proposal("dream-a", ["src-a"])]);
    // the plan copied into another store whose src-a has different content
    const rootB = store();
    sourceNote(rootB, "personal", "src-a", "DIFFERENT content in the copy");
    mkdirSync(dreamsDir(rootB, "personal"), { recursive: true });
    writeFileSync(join(dreamsDir(rootB, "personal"), `${runId}.json`),
      readFileSync(join(dreamsDir(rootA, "personal"), `${runId}.json`), "utf8"));

    expect(() => applyPlan({ root: rootB, now: NOW }, loadPlan(rootB, "personal", runId))).toThrow(StalePlanError);
    expect(existsSync(join(rootB, "personal", "dream-a.md"))).toBe(false);
  });

  test("refuses a proposal whose slug lacks the reserved dream- prefix", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    // a plain (non-derived) slug — retrieval could not recognise it as derived
    const runId = plannedRun(root, "personal", [{ slug: "plain-note", type: "reference", description: "d", importance: 6, sources: ["src-a"], body: "synthesis" }]);

    const res = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    expect(res.applied).toHaveLength(0);
    expect(res.skipped[0]).toMatchObject({ slug: "plain-note", reason: "invalid-schema" });
    expect(existsSync(join(root, "personal", "plain-note.md"))).toBe(false);
  });

  test("refuses a tampered proposal whose type is not a derived-note type", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    const pj = join(dreamsDir(root, "personal"), `${runId}.json`);
    const t = JSON.parse(readFileSync(pj, "utf8"));
    t.proposals[0].type = "feedback"; // would land a synthetic fact at <scope>/<slug>.md
    writeFileSync(pj, JSON.stringify(t));

    const res = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    expect(res.applied).toHaveLength(0);
    expect(res.skipped[0]).toMatchObject({ slug: "dream-a", reason: "invalid-schema" });
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(false);
  });

  test("refuses a tampered proposal that cites a source not in the revalidated manifest", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    const pj = join(dreamsDir(root, "personal"), `${runId}.json`);
    const t = JSON.parse(readFileSync(pj, "utf8"));
    t.proposals[0].sources = ["ghost-source"]; // invented provenance, not in manifest
    writeFileSync(pj, JSON.stringify(t));

    const res = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    expect(res.skipped[0]).toMatchObject({ slug: "dream-a", reason: "invalid-schema" });
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(false);
  });

  test("refuses to write a scope this machine does not own", () => {
    const root = store("personal");
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    writeFileSync(join(root, ".owner"), JSON.stringify({ owns: [] })); // drop ownership

    expect(() => applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId))).toThrow(/own/i);
  });

  test("does not apply links in v1 (they would edit existing notes) and reports them", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    sourceNote(root, "personal", "src-b");
    const plan = buildPlan({
      root, scope: "personal", model: { id: "m" }, now: NOW, runId: "run-links",
      proposals: [proposal("dream-a", ["src-a"])],
      links: [{ slugs: ["src-a", "src-b"], similarity: 0.9 }],
    });
    persistPlan(root, plan);

    const res = applyPlan({ root, now: NOW }, loadPlan(root, "personal", "run-links"));
    expect(res.linksSkipped).toBe(1);
    // the endpoint notes are untouched — no links frontmatter added
    expect(parseFrontmatter(readFileSync(join(root, "personal", "src-a.md"), "utf8")).data.links).toBeUndefined();
  });

  test("records each written note immediately, so the whole run reverts", () => {
    // Notes and their reversal record are durable together (recorded per note),
    // not in one end-of-batch write that could be lost.
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"]), proposal("dream-b", ["src-a"])]);
    applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));

    const rev = revertPlan({ root, now: NOW }, "personal", runId);
    expect(rev.reverted.map((r) => r.slug).sort()).toEqual(["dream-a", "dream-b"]);
  });

  test("never claims an existing note it did not write (no cross-run deletion)", () => {
    // Two runs, same createdAt + identical content → identical bytes. Apply A
    // creates the note; apply B must not adopt it, so reverting B cannot delete it.
    const root = store();
    sourceNote(root, "personal", "src-a");
    persistPlan(root, buildPlan({ root, scope: "personal", model: { id: "m" }, now: NOW, runId: "run-A", proposals: [proposal("dream-x", ["src-a"])] }));
    persistPlan(root, buildPlan({ root, scope: "personal", model: { id: "m" }, now: NOW, runId: "run-B", proposals: [proposal("dream-x", ["src-a"])] }));
    applyPlan({ root, now: NOW }, loadPlan(root, "personal", "run-A"));
    const resB = applyPlan({ root, now: NOW }, loadPlan(root, "personal", "run-B"));
    expect(resB.applied).toHaveLength(0);
    expect(resB.skipped).toEqual([{ slug: "dream-x", reason: "exists" }]);

    // B never wrote dream-x → B has no record → reverting B deletes nothing.
    expect(() => revertPlan({ root, now: NOW }, "personal", "run-B")).toThrow(PlanNotFoundError);
    expect(existsSync(join(root, "personal", "dream-x.md"))).toBe(true);
    // A still owns and can revert its note.
    expect(revertPlan({ root, now: NOW }, "personal", "run-A").reverted.map((r) => r.slug)).toEqual(["dream-x"]);
  });

  test("a human edit before a re-apply is never adopted, so revert keeps it", () => {
    // Guard against the retry hazard: re-applying must not overwrite the record
    // with the edited bytes, or revert would then delete the human's changes.
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    const path = join(root, "personal", "dream-a.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\nhand edit\n"); // human edits it
    applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId)); // retry: exists, differs

    const rev = revertPlan({ root, now: NOW }, "personal", runId);
    expect(rev.reverted).toHaveLength(0);
    expect(rev.kept).toEqual([{ slug: "dream-a", reason: "modified" }]);
    expect(existsSync(path)).toBe(true); // the human's edit survives
  });

  test("a malformed proposal is reported and never aborts the rest of the batch", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-bad", ["src-a"]), proposal("dream-good", ["src-a"])]);
    const pj = join(dreamsDir(root, "personal"), `${runId}.json`);
    const t = JSON.parse(readFileSync(pj, "utf8"));
    t.proposals[0].sources = null; // malformed: would throw on .filter if used unguarded
    writeFileSync(pj, JSON.stringify(t));

    const res = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    expect(res.skipped.find((s) => s.slug === "dream-bad")).toMatchObject({ reason: "invalid-schema" });
    expect(res.applied.map((a) => a.slug)).toEqual(["dream-good"]); // the rest still applies
    expect(existsSync(join(root, "personal", "dream-good.md"))).toBe(true);
  });

  test("a null entry in proposals is reported, not fatal, and the rest still apply", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-good", ["src-a"])]);
    const pj = join(dreamsDir(root, "personal"), `${runId}.json`);
    const t = JSON.parse(readFileSync(pj, "utf8"));
    t.proposals = [null, t.proposals[0]]; // a null slipped into the artifact
    writeFileSync(pj, JSON.stringify(t));

    const res = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    expect(res.applied.map((a) => a.slug)).toEqual(["dream-good"]);
    expect(res.skipped.some((s) => s.reason === "invalid-schema")).toBe(true);
  });

  test("rolls back the note when its reversal record cannot be persisted", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    // make the record path unwritable: a directory where the .applied.json must go,
    // so the atomic rename fails after the note is written
    mkdirSync(join(dreamsDir(root, "personal"), `${runId}.applied.json`), { recursive: true });

    const res = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    expect(res.applied).toHaveLength(0);
    expect(res.skipped[0]).toMatchObject({ slug: "dream-a", reason: "error" });
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(false); // rolled back
  });

  test("a delete-then-reapply of the same run updates the recorded revision so revert works", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    rmSync(join(root, "personal", "dream-a.md")); // deleted out of band
    // the plan is re-reviewed with a changed body, then re-applied
    const pj = join(dreamsDir(root, "personal"), `${runId}.json`);
    const t = JSON.parse(readFileSync(pj, "utf8"));
    t.proposals[0].body = "re-reviewed synthesis";
    writeFileSync(pj, JSON.stringify(t));

    const res = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    expect(res.applied.map((a) => a.slug)).toEqual(["dream-a"]);
    const rev = revertPlan({ root, now: NOW }, "personal", runId);
    expect(rev.reverted.map((r) => r.slug)).toEqual(["dream-a"]); // not reported "modified"
  });

  test("recreating a slug retires an older run's stale claim (no cross-run deletion)", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    persistPlan(root, buildPlan({ root, scope: "personal", model: { id: "m" }, now: NOW, runId: "run-A", proposals: [proposal("dream-x", ["src-a"])] }));
    persistPlan(root, buildPlan({ root, scope: "personal", model: { id: "m" }, now: NOW, runId: "run-B", proposals: [proposal("dream-x", ["src-a"])] }));
    applyPlan({ root, now: NOW }, loadPlan(root, "personal", "run-A"));
    rmSync(join(root, "personal", "dream-x.md")); // A's note deleted out of band; A's record still claims it
    applyPlan({ root, now: NOW }, loadPlan(root, "personal", "run-B")); // B recreates identical bytes

    // B's creation retired A's claim → reverting A cannot delete B's note
    expect(() => revertPlan({ root, now: NOW }, "personal", "run-A")).toThrow(PlanNotFoundError);
    expect(existsSync(join(root, "personal", "dream-x.md"))).toBe(true);
    expect(revertPlan({ root, now: NOW }, "personal", "run-B").reverted.map((r) => r.slug)).toEqual(["dream-x"]);
  });

  test("a failed write is never recorded, so reverting that run cannot delete another run's note", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    persistPlan(root, buildPlan({ root, scope: "personal", model: { id: "m" }, now: NOW, runId: "run-A", proposals: [proposal("dream-x", ["src-a"])] }));
    persistPlan(root, buildPlan({ root, scope: "personal", model: { id: "m" }, now: NOW, runId: "run-B", proposals: [proposal("dream-x", ["src-a"])] }));
    // block run A's write: a directory occupies dream-x.md, so its create fails
    mkdirSync(join(root, "personal", "dream-x.md"), { recursive: true });
    const resA = applyPlan({ root, now: NOW }, loadPlan(root, "personal", "run-A"));
    expect(resA.applied).toHaveLength(0);

    // clear the blocker and let run B create the note for real
    rmSync(join(root, "personal", "dream-x.md"), { recursive: true });
    const resB = applyPlan({ root, now: NOW }, loadPlan(root, "personal", "run-B"));
    expect(resB.applied.map((a) => a.slug)).toEqual(["dream-x"]);

    // run A never created dream-x, so it has no record → reverting A deletes nothing
    expect(() => revertPlan({ root, now: NOW }, "personal", "run-A")).toThrow(PlanNotFoundError);
    expect(existsSync(join(root, "personal", "dream-x.md"))).toBe(true); // B's note survives
  });

  test("a proposal with a malformed id is skipped (would otherwise crash renderPlan)", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"]), proposal("dream-b", ["src-a"])]);
    const pj = join(dreamsDir(root, "personal"), `${runId}.json`);
    const t = JSON.parse(readFileSync(pj, "utf8"));
    delete t.proposals[0].id; // no id → renderPlan's p.id.slice would throw
    writeFileSync(pj, JSON.stringify(t));

    const res = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    expect(res.skipped.find((s) => s.slug === "dream-a")).toMatchObject({ reason: "invalid-schema" });
    expect(res.applied.map((a) => a.slug)).toEqual(["dream-b"]);
  });

  test("a malformed proposal body does not crash budget computation or the batch", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-bad", ["src-a"]), proposal("dream-good", ["src-a"])]);
    const pj = join(dreamsDir(root, "personal"), `${runId}.json`);
    const t = JSON.parse(readFileSync(pj, "utf8"));
    t.proposals[0].body = { not: "a string" }; // would be written as [object Object], or crash budget
    writeFileSync(pj, JSON.stringify(t));

    const res = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    expect(res.skipped.find((s) => s.slug === "dream-bad")).toMatchObject({ reason: "invalid-schema" });
    expect(res.applied.map((a) => a.slug)).toEqual(["dream-good"]);
  });

  test("skips a proposal whose slug is already claimed by a FACT (ULID filename)", () => {
    // A fact never owns `<slug>.md`, so isDuplicate (checks the note file) and
    // O_EXCL both miss it. findSlugClaims catches it, keeping (scope, slug) unique.
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    // a feedback fact already carries name: dream-a
    mkdirSync(join(root, "personal", "facts"), { recursive: true });
    writeFileSync(join(root, "personal", "facts", "01JABCDEF0000000000000FACT.md"),
      ["---", "name: dream-a", "description: a fact with this slug", "scope: personal", "type: feedback",
        "created: 2026-06-01T10:00:00", "importance: 5", "---", "fact body", ""].join("\n"));

    const res = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    expect(res.applied).toHaveLength(0);
    expect(res.skipped[0]).toMatchObject({ slug: "dream-a", reason: "duplicate" });
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(false);
  });

  test("is idempotent: re-applying the same plan writes nothing new", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);

    const first = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    expect(first.applied).toHaveLength(1);
    const second = applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toEqual([{ slug: "dream-a", reason: "exists" }]);
  });
});

describe("revertPlan — bounded, revision-checked reversal", () => {
  test("removes exactly the notes this run applied", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(true);

    const res = revertPlan({ root, now: NOW }, "personal", runId);
    expect(res.reverted.map((r) => r.slug)).toEqual(["dream-a"]);
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(false);
  });

  test("refuses to delete a derived note a human has edited since apply", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    // human edits the derived note after it was applied
    const path = join(root, "personal", "dream-a.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\nhand edit\n");

    const res = revertPlan({ root, now: NOW }, "personal", runId);
    expect(res.reverted).toHaveLength(0);
    expect(res.kept).toEqual([{ slug: "dream-a", reason: "modified" }]);
    expect(existsSync(path)).toBe(true); // not deleted
  });

  test("throws PlanNotFoundError when there is no apply record for the run", () => {
    const root = store();
    expect(() => revertPlan({ root, now: NOW }, "personal", "never-applied")).toThrow(PlanNotFoundError);
  });

  test("never deletes outside the selected store, even with a copied apply record", () => {
    const rootA = store();
    sourceNote(rootA, "personal", "src-a");
    const runId = plannedRun(rootA, "personal", [proposal("dream-a", ["src-a"])]);
    applyPlan({ root: rootA, now: NOW }, loadPlan(rootA, "personal", runId));
    const noteA = join(rootA, "personal", "dream-a.md");
    expect(existsSync(noteA)).toBe(true);

    // the SAME record copied into a different owned store (as copying a store does)
    const rootB = store();
    mkdirSync(dreamsDir(rootB, "personal"), { recursive: true });
    const recA = join(dreamsDir(rootA, "personal"), `${runId}.applied.json`);
    writeFileSync(join(dreamsDir(rootB, "personal"), `${runId}.applied.json`), readFileSync(recA, "utf8"));

    const res = revertPlan({ root: rootB, now: NOW }, "personal", runId);
    expect(res.reverted).toHaveLength(0);          // nothing in B to revert
    expect(existsSync(noteA)).toBe(true);          // A's note is untouched
  });

  test("retires the claim on a note already gone, so a re-revert cannot delete another run's note", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    persistPlan(root, buildPlan({ root, scope: "personal", model: { id: "m" }, now: NOW, runId: "run-A", proposals: [proposal("dream-x", ["src-a"])] }));
    applyPlan({ root, now: NOW }, loadPlan(root, "personal", "run-A"));
    rmSync(join(root, "personal", "dream-x.md")); // the note goes missing out of band

    const rev = revertPlan({ root, now: NOW }, "personal", "run-A");
    expect(rev.kept).toEqual([{ slug: "dream-x", reason: "missing" }]);

    // another run recreates identical bytes at the same slug
    persistPlan(root, buildPlan({ root, scope: "personal", model: { id: "m" }, now: NOW, runId: "run-B", proposals: [proposal("dream-x", ["src-a"])] }));
    applyPlan({ root, now: NOW }, loadPlan(root, "personal", "run-B"));
    // A's claim was retired, so re-reverting A does not touch B's note
    expect(() => revertPlan({ root, now: NOW }, "personal", "run-A")).toThrow(PlanNotFoundError);
    expect(existsSync(join(root, "personal", "dream-x.md"))).toBe(true);
  });

  test("rejects a revert whose record identity does not match the request", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    // run A's record copied under run B's filename
    const dir = dreamsDir(root, "personal");
    writeFileSync(join(dir, "run-B.applied.json"), readFileSync(join(dir, `${runId}.applied.json`), "utf8"));

    expect(() => revertPlan({ root, now: NOW }, "personal", "run-B")).toThrow(PlanNotFoundError);
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(true); // A's note intact
  });

  test("refuses to revert a scope this machine no longer owns", () => {
    const root = store();
    sourceNote(root, "personal", "src-a");
    const runId = plannedRun(root, "personal", [proposal("dream-a", ["src-a"])]);
    applyPlan({ root, now: NOW }, loadPlan(root, "personal", runId));
    writeFileSync(join(root, ".owner"), JSON.stringify({ owns: [] })); // ownership revoked

    expect(() => revertPlan({ root, now: NOW }, "personal", runId)).toThrow(/own/i);
    expect(existsSync(join(root, "personal", "dream-a.md"))).toBe(true); // not deleted
  });
});
