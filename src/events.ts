import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";

/**
 * Access events — the synced, append-only, conflict-free source for
 * reinforcement (decay-on-access). Each machine writes ONLY its own file:
 *
 *   <scope>/events/<machineId>/<YYYY-MM-DD>.jsonl
 *
 * one JSON line per access. `hot_state` is materialized by replaying these.
 */
export type AccessKind = "get";
export interface AccessEvent {
  slug: string;
  ts: string;
  kind: AccessKind;
}

/** Reads (creating once) a per-machine ULID from `<indexDir>/machine-id`. Local, never synced. */
export function getMachineId(indexDir: string): string {
  const file = join(indexDir, "machine-id");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(indexDir, { recursive: true });
  const id = ulid();
  writeFileSync(file, id);
  return id;
}

function eventsDir(root: string, scope: string, machineId: string): string {
  return join(root, scope, "events", machineId);
}

/** Appends one JSONL line to `<scope>/events/<machineId>/<YYYY-MM-DD>.jsonl` (dir created as needed). */
export function appendEvent(root: string, scope: string, machineId: string, ev: AccessEvent): void {
  const dir = eventsDir(root, scope, machineId);
  mkdirSync(dir, { recursive: true });
  const date = ev.ts.slice(0, 10);
  appendFileSync(join(dir, `${date}.jsonl`), `${JSON.stringify(ev)}\n`);
}

/**
 * Composite key for the map returned by `readEvents`. A slug can recur across
 * scopes (schema enforces per-scope `(scope, slug)` uniqueness) — keying by
 * slug alone would merge unrelated events from different scopes into one
 * bucket and corrupt hot state. Scope is known at read time (it's the
 * directory being read), so key by (scope, slug).
 */
export function eventKey(scope: string, slug: string): string {
  return `${scope} ${slug}`;
}

/** Replays all machines' logs across the given scopes, grouped by (scope, slug), tolerant of a malformed/partial last line. */
export function readEvents(root: string, scopes: string[]): Map<string, AccessEvent[]> {
  const grouped = new Map<string, AccessEvent[]>();
  for (const scope of scopes) {
    const base = join(root, scope, "events");
    if (!existsSync(base)) continue;
    for (const machine of readdirSync(base)) {
      const dir = join(base, machine);
      let files: string[];
      try {
        files = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
          if (!line.trim()) continue;
          let ev: AccessEvent;
          try {
            ev = JSON.parse(line) as AccessEvent;
          } catch {
            continue; // tolerate partial last line
          }
          const key = eventKey(scope, ev.slug);
          const arr = grouped.get(key);
          if (arr) arr.push(ev);
          else grouped.set(key, [ev]);
        }
      }
    }
  }
  return grouped;
}
