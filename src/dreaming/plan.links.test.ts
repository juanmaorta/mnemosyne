// src/dreaming/plan.links.test.ts
//
// MNE-90: link-gen folded into the dry-run plan. buildPlan accepts proposed
// associative links (from links.ts), validates their endpoints are notes in the
// SAME scope, gives each a stable id, counts them against the budget, renders
// them, and emits telemetry. Application stays in MNE-46 — the plan only
// proposes.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildPlan, renderPlan, dreamPlanEvents, InvalidSourcesError, DEFAULT_BUDGET } from "./plan.js";
import type { ProposedLink } from "./links.js";
import { serializeFrontmatter } from "../frontmatter.js";

const MODEL = { id: "qwen2.5:7b" };
const NOW = "2026-10-04T03:00:00.000Z";

function store(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-planlinks-"));
  mkdirSync(join(root, "personal", "facts"), { recursive: true });
  return root;
}

function writeNote(root: string, scope: string, slug: string): void {
  mkdirSync(join(root, scope), { recursive: true });
  const fm = { name: slug, description: `${slug} desc`, scope, created: "2026-09-01T10:00:00", importance: 5, type: "reference" };
  writeFileSync(join(root, scope, `${slug}.md`), serializeFrontmatter(fm, `body of ${slug}`));
}

function link(a: string, b: string, similarity = 0.95): ProposedLink {
  const slugs: [string, string] = a < b ? [a, b] : [b, a];
  return { slugs, similarity };
}

describe("buildPlan — link proposals", () => {
  test("folds links into the plan with stable ids that repeat across runs", () => {
    const root = store();
    writeNote(root, "personal", "yogurt");
    writeNote(root, "personal", "kefir");
    const links = [link("yogurt", "kefir")];

    const p1 = buildPlan({ root, scope: "personal", model: MODEL, now: NOW, runId: "r1", proposals: [], links });
    expect(p1.links).toHaveLength(1);
    expect(p1.links[0]!.slugs).toEqual(["kefir", "yogurt"]);
    expect(p1.links[0]!.id).toMatch(/^[0-9a-f]{16}$/);

    const p2 = buildPlan({ root, scope: "personal", model: MODEL, now: NOW, runId: "r2", proposals: [], links });
    expect(p2.links[0]!.id).toBe(p1.links[0]!.id); // identity is (scope, pair), not run
  });

  test("a plan with no links option has an empty links array and a 0/limit verdict", () => {
    const root = store();
    const plan = buildPlan({ root, scope: "personal", model: MODEL, now: NOW, runId: "r", proposals: [] });
    expect(plan.links).toEqual([]);
    expect(plan.budgetVerdict.links).toEqual({ proposed: 0, limit: DEFAULT_BUDGET.maxLinks });
  });

  test("rejects a link whose endpoint is not a note in the scope", () => {
    const root = store();
    writeNote(root, "personal", "yogurt");
    // "ghost" has no note file in the scope.
    expect(() =>
      buildPlan({ root, scope: "personal", model: MODEL, now: NOW, runId: "r", proposals: [], links: [link("yogurt", "ghost")] }),
    ).toThrow(InvalidSourcesError);
  });

  test("never accepts an endpoint from another scope", () => {
    const root = store();
    writeNote(root, "personal", "yogurt");
    writeNote(root, "work", "secret"); // exists, but in a DIFFERENT scope
    expect(() =>
      buildPlan({ root, scope: "personal", model: MODEL, now: NOW, runId: "r", proposals: [], links: [link("yogurt", "secret")] }),
    ).toThrow(InvalidSourcesError);
  });

  test("rejects a link endpoint that uses path traversal to escape the scope", () => {
    const root = store();
    writeNote(root, "personal", "yogurt");
    writeNote(root, "work", "secret"); // a real note in another scope
    const traversal = { slugs: ["yogurt", "../work/secret"] as [string, string], similarity: 0.95 };
    expect(() =>
      buildPlan({ root, scope: "personal", model: MODEL, now: NOW, runId: "r", proposals: [], links: [traversal] }),
    ).toThrow(InvalidSourcesError);
  });

  test("counts links against the budget and marks it exceeded", () => {
    const root = store();
    for (const s of ["a", "b", "c", "d"]) writeNote(root, "personal", s);
    const links = [link("a", "b"), link("c", "d")];
    const plan = buildPlan({
      root, scope: "personal", model: MODEL, now: NOW, runId: "r", proposals: [], links,
      budget: { maxNotes: 10, maxNoteChars: 4000, maxLinks: 1 },
    });
    expect(plan.budgetVerdict.links).toEqual({ proposed: 2, limit: 1 });
    expect(plan.budgetVerdict.within).toBe(false);
  });

  test("renderPlan shows the proposed links", () => {
    const root = store();
    writeNote(root, "personal", "yogurt");
    writeNote(root, "personal", "kefir");
    const plan = buildPlan({ root, scope: "personal", model: MODEL, now: NOW, runId: "r", proposals: [], links: [link("yogurt", "kefir")] });
    const rendered = renderPlan(plan);
    expect(rendered).toMatch(/proposed links \(1\)/);
    expect(rendered).toMatch(/kefir.*yogurt|yogurt.*kefir/);
  });

  test("dreamPlanEvents emits a dream.link per link and a link count in dream.run", () => {
    const root = store();
    writeNote(root, "personal", "yogurt");
    writeNote(root, "personal", "kefir");
    const plan = buildPlan({ root, scope: "personal", model: MODEL, now: NOW, runId: "r", proposals: [], links: [link("yogurt", "kefir")] });
    const events = dreamPlanEvents(plan);
    const run = events.find((e) => e.kind === "dream.run")!;
    expect(run.links).toBe(1);
    const linkEvents = events.filter((e) => e.kind === "dream.link");
    expect(linkEvents).toHaveLength(1);
    expect(linkEvents[0]!.slugs).toEqual(["kefir", "yogurt"]);
    expect(linkEvents[0]!.scope).toBe("personal");
  });
});
