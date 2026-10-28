// src/dreaming/plan.test.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildPlan,
  renderPlan,
  persistPlan,
  dreamsDir,
  DEFAULT_BUDGET,
  InvalidSourcesError,
  type ProposedNote,
} from "./plan.js";
import { serializeFrontmatter } from "../frontmatter.js";
import { revisionOf } from "../revision.js";

const MODEL = { id: "qwen2.5:7b" };
const NOW = "2026-10-04T03:00:00.000Z";

/** A store with a scope and some source engrams already on disk. */
function store(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-plan-"));
  mkdirSync(join(root, "personal", "facts"), { recursive: true });
  return root;
}

/** Write an authored note `<scope>/<slug>.md`. */
function writeNote(root: string, scope: string, slug: string, body: string): void {
  const fm = {
    name: slug,
    description: `${slug} desc`,
    scope,
    created: "2026-09-01T10:00:00",
    importance: 5,
    type: "project",
  };
  writeFileSync(join(root, scope, `${slug}.md`), serializeFrontmatter(fm, body));
}

/** Write an append-only fact under a ULID filename, carrying `name: <slug>`. */
function writeFact(root: string, scope: string, slug: string, ulid: string, body: string): void {
  const fm = {
    name: slug,
    description: `${slug} fact`,
    scope,
    created: "2026-09-02T10:00:00",
    importance: 5,
    type: "feedback",
  };
  writeFileSync(join(root, scope, "facts", `${ulid}.md`), serializeFrontmatter(fm, body));
}

function proposal(over: Partial<ProposedNote> = {}): ProposedNote {
  return {
    slug: "deploy-window",
    type: "project",
    description: "when deploys run",
    sources: ["fact-a"],
    body: "Deploys run at 3am UTC on the main cluster.",
    ...over,
  };
}

describe("buildPlan — plan artifact", () => {
  test("records runId, scope, model, sources+revisions and proposals", () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "deploy at 3am");

    const plan = buildPlan({ root, scope: "personal", model: MODEL, now: NOW, runId: "run-1",
      proposals: [proposal()] });

    expect(plan.runId).toBe("run-1");
    expect(plan.scope).toBe("personal");
    expect(plan.model).toEqual(MODEL);
    expect(plan.createdAt).toBe(NOW);
    // The one cited source was read, with the revision of its exact bytes.
    expect(plan.sources).toHaveLength(1);
    const bytes = readFileSync(join(root, "personal", "facts", "01J0000000000000000000000A.md"));
    expect(plan.sources[0]).toMatchObject({ slug: "fact-a", isFact: true, revision: revisionOf(bytes) });
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]).toMatchObject({ slug: "deploy-window", isDuplicate: false });
    expect(plan.proposals[0]!.id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("resolves a cited source that is an authored note", () => {
    const root = store();
    writeNote(root, "personal", "infra", "the infra note body");

    const plan = buildPlan({ root, scope: "personal", model: MODEL, now: NOW,
      proposals: [proposal({ sources: ["infra"] })] });

    expect(plan.sources).toHaveLength(1);
    expect(plan.sources[0]).toMatchObject({ slug: "infra", isFact: false });
  });

  test("dry-run leaves source files byte-identical and writes no index/reinforcement", () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "deploy at 3am");
    const factPath = join(root, "personal", "facts", "01J0000000000000000000000A.md");
    const before = readFileSync(factPath);

    buildPlan({ root, scope: "personal", model: MODEL, now: NOW, proposals: [proposal()] });

    expect(readFileSync(factPath).equals(before)).toBe(true);
    // No store mutation of any kind: no new notes, no index, no telemetry log.
    expect(existsSync(join(root, "personal", "deploy-window.md"))).toBe(false);
    expect(existsSync(join(root, ".index"))).toBe(false);
    expect(existsSync(join(root, ".telemetry", "events-2026-10-04.jsonl"))).toBe(false);
  });

  test("stable identity: same inputs yield the same proposal id", () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "deploy at 3am");

    const a = buildPlan({ root, scope: "personal", model: MODEL, now: NOW, runId: "r1", proposals: [proposal()] });
    const b = buildPlan({ root, scope: "personal", model: MODEL, now: "2026-10-05T03:00:00.000Z", runId: "r2", proposals: [proposal()] });

    expect(a.proposals[0]!.id).toBe(b.proposals[0]!.id);
  });

  test("flags a proposal whose slug already exists as a note (no duplicate creation)", () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "deploy at 3am");
    writeNote(root, "personal", "deploy-window", "an existing note already holds this");

    const plan = buildPlan({ root, scope: "personal", model: MODEL, now: NOW, proposals: [proposal()] });

    expect(plan.proposals[0]!.isDuplicate).toBe(true);
    // A duplicate is not counted as a NEW note against the budget.
    expect(plan.budgetVerdict.notes.proposed).toBe(0);
  });

  test("rejects a cited source missing from the scope", () => {
    const root = store();
    expect(() =>
      buildPlan({ root, scope: "personal", model: MODEL, now: NOW, proposals: [proposal({ sources: ["ghost"] })] }),
    ).toThrow(InvalidSourcesError);
  });

  test("rejects a source that exists only in another scope (scope boundary)", () => {
    const root = store();
    mkdirSync(join(root, "work", "facts"), { recursive: true });
    writeFact(root, "work", "fact-a", "01J0000000000000000000000A", "other scope");

    expect(() =>
      buildPlan({ root, scope: "personal", model: MODEL, now: NOW, proposals: [proposal()] }),
    ).toThrow(InvalidSourcesError);
  });
});

describe("buildPlan — budget verdict", () => {
  test("reports note-count excess without trimming the plan", () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "x");
    const proposals = Array.from({ length: 3 }, (_, i) =>
      proposal({ slug: `note-${i}`, sources: ["fact-a"] }));

    const plan = buildPlan({ root, scope: "personal", model: MODEL, now: NOW,
      budget: { maxNotes: 2, maxNoteChars: 10_000, maxLinks: 20 }, proposals });

    expect(plan.budgetVerdict.within).toBe(false);
    expect(plan.budgetVerdict.notes).toEqual({ proposed: 3, limit: 2 });
    // Not trimmed: every proposal survives for review.
    expect(plan.proposals).toHaveLength(3);
  });

  test("reports an oversize note body without trimming it", () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "x");

    const plan = buildPlan({ root, scope: "personal", model: MODEL, now: NOW,
      budget: { maxNotes: 10, maxNoteChars: 20, maxLinks: 20 },
      proposals: [proposal({ body: "this body is definitely longer than twenty chars" })] });

    expect(plan.budgetVerdict.within).toBe(false);
    expect(plan.budgetVerdict.oversizeNotes).toEqual([
      { slug: "deploy-window", chars: 48, limit: 20 },
    ]);
    expect(plan.proposals[0]!.body).toHaveLength(48);
  });

  test("a plan within both limits is marked within", () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "x");

    const plan = buildPlan({ root, scope: "personal", model: MODEL, now: NOW, proposals: [proposal()] });

    expect(plan.budgetVerdict.within).toBe(true);
    expect(plan.budget).toEqual(DEFAULT_BUDGET);
  });
});

describe("renderPlan", () => {
  test("renders a human-readable diff naming run, scope, sources and new notes", () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "x");

    const plan = buildPlan({ root, scope: "personal", model: MODEL, now: NOW, runId: "run-1", proposals: [proposal()] });
    const text = renderPlan(plan);

    expect(text).toContain("run-1");
    expect(text).toContain("personal");
    expect(text).toContain("qwen2.5:7b");
    expect(text).toContain("deploy-window");
    expect(text).toContain("fact-a");
    expect(text).toMatch(/\+/); // creations shown as additions
  });

  test("announces a budget breach in the rendered report", () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "x");
    const proposals = Array.from({ length: 3 }, (_, i) => proposal({ slug: `n-${i}`, sources: ["fact-a"] }));

    const plan = buildPlan({ root, scope: "personal", model: MODEL, now: NOW,
      budget: { maxNotes: 1, maxNoteChars: 10_000, maxLinks: 20 }, proposals });
    const text = renderPlan(plan);

    expect(text.toLowerCase()).toContain("budget");
  });
});

describe("persistPlan", () => {
  test("writes the plan JSON under .telemetry/dreams/<scope>/<runId>.json", () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "x");

    const plan = buildPlan({ root, scope: "personal", model: MODEL, now: NOW, runId: "run-1", proposals: [proposal()] });
    const path = persistPlan(root, plan);

    expect(path).toBe(join(dreamsDir(root, "personal"), "run-1.json"));
    expect(existsSync(path)).toBe(true);
    const round = JSON.parse(readFileSync(path, "utf8"));
    expect(round.runId).toBe("run-1");
    expect(round.scope).toBe("personal");
    // Scope-namespaced: nothing for personal leaks into another scope's folder.
    expect(readdirSync(dreamsDir(root, "personal"))).toEqual(["run-1.json"]);
  });
});
