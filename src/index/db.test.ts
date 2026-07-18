import { describe, expect, test } from "vitest";
import { openDb, applySchema } from "./db.js";

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
