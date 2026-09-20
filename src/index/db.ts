import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { DEFAULT_EMBEDDING_DIM } from "../embeddings.js";

export type Db = Database.Database;

export function applySchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engrams (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      importance INTEGER NOT NULL,
      created TEXT NOT NULL,
      description TEXT NOT NULL,
      path TEXT NOT NULL,
      snippet TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      UNIQUE(scope, slug)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_engrams USING vec0(embedding float[${DEFAULT_EMBEDDING_DIM}]);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_engrams USING fts5(description, body);
    CREATE TABLE IF NOT EXISTS hot_state (
      scope TEXT NOT NULL,
      slug TEXT NOT NULL,
      last_access TEXT NOT NULL,
      access_count INTEGER NOT NULL,
      strength REAL NOT NULL,
      retention REAL NOT NULL,
      PRIMARY KEY (scope, slug)
    );
    CREATE TABLE IF NOT EXISTS file_state (
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  addMissingColumns(db);
}

/**
 * Adds columns that a `CREATE TABLE IF NOT EXISTS` can never add to an index
 * that already exists.
 *
 * The index is derived and disposable, so the alternative was to drop and
 * rebuild it on any schema change. That is a minutes-long reindex and a call to
 * the embedder for every note, to add one column whose default is right for
 * every row already there: a note nobody has touched is active. Cheap and
 * correct beats dramatic.
 */
function addMissingColumns(db: Db): void {
  const columns = (db.prepare("PRAGMA table_info(engrams)").all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes("status")) {
    db.exec("ALTER TABLE engrams ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * Width the vector table was created at, or undefined when there is no table.
 *
 * Read from the live schema rather than from `meta`, because the schema is the
 * thing an insert is actually checked against: a store written before the
 * dimension was tracked, or one whose meta row was lost, still answers
 * truthfully here.
 */
export function vectorIndexDim(db: Db): number | undefined {
  const row = db.prepare("select sql from sqlite_master where name = 'vec_engrams'").get() as
    | { sql: string | null }
    | undefined;
  const m = row?.sql?.match(/float\s*\[\s*(\d+)\s*\]/i);
  return m ? Number(m[1]) : undefined;
}

/**
 * Drop and recreate the vector table at the given embedding dimension.
 *
 * `CREATE VIRTUAL TABLE IF NOT EXISTS` never redimensions an existing table, so
 * pointing the store at a model of another width would leave it with a table at
 * the old width and every insert failing. Recreating is safe because the index
 * is disposable by design — `reindex` re-embeds everything.
 */
export function resetVectorIndex(db: Db, dim: number): void {
  db.exec(`DROP TABLE IF EXISTS vec_engrams; CREATE VIRTUAL TABLE vec_engrams USING vec0(embedding float[${dim}]);`);
}

export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  /**
   * Two harnesses (or two sessions) invoke `mneme` concurrently against one
   * store, and every read command also writes: `search`/`context` reindex
   * lazily, `get` reinforces hot state. SQLite permits one writer at a time and
   * the default busy_timeout is 0, so the loser fails INSTANTLY instead of
   * waiting — and `reindex` counts that failure and carries on, leaving a store
   * that silently never got indexed and a SessionStart digest served empty.
   * Every write here is short and bounded, so waiting is always the right
   * answer; this is set per connection, so it belongs in openDb.
   */
  db.pragma("busy_timeout = 5000");
  sqliteVec.load(db);
  applySchema(db);
  return db;
}
