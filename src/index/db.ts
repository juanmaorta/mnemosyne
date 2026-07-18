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
  `);
}

export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);
  applySchema(db);
  return db;
}
