import { readTelemetry, type TelemetryEvent } from "../telemetry/events.js";

export interface TraceEntry {
  ts: string;
  kind: string;
  detail: string;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function f3(v: unknown): string {
  const n = num(v);
  return n === undefined ? "—" : n.toFixed(3);
}

/**
 * An event belongs to this engram if it names the slug directly, or — for
 * injections, which list what the agent was shown — if the slug appears in
 * their array. Filtering on `slug` alone would silently drop the moment the
 * note actually reached the agent, which is the milestone that matters most.
 */
function mentions(ev: TelemetryEvent, slug: string): boolean {
  if (ev.slug === slug) return true;
  if (Array.isArray(ev.injectedSlugs) && (ev.injectedSlugs as unknown[]).includes(slug)) return true;
  // A dreaming proposal names the SOURCES it derived from: surfacing it on each
  // source's lifeline is how "a derived note did not bury its sources" stays
  // observable — the source can see it was consolidated.
  return Array.isArray(ev.sources) && (ev.sources as unknown[]).includes(slug);
}

function describe(ev: TelemetryEvent): string {
  const signals = ev.signals as { relevanceCosine?: unknown; recencyNorm?: unknown } | undefined;
  switch (ev.kind) {
    case "engram.created":
      return `written to ${String(ev.scope)} as ${String(ev.type)}, importance ${String(ev.importance)} (scanner: ${String(ev.scannerVerdict)})`;
    case "engram.indexed":
      return `indexed — reason ${String(ev.reason)}, model ${String(ev.embeddingId)}`;
    case "retrieval.candidate":
      return `${ev.included ? "served" : "considered"} at rank ${String(ev.rank)} — cos ${f3(signals?.relevanceCosine)}, cut line ${f3(ev.threshold)}`;
    case "retrieval.injected":
      return `injected into ${String(ev.scope)} context (budget ${String(ev.budget)}, ${String(ev.droppedForBudget)} dropped)`;
    case "access.reinforced":
      return `read — strength ${String(ev.strengthBefore)} → ${String(ev.strengthAfter)}, ${String(ev.accessCountAfter)} access${ev.accessCountAfter === 1 ? "" : "es"}`;
    case "dream.run":
      return `dreaming run ${String(ev.runId)} on ${String(ev.scope)} — ${String(ev.proposals)} proposal(s), ${String(ev.duplicates)} dup, model ${String(ev.model)}${ev.withinBudget === false ? " (OVER BUDGET)" : ""}`;
    case "dream.proposal":
      return `proposed derived note ${String(ev.slug)} from [${Array.isArray(ev.sources) ? (ev.sources as unknown[]).join(", ") : ""}]${ev.isDuplicate ? " — duplicate, skipped" : ""}`;
    case "dream.applied":
      return `applied — derived note ${String(ev.slug)} written from [${Array.isArray(ev.sources) ? (ev.sources as unknown[]).join(", ") : ""}]`;
    default:
      return ev.kind;
  }
}

/** Lifecycle of one engram, reconstructed from the event log alone. */
export function traceEngram(root: string, slug: string): TraceEntry[] {
  return readTelemetry(root)
    .filter((ev) => mentions(ev, slug))
    .map((ev) => ({ ts: ev.ts, kind: ev.kind, detail: describe(ev) }));
}

export function formatTrace(entries: TraceEntry[], slug: string): string {
  if (entries.length === 0) {
    return `${slug}: no recorded history (telemetry may be off, or the engram predates it)`;
  }
  const lines = [`${slug} — ${entries.length} events`, ""];
  for (const e of entries) {
    lines.push(`  ${e.ts}  ${e.kind.padEnd(20)} ${e.detail}`);
  }
  return lines.join("\n");
}
