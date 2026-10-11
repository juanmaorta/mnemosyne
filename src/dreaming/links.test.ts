// src/dreaming/links.test.ts
//
// MNE-90: link-gen (option 1) — associative links between notes of the SAME
// scope from cosine similarity over a threshold, capped per note. Deterministic:
// it reuses the vectors already in the index, never calls a model, and the same
// inputs always yield the same links in the same order.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, test } from "vitest";
import { selectLinks, proposeLinks, DEFAULT_LINK_PARAMS, type LinkItem } from "./links.js";
import { openDb, type Db } from "../index/db.js";
import { toBlob } from "../index/vecBlob.js";
import { serializeFrontmatter } from "../frontmatter.js";

const NO_EXISTING = new Map<string, Set<string>>();

function item(slug: string, vector: number[]): LinkItem {
  return { slug, vector };
}

/** An in-memory index whose vec table is narrowed to dim 4 for tiny test vectors. */
function freshDb(): Db {
  const db = openDb(":memory:");
  db.exec("DROP TABLE vec_engrams; CREATE VIRTUAL TABLE vec_engrams USING vec0(embedding float[4]);");
  return db;
}

/** Insert an engram row + its note file on disk, and optionally its vector. */
function insertNote(
  db: Db,
  root: string,
  scope: string,
  slug: string,
  type: string,
  vector: number[] | null,
  links?: string[],
): void {
  const fm: Record<string, unknown> = {
    name: slug, description: `${slug} desc`, scope, created: "2026-09-01T10:00:00", importance: 5, type,
    ...(links ? { links } : {}),
  };
  const path = join(root, scope, `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeFrontmatter(fm, `body of ${slug}`));
  const info = db
    .prepare(
      `insert into engrams(slug, scope, type, importance, created, description, path, snippet, mtime, size, hash, status)
       values(?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'h', 'active')`,
    )
    .run(slug, scope, type, 5, fm.created, fm.description, path, `snip ${slug}`);
  if (vector) db.prepare("insert into vec_engrams(rowid, embedding) values(?, ?)").run(BigInt(info.lastInsertRowid as number), toBlob(vector));
}

describe("selectLinks — pure core", () => {
  test("links a pair above the threshold and excludes one below it", () => {
    const items = [item("a", [1, 0]), item("b", [1, 0.05]), item("c", [0, 1])];
    const links = selectLinks(items, NO_EXISTING, { threshold: 0.9, maxPerNote: 5 });
    expect(links).toHaveLength(1);
    expect(links[0]!.slugs).toEqual(["a", "b"]);
    expect(links[0]!.similarity).toBeGreaterThanOrEqual(0.9);
  });

  test("link slugs are canonical (sorted) regardless of input order", () => {
    const items = [item("zeta", [1, 0]), item("alpha", [1, 0.02])];
    const links = selectLinks(items, NO_EXISTING, { threshold: 0.9, maxPerNote: 5 });
    expect(links[0]!.slugs).toEqual(["alpha", "zeta"]);
  });

  test("never proposes a self-link", () => {
    const links = selectLinks([item("solo", [1, 0])], NO_EXISTING, { threshold: 0.5, maxPerNote: 5 });
    expect(links).toEqual([]);
  });

  test("respects the per-note cap, keeping the highest-similarity edges", () => {
    // a is close to b (closest), c, d; with a cap of 1 the greedy pass takes the
    // strongest edge a-b, then the strongest remaining non-saturated pair c-d.
    const items = [item("a", [1, 0]), item("b", [1, 0.01]), item("c", [1, 0.1]), item("d", [1, 0.2])];
    const links = selectLinks(items, NO_EXISTING, { threshold: 0.9, maxPerNote: 1 });
    expect(links.map((l) => l.slugs)).toEqual([["a", "b"], ["c", "d"]]);
  });

  test("skips a pair that is already linked (either direction)", () => {
    const items = [item("a", [1, 0]), item("b", [1, 0.01])];
    const forward = new Map([["a", new Set(["b"])]]);
    expect(selectLinks(items, forward, { threshold: 0.9, maxPerNote: 5 })).toEqual([]);
    const backward = new Map([["b", new Set(["a"])]]);
    expect(selectLinks(items, backward, { threshold: 0.9, maxPerNote: 5 })).toEqual([]);
  });

  test("is deterministic: same inputs, same output order", () => {
    const items = [item("a", [1, 0]), item("b", [1, 0.01]), item("c", [1, 0.1]), item("d", [1, 0.2])];
    const run1 = selectLinks(items, NO_EXISTING, DEFAULT_LINK_PARAMS);
    const run2 = selectLinks(items, NO_EXISTING, DEFAULT_LINK_PARAMS);
    expect(run1).toEqual(run2);
  });

  test("a zero vector never links (undefined cosine treated as no relation)", () => {
    const items = [item("a", [0, 0]), item("b", [1, 0])];
    expect(selectLinks(items, NO_EXISTING, { threshold: 0.1, maxPerNote: 5 })).toEqual([]);
  });

  test("an existing edge consumes a note's degree budget", () => {
    // a is a hub close to both b and c; b and c are orthogonal (never linked).
    const items = [item("a", [1, 1, 0]), item("b", [1, 0, 0]), item("c", [0, 1, 0])];
    // No existing edges: with a cap of 1, a takes exactly one new edge.
    expect(selectLinks(items, NO_EXISTING, { threshold: 0.7, maxPerNote: 1 }).map((l) => l.slugs))
      .toEqual([["a", "b"]]);
    // a already links to c on disk → a is at its cap and proposes nothing new,
    // even though a-b clears the threshold. The cap bounds total degree, not just
    // newly-proposed degree.
    const existing = new Map([["a", new Set(["c"])]]);
    expect(selectLinks(items, existing, { threshold: 0.7, maxPerNote: 1 })).toEqual([]);
  });
});

describe("proposeLinks — index adapter", () => {
  const root = () => mkdtempSync(join(tmpdir(), "mneme-links-"));

  test("links two close notes in a scope, honouring existing links on disk", () => {
    const r = root();
    const db = freshDb();
    insertNote(db, r, "personal", "yogurt", "reference", [1, 0, 0, 0]);
    insertNote(db, r, "personal", "kefir", "reference", [1, 0.05, 0, 0]);
    insertNote(db, r, "personal", "distant", "reference", [0, 1, 0, 0]);
    const links = proposeLinks(db, "personal", { threshold: 0.9, maxPerNote: 5 });
    expect(links.map((l) => l.slugs)).toEqual([["kefir", "yogurt"]]);

    // Now record the link on disk; a re-run proposes nothing new.
    insertNote(db, r, "personal", "kefir2", "reference", [1, 0.05, 0, 0], ["yogurt"]);
    const links2 = proposeLinks(db, "personal", { threshold: 0.9, maxPerNote: 5 });
    expect(links2.some((l) => l.slugs.includes("kefir2"))).toBe(true); // kefir2 links to others
    const yogurtKefir2 = links2.find((l) => l.slugs.includes("kefir2") && l.slugs.includes("yogurt"));
    expect(yogurtKefir2).toBeUndefined(); // but NOT to yogurt — already linked on disk
    db.close();
  });

  test("never links across scopes", () => {
    const r = root();
    const db = freshDb();
    insertNote(db, r, "personal", "note-a", "reference", [1, 0, 0, 0]);
    insertNote(db, r, "work", "note-b", "reference", [1, 0.01, 0, 0]); // identical-ish, other scope
    expect(proposeLinks(db, "personal", { threshold: 0.5, maxPerNote: 5 })).toEqual([]);
    expect(proposeLinks(db, "work", { threshold: 0.5, maxPerNote: 5 })).toEqual([]);
    db.close();
  });

  test("excludes facts from the associative graph", () => {
    const r = root();
    const db = freshDb();
    insertNote(db, r, "personal", "note", "reference", [1, 0, 0, 0]);
    insertNote(db, r, "personal", "a-fact", "feedback", [1, 0.01, 0, 0]);
    expect(proposeLinks(db, "personal", { threshold: 0.5, maxPerNote: 5 })).toEqual([]);
    db.close();
  });

  test("counts existing links from a same-scope note that has no vector", () => {
    // Partial index: c is a note with an on-disk link to a but no embedding.
    // a's total degree must include c→a, so with a cap of 1 a takes no new edge.
    const r = root();
    const db = freshDb();
    insertNote(db, r, "personal", "a", "reference", [1, 0, 0, 0]);
    insertNote(db, r, "personal", "b", "reference", [1, 0.01, 0, 0]);
    insertNote(db, r, "personal", "c", "reference", null, ["a"]); // no vector, links to a
    expect(proposeLinks(db, "personal", { threshold: 0.9, maxPerNote: 1 })).toEqual([]);
    db.close();
  });

  test("tier 0 (no vectors) yields no links", () => {
    const r = root();
    const db = freshDb();
    insertNote(db, r, "personal", "note-a", "reference", null);
    insertNote(db, r, "personal", "note-b", "reference", null);
    expect(proposeLinks(db, "personal", DEFAULT_LINK_PARAMS)).toEqual([]);
    db.close();
  });
});
