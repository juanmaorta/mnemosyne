// src/index/reindex.ts
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { getMeta, setMeta, resetVectorIndex, type Db } from "./db.js";
import { EMBEDDING_DIM, type EmbeddingClient } from "../embeddings.js";
import { listEngramFiles, type EngramFile } from "./walk.js";
import { needsReindex, type FileState } from "./fileState.js";
import { emitEvents, type TelemetryInput } from "../telemetry/events.js";
import { parseFrontmatter } from "../frontmatter.js";
import { EngramSchema, type Engram } from "../schema.js";
import { toBlob } from "./vecBlob.js";
import { systemClock, type Clock } from "../clock.js";

export interface ReindexStats {
  indexed: number;
  skipped: number;
  deleted: number;
  errors: number;
  /** True when the stored embedding model differed and the index was rebuilt. */
  embeddingMismatch: boolean;
}

export interface ReindexDeps {
  root: string;
  db: Db;
  embedder: EmbeddingClient;
  scopes?: string[];
  /** Defaults to the system clock; injected by tests and the bench harness. */
  clock?: Clock;
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
  /** Absent = never indexed. Distinguishes a new file from a modified one. */
  prev: FileState | undefined;
}

export async function reindex(deps: ReindexDeps): Promise<ReindexStats> {
  const { db, embedder, root, scopes, clock = systemClock } = deps;

  // Vectors produced by different models are not comparable: mixing them would
  // silently corrupt every cosine distance with no error to notice. A changed
  // fingerprint therefore invalidates the whole index — safe, because the index
  // is disposable and this function rebuilds it. Recreating the vector table
  // (not just clearing file_state) also covers a shipped EMBEDDING_DIM change,
  // which `CREATE VIRTUAL TABLE IF NOT EXISTS` would otherwise never apply.
  const previousEmbeddingId = getMeta(db, "embedding_id");
  const embeddingMismatch = previousEmbeddingId !== undefined && previousEmbeddingId !== embedder.id;
  if (embeddingMismatch) {
    db.prepare("DELETE FROM file_state").run();
    resetVectorIndex(db);
  }
  setMeta(db, "embedding_id", embedder.id);

  const stats: ReindexStats = { indexed: 0, skipped: 0, deleted: 0, errors: 0, embeddingMismatch };
  const files = listEngramFiles(root, scopes);
  const seen = new Set(files.map((f) => f.path));

  // Phase 1: walk + parse frontmatter for files that changed. Parse errors are
  // per-file and non-fatal — they must not abort files that parse fine.
  const pending: PendingItem[] = [];
  for (const file of files) {
    const st = statSync(file.path);
    const curr = { mtime: Math.floor(st.mtimeMs), size: st.size };
    const prev = fileStateOf(db, file.path);
    if (!needsReindex(prev, curr)) {
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
    pending.push({ file, engram, body, hash, curr, prev });
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
  const now = clock.nowIso();
  const indexedEvents: TelemetryInput[] = [];
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!;
    const vec = vectors[i]!;
    const { file, engram, body, hash, curr } = item;

    const upsert = db.transaction(() => {
      deleteRowsForPath(db, file.path);
      const info = db
        .prepare(
          `insert into engrams(slug, scope, type, importance, created, description, path, snippet, mtime, size, hash, status)
           values(@slug,@scope,@type,@importance,@created,@description,@path,@snippet,@mtime,@size,@hash,@status)`,
        )
        .run({
          slug: engram.name,
          scope: engram.scope,
          // Absent means active, here as in the frontmatter.
          status: engram.status ?? "active",
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
      //
      // `.immediate()`, not the default BEGIN DEFERRED: a deferred transaction
      // starts as a reader and asks for the write lock only at the first
      // INSERT, and if another process committed in between SQLite answers
      // SQLITE_BUSY_SNAPSHOT — which busy_timeout does NOT retry, because the
      // read snapshot can no longer be rewound. BEGIN IMMEDIATE takes the write
      // lock up front, where busy_timeout does apply.
      upsert.immediate();
      stats.indexed++;
      indexedEvents.push({
        kind: "engram.indexed",
        scope: engram.scope,
        slug: engram.name,
        embeddingId: embedder.id,
        dim: EMBEDDING_DIM,
        // `hash` means the bytes changed; `mtime` means only the stat did
        // (a touch, or a Syncthing round-trip) yet we re-embedded anyway.
        reason: item.prev === undefined ? "new" : item.prev.hash !== hash ? "hash" : "mtime",
      });
    } catch {
      stats.errors++;
    }
  }

  // Prune rows whose files vanished. Count `deleted` per file (path), not per row.
  // A SCOPED reindex only walked the given scopes, so `seen` never contains other
  // scopes' paths — the prune candidate set must be narrowed to the reindexed
  // scopes, or a scoped run (e.g. the SessionStart `mneme context` hook) would
  // wipe every other scope from the index. A full reindex (no `scopes`) prunes
  // globally, as before. Trailing `sep` keeps `acme` from matching `acme-x`.
  const prefixes = scopes?.map((s) => join(root, s) + sep);
  const known = (db.prepare("select path from file_state").all() as { path: string }[]).filter(
    (r) => !prefixes || prefixes.some((p) => r.path.startsWith(p)),
  );
  const prune = db.transaction(() => {
    for (const { path } of known) {
      if (seen.has(path)) continue;
      deleteRowsForPath(db, path);
      db.prepare("delete from file_state where path = ?").run(path);
      stats.deleted++;
    }
  });
  prune.immediate(); // same BEGIN IMMEDIATE reasoning as the upsert above
  // One append for the whole run: a full reindex touches every engram in the
  // store, so per-event writes would put hundreds of syscalls in a command the
  // SessionStart hook runs.
  emitEvents(root, clock, indexedEvents);
  return stats;
}
