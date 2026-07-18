// src/index/reindex.ts
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Db } from "./db.js";
import type { EmbeddingClient } from "../embeddings.js";
import { listEngramFiles, type EngramFile } from "./walk.js";
import { needsReindex, type FileState } from "./fileState.js";
import { parseFrontmatter } from "../frontmatter.js";
import { EngramSchema, type Engram } from "../schema.js";
import { toBlob } from "./vecBlob.js";

export interface ReindexStats {
  indexed: number;
  skipped: number;
  deleted: number;
  errors: number;
}

export interface ReindexDeps {
  root: string;
  db: Db;
  embedder: EmbeddingClient;
  scopes?: string[];
}

/** Batch size for embedding round-trips — keeps request bodies bounded on large stores. */
const EMBED_BATCH_SIZE = 64;

export function snippetOf(body: string, max = 200): string {
  const s = body.trim().replace(/\s+/g, " ");
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function fileStateOf(db: Db, path: string): FileState | undefined {
  return db.prepare("select path, mtime, size, hash from file_state where path = ?").get(path) as
    | FileState
    | undefined;
}

/**
 * Delete ALL engrams/vec/fts rows for a given path — a file's stable identity
 * is its PATH (file_state's PK), not its frontmatter (scope, slug). Using
 * `.all()` rather than `.get()` is deliberate: it also sweeps up any
 * pre-existing orphan rows sharing the path, not just the single row a naive
 * lookup would assume exists.
 */
function deleteRowsForPath(db: Db, path: string): void {
  const rows = db.prepare("select id from engrams where path = ?").all(path) as { id: number }[];
  for (const { id } of rows) {
    db.prepare("delete from vec_engrams where rowid = ?").run(id);
    db.prepare("delete from fts_engrams where rowid = ?").run(id);
    db.prepare("delete from engrams where id = ?").run(id);
  }
}

interface PendingItem {
  file: EngramFile;
  engram: Engram;
  body: string;
  hash: string;
  curr: { mtime: number; size: number };
}

export async function reindex(deps: ReindexDeps): Promise<ReindexStats> {
  const { db, embedder, root, scopes } = deps;
  const stats: ReindexStats = { indexed: 0, skipped: 0, deleted: 0, errors: 0 };
  const files = listEngramFiles(root, scopes);
  const seen = new Set(files.map((f) => f.path));

  // Phase 1: walk + parse frontmatter for files that changed. Parse errors are
  // per-file and non-fatal — they must not abort files that parse fine.
  const pending: PendingItem[] = [];
  for (const file of files) {
    const st = statSync(file.path);
    const curr = { mtime: Math.floor(st.mtimeMs), size: st.size };
    if (!needsReindex(fileStateOf(db, file.path), curr)) {
      stats.skipped++;
      continue;
    }
    const raw = readFileSync(file.path, "utf8");
    const { data, body } = parseFrontmatter(raw);
    let engram: Engram;
    try {
      engram = EngramSchema.parse(data);
    } catch {
      stats.errors++;
      continue;
    }
    const hash = createHash("sha256").update(raw).digest("hex");
    pending.push({ file, engram, body, hash, curr });
  }

  // Phase 2: batch-embed all pending texts in chunks. A batch failure (e.g.
  // Ollama unreachable) legitimately aborts the whole run — nothing can be
  // indexed without embeddings — but it no longer costs one HTTP round-trip
  // per file, and a single file's content no longer aborts the entire loop.
  const vectors: number[][] = [];
  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const chunk = pending.slice(i, i + EMBED_BATCH_SIZE);
    const texts = chunk.map((p) => `${p.engram.description}\n\n${p.body}`);
    const embedded = await embedder.embed(texts);
    vectors.push(...embedded);
  }

  // Phase 3: upsert each pending item, keyed by path.
  const now = new Date().toISOString();
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!;
    const vec = vectors[i]!;
    const { file, engram, body, hash, curr } = item;

    const upsert = db.transaction(() => {
      deleteRowsForPath(db, file.path);
      const info = db
        .prepare(
          `insert into engrams(slug, scope, type, importance, created, description, path, snippet, mtime, size, hash)
           values(@slug,@scope,@type,@importance,@created,@description,@path,@snippet,@mtime,@size,@hash)`,
        )
        .run({
          slug: engram.name,
          scope: engram.scope,
          type: engram.type,
          importance: engram.importance,
          created: engram.created,
          description: engram.description,
          path: file.path,
          snippet: snippetOf(body),
          mtime: curr.mtime,
          size: curr.size,
          hash,
        });
      const id = info.lastInsertRowid as number;
      // sqlite-vec's vec0 xUpdate rejects a bound INTEGER rowid parameter that
      // better-sqlite3 sends as a plain JS number; binding it as a BigInt makes
      // better-sqlite3 emit SQLITE_INTEGER unambiguously and vec0 accepts it.
      db.prepare("insert into vec_engrams(rowid, embedding) values(?, ?)").run(BigInt(id), toBlob(vec));
      db.prepare("insert into fts_engrams(rowid, description, body) values(?, ?, ?)").run(id, engram.description, body);
      db.prepare(
        `insert into file_state(path, mtime, size, hash, indexed_at) values(?, ?, ?, ?, ?)
         on conflict(path) do update set mtime=excluded.mtime, size=excluded.size, hash=excluded.hash, indexed_at=excluded.indexed_at`,
      ).run(file.path, curr.mtime, curr.size, hash, now);
    });

    try {
      // better-sqlite3's transaction() wrapper rolls back automatically on a
      // thrown error (e.g. UNIQUE(scope, slug) violation when a DIFFERENT
      // path already claims this scope+slug — a genuine collision) and
      // rethrows, so prior state is left intact when we catch below.
      upsert();
      stats.indexed++;
    } catch {
      stats.errors++;
    }
  }

  // Prune rows whose files vanished. Count `deleted` per file (path), not per row.
  const known = db.prepare("select path from file_state").all() as { path: string }[];
  const prune = db.transaction(() => {
    for (const { path } of known) {
      if (seen.has(path)) continue;
      deleteRowsForPath(db, path);
      db.prepare("delete from file_state where path = ?").run(path);
      stats.deleted++;
    }
  });
  prune();
  return stats;
}
