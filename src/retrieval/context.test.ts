import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { rankContext, selectWithinBudget, formatContextDigest, type ContextEntry } from "./context.js";

function note(root: string, slug: string, importance: number, desc: string) {
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, "personal", `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${desc}`, "scope: personal", "type: reference",
      "created: 2026-06-01T10:00:00", `importance: ${importance}`, "---", `body ${slug}`, ""].join("\n"));
}

describe("rankContext", () => {
  test("rankContext_orders_by_importance_when_recency_ties", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-ctx-"));
    mkdirSync(join(root, ".index"), { recursive: true });
    note(root, "low", 2, "low importance note");
    note(root, "high", 9, "high importance note");
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    const ranked = rankContext(db, root, "personal", Date.parse("2026-06-01T10:00:00Z"));

    expect(ranked.map((e) => e.slug)).toEqual(["high", "low"]);
    expect(ranked[0]!.description).toBe("high importance note");
  });
});

describe("selectWithinBudget", () => {
  const e = (slug: string, description: string): ContextEntry => ({ slug, scope: "personal", description, score: 1 });
  test("selectWithinBudget_stops_when_budget_exceeded", () => {
    const entries = [e("a", "x".repeat(40)), e("b", "y".repeat(40)), e("c", "z".repeat(40))]; // ~each >10 tokens
    const { included, omitted } = selectWithinBudget(entries, 15);
    expect(included).toHaveLength(1);
    expect(omitted).toBe(2);
  });
  test("selectWithinBudget_includes_all_when_budget_ample", () => {
    const { included, omitted } = selectWithinBudget([e("a", "short"), e("b", "short")], 1000);
    expect(included).toHaveLength(2);
    expect(omitted).toBe(0);
  });
});

describe("formatContextDigest", () => {
  test("formatContextDigest_lists_entries_and_always_appends_hint", () => {
    const out = formatContextDigest([{ slug: "yogurtera", scope: "personal", description: "control MQTT", score: 1 }], "personal", 0);
    expect(out).toContain("- [yogurtera] control MQTT");
    expect(out).toContain("mneme search");
    expect(out).toContain("scope: personal");
  });
  test("formatContextDigest_shows_omitted_count", () => {
    expect(formatContextDigest([], "acme", 5)).toMatch(/no memory in this scope yet|\+5 more/);
  });
  test("formatContextDigest_empty_scope_still_has_hint", () => {
    expect(formatContextDigest([], "personal", 0)).toContain("mneme search");
  });
});
