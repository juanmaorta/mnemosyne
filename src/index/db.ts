import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { EMBEDDING_DIM } from "../embeddings.js";

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
      UNIQUE(scope, slug)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_engrams USING vec0(embedding float[${EMBEDDING_DIM}]);
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
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * Drop and recreate the vector table at the CURRENT embedding dimension.
 *
 * `CREATE VIRTUAL TABLE IF NOT EXISTS` never redimensions an existing table, so
 * a release that changes EMBEDDING_DIM would leave every existing store with a
 * table at the old width and every insert failing. Recreating is safe because
 * the index is disposable by design — `reindex` re-embeds everything.
 */
export function resetVectorIndex(db: Db): void {
  db.exec(`DROP TABLE IF EXISTS vec_engrams; CREATE VIRTUAL TABLE vec_engrams USING vec0(embedding float[${EMBEDDING_DIM}]);`);
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
