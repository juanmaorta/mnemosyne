import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildPlan, persistPlan, type ProposedNote } from "./plan.js";
import { readTelemetry } from "../telemetry/events.js";
import { fixedClock } from "../clock.js";

const NOW = "2026-10-05T03:00:00.000Z";

/** A store with one real source note so buildPlan's source check passes. */
function storeWithSource(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-dreamtel-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, "personal", "riego-notas.md"),
    ["---", "name: riego-notas", "description: riego", "scope: personal", "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", "cuerpo", ""].join("\n"));
  return root;
}

function proposal(over: Partial<ProposedNote> = {}): ProposedNote {
  return { slug: "dream-abc123", type: "reference", description: "resumen", sources: ["riego-notas"], body: "cuerpo derivado", ...over };
}

describe("persistPlan telemetry", () => {
  test("emits_a_dream_run_and_a_dream_proposal_per_proposal", () => {
    const root = storeWithSource();
    const plan = buildPlan({ root, scope: "personal", model: { id: "fake-model" }, now: NOW, runId: "run-1", proposals: [proposal()] });

    persistPlan(root, plan, fixedClock(Date.parse(NOW)));

    const evs = readTelemetry(root);
    const run = evs.find((e) => e.kind === "dream.run");
    expect(run).toMatchObject({ runId: "run-1", scope: "personal", model: "fake-model", proposals: 1 });

    const prop = evs.find((e) => e.kind === "dream.proposal");
    expect(prop).toMatchObject({ runId: "run-1", scope: "personal", slug: "dream-abc123", isDuplicate: false });
    expect(prop!.sources).toEqual(["riego-notas"]);
  });

  test("every_dream_event_carries_its_scope_so_the_boundary_can_be_enforced", () => {
    const root = storeWithSource();
    const plan = buildPlan({ root, scope: "personal", model: { id: "m" }, now: NOW, runId: "run-2", proposals: [proposal()] });

    persistPlan(root, plan, fixedClock(Date.parse(NOW)));

    const dreamEvents = readTelemetry(root).filter((e) => e.kind.startsWith("dream."));
    expect(dreamEvents.length).toBeGreaterThan(0);
    for (const e of dreamEvents) expect(e.scope).toBe("personal");
  });
});
