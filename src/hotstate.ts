import type { Db } from "./index/db.js";
import { appendEvent, getMachineId, readEvents, eventKey } from "./events.js";
import { reinforce, retention, INITIAL_STRENGTH } from "./scoring.js";
import { storePaths } from "./store.js";

/**
 * Hot state — derived (strength, last_access, access_count, retention) — lives
 * ONLY in the local index, materialized by replaying the synced `events/` log.
 * Keyed by (scope, slug): the schema enforces per-scope (scope, slug)
 * uniqueness, so a slug can legitimately recur across scopes. Keying by slug
 * alone would clobber hot state across scopes on collision.
 */
export interface HotState {
  scope: string;
  slug: string;
  lastAccess: string;
  accessCount: number;
  strength: number;
  retention: number;
}

/** Folds each engram's events (sorted by ts) from INITIAL_STRENGTH/created, upserts hot_state. */
export function materializeHotState(db: Db, root: string, scopes: string[], nowMs: number): void {
  if (scopes.length === 0) return;
  const placeholders = scopes.map(() => "?").join(",");
  const engrams = db
    .prepare(`select scope, slug, created from engrams where scope in (${placeholders})`)
    .all(...scopes) as { scope: string; slug: string; created: string }[];
  const events = readEvents(root, scopes);
  const upsert = db.prepare(
    `insert into hot_state(scope, slug, last_access, access_count, strength, retention)
     values(@scope,@slug,@last,@count,@strength,@retention)
     on conflict(scope, slug) do update set last_access=excluded.last_access,
       access_count=excluded.access_count, strength=excluded.strength, retention=excluded.retention`,
  );
  const tx = db.transaction(() => {
    for (const e of engrams) {
      let state = { strength: INITIAL_STRENGTH, accessCount: 0 };
      let lastAccess = e.created;
      const evs = (events.get(eventKey(e.scope, e.slug)) ?? []).slice().sort((a, b) => a.ts.localeCompare(b.ts));
      for (const ev of evs) {
        state = reinforce(state);
        lastAccess = ev.ts;
      }
      upsert.run({
        scope: e.scope,
        slug: e.slug,
        last: lastAccess,
        count: state.accessCount,
        strength: state.strength,
        retention: retention(nowMs, Date.parse(lastAccess), state.strength),
      });
    }
  });
  tx();
}

export function getHotState(db: Db, scope: string, slug: string): HotState | undefined {
  return db
    .prepare(
      `select scope, slug, last_access as lastAccess, access_count as accessCount, strength, retention
       from hot_state where scope = ? and slug = ?`,
    )
    .get(scope, slug) as HotState | undefined;
}

/** Appends a `get` event for (scope, slug), then re-materializes that scope's hot state. */
export function recordAccess(db: Db, root: string, scope: string, slug: string, nowIso: string): void {
  const machineId = getMachineId(storePaths(root).indexDir);
  appendEvent(root, scope, machineId, { slug, ts: nowIso, kind: "get" });
  materializeHotState(db, root, [scope], Date.parse(nowIso));
}
