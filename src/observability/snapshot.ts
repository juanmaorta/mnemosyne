import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../index/db.js";
import { storePaths } from "../store.js";
import { ALGO_VERSION } from "../version.js";
import type { Clock } from "../clock.js";
import { computeStats, type Stats } from "./stats.js";
import { loadTelemetryConfig } from "../telemetry/config.js";

/**
 * Point-in-time record of the store's metrics.
 *
 * `computeStats` only ever describes NOW. Without a persisted series there is
 * nothing to compare against when a subsystem that rewrites memories (dreaming,
 * Fase 4) starts running — you would see the state after the change and have no
 * idea what it looked like before. The series only has value if it starts
 * before it is needed.
 */
export interface StatsSnapshot {
  ts: string;
  /** Attributes a metric shift to a code change rather than to changed usage. */
  algoVersion: string;
  stats: Stats;
}

export function snapshotsDir(root: string): string {
  return join(storePaths(root).telemetryDir, "snapshots");
}

function fileFor(dir: string, tsIso: string): string {
  return join(dir, `stats-${tsIso.slice(0, 10)}.json`);
}

/**
 * Write today's snapshot, replacing any earlier one from the same day: a weekly
 * job that fires twice (a wake-from-sleep catch-up, a manual run) must not turn
 * one day into two data points.
 */
export function writeSnapshot(db: Db, root: string, clock: Clock): string {
  const dir = snapshotsDir(root);
  mkdirSync(dir, { recursive: true });
  const ts = clock.nowIso();
  // A snapshot is persisted and lives outside <root>/<scope>/, so it must
  // honour the same scope exclusions as the event log — otherwise a client
  // scope survives the offboarding purge as a daily count.
  const stats = computeStats(db, root, { excludeScopes: loadTelemetryConfig(root).excludeScopes });
  const snapshot: StatsSnapshot = { ts, algoVersion: ALGO_VERSION, stats };
  const path = fileFor(dir, ts);
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  return path;
}

/** The series, oldest first. A corrupt file is skipped, never fatal. */
export function readSnapshots(root: string): StatsSnapshot[] {
  const dir = snapshotsDir(root);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith("stats-") && n.endsWith(".json")).sort();
  } catch {
    return []; // no snapshots yet
  }
  const out: StatsSnapshot[] = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as StatsSnapshot);
    } catch { /* skip a truncated file rather than lose the series */ }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}
