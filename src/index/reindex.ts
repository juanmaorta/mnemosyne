// src/index/reindex.ts
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { getMeta, setMeta, resetVectorIndex, vectorIndexDim, type Db } from "./db.js";
import { type EmbeddingClient } from "../embeddings.js";
import { listEngramFiles, type EngramFile } from "./walk.js";
import { needsReindex, type FileState } from "./fileState.js";
import { emitEvents, type TelemetryInput } from "../telemetry/events.js";
import { parseFrontmatter } from "../frontmatter.js";
import { EngramSchema, type Engram } from "../schema.js";
import { toBlob } from "./vecBlob.js";
import { retryOnBusy } from "./retry-busy.js";
import { systemClock, type Clock } from "../clock.js";

export interface ReindexStats {
  indexed: number;
  skipped: number;
  deleted: number;
  errors: number;
  /** True when the stored embedding model differed and the index was rebuilt. */
  embeddingMismatch: boolean;
}

/**
 * Raised instead of silently rebuilding an index that already holds vectors
 * from a different embedder.
 *
 * The rebuild itself is safe — the index is derived and the Markdown is the
 * truth. What is not safe is doing it unasked: it costs one embedder call per
 * engram, it fires from the lazy reindex inside `search`/`context` (so, at the
 * start of a session), and until it finishes there is no retrieval. An
 * `OLLAMA_MODEL` that disagrees with the index is a mistyped environment far
 * more often than a decision.
 */
export class EmbedderMismatchError extends Error {
  constructor(readonly previous: string, readonly current: string) {
    super(
      `this index was built with embedder '${previous}' but '${current}' is configured now. `
      + "Vectors from two models are not comparable, so nothing is rebuilt without being asked. "
      + "Either point OLLAMA_MODEL back at the old model, or rebuild on purpose with "
      + "`mneme reindex --force-embedder` — that re-embeds every engram in the store.",
    );
    this.name = "EmbedderMismatchError";
  }
}

export interface ReindexDeps {
  root: string;
  db: Db;
  /** Null means tier 0: index the FTS table only, no vectors (MNE-19). */
  embedder: EmbeddingClient | null;
  scopes?: string[];
  /** Defaults to the system clock; injected by tests and the bench harness. */
  clock?: Clock;
  /** Consent to re-embed the whole store because the embedder changed. */
  forceEmbedder?: boolean;
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
  const { db, embedder, root, scopes, clock = systemClock, forceEmbedder = false } = deps;

  // Vectors produced by different models are not comparable: mixing them would
  // silently corrupt every cosine distance with no error to notice. A changed
  // fingerprint therefore invalidates the whole index — safe, because the index
  // is disposable and this function rebuilds it.
  const previousEmbeddingId = getMeta(db, "embedding_id");
  const embeddingMismatch = embedder !== null && previousEmbeddingId !== undefined && previousEmbeddingId !== embedder.id;
  // The table's own width is checked separately, and against the SCHEMA rather
  // than the stamp: a store created at the default width and then pointed at a
  // 1024-dim model is NOT a model change (there is no previous stamp to differ
  // from), yet every insert would fail against the 768-wide table. This is also
  // the path that covers a store predating the stamp entirely.
  const widthMismatch = embedder !== null && vectorIndexDim(db) !== embedder.dim;
  if (embedder !== null && (embeddingMismatch || widthMismatch)) {
    // An index with no VECTORS has nothing to protect: the first run of a
    // non-default model must not be an error — and a tier-0 index (engram rows
    // but an empty, default-width vector table) is exactly that case, so it must
    // not demand --force-embedder either. Only actual vectors can be corrupted
    // by mixing models. Past that, the caller says so.
    const hasVectors = (db.prepare("select count(*) as n from vec_engrams").get() as { n: number }).n > 0;
    if (hasVectors && !forceEmbedder) {
      throw new EmbedderMismatchError(
        previousEmbeddingId ?? `an index ${vectorIndexDim(db)} dimensions wide`,
        embedder.id,
      );
    }
  }
  // Deliberately NOT destroyed here. Everything below up to phase 3 can fail —
  // Ollama down, the model never pulled — and the old index is what answers
  // every search until a rebuild actually succeeds. Wiping it first and finding
  // out second leaves the store with no retrieval at all, which is worse than
  // not having tried. The stamp waits too: written early, a failed rebuild
  // would leave the index claiming an embedder whose vectors are not in it.
  const rebuild = embeddingMismatch || widthMismatch;

  // Backfill set (MNE-19): paths that have an engram but no vector — the state a
  // tier-0 index leaves a note in. Collected in ONE query per run, not per file:
  // `engrams.path` is unindexed, so a per-file lookup is a full-table scan each
  // time and goes quadratic on a large store. Skipped entirely when there is no
  // embedder (tier 0 stays FTS-only) or when a rebuild already re-embeds all.
  const missingVectorPaths = new Set<string>();
  if (embedder !== null && !rebuild) {
    for (const r of db.prepare(
      "select e.path as path from engrams e left join vec_engrams v on v.rowid = e.id where v.rowid is null",
    ).all() as { path: string }[]) missingVectorPaths.add(r.path);
  }

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
    // A rebuild re-embeds everything: the vectors are about to be dropped, so a
    // file whose bytes did not change still needs its vector written again.
    // Likewise, a file indexed in tier 0 has no vector yet: with an embedder
    // now present, re-embed it even though its bytes are unchanged (MNE-19).
    const needsBackfill = missingVectorPaths.has(file.path);
    if (!rebuild && !needsBackfill && !needsReindex(prev, curr)) {
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
  // Tier 0 (embedder === null): no vectors. The FTS table is still filled in
  // phase 3, so BM25 search works without an embedder.
  const vectors: number[][] = [];
  if (embedder !== null) {
    for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
      const chunk = pending.slice(i, i + EMBED_BATCH_SIZE);
      const texts = chunk.map((p) => `${p.engram.description}\n\n${p.body}`);
      const embedded = await embedder.embed(texts, "document");
      vectors.push(...embedded);
    }
  }

  // The embeddings are in hand, so now the old index can go. Between this line
  // and the end of phase 3 there is no network and no parsing — only local
  // writes — which is as narrow as this window gets without giving up the
  // per-file transactions that keep one bad note from aborting the run.
  if (rebuild && embedder !== null) {
    // Drop/resize the vector index (a rebuild re-embeds everything), but DON'T
    // clear file_state: the `rebuild` flag already forces every walked file past
    // the phase-1 skip, and the prune below reads file_state to find notes whose
    // files vanished. Clearing it here would strand a note deleted since the last
    // index — including a note deleted during a tier-0 window before promotion.
    resetVectorIndex(db, embedder.dim);
  }
  // Only stamp the embedding model when there actually are vectors: a tier-0
  // run must not claim an embedder whose vectors are not in the index.
  if (embedder !== null) setMeta(db, "embedding_id", embedder.id);

  // Phase 3: upsert each pending item, keyed by path.
  const now = clock.nowIso();
  const indexedEvents: TelemetryInput[] = [];
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!;
    const vec = embedder !== null ? vectors[i]! : null;
    const { file, engram, body, hash, curr } = item;

    const upsert = db.transaction(() => {
      deleteRowsForPath(db, file.path);
      const info = db
        .prepare(
          `insert into engrams(slug, scope, type, importance, created, description, path, snippet, mtime, size, hash, status, pinned)
           values(@slug,@scope,@type,@importance,@created,@description,@path,@snippet,@mtime,@size,@hash,@status,@pinned)`,
        )
        .run({
          slug: engram.name,
          scope: engram.scope,
          // Absent means active, here as in the frontmatter.
          status: engram.status ?? "active",
          // Absent means not pinned. SQLite has no boolean: 1/0 (MNE-62).
          pinned: engram.pinned ? 1 : 0,
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
      if (vec !== null) {
        db.prepare("insert into vec_engrams(rowid, embedding) values(?, ?)").run(BigInt(id), toBlob(vec));
      }
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
      // lock up front, where busy_timeout does apply. Under a storm the timeout
      // itself can expire and throw SQLITE_BUSY; retryOnBusy waits a little
      // longer rather than booking that transient loss as a swallowed error.
      retryOnBusy(() => upsert.immediate());
      stats.indexed++;
      indexedEvents.push({
        kind: "engram.indexed",
        scope: engram.scope,
        slug: engram.name,
        embeddingId: embedder === null ? "none" : embedder.id,
        dim: embedder === null ? 0 : embedder.dim,
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
  retryOnBusy(() => prune.immediate()); // same BEGIN IMMEDIATE + busy retry as the upsert above
  // One append for the whole run: a full reindex touches every engram in the
  // store, so per-event writes would put hundreds of syscalls in a command the
  // SessionStart hook runs.
  emitEvents(root, clock, indexedEvents);
  return stats;
}
