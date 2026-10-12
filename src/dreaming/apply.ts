// src/dreaming/apply.ts
//
// Apply a reviewed Dreaming plan (MNE-46). The plan is the dry-run artifact
// MNE-42 persisted; applying it is this separate, explicit, manual step — no
// model is invoked, no cron runs it. Keeping generation and application apart is
// what makes "no bad run can destroy the curation" a property of the shape.
//
// This first version ONLY creates derived notes. It never edits facts or
// authored notes, never marks originals superseded, never archives, and does not
// apply the plan's associative links (MNE-90) — those would edit existing notes,
// which is deliberately out of scope here. Every write goes through the same
// gates (owner, secrets) and the same scope lock as `mneme add`, the model's
// output is treated as untrusted content, and the run records exactly what it
// wrote so it can be reverted without guessing.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { storePaths } from "../store.js";
import { serializeFrontmatter } from "../frontmatter.js";
import { revisionOf } from "../revision.js";
import { EngramSchema, NOTE_TYPES } from "../schema.js";
import { withScopeLock } from "../write/lock.js";
import { findSlugClaims } from "../write/claims.js";
import { assertOwnsScope, assertNoSecrets, SecretDetectedError } from "../write/validation.js";
import { emitEvent } from "../telemetry/events.js";
import { systemClock, type Clock } from "../clock.js";
import { dreamsDir, computeBudgetVerdict, type DreamingPlan, type PlanProposal, type PlanLink, type Budget, type BudgetVerdict, type SourceRef } from "./plan.js";
import { isDerivedSlug, DERIVED_SLUG_PREFIX } from "./derived.js";

/** A derived note's slug must be a plain kebab slug — no separators or traversal,
 *  so a path derived from it (apply, revert) can never escape the scope dir. */
const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Importance for a derived note when the proposal did not set one. */
export const DEFAULT_DERIVED_IMPORTANCE = 5;

export interface ApplyDeps {
  root: string;
  /** Local ISO datetime (no timezone) stamped as each derived note's `created`. */
  now: string;
  clock?: Clock;
}

export interface AppliedNote {
  slug: string;
  path: string;
  /** Revision of the exact bytes written — revert checks nobody edited it since. */
  revision: string;
}

export type SkipReason = "duplicate" | "exists" | "secret" | "invalid-schema" | "error";
export interface SkippedNote {
  slug: string;
  reason: SkipReason;
  detail?: string;
}

export interface ApplyResult {
  runId: string;
  scope: string;
  applied: AppliedNote[];
  skipped: SkippedNote[];
  /** Links in the plan are not applied in v1 (they would edit existing notes). */
  linksSkipped: number;
}

export type KeptReason = "modified" | "missing";
export interface KeptNote {
  slug: string;
  reason: KeptReason;
}
export interface RevertResult {
  runId: string;
  scope: string;
  reverted: { slug: string; path: string }[];
  kept: KeptNote[];
}

interface ApplyRecord {
  runId: string;
  scope: string;
  appliedAt: string;
  notes: AppliedNote[];
}

export class PlanNotFoundError extends Error {
  constructor(readonly scope: string, readonly runId: string, readonly kind: "plan" | "apply-record" = "plan") {
    super(`${kind === "plan" ? "plan" : "apply record"} not found for run '${runId}' in scope '${scope}'`);
    this.name = "PlanNotFoundError";
  }
}

export class StalePlanError extends Error {
  constructor(readonly stale: { slug: string; expected: string; actual: string }[]) {
    super(`plan is stale — ${stale.length} source(s) changed since it was built: ${stale.map((s) => s.slug).join(", ")}`);
    this.name = "StalePlanError";
  }
}

export class PlanOverBudgetError extends Error {
  constructor(readonly verdict: BudgetVerdict) {
    super("plan is over budget; it must be re-reviewed, not applied");
    this.name = "PlanOverBudgetError";
  }
}

function planPath(root: string, scope: string, runId: string): string {
  return join(dreamsDir(root, scope), `${runId}.json`);
}

function applyRecordPath(root: string, scope: string, runId: string): string {
  return join(dreamsDir(root, scope), `${runId}.applied.json`);
}

/** Read back the plan persistPlan wrote. The dry-run artifact is the only input. */
export class MalformedPlanError extends Error {
  constructor(readonly scope: string, readonly runId: string, detail: string) {
    super(`malformed plan artifact for run '${runId}' in scope '${scope}': ${detail}`);
    this.name = "MalformedPlanError";
  }
}

export function loadPlan(root: string, scope: string, runId: string): DreamingPlan {
  const path = planPath(root, scope, runId);
  if (!existsSync(path)) throw new PlanNotFoundError(scope, runId, "plan");
  let plan: DreamingPlan;
  try {
    plan = JSON.parse(readFileSync(path, "utf8")) as DreamingPlan;
  } catch (e) {
    throw new MalformedPlanError(scope, runId, `not valid JSON${e instanceof Error ? `: ${e.message}` : ""}`);
  }
  if (plan === null || typeof plan !== "object") throw new MalformedPlanError(scope, runId, "not an object");
  // The artifact's embedded identity must match what was asked for: a plan copied
  // under another scope dir or run filename would otherwise be applied to the
  // scope IT names, not the one requested, writing somewhere nobody asked.
  if (plan.scope !== scope || plan.runId !== runId) throw new PlanNotFoundError(scope, runId, "plan");
  // Structural validation at the boundary: the untrusted artifact's containers and
  // budget must be the shapes everything downstream (budget, render, apply) assume.
  // Deep per-entry validation stays per-entry (proposals/links are skipped, not
  // fatal) — this only guards the top-level shape.
  if (!Array.isArray(plan.proposals)) throw new MalformedPlanError(scope, runId, "proposals is not an array");
  if (!Array.isArray(plan.links)) throw new MalformedPlanError(scope, runId, "links is not an array");
  if (!Array.isArray(plan.sources)) throw new MalformedPlanError(scope, runId, "sources is not an array");
  const b = plan.budget as unknown;
  if (b === null || typeof b !== "object"
    || typeof (b as Budget).maxNotes !== "number"
    || typeof (b as Budget).maxNoteChars !== "number"
    || typeof (b as Budget).maxLinks !== "number") {
    throw new MalformedPlanError(scope, runId, "budget is missing or non-numeric");
  }
  return plan;
}

/**
 * Re-read every source the plan cited and compare its current bytes to the
 * revision recorded at build time. A source edited (or deleted) since the plan
 * was reviewed makes the whole plan stale: its proposals were synthesised from
 * text that no longer exists, so nothing is written.
 */
export function revalidateSources(root: string, plan: DreamingPlan): { slug: string; expected: string; actual: string }[] {
  const paths = storePaths(root);
  const stale: { slug: string; expected: string; actual: string }[] = [];
  for (const s of plan.sources as SourceRef[]) {
    // Resolve each source WITHIN the selected store, never the absolute path the
    // plan recorded (which points at the store the plan was built in). A note
    // resolves by slug; a fact keeps its ULID filename across a store copy, so it
    // resolves by that basename under the current facts dir.
    if (!s.isFact && !SAFE_SLUG_RE.test(s.slug)) { stale.push({ slug: s.slug, expected: s.revision, actual: "missing" }); continue; }
    const resolved = s.isFact
      ? join(paths.factsDir(plan.scope), basename(s.path))
      : join(paths.scopeDir(plan.scope), `${s.slug}.md`);
    if (!existsSync(resolved)) { stale.push({ slug: s.slug, expected: s.revision, actual: "missing" }); continue; }
    const actual = revisionOf(readFileSync(resolved));
    if (actual !== s.revision) stale.push({ slug: s.slug, expected: s.revision, actual });
  }
  return stale;
}

/** Reject an untrusted artifact proposal whose fields are not the shapes the rest
 *  of apply (and budget computation) assume. Returns a reason, or null if valid. */
function malformedProposalReason(p: PlanProposal): string | null {
  if (p === null || typeof p !== "object") return "malformed proposal (not an object)";
  if (typeof p.slug !== "string" || !SAFE_SLUG_RE.test(p.slug)) return "malformed proposal (slug)";
  if (typeof p.type !== "string") return "malformed proposal (type)";
  if (!Array.isArray(p.sources) || !p.sources.every((s) => typeof s === "string")) return "malformed proposal (sources)";
  if (typeof p.body !== "string") return "malformed proposal (body)";
  if (typeof p.description !== "string") return "malformed proposal (description)";
  if (typeof p.id !== "string") return "malformed proposal (id)";
  if (typeof p.isDuplicate !== "boolean") return "malformed proposal (isDuplicate)";
  return null;
}

/** Links are rendered in the preview and counted in the budget; a malformed one
 *  (hand-edited artifact) must be filtered, not crash renderPlan. */
function malformedLink(l: PlanLink): boolean {
  return l === null || typeof l !== "object"
    || !Array.isArray(l.slugs) || l.slugs.length !== 2 || !l.slugs.every((s) => typeof s === "string")
    || typeof l.similarity !== "number" || typeof l.id !== "string";
}

/** Keep only well-formed links, for rendering and budgeting. */
export function validLinks(links: PlanLink[]): PlanLink[] {
  return links.filter((l) => !malformedLink(l));
}

/**
 * Split untrusted artifact proposals into the valid ones and a report of the
 * malformed ones. Shared by apply and the dry-run preview, so the preview shows
 * exactly the batch `--apply` would accept (and never crashes on a null proposal).
 */
export function partitionProposals(proposals: PlanProposal[]): { valid: PlanProposal[]; malformed: SkippedNote[] } {
  const valid: PlanProposal[] = [];
  const malformed: SkippedNote[] = [];
  for (const p of proposals) {
    const bad = malformedProposalReason(p);
    if (bad) { malformed.push({ slug: typeof p?.slug === "string" ? p.slug : String((p as { slug?: unknown })?.slug), reason: "invalid-schema", detail: bad }); continue; }
    valid.push(p);
  }
  return { valid, malformed };
}

/**
 * Apply the plan: create each non-duplicate proposal as a derived note. Revalidates
 * owner, budget and every source revision BEFORE the first write; a stale or
 * over-budget plan is refused whole. Idempotent — re-running finds the notes it
 * already wrote (O_EXCL) and reports them as skipped, never duplicating. A
 * per-note failure (malformed, secret, invalid schema) skips that note and is
 * reported; the rest of the batch still applies. Each written note is recorded
 * immediately, so notes and their reversal bookkeeping are durable together.
 */
export function applyPlan(deps: ApplyDeps, plan: DreamingPlan): ApplyResult {
  const { root } = deps;
  const scope = plan.scope;
  const clock = deps.clock ?? systemClock;

  const applied: AppliedNote[] = [];
  const skipped: SkippedNote[] = [];

  // Gate: owner. A machine never materializes a scope it does not own.
  assertOwnsScope(root, scope);

  // Shape-validate the untrusted proposals BEFORE budget or any write, so a
  // malformed one is reported and can neither crash budget computation (which
  // reads `body.length`) nor abort the batch.
  const { valid, malformed } = partitionProposals(plan.proposals);
  skipped.push(...malformed);

  // Gate: budget — RECOMPUTED from the (valid) proposals and links, never trusting
  // the verdict serialized in the hand-editable artifact.
  const verdict = computeBudgetVerdict(valid, validLinks(plan.links), plan.budget);
  if (!verdict.within) throw new PlanOverBudgetError(verdict);

  const scopeDir = storePaths(root).scopeDir(scope);
  mkdirSync(scopeDir, { recursive: true });
  // The revalidated provenance manifest: a proposal may only cite sources in it.
  const manifest = new Set(plan.sources.map((s) => s.slug));

  withScopeLock(scopeDir, () => {
    const toWrite: { slug: string; path: string; sources: string[]; fileContent: string }[] = [];

    for (const p of valid) {
      if (p.isDuplicate) { skipped.push({ slug: p.slug, reason: "duplicate" }); continue; }
      // A derived note MUST carry the reserved `dream-` prefix: retrieval's
      // source-rescue (MNE-87) recognises derived notes only by it, so a prefixless
      // generated note would be treated as authoritative and could bury its sources.
      if (!isDerivedSlug(p.slug)) {
        skipped.push({ slug: p.slug, reason: "invalid-schema", detail: `derived note slug must start with '${DERIVED_SLUG_PREFIX}'` });
        continue;
      }
      // A derived note is a NOTE, never a fact: a tampered `type: feedback` passes
      // the schema but would land a synthetic fact at `<scope>/<slug>.md`.
      if (!(NOTE_TYPES as readonly string[]).includes(p.type)) {
        skipped.push({ slug: p.slug, reason: "invalid-schema", detail: `type '${p.type}' is not a derived-note type` });
        continue;
      }
      const unknown = p.sources.filter((s) => !manifest.has(s));
      if (unknown.length > 0) {
        skipped.push({ slug: p.slug, reason: "invalid-schema", detail: `cites source(s) not in the revalidated manifest: ${unknown.join(", ")}` });
        continue;
      }
      const path = join(scopeDir, `${p.slug}.md`);

      // (scope, slug) uniqueness incl. FACTS: a fact's filename is a ULID, so it
      // never owns `<slug>.md` — neither isDuplicate nor O_EXCL would catch a fact
      // (or a note elsewhere) already claiming this slug. Same check as `add`.
      const taken = findSlugClaims(root, scope, p.slug).find((c) => c.isFact || c.path !== path);
      if (taken) { skipped.push({ slug: p.slug, reason: "duplicate", detail: taken.path }); continue; }

      const frontmatter = {
        name: p.slug,
        description: p.description,
        scope,
        type: p.type,
        created: plan.createdAt, // plan time, not now: deterministic bytes across retries
        importance: p.importance ?? DEFAULT_DERIVED_IMPORTANCE,
        sources: p.sources,
      };

      let fileContent: string;
      try {
        EngramSchema.parse(frontmatter); // the model's output is untrusted content
        fileContent = serializeFrontmatter(frontmatter, p.body);
        assertNoSecrets(fileContent); // scans the FULL document, frontmatter included
      } catch (e) {
        skipped.push({
          slug: p.slug,
          reason: e instanceof SecretDetectedError ? "secret" : "invalid-schema",
          ...(e instanceof Error ? { detail: e.message } : {}),
        });
        continue;
      }

      // Already on disk: reported, never touched. We do NOT adopt it into the
      // reversal record — byte equality does not prove THIS run created it (two
      // runs can produce identical bytes), and adopting could make revert delete
      // another run's note. Only notes THIS run actually writes are recorded.
      if (existsSync(path)) { skipped.push({ slug: p.slug, reason: "exists" }); continue; }
      toWrite.push({ slug: p.slug, path, sources: p.sources, fileContent });
    }

    // Gate: freshness — checked HERE, under the lock (TOCTOU-safe), and only when
    // there are new notes to write.
    if (toWrite.length > 0) {
      const stale = revalidateSources(root, plan);
      if (stale.length > 0) throw new StalePlanError(stale);
      for (const w of toWrite) {
        // Write FIRST. The exclusive create succeeding is the proof that THIS run
        // created the file: only then do we record a reversal claim on it. A write
        // that fails (EEXIST from another run's identical note, or any error) is
        // never recorded, so reverting this run can never delete a note it did not
        // create. (The residual gap is a process kill between the write and the
        // record below: the note is then untracked — an orphan, never a wrongful
        // deletion. Closing that needs an atomic multi-file commit, out of scope.)
        try {
          writeFileSync(w.path, w.fileContent, { flag: "wx" }); // O_EXCL
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") { skipped.push({ slug: w.slug, reason: "exists" }); continue; }
          try { rmSync(w.path); } catch { /* best effort: clean a partial create */ }
          skipped.push({ slug: w.slug, reason: "error", ...(e instanceof Error ? { detail: e.message } : {}) });
          continue;
        }

        // Revision from the bytes WE wrote (not a re-read), so an external writer
        // touching the file cannot make the record describe someone else's bytes.
        const note = { slug: w.slug, path: w.path, revision: revisionOf(Buffer.from(w.fileContent)) };

        // Retire any older run's claim on this slug BEFORE recording ours — if that
        // fails we must not keep the note, or two runs would claim one live file.
        try {
          retireOtherClaims(root, scope, plan.runId, w.slug);
        } catch (e) {
          try { rmSync(w.path); } catch { /* best effort */ }
          skipped.push({ slug: w.slug, reason: "error", detail: `could not retire a prior claim; note rolled back${e instanceof Error ? `: ${e.message}` : ""}` });
          continue;
        }

        try {
          recordApplied(root, scope, plan.runId, deps.now, [note]);
        } catch (e) {
          // Record failed after creation: roll the note back so it is never left
          // on disk without reversal bookkeeping.
          try { rmSync(w.path); } catch { /* best effort */ }
          skipped.push({ slug: w.slug, reason: "error", detail: `could not persist reversal record; note rolled back${e instanceof Error ? `: ${e.message}` : ""}` });
          continue;
        }

        applied.push(note);
        emitEvent(root, clock, { kind: "dream.applied", runId: plan.runId, scope, slug: w.slug, sources: w.sources });
      }
    }
  });

  return { runId: plan.runId, scope, applied, skipped, linksSkipped: plan.links.length };
}

/** Merge newly-applied notes into the run's durable apply record (union by slug). */
function recordApplied(root: string, scope: string, runId: string, appliedAt: string, notes: AppliedNote[]): void {
  const path = applyRecordPath(root, scope, runId);
  const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ApplyRecord).notes : [];
  // NEW entries win: recordApplied is only ever called for a note this run just
  // created (O_EXCL succeeded), so its revision is authoritative. A delete-then-
  // reapply of the same run must update the recorded revision, not keep the stale one.
  const bySlug = new Map<string, AppliedNote>();
  for (const n of [...existing, ...notes]) bySlug.set(n.slug, n);
  const record: ApplyRecord = { runId, scope, appliedAt, notes: [...bySlug.values()] };
  mkdirSync(dreamsDir(root, scope), { recursive: true });
  writeJsonAtomic(path, record);
}

/**
 * When this run creates a note at `slug`, retire any OTHER run's stale claim on
 * the same slug — e.g. a run that recorded it, then had its note deleted out of
 * band. Revision equality cannot tell two runs' identical bytes apart, so
 * ownership of the live file belongs to the run that actually created it now;
 * without this, reverting the older run would delete this run's note.
 */
function retireOtherClaims(root: string, scope: string, keepRunId: string, slug: string): void {
  const dir = dreamsDir(root, scope);
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith(".applied.json")) continue;
    const path = join(dir, name);
    let rec: ApplyRecord;
    try { rec = JSON.parse(readFileSync(path, "utf8")) as ApplyRecord; } catch { continue; }
    if (rec.runId === keepRunId || !rec.notes.some((n) => n.slug === slug)) continue;
    const remaining = rec.notes.filter((n) => n.slug !== slug);
    // A write failure here MUST propagate: if the older claim is not actually
    // retired, both runs would claim the live file and reverting the older one
    // would delete this run's note. The caller rolls back on this throw.
    if (remaining.length > 0) writeJsonAtomic(path, { ...rec, notes: remaining });
    else rmSync(path);
  }
}

/** Temp file + rename, so a crash or disk-full never leaves a truncated record
 *  that both re-apply and revert would choke on. */
function writeJsonAtomic(path: string, obj: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Revert a run, bounded to exactly the notes it recorded applying. Each note is
 * deleted only if its current bytes still match the revision apply recorded —
 * a note a human has edited since is KEPT, never silently discarded. Idempotent:
 * what is already gone, or has been kept, can be retried.
 */
/**
 * Classify each recorded note WITHOUT touching disk: which can be reverted (still
 * byte-identical to what apply wrote) and which must be kept (edited since, or
 * already gone). Resolves every target inside the selected store from scope+slug,
 * never the absolute path the record stored, so it is boundary-safe.
 */
function classifyRecord(scopeDir: string, record: ApplyRecord): { toRevert: { slug: string; path: string }[]; kept: KeptNote[] } {
  const toRevert: { slug: string; path: string }[] = [];
  const kept: KeptNote[] = [];
  for (const n of record.notes) {
    if (!SAFE_SLUG_RE.test(n.slug)) throw new Error(`apply record contains an unsafe slug: ${n.slug}`);
    const notePath = join(scopeDir, `${n.slug}.md`);
    if (!existsSync(notePath)) { kept.push({ slug: n.slug, reason: "missing" }); continue; }
    if (revisionOf(readFileSync(notePath)) !== n.revision) { kept.push({ slug: n.slug, reason: "modified" }); continue; }
    toRevert.push({ slug: n.slug, path: notePath });
  }
  return { toRevert, kept };
}

function readApplyRecord(root: string, scope: string, runId: string): ApplyRecord {
  const path = applyRecordPath(root, scope, runId);
  if (!existsSync(path)) throw new PlanNotFoundError(scope, runId, "apply-record");
  const record = JSON.parse(readFileSync(path, "utf8")) as ApplyRecord;
  // Identity must match the request, exactly as loadPlan checks: a record copied
  // under another run's filename must not drive a revert of this run's notes.
  if (record.scope !== scope || record.runId !== runId) throw new PlanNotFoundError(scope, runId, "apply-record");
  return record;
}

/** Dry run of a revert: what it WOULD delete vs keep, deleting nothing. Rejects an
 *  unknown run, so the preview of a destructive op is honest. */
export function previewRevert(deps: ApplyDeps, scope: string, runId: string): { runId: string; scope: string; wouldRevert: { slug: string; path: string }[]; kept: KeptNote[] } {
  const { root } = deps;
  const record = readApplyRecord(root, scope, runId);
  const { toRevert, kept } = classifyRecord(storePaths(root).scopeDir(scope), record);
  return { runId, scope, wouldRevert: toRevert, kept };
}

export function revertPlan(deps: ApplyDeps, scope: string, runId: string): RevertResult {
  const { root } = deps;
  // Gate: owner. Deleting notes is a write; it must respect ownership exactly as
  // apply does, even if ownership was revoked after the run was applied.
  assertOwnsScope(root, scope);
  const path = applyRecordPath(root, scope, runId);
  const scopeDir = storePaths(root).scopeDir(scope);

  const reverted: { slug: string; path: string }[] = [];
  const kept: KeptNote[] = [];

  // Record read, note deletion and record update are ONE locked operation: a
  // concurrent apply must not slip between reading the record and rewriting it,
  // or its freshly written notes would be left without reversal bookkeeping.
  withScopeLock(scopeDir, () => {
    const record = readApplyRecord(root, scope, runId);
    const classified = classifyRecord(scopeDir, record);
    kept.push(...classified.kept);
    for (const n of classified.toRevert) {
      rmSync(n.path);
      reverted.push(n);
    }

    // Keep the record only for notes still present but modified since apply, so a
    // retry can act on them. A note already gone ("missing") retires its claim: if
    // another run later creates identical bytes at that slug, a re-revert of this
    // run must not delete it. Drop the record entirely once nothing remains.
    const keptModified = new Set(kept.filter((k) => k.reason === "modified").map((k) => k.slug));
    const remaining = record.notes.filter((n) => keptModified.has(n.slug));
    if (remaining.length > 0) {
      writeJsonAtomic(path, { ...record, notes: remaining });
    } else {
      rmSync(path);
    }
  });

  return { runId, scope, reverted, kept };
}
