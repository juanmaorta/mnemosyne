import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../index/db.js";
import { reindex } from "../index/reindex.js";
import { createFakeEmbedder } from "../embeddings.fake.js";
import { recordAccess } from "../hotstate.js";
import { rankContext, selectWithinBudget, formatContextDigest, DEFAULT_CONTEXT_MAX_ENTRIES, type ContextEntry } from "./context.js";

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
  test("selectWithinBudget_caps_the_entry_count_even_when_the_token_budget_is_ample", () => {
    // The selectivity guard (MNE-29): a scope with many tiny notes could inject
    // a disproportionate share of itself under the token budget alone (a real
    // case hit 78% of a scope). A hard cap on the NUMBER of lines keeps the
    // ambient digest a handful of lines regardless of how short each one is.
    const entries = Array.from({ length: 5 }, (_, i) => e(`s${i}`, "short"));
    const { included, omitted } = selectWithinBudget(entries, 100_000, 2);
    expect(included.map((x) => x.slug)).toEqual(["s0", "s1"]);
    expect(omitted).toBe(3);
  });
  test("selectWithinBudget_applies_a_default_entry_cap_when_none_is_given", () => {
    const entries = Array.from({ length: DEFAULT_CONTEXT_MAX_ENTRIES + 7 }, (_, i) => e(`s${i}`, "short"));
    const { included, omitted } = selectWithinBudget(entries, 100_000);
    expect(included).toHaveLength(DEFAULT_CONTEXT_MAX_ENTRIES);
    expect(omitted).toBe(7);
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

describe("rankContext and supersession", () => {
  /** A note with the supersession fields already set, written straight to disk. */
  function supersededNote(root: string, slug: string, by: string, importance = 9) {
    mkdirSync(join(root, "personal"), { recursive: true });
    writeFileSync(join(root, "personal", `${slug}.md`),
      ["---", `name: ${slug}`, `description: ${slug} description`, "scope: personal", "type: reference",
        "created: 2026-06-01T10:00:00", `importance: ${importance}`, "status: superseded",
        `superseded_by: ${by}`, "---", `body ${slug}`, ""].join("\n"));
  }

  test("rankContext_leaves_superseded_notes_out_of_the_digest", async () => {
    // The digest is a handful of lines the agent reads before its first turn.
    // A claim that something else has replaced does not belong there, and its
    // importance would otherwise put it at the very top.
    const root = mkdtempSync(join(tmpdir(), "mneme-ctx-sup-"));
    mkdirSync(join(root, ".index"), { recursive: true });
    supersededNote(root, "network-upgrade", "network-upgrade-mesh");
    note(root, "network-upgrade-mesh", 5, "el plan que manda");
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    const ranked = rankContext(db, root, "personal", Date.parse("2026-06-01T10:00:00Z"));

    expect(ranked.map((e) => e.slug)).toEqual(["network-upgrade-mesh"]);
  });

  test("rankContext_keeps_flagged_notes_in_the_digest", async () => {
    // `flagged` is an unresolved contradiction. Hiding it would bury exactly
    // the thing somebody needs to look at.
    const root = mkdtempSync(join(tmpdir(), "mneme-ctx-flag-"));
    mkdirSync(join(root, ".index"), { recursive: true });
    mkdirSync(join(root, "personal"), { recursive: true });
    writeFileSync(join(root, "personal", "dudosa.md"),
      ["---", "name: dudosa", "description: algo que no cuadra", "scope: personal", "type: reference",
        "created: 2026-06-01T10:00:00", "importance: 5", "status: flagged", "---", "body", ""].join("\n"));
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    const ranked = rankContext(db, root, "personal", Date.parse("2026-06-01T10:00:00Z"));

    expect(ranked.map((e) => e.slug)).toEqual(["dudosa"]);
  });
});

describe("rankContext and ephemeral snapshots (MNE-29)", () => {
  /** A dated photo of state, written straight to disk. */
  function snapshot(root: string, slug: string, importance = 9, created = "2026-06-02T10:00:00") {
    mkdirSync(join(root, "personal"), { recursive: true });
    writeFileSync(join(root, "personal", `${slug}.md`),
      ["---", `name: ${slug}`, `description: ${slug} description`, "scope: personal", "type: snapshot",
        `created: ${created}`, `importance: ${importance}`, "---", `body ${slug}`, ""].join("\n"));
  }

  test("rankContext_leaves_snapshots_out_of_the_ambient_digest", async () => {
    // A snapshot is a photo of state, not a durable truth, and it is the single
    // most likely thing to be stale at session start (its own slug is usually
    // dated). Even at importance 9 and newer than the durable note, it must not
    // appear in the ambient digest — it is recalled deliberately via search.
    const root = mkdtempSync(join(tmpdir(), "mneme-ctx-snap-"));
    mkdirSync(join(root, ".index"), { recursive: true });
    note(root, "decision-que-manda", 3, "la decisión durable", "2026-06-01T10:00:00");
    snapshot(root, "estado-2026-06-02", 9, "2026-06-02T10:00:00");
    const db = openDb(join(root, ".index", "store.db"));
    await reindex({ root, db, embedder: createFakeEmbedder(), scopes: ["personal"] });

    const ranked = rankContext(db, root, "personal", Date.parse("2026-06-02T10:00:00Z"));

    expect(ranked.map((e) => e.slug)).toEqual(["decision-que-manda"]);
  });
});
