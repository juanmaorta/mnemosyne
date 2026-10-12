/**
 * Dreaming's change plan: the single, materialized artifact a run produces
 * (MNE-42). Dry-run is NOT a second code path — it is structural: this module
 * only ever *computes* a plan and writes a *report* of it. It never mutates the
 * store, never creates notes, never reinforces access. Applying the plan is a
 * separate, explicit step (MNE-46) that consumes exactly this artifact; the
 * synthesis that fills the proposals is another (MNE-52). Keeping those seams
 * apart is what makes "no bad run can destroy the curation" a property of the
 * shape, not of remembering to pass a flag.
 *
 * Scope is a hard boundary: a plan reads only its own scope's sources, records
 * their revisions for provenance, and the whole artifact is persisted
 * machine-local and out of git. A source cited from outside the scope is a
 * loud error, never a silent cross-scope read.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { storePaths } from "../store.js";
import { parseFrontmatter } from "../frontmatter.js";
import { revisionOf } from "../revision.js";
import { ALGO_VERSION } from "../version.js";
import { emitEvents, type TelemetryInput } from "../telemetry/events.js";
import { systemClock, type Clock } from "../clock.js";
import type { ProposedLink } from "./links.js";

export type NoteType = "user" | "reference" | "project";

/**
 * A new derived note the synthesis step (MNE-52) proposes to create. This
 * delivery proposes ONLY creations: originals, the append-only fact stream and
 * authored notes are never touched. `sources` are the slugs this note derives
 * from — its provenance and its scope taint.
 */
export interface ProposedNote {
  slug: string;
  type: NoteType;
  description: string;
  importance?: number;
  sources: string[];
  body: string;
}

/**
 * A source engram read while planning, with the revision (hash of its exact
 * bytes) at read time. Reading it is MAINTENANCE, not a user recall: it goes
 * straight to the file, so it never reinforces strength or touches the index.
 */
export interface SourceRef {
  slug: string;
  path: string;
  isFact: boolean;
  revision: string;
}

/** A source read into memory: its `revision` and `content` come from the SAME
 *  bytes, so a reader never records a revision that disagrees with the text it
 *  used (and a file mutated after the read cannot split the two apart). */
export interface LoadedSource extends SourceRef {
  content: string;
}

/**
 * The change budget, checked before anything could be written. Absolute counts,
 * deliberately: this delivery has only creations, so there is no denominator to
 * take a percentage of. When future updates arrive they will count affected
 * notes over an explicit denominator — modelling the creation budget as a bare
 * number now keeps that door open instead of baking in an implicit percentage.
 */
export interface Budget {
  /** Max NEW notes per run. */
  maxNotes: number;
  /** Max characters in a single new note's body. */
  maxNoteChars: number;
  /** Max NEW associative links per run (MNE-90). */
  maxLinks: number;
}

/** Conservative defaults; override per run. Never a switch that enables writes. */
export const DEFAULT_BUDGET: Budget = { maxNotes: 10, maxNoteChars: 4_000, maxLinks: 20 };

export interface BudgetVerdict {
  within: boolean;
  /** New notes proposed vs the limit. Duplicates do not count — see isDuplicate. */
  notes: { proposed: number; limit: number };
  /** New links proposed vs the limit (MNE-90). */
  links: { proposed: number; limit: number };
  /** Bodies over the per-note size cap, REPORTED, never silently trimmed. */
  oversizeNotes: { slug: string; chars: number; limit: number }[];
}

export interface PlanProposal extends ProposedNote {
  /** Stable identity: same (scope, slug, sources, body) always hashes the same,
   *  so repeating a run on unchanged inputs proposes the same thing, not a copy. */
  id: string;
  /** A note with this slug already exists in the scope; a creation would clash,
   *  so it is flagged and excluded from the new-note budget. */
  isDuplicate: boolean;
}

/**
 * A proposed associative link, as it lands in the plan. Identity is the
 * (scope, endpoint pair) — NOT the similarity, which can drift as the index is
 * rebuilt — so re-running on an unchanged index proposes the same link with the
 * same id instead of a near-duplicate.
 */
export interface PlanLink extends ProposedLink {
  id: string;
}

export interface DreamingPlan {
  runId: string;
  scope: string;
  createdAt: string;
  model: { id: string };
  algoVersion: string;
  budget: Budget;
  budgetVerdict: BudgetVerdict;
  sources: SourceRef[];
  proposals: PlanProposal[];
  links: PlanLink[];
}

export interface BuildPlanOptions {
  root: string;
  scope: string;
  model: { id: string };
  now: string;
  proposals: ProposedNote[];
  /** Proposed associative links among the scope's notes (MNE-90). */
  links?: ProposedLink[];
  budget?: Budget;
  /** Injectable for deterministic artifacts; a fresh id is derived otherwise. */
  runId?: string;
}

/** A plan cited sources that do not exist in its scope. Fail loud, never read on. */
export class InvalidSourcesError extends Error {
  constructor(readonly scope: string, readonly slugs: string[]) {
    super(`sources not found in scope '${scope}': ${slugs.join(", ")}`);
    this.name = "InvalidSourcesError";
  }
}

const KEBAB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertSafeScope(scope: string): void {
  if (!KEBAB_SLUG_RE.test(scope)) {
    throw new Error(`unsafe scope (must be a kebab-case slug): ${scope}`);
  }
}

function stableId(scope: string, p: ProposedNote): string {
  const material = [scope, p.slug, [...p.sources].sort().join(","), p.body].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Identity of a link: scope + its (already-sorted) endpoint pair. */
function stableLinkId(scope: string, link: ProposedLink): string {
  const material = [scope, link.slugs[0], link.slugs[1]].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/**
 * Both endpoints of every link must be a note file in THIS scope. A missing or
 * cross-scope endpoint is raised loudly (same as an out-of-scope source), so a
 * link can never silently reach across the scope boundary.
 */
function assertLinkEndpointsInScope(scope: string, scopeDir: string, links: ProposedLink[]): void {
  const missing = new Set<string>();
  for (const link of links) {
    for (const slug of link.slugs) {
      // Validate the slug shape BEFORE touching the filesystem: a value like
      // `../work/secret` would otherwise resolve to a note in another scope and
      // silently defeat the boundary. A real slug has no separators or traversal.
      if (!KEBAB_SLUG_RE.test(slug) || !existsSync(join(scopeDir, `${slug}.md`))) missing.add(slug);
    }
  }
  if (missing.size > 0) throw new InvalidSourcesError(scope, [...missing]);
}

/**
 * Read every cited source within the scope, directly from disk. A note resolves
 * by its filename (`<slug>.md`); a fact resolves by matching `name` in its
 * frontmatter (its filename is a ULID). Any cited slug that resolves to nothing
 * in THIS scope is collected and raised together, so a mistake names all of its
 * parts at once.
 *
 * Exported because synthesis (MNE-52) reads its source group through exactly the
 * same maintenance-read primitive: same scope boundary, same revisions, same
 * absence of reinforcement.
 */
export function readSources(root: string, scope: string, slugs: string[]): SourceRef[] {
  return loadSources(root, scope, slugs).map((s) => ({
    slug: s.slug,
    path: s.path,
    isFact: s.isFact,
    revision: s.revision,
  }));
}

/**
 * Like `readSources`, but keeps each source's bytes in memory — one read per
 * file, with revision and content taken from the same Buffer. Synthesis needs
 * the text, and reading it twice (once for the revision, once for the prompt)
 * would open a window where the recorded revision no longer describes the text
 * that was synthesized. Reading once closes it.
 */
export function loadSources(root: string, scope: string, slugs: string[]): LoadedSource[] {
  assertSafeScope(scope);
  const paths = storePaths(root);
  const scopeDir = paths.scopeDir(scope);
  const factsDir = paths.factsDir(scope);

  const noteFiles = new Set<string>(
    safeReaddir(scopeDir).filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)),
  );
  // Facts share a `name`, so a slug can map to several fact files. Read each
  // fact's bytes once here and index them by name.
  const factsByName = new Map<string, { path: string; buf: Buffer }[]>();
  for (const name of safeReaddir(factsDir)) {
    if (!name.endsWith(".md")) continue;
    const path = join(factsDir, name);
    const buf = readFileSync(path);
    const slug = parseFrontmatter(buf.toString("utf8")).data["name"];
    if (typeof slug === "string") {
      const list = factsByName.get(slug) ?? [];
      list.push({ path, buf });
      factsByName.set(slug, list);
    }
  }

  const out: LoadedSource[] = [];
  const missing: string[] = [];
  for (const slug of slugs) {
    if (noteFiles.has(slug)) {
      const path = join(scopeDir, `${slug}.md`);
      const buf = readFileSync(path);
      out.push({ slug, path, isFact: false, revision: revisionOf(buf), content: buf.toString("utf8") });
    } else if (factsByName.has(slug)) {
      for (const { path, buf } of factsByName.get(slug)!) {
        out.push({ slug, path, isFact: true, revision: revisionOf(buf), content: buf.toString("utf8") });
      }
    } else {
      missing.push(slug);
    }
  }
  if (missing.length > 0) throw new InvalidSourcesError(scope, missing);
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function buildPlan(opts: BuildPlanOptions): DreamingPlan {
  const { root, scope, model, now, proposals } = opts;
  const links = opts.links ?? [];
  assertSafeScope(scope);
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const runId = opts.runId ?? deriveRunId(scope, now);

  // Provenance: read exactly the sources the proposals cite, deduped. This
  // throws on any out-of-scope or missing source before anything else happens.
  const citedSlugs = [...new Set(proposals.flatMap((p) => p.sources))];
  const sources = readSources(root, scope, citedSlugs);

  const scopeDir = storePaths(root).scopeDir(scope);
  // Links never cross the scope boundary: every endpoint must be a note here.
  assertLinkEndpointsInScope(scope, scopeDir, links);
  const planProposals: PlanProposal[] = proposals.map((p) => ({
    ...p,
    id: stableId(scope, p),
    isDuplicate: existsSync(join(scopeDir, `${p.slug}.md`)),
  }));
  const planLinks: PlanLink[] = links.map((l) => ({ ...l, id: stableLinkId(scope, l) }));

  const budgetVerdict = computeBudgetVerdict(planProposals, planLinks, budget);

  return {
    runId,
    scope,
    createdAt: now,
    model,
    algoVersion: ALGO_VERSION,
    budget,
    budgetVerdict,
    sources,
    proposals: planProposals,
    links: planLinks,
  };
}

function deriveRunId(scope: string, now: string): string {
  return `dream-${scope}-${now.replace(/[:.]/g, "-")}`;
}

/**
 * Count the NEW notes and flag oversize bodies, reporting excess without ever
 * trimming the plan: the reviewer (and MNE-46) decide what to do, and a plan
 * silently shortened to fit would hide exactly the run worth stopping.
 */
export function computeBudgetVerdict(proposals: PlanProposal[], links: PlanLink[], budget: Budget): BudgetVerdict {
  const fresh = proposals.filter((p) => !p.isDuplicate);
  const oversizeNotes = fresh
    .filter((p) => p.body.length > budget.maxNoteChars)
    .map((p) => ({ slug: p.slug, chars: p.body.length, limit: budget.maxNoteChars }));
  const notes = { proposed: fresh.length, limit: budget.maxNotes };
  const linksVerdict = { proposed: links.length, limit: budget.maxLinks };
  const within =
    notes.proposed <= budget.maxNotes &&
    linksVerdict.proposed <= budget.maxLinks &&
    oversizeNotes.length === 0;
  return { within, notes, links: linksVerdict, oversizeNotes };
}

/** Human-readable diff: what this run would create, from what, under what budget. */
export function renderPlan(plan: DreamingPlan): string {
  const lines: string[] = [];
  lines.push(`dreaming plan ${plan.runId} — scope ${plan.scope}`);
  lines.push(`model ${plan.model.id} · algo ${plan.algoVersion} · ${plan.createdAt}`);

  lines.push(`sources read (${plan.sources.length}):`);
  for (const s of plan.sources) {
    lines.push(`  - ${s.slug} @ ${s.revision.slice(0, 8)} (${s.isFact ? "fact" : "note"})`);
  }

  const fresh = plan.proposals.filter((p) => !p.isDuplicate);
  const dupes = plan.proposals.filter((p) => p.isDuplicate);
  lines.push(`proposed new notes (${fresh.length}):`);
  for (const p of fresh) {
    lines.push(`  + ${p.slug}  [id ${p.id.slice(0, 8)}]`);
    lines.push(`      ${p.description}`);
    lines.push(`      sources: ${p.sources.join(", ")}`);
  }
  for (const p of dupes) {
    lines.push(`  ~ ${p.slug} — skipped (a note already holds this slug)`);
  }

  lines.push(`proposed links (${plan.links.length}):`);
  for (const l of plan.links) {
    lines.push(`  ↔ ${l.slugs[0]} — ${l.slugs[1]}  [id ${l.id.slice(0, 8)}, cos ${l.similarity.toFixed(3)}]`);
  }

  const v = plan.budgetVerdict;
  if (v.within) {
    lines.push(`budget: within (notes ${v.notes.proposed}/${v.notes.limit}, links ${v.links.proposed}/${v.links.limit})`);
  } else {
    const bits = [`notes ${v.notes.proposed}/${v.notes.limit}`, `links ${v.links.proposed}/${v.links.limit}`];
    if (v.oversizeNotes.length > 0) bits.push(`${v.oversizeNotes.length} oversize`);
    lines.push(`budget: EXCEEDED (${bits.join("; ")})`);
    for (const o of v.oversizeNotes) {
      lines.push(`      ! ${o.slug}: ${o.chars} chars > ${o.limit}`);
    }
  }
  return lines.join("\n");
}

/** `<root>/.telemetry/dreams/<scope>/` — durable, machine-local, out of git. */
export function dreamsDir(root: string, scope: string): string {
  assertSafeScope(scope);
  return join(storePaths(root).telemetryDir, "dreams", scope);
}

/**
 * Persist the plan artifact as the dry-run's explicit output. It lives under the
 * machine-local `.telemetry/` tree (never synced, outside the per-scope folders)
 * and is namespaced by scope, so a plan's private contents never leave this box
 * and never land in another scope's space. This writes a REPORT, not the store.
 */
export function persistPlan(root: string, plan: DreamingPlan, clock: Clock = systemClock): string {
  const dir = dreamsDir(root, plan.scope);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${plan.runId}.json`);
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
  // Durable trace of the run alongside its artifact. Best-effort by contract
  // (emitEvents swallows failures and honours scope exclusions), so a telemetry
  // hiccup never fails the persist.
  emitEvents(root, clock, dreamPlanEvents(plan));
  return path;
}

/**
 * The `dream.*` telemetry a run produces: one `dream.run` summarising it and one
 * `dream.proposal` per proposed derived note, each stamped with the scope so the
 * central scope policy (events.ts) can enforce the boundary. Pure — the caller
 * decides when to emit; `dream.applied` is the apply step's to emit (MNE-46).
 */
export function dreamPlanEvents(plan: DreamingPlan): TelemetryInput[] {
  const run: TelemetryInput = {
    kind: "dream.run",
    runId: plan.runId,
    scope: plan.scope,
    model: plan.model.id,
    proposals: plan.proposals.length,
    duplicates: plan.proposals.filter((p) => p.isDuplicate).length,
    links: plan.links.length,
    withinBudget: plan.budgetVerdict.within,
  };
  const proposals: TelemetryInput[] = plan.proposals.map((p) => ({
    kind: "dream.proposal",
    runId: plan.runId,
    scope: plan.scope,
    slug: p.slug,
    sources: p.sources,
    isDuplicate: p.isDuplicate,
    proposalId: p.id,
  }));
  const links: TelemetryInput[] = plan.links.map((l) => ({
    kind: "dream.link",
    runId: plan.runId,
    scope: plan.scope,
    slugs: l.slugs,
    similarity: l.similarity,
    linkId: l.id,
  }));
  return [run, ...proposals, ...links];
}
