import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { recordAccess } from "../hotstate.js";
import { rankContext, selectWithinBudget, formatContextDigest, type ContextEntry } from "./context.js";

function note(root: string, slug: string, importance: number, desc: string, created = "2026-06-01T10:00:00") {
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, "personal", `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${desc}`, "scope: personal", "type: reference",
      `created: ${created}`, `importance: ${importance}`, "---", `body ${slug}`, ""].join("\n"));
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

  test("rankContext_ties_break_by_created_then_slug", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-ctx-"));
    mkdirSync(join(root, ".index"), { recursive: true });
    // Adversarial naming: files are created (and read back by readdir) in
    // alphabetical order — abc, yankee, zulu — which is the OPPOSITE of the
    // expected created-desc order. A naive stable sort on tied scores would
    // preserve that alphabetical/insertion order (abc, yankee, zulu) and this
    // assertion would fail; only an explicit created-desc/slug-asc tie-break
    // produces the expected order below.
    note(root, "abc", 5, "oldest", "2026-01-01T10:00:00");
    note(root, "yankee", 5, "newest, slug y", "2026-06-01T10:00:00");
    note(root, "zulu", 5, "newest, slug z", "2026-06-01T10:00:00");
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    const ranked = rankContext(db, root, "personal", Date.parse("2026-06-01T10:00:00Z"));

    expect(ranked.map((e) => e.slug)).toEqual(["yankee", "zulu", "abc"]);
  });

  test("rankContext_accessed_long_ago_ranks_below_never_accessed", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-ctx-"));
    mkdirSync(join(root, ".index"), { recursive: true });
    note(root, "never-accessed", 5, "never accessed");
    note(root, "accessed-long-ago", 5, "accessed long ago");
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    const nowMs = Date.parse("2026-06-01T10:00:00Z");
    const oldAccess = new Date(nowMs - 40 * 24 * 3600 * 1000).toISOString();
    recordAccess(db, root, "personal", "accessed-long-ago", oldAccess);

    const ranked = rankContext(db, root, "personal", nowMs);

    expect(ranked.map((e) => e.slug)).toEqual(["never-accessed", "accessed-long-ago"]);
  });
});

describe("selectWithinBudget", () => {
  const e = (slug: string, description: string): ContextEntry => ({ slug, scope: "personal", description, score: 1, created: "2026-06-01T10:00:00" });
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
    const out = formatContextDigest([{ slug: "yogurtera", scope: "personal", description: "control MQTT", score: 1, created: "2026-06-01T10:00:00" }], "personal", 0);
    expect(out).toContain("- [yogurtera] control MQTT");
    expect(out).toContain("mneme search");
    expect(out).toContain("scope: personal");
  });
  test("formatContextDigest_starved_budget_does_not_claim_scope_is_empty", () => {
    const out = formatContextDigest([], "acme", 5);
    expect(out).toContain("none fit the token budget");
    expect(out).not.toContain("no memory");
  });
  test("formatContextDigest_empty_scope_still_has_hint", () => {
    const out = formatContextDigest([], "personal", 0);
    expect(out).toContain("mneme search");
    expect(out).toContain("no memory in this scope yet");
  });
});
