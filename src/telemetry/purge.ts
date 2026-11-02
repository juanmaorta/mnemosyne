import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dreamsDir } from "../dreaming/plan.js";
import { join } from "node:path";
import { storePaths } from "../store.js";
import { applyScopePolicy, type TelemetryEvent, type TelemetryInput } from "./events.js";

export interface PurgeReport {
  scope: string;
  dryRun: boolean;
  /** Events dropped outright (their only scope was the purged one). */
  eventsRemoved: number;
  /** Multi-scope events kept, with the purged scope stripped from them. */
  eventsNarrowed: number;
  filesRewritten: number;
  /** Day files deleted because nothing survived in them. */
  filesDeleted: number;
  snapshotsRedacted: number;
  /**
   * Dreaming plans and apply records deleted (MNE-115): whole proposed note
   * bodies live there, under .telemetry/dreams/<scope>/.
   */
  dreamFilesRemoved: number;
}

export interface PurgeOptions {
  /** Report what would change without touching anything. */
  dryRun?: boolean;
}

/**
 * Retroactively remove a scope from the telemetry store.
 *
 * The preventive half is `excludeScopes` (nothing gets written). This is the
 * corrective half, for when the exclusion was configured too late: telemetry
 * records slug and scope in clear and lives in `.telemetry/`, OUTSIDE
 * `<root>/<scope>/`, so it survives the `rm -rf` the client-offboarding
 * runbook prescribes.
 *
 * Rewriting an append-only log is a deliberate exception. The log is
 * diagnostic and disposable; a compliance obligation to delete outranks the
 * append-only property, and there is nowhere else to honour it — `.telemetry/`
 * is machine-local and neither synced nor backed up.
 */
export function purgeTelemetryScope(root: string, scope: string, opts: PurgeOptions = {}): PurgeReport {
  const dryRun = opts.dryRun ?? false;
  const report: PurgeReport = {
    scope, dryRun, eventsRemoved: 0, eventsNarrowed: 0, filesRewritten: 0, filesDeleted: 0, snapshotsRedacted: 0,
    dreamFilesRemoved: 0,
  };
  const dir = storePaths(root).telemetryDir;

  // Dreaming's artifacts first, and whether or not any event log exists: a
  // plan is the scope's notes rewritten, the most sensitive thing in here.
  // Only "there is none" is ignored: a deletion that fails must surface, or an
  // offboarding would report success over note bodies still on disk.
  const dreams = dreamsDir(root, scope);
  let dreamFiles = 0;
  try {
    dreamFiles = readdirSync(dreams).length;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (dreamFiles > 0 && !dryRun) rmSync(dreams, { recursive: true });
  report.dreamFilesRemoved = dreamFiles;

  let dayFiles: string[];
  try {
    dayFiles = readdirSync(dir).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl")).sort();
  } catch {
    return report; // no telemetry at all
  }

  for (const name of dayFiles) {
    const path = join(dir, name);
    const kept: string[] = [];
    let removed = 0;
    let narrowed = 0;

    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let ev: TelemetryEvent;
      try {
        ev = JSON.parse(line) as TelemetryEvent;
      } catch {
        kept.push(line); // a torn line names no scope we can verify; leave it
        continue;
      }
      // Same rule as prevention, so the two can never disagree.
      const survivor = applyScopePolicy(ev as TelemetryInput, [scope]);
      if (survivor === undefined) {
        removed++;
        continue;
      }
      const changed = JSON.stringify(survivor) !== JSON.stringify(ev);
      if (changed) narrowed++;
      kept.push(JSON.stringify(survivor));
    }

    if (removed === 0 && narrowed === 0) continue;
    report.eventsRemoved += removed;
    report.eventsNarrowed += narrowed;

    if (kept.length === 0) {
      // An empty file would still say "the client was active on this date".
      report.filesDeleted++;
      if (!dryRun) rmSync(path);
      continue;
    }
    report.filesRewritten++;
    if (!dryRun) writeAtomically(path, `${kept.join("\n")}\n`);
  }

  report.snapshotsRedacted = redactSnapshots(dir, scope, dryRun);
  return report;
}

/**
 * Drop the scope's entry from each snapshot's per-scope counts.
 *
 * NOTE this cannot be surgical: `countsByType` and `strengthHistogram` are
 * aggregates with no per-scope breakdown, so the purged scope stays folded
 * into those totals. What it removes is what identifies the client — the scope
 * NAME and the size of its memory. If even the aggregates are unacceptable,
 * the snapshots have to be deleted, not redacted.
 */
function redactSnapshots(telemetryDir: string, scope: string, dryRun: boolean): number {
  const dir = join(telemetryDir, "snapshots");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith("stats-") && n.endsWith(".json"));
  } catch {
    return 0;
  }
  let redacted = 0;
  for (const name of names) {
    const path = join(dir, name);
    let doc: { stats?: { countsByScope?: Record<string, number> }; catchAll?: string };
    try {
      doc = JSON.parse(readFileSync(path, "utf8")) as typeof doc;
    } catch {
      continue;
    }
    const inCounts = doc.stats?.countsByScope !== undefined && scope in doc.stats.countsByScope;
    // A catch-all recorded before this scope was excluded still names it (MNE-59),
    // so offboarding has to strip it as well, not only the per-scope counts.
    const inCatchAll = doc.catchAll === scope;
    if (!inCounts && !inCatchAll) continue;
    redacted++;
    if (dryRun) continue;
    if (inCounts) delete doc.stats!.countsByScope![scope];
    if (inCatchAll) delete doc.catchAll;
    writeAtomically(path, `${JSON.stringify(doc, null, 2)}\n`);
  }
  return redacted;
}

/** Write via temp + rename so an interrupted purge cannot truncate the log. */
function writeAtomically(path: string, content: string): void {
  const tmp = `${path}.purge-tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
