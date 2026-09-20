import { describe, expect, test } from "vitest";
import { openDb, applySchema, getMeta, setMeta, resetVectorIndex, vectorIndexDim } from "./db.js";
import { DEFAULT_EMBEDDING_DIM } from "../embeddings.js";

describe("openDb", () => {
  test("openDb_creates_all_tables_and_loads_vec", () => {
    const db = openDb(":memory:");
    const names = db
      .prepare("select name from sqlite_master where type in ('table','view') order by name")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(names).toEqual(expect.arrayContaining(["engrams", "vec_engrams", "fts_engrams", "hot_state", "file_state"]));
    expect(db.prepare("select vec_version() as v").get()).toBeTruthy();
  });

  test("applySchema_is_idempotent", () => {
    const db = openDb(":memory:");
    expect(() => applySchema(db)).not.toThrow(); // second application on same handle
  });

  test("meta_stores_and_upserts_key_values", () => {
    const db = openDb(":memory:");
    expect(getMeta(db, "embedding_id")).toBeUndefined();
    setMeta(db, "embedding_id", "nomic-embed-text/dim768");
    expect(getMeta(db, "embedding_id")).toBe("nomic-embed-text/dim768");
    setMeta(db, "embedding_id", "other/dim768");
    expect(getMeta(db, "embedding_id")).toBe("other/dim768");
  });

  test("resetVectorIndex_rebuilds_the_table_at_the_current_dimension", () => {
    // A model of another width leaves existing DBs holding a vec table
    // at the OLD width: `CREATE VIRTUAL TABLE IF NOT EXISTS` never redimensions
    // it, so every insert would fail. Simulate that stale table and prove the
    // reset restores a usable index.
    const db = openDb(":memory:");
    db.exec("DROP TABLE vec_engrams; CREATE VIRTUAL TABLE vec_engrams USING vec0(embedding float[4]);");
    const wide = Buffer.from(Float32Array.from(new Array(DEFAULT_EMBEDDING_DIM).fill(0.1)).buffer);
    expect(() => db.prepare("insert into vec_engrams(rowid, embedding) values (1, ?)").run(wide)).toThrow();

    resetVectorIndex(db, DEFAULT_EMBEDDING_DIM);

    expect(() => db.prepare("insert into vec_engrams(rowid, embedding) values (1, ?)").run(wide)).not.toThrow();
  });

  test("resetVectorIndex_drops_existing_vectors", () => {
    const db = openDb(":memory:");
    const blob = Buffer.from(Float32Array.from(new Array(DEFAULT_EMBEDDING_DIM).fill(0.1)).buffer);
    db.prepare("insert into vec_engrams(rowid, embedding) values (1, ?)").run(blob);

    resetVectorIndex(db, DEFAULT_EMBEDDING_DIM);

    expect((db.prepare("select count(*) as n from vec_engrams").get() as { n: number }).n).toBe(0);
  });

  test("vec_table_accepts_768_dim_vector", () => {
    const db = openDb(":memory:");
    const blob = Buffer.from(Float32Array.from(new Array(768).fill(0.1)).buffer);
    db.prepare("insert into vec_engrams(rowid, embedding) values (1, ?)").run(blob);
    const dist = db
      .prepare("select vec_distance_cosine(embedding, ?) as d from vec_engrams where rowid = 1")
      .get(blob) as { d: number };
    expect(dist.d).toBeCloseTo(0, 5);
  });
});

describe("vector index width", () => {
  test("vectorIndexDim_reports_the_width_a_fresh_index_was_created_at", () => {
    expect(vectorIndexDim(openDb(":memory:"))).toBe(DEFAULT_EMBEDDING_DIM);
  });

  test("resetVectorIndex_rebuilds_the_table_at_the_requested_dimension", () => {
    // Switching to a 1024-dim model must widen the table; `CREATE VIRTUAL TABLE
    // IF NOT EXISTS` never would, and every insert would fail from then on.
    const db = openDb(":memory:");

    resetVectorIndex(db, 1024);

    expect(vectorIndexDim(db)).toBe(1024);
    const blob = Buffer.from(Float32Array.from(new Array(1024).fill(0.1)).buffer);
    expect(() => db.prepare("insert into vec_engrams(rowid, embedding) values (1, ?)").run(blob)).not.toThrow();
  });
});
