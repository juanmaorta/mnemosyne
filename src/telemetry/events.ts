import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { storePaths } from "../store.js";
import { ALGO_VERSION } from "../version.js";
import type { Clock } from "../clock.js";
import { loadTelemetryConfig } from "./config.js";

export type TelemetryKind =
  | "engram.created" | "engram.indexed" | "retrieval.query" | "retrieval.candidate"
  | "retrieval.injected" | "access.reinforced"
  // Dreaming (Fase 4). `dream.run`/`dream.proposal` are emitted when a plan is
  // persisted — including a dry-run, so evidence accrues before anything writes.
  // `dream.applied` is emitted by the apply step (MNE-46) when a derived note is
  // actually written, and stays unused until that lands. `dream.link` records a
  // proposed associative link (MNE-90), one per link folded into the plan.
  | "dream.run" | "dream.proposal" | "dream.applied" | "dream.link";

export interface TelemetryEvent {
  ts: string;
  kind: TelemetryKind;
  algoVersion: string;
  corrId?: string;
  runId?: string;
  /** Kind-specific payload. */
  [k: string]: unknown;
}

/** What a caller supplies; `ts` and `algoVersion` are stamped by the writer. */
export type TelemetryInput = Omit<TelemetryEvent, "ts" | "algoVersion">;

export interface ReadOptions {
  /** Inclusive lower bound, ISO timestamp. */
  since?: string;
  /** Inclusive upper bound, ISO timestamp. */
  until?: string;
}

const FILE_PREFIX = "events-";
const FILE_SUFFIX = ".jsonl";

function dayFile(root: string, tsIso: string): string {
  return join(storePaths(root).telemetryDir, `${FILE_PREFIX}${tsIso.slice(0, 10)}${FILE_SUFFIX}`);
}

/** `events-2026-08-07.jsonl` → `2026-08-07`, or undefined if not a log file. */
function dayOf(filename: string): string | undefined {
  if (!filename.startsWith(FILE_PREFIX) || !filename.endsWith(FILE_SUFFIX)) return undefined;
  return filename.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
}

/**
 * Append events to the durable log. Best-effort by contract: telemetry must
 * never break the command that emits it, so every failure is swallowed.
 *
 * The whole batch is stamped with ONE clock read and written with ONE append.
 * A single retrieval emits an event per candidate — stamping them individually
 * would put N clock reads and N syscalls on the hot path (the SessionStart hook
 * runs a retrieval) and let events from one query drift apart in time.
 */
export function emitEvents(root: string, clock: Clock, evs: TelemetryInput[]): void {
  if (evs.length === 0) return;
  try {
    const config = loadTelemetryConfig(root);
    if (!config.enabled) return;
    const admitted = evs.map((ev) => applyScopePolicy(ev, config.excludeScopes)).filter((ev): ev is TelemetryInput => ev !== undefined);
    if (admitted.length === 0) return;

    mkdirSync(storePaths(root).telemetryDir, { recursive: true });
    const ts = clock.nowIso();
    const lines = admitted.map((ev) => `${JSON.stringify({ ts, algoVersion: ALGO_VERSION, ...ev })}\n`).join("");
    appendFileSync(dayFile(root, ts), lines);
  } catch { /* swallow — see contract above */ }
}

/**
 * Enforce scope exclusions centrally, so no call site can forget them: an
 * event naming an excluded scope is dropped, and a multi-scope event is
 * narrowed to the admitted ones (dropped entirely if none survive). Events
 * with no scope at all belong to no scope and pass through.
 *
 * Exported because retroactive purging must apply exactly the same rule as
 * prevention: two copies of "does this event belong to that scope?" would
 * drift, and the one that drifts silently is the one that leaves client data
 * behind.
 */
export function applyScopePolicy(ev: TelemetryInput, excluded: string[]): TelemetryInput | undefined {
  if (excluded.length === 0) return ev;
  if (typeof ev.scope === "string" && excluded.includes(ev.scope)) return undefined;
  if (Array.isArray(ev.scopes)) {
    const kept = (ev.scopes as unknown[]).filter((s) => typeof s === "string" && !excluded.includes(s));
    if (kept.length === 0) return undefined;
    return { ...ev, scopes: kept };
  }
  return ev;
}

export function emitEvent(root: string, clock: Clock, ev: TelemetryInput): void {
  emitEvents(root, clock, [ev]);
}

/**
 * Read the log, oldest first. `since`/`until` skip whole day files by name
 * before opening them — the log grows unboundedly (an event per candidate per
 * query), so a full scan is not an acceptable default for callers that only
 * need a window.
 */
export function readTelemetry(root: string, opts: ReadOptions = {}): TelemetryEvent[] {
  const dir = storePaths(root).telemetryDir;
  if (!existsSync(dir)) return [];
  const sinceDay = opts.since?.slice(0, 10);
  const untilDay = opts.until?.slice(0, 10);

  const days = readdirSync(dir)
    .map((name) => ({ name, day: dayOf(name) }))
    .filter((f): f is { name: string; day: string } => f.day !== undefined)
    .filter((f) => (sinceDay === undefined || f.day >= sinceDay) && (untilDay === undefined || f.day <= untilDay))
    .sort((a, b) => a.day.localeCompare(b.day));

  const out: TelemetryEvent[] = [];
  for (const { name } of days) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let ev: TelemetryEvent;
      try {
        ev = JSON.parse(line) as TelemetryEvent;
      } catch {
        continue; // torn line from a process killed mid-append
      }
      // Day-file filtering is coarse; enforce the exact bounds per event.
      if (opts.since !== undefined && ev.ts < opts.since) continue;
      if (opts.until !== undefined && ev.ts > opts.until) continue;
      out.push(ev);
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}
