import { parseArgs } from "node:util";
import { storePaths, DEFAULT_SCOPE } from "./store.js";
import { resolveRoot, loadStoreConfig } from "./config.js";
import { openDb } from "./index/db.js";
import { reindex } from "./index/reindex.js";
import { searchExplainInstrumented } from "./retrieval/instrumented.js";
import { resolveLexicalFloor, defaultLexicalFloorForModel } from "./retrieval/search.js";
import { newCorrId } from "./telemetry/corr.js";
import { computeStats } from "./observability/stats.js";
import { formatExplain } from "./observability/explain.js";
import { traceEngram, formatTrace } from "./observability/trace.js";
import { writeSnapshot, readSnapshots } from "./observability/snapshot.js";
import { formatSnapshotSeries } from "./observability/format.js";
import { formatStats } from "./observability/format.js";
import { emitEvent } from "./telemetry/events.js";
import { loadTelemetryConfig } from "./telemetry/config.js";
import { purgeTelemetryScope } from "./telemetry/purge.js";
import { getEngramWithRevision } from "./retrieval/get.js";
import { createOllamaClient, probeOllama, resolveEmbeddingDim, DEFAULT_EMBEDDING_MODEL, type EmbeddingClient } from "./embeddings.js";
import { createFakeEmbedder } from "./embeddings.fake.js";
import { resolveScope, resolveScopeStrict, loadScopeMap, scopeMapPath, realpathOrUndefined, resolvesViaCatchAll, catchAllIsIntentionalAt, ensureCatchAllScopeMap } from "./scope/scopemap.js";
import { listScopes } from "./index/walk.js";
import { loadOwnerPolicy, ownsScope } from "./scope/owner.js";
import { rankContext, selectWithinBudget, formatContextDigest, DEFAULT_CONTEXT_MAX_ENTRIES } from "./retrieval/context.js";
import { loadPlan, applyPlan, revertPlan, previewRevert, revalidateSources, partitionProposals, validLinks, PlanNotFoundError, StalePlanError, PlanOverBudgetError, MalformedPlanError } from "./dreaming/apply.js";
import { renderPlan, computeBudgetVerdict } from "./dreaming/plan.js";
import { appendEvalLog } from "./eval/log.js";
import { systemClock } from "./clock.js";
import { homedir } from "node:os";
import {
  codexHookSnippet,
  codexSessionStartEnvelope,
  cwdFromHookPayload,
  hookSnippet,
  installSessionStartHook,
  uninstallSessionStartHook,
  SESSION_START_COMMAND,
} from "./hook.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { scanForSecrets, hasRejectFinding } from "./secrets/scanner.js";
import { rescanStore, formatStoreFinding, formatRescanSummary } from "./secrets/rescan.js";
import { complianceLintStore, formatComplianceFinding, formatComplianceSummary, type ComplianceConfig } from "./compliance/lint.js";
import {
  addMemory,
  ScopeUnresolvedError,
  NotOwnerError,
  SecretDetectedError,
  NoteExistsError,
  FactExistsError,
  SlugTakenError,
  type EngramType,
} from "./write/add.js";
import { NOTE_TYPES, FACT_TYPES } from "./schema.js";
import {
  updateNote,
  NoChangesError,
  NoteNotFoundError,
  DuplicateSlugError,
  NotEditableError,
  IdentityMismatchError,
  RevisionMismatchError,
  NotRegularFileError,
  UnknownSupersederError,
} from "./write/update.js";
import { BodyInputError, resolveBody } from "./write/body.js";
import { ImportUsageError, importClaudeMemory, importFailed, formatImportReport } from "./import/claude.js";
import { LockBusyError } from "./write/lock.js";
import { runUpgrade, UPGRADE_USAGE, updateNotice, versionLine } from "./release.js";

type Out = (s: string) => void;

const ADD_TYPES_HELP = [...FACT_TYPES, ...NOTE_TYPES].join("|");

/**
 * What `mneme <command> --help` prints, one entry per command (MNE-106). Also
 * the list of commands the dispatcher knows: a command without an entry here
 * has no help, and the test that walks this table would not see it.
 */
export const COMMAND_USAGE: Readonly<Record<string, string>> = {
  context: "usage: mneme context [--scope s] [--cwd d] [--budget n] [--emit codex-session-start] [--json] [--root r]",
  search: 'usage: mneme search "<query>" [--scope s] [-k N] [--min-cos c] [--lexical-floor b] [--fusion rrf] [--explain [--all]] [--json] [--root r]',
  explain: 'usage: mneme explain "<query>" [--scope s] [-k N] [--min-cos c] [--lexical-floor b] [--all] [--root r]',
  get: "usage: mneme get <slug> [--scope s] [--json] [--root r]",
  stats: "usage: mneme stats [--json] [--root r]",
  trace: "usage: mneme trace <slug> [--root r]",
  snapshot: "usage: mneme snapshot [--list] [--root r]",
  "purge-telemetry": "usage: mneme purge-telemetry --scope <scope> [--apply] [--root r]",
  reindex: "usage: mneme reindex [--scope s]... [--force-embedder] [--root r]",
  scan: 'usage: mneme scan "<text>" | --file <path> | --scope <s> [--scope <s2>] | --all [--root <path>]',
  "compliance-lint": "usage: mneme compliance-lint --config <path> [--scope <s>]... [--root <path>]",
  scope: "usage: mneme scope [<path>] [--root r]",
  init: "usage: mneme init [--write] [--root r] [--model <name>] [--embedder ollama|none] [--min-cos <n>] [--lexical-floor <n>]",
  "install-hook": "usage: mneme install-hook [--write] [--harness claude-code|codex]",
  "uninstall-hook": "usage: mneme uninstall-hook [--write] [--harness claude-code|codex]",
  add: `usage: mneme add "<content>" | --file <path> --type ${ADD_TYPES_HELP} [--scope s] [--description d] [--importance n] [--slug s]\n`
    + "       a body whose first character is '-' (a bulleted list) must use --file, or come after `--`: mneme add --type t [flags] -- \"- uno\"",
  update: 'usage: mneme update <slug> ["<body>" | --file <path>] --if-match <revision> [--scope s] [--cwd d] [--description d] [--importance n] [--superseded-by <slug> | --status active|superseded|flagged] [--pinned | --unpinned]\n'
    + "       a body whose first character is '-' (a bulleted list) must use --file, or come after `--`: mneme update --if-match <rev> [flags] -- <slug> \"- uno\"",
  "import-claude": "usage: mneme import-claude --source <dir> --source-id <slug> --scope <scope> [--apply] [--root r]",
  dream: "usage: mneme dream apply|revert --run <runId> --scope <scope> [--apply] [--root r]\n"
    + "       dry-run by default (shows what would change); --apply commits the write.",
  upgrade: UPGRADE_USAGE,
};

const GENERAL_USAGE = `usage: mneme <command> [options]   (mneme <command> --help for one command)\ncommands: ${Object.keys(COMMAND_USAGE).join(", ")}`;

/** Options whose value is a filesystem path. */
const PATH_OPTIONS = ["root", "cwd", "file", "source", "config"] as const;

/** The tokens that are options: everything before a bare `--`. */
function optionTokens(args: string[]): string[] {
  const end = args.indexOf("--");
  return end === -1 ? args : args.slice(0, end);
}

/**
 * The first path option handed something that looks like a flag, as an error
 * message, or undefined. `--root --help` and `--root=--help` would otherwise
 * become a directory named `--help` (MNE-106); a path that really starts with
 * a dash can still be written `./-name`.
 */
function flagLikePathValue(args: string[]): string | undefined {
  const tokens = optionTokens(args);
  for (let i = 0; i < tokens.length; i++) {
    for (const name of PATH_OPTIONS) {
      const flag = `--${name}`;
      const tok = tokens[i]!;
      const value = tok === flag ? tokens[i + 1] : tok.startsWith(`${flag}=`) ? tok.slice(flag.length + 1) : undefined;
      if (value !== undefined && value.startsWith("-")) {
        return `${flag} expects a path, got '${value}'. A path that starts with '-' must be written as './${value}'.`;
      }
    }
  }
  return undefined;
}

/** Token budget for the injected digest when neither --budget nor the env var says. */
const DEFAULT_CONTEXT_BUDGET = 1000;

/**
 * The directory whose scope the caller means.
 *
 * Ambient `process.cwd()` is the right answer only while the caller is ephemeral
 * and started in the project — one process per invocation, which is what a
 * session-start hook does. A long-running agent server that multiplexes sessions
 * breaks that: its cwd is wherever it was started, so every session would
 * resolve against that one directory. Only the caller knows which project a
 * given turn belongs to, so it has to be able to say. A relative path resolves
 * against the caller, which is its natural reading; blank is treated as unset,
 * like `--scope ""`.
 */
function callerCwd(flag: string | undefined): string {
  const given = flag?.trim();
  const path = given ? resolve(given) : process.cwd();
  // Canonicalized so a caller passing a symlinked path and `process.cwd()`,
  // which is always already resolved, are asked the same question of the map.
  return realpathOrUndefined(path) ?? path;
}

/**
 * The session cwd a harness reports on the hook's stdin, or undefined when
 * there is nothing readable there.
 *
 * Best-effort by design: a hook that cannot read its own payload still has a
 * process cwd to fall back on, and falling back costs one scope where throwing
 * would cost the whole digest.
 */
function hookPayloadCwd(): string | undefined {
  try {
    return cwdFromHookPayload(readFileSync(0, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * `--importance` as a number, or null when the flag is not one.
 *
 * The schema says the same thing in zod's language, but its error is a JSON
 * dump of issue objects — the one place the CLI would stop speaking its own.
 * Checked at the flag instead, where the caller's typo actually is.
 */
function parseImportance(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
}

/**
 * Flag > env > the store's `.config.json` (MNE-97) > the per-model default.
 * The config value is already a validated number; the other two are text.
 */
function configuredMinCos(flag: string | undefined, root: string): number | undefined {
  const raw = flag ?? process.env.MNEMOSYNE_MIN_COS;
  if (raw === undefined) return loadStoreConfig(root).minCos;
  if (raw.trim() === "") throw new Error("--min-cos must be a number between -1 and 1.");
  const value = Number(raw);
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error("--min-cos must be a number between -1 and 1.");
  }
  return value;
}

function configuredLexicalFloor(flag: string | undefined, root: string): number | undefined {
  const raw = flag ?? process.env.MNEMOSYNE_LEXICAL_FLOOR;
  const value = raw === undefined ? loadStoreConfig(root).lexicalFloor : raw.trim() === "" ? Number.NaN : Number(raw);
  if (value === undefined) return undefined;
  return resolveLexicalFloor(value) ?? undefined;
}

function emptySearchMessage(candidates: { slug: string; scope: string; signals: { relevanceCosine: number } }[], minCos: number | null): string {
  const best = candidates.reduce<(typeof candidates)[number] | undefined>((acc, candidate) =>
    !acc || candidate.signals.relevanceCosine > acc.signals.relevanceCosine ? candidate : acc, undefined);
  if (!best) return "No relevant results; the scope is empty or unindexed.";
  return `No relevant results; best candidate: ${best.slug} [${best.scope}] at cos ${best.signals.relevanceCosine.toFixed(3)}${minCos === null ? "" : ` (minimum ${minCos.toFixed(3)})`}.`;
}

/**
 * The tier for this store: the `MNEMOSYNE_EMBEDDER` env var wins, else the tier
 * `mneme init` persisted in the store's `.config.json`, else undefined (default
 * resolution). `"none"` means tier 0. Read from the store's actual root so a
 * `--root` invocation sees its own config, not the default store's.
 */
function configuredTier(root: string): string | undefined {
  const env = process.env.MNEMOSYNE_EMBEDDER;
  if (env !== undefined) return env;
  try {
    const cfg = JSON.parse(readFileSync(storePaths(root).config, "utf8")) as { embedder?: unknown };
    return typeof cfg.embedder === "string" ? cfg.embedder : undefined;
  } catch {
    return undefined; // no config, unreadable, or malformed → fall through to default
  }
}

function embedder(root: string): EmbeddingClient | null {
  // Tier 0 (MNE-19): no embedder at all. `search`/`context` fall back to BM25
  // over FTS and `reindex` indexes the FTS table only. Explicit on purpose — it
  // never masks a transient Ollama failure as a silent quality drop.
  if (configuredTier(root) === "none") return null;
  if (process.env.MNEMOSYNE_FAKE_EMBED === "1") return createFakeEmbedder();
  // `OLLAMA_MODEL` wins; else the model `init` persisted (MNE-97), so a process
  // that never saw the shell's env still embeds with the model the index holds.
  const model = process.env.OLLAMA_MODEL ?? loadStoreConfig(root).model;
  return createOllamaClient(model === undefined ? {} : { model });
}

function openIndex(root: string) {
  return openDb(storePaths(root).indexDb);
}

export async function runCli(argv: string[], out: Out = console.log, err: Out = console.error): Promise<number> {
  const [command, ...rest] = argv;
  // MNE-106: help is answered before anything can resolve a store, read a path
  // or create a directory. `--` ends the options, so `-- --help` stays content.
  if (command === "--help" || command === "-h" || command === "help") {
    const topic = command === "help" ? rest[0] : undefined;
    out(topic !== undefined && Object.hasOwn(COMMAND_USAGE, topic) ? COMMAND_USAGE[topic]! : GENERAL_USAGE);
    return 0;
  }
  if (command !== undefined && Object.hasOwn(COMMAND_USAGE, command)) {
    // Checked first: in `--root --help` the flag is the path's value, and the
    // answer is the refusal that says so, not a usage that hides the mistake.
    const badPath = flagLikePathValue(rest);
    // compliance-lint reserves exit 1 for findings; its errors are 2.
    if (badPath !== undefined) { err(`${command}: ${badPath}`); return command === "compliance-lint" ? 2 : 1; }
    if (optionTokens(rest).some((a) => a === "--help" || a === "-h")) { out(COMMAND_USAGE[command]!); return 0; }
  }
  // MNE-94: warn on stderr when a write actually resolved through the `~`
  // catch-all (no specific prefix matched this cwd) and more than one scope
  // exists — the moment a context could silently land in the wrong scope. An
  // explicit `--scope` never resolves via the catch-all, a single-scope store has
  // nothing to protect, and a `# catch-all: intentional` marker opts out. Never
  // breaks a successful write: a hygiene warning is best-effort.
  const warnCatchAllWrite = (root: string, cwdArg: string | undefined, resolvedScope: string, explicitScope: string | undefined): void => {
    if (explicitScope) return;
    try {
      const path = scopeMapPath(root);
      if (!resolvesViaCatchAll(loadScopeMap(path, homedir()), callerCwd(cwdArg), homedir())) return;
      const scopeCount = listScopes(root).length;
      if (scopeCount < 2 || catchAllIsIntentionalAt(path)) return;
      err(`warning: this write resolved to scope '${resolvedScope}' via the '~' catch-all in .scopemap (no specific prefix matched this directory) and ${scopeCount} scopes exist. Map this context explicitly with a prefix, or add a '# catch-all: intentional' line to .scopemap to silence this.`);
    } catch { /* a hygiene warning never breaks a successful write */ }
  };
  try {
    switch (command) {
      case "reindex": {
        const { values } = parseArgs({ args: rest, options: { root: { type: "string" }, scope: { type: "string", multiple: true }, "force-embedder": { type: "boolean" } }, allowPositionals: true });
        const root = resolveRoot(values.root);
        const db = openIndex(root);
        // The only place that can consent to re-embedding the whole store:
        // every other entry point reaches reindex lazily, and consent given by
        // something running on its own is not consent.
        const stats = await reindex({ root, db, embedder: embedder(root), clock: systemClock, forceEmbedder: Boolean(values["force-embedder"]), ...(values.scope ? { scopes: values.scope } : {}) });
        if (stats.embeddingMismatch) err("warning: embedding model changed; index fully rebuilt.");
        out(`indexed ${stats.indexed}, skipped ${stats.skipped}, deleted ${stats.deleted}, errors ${stats.errors}`);
        return 0;
      }
      case "search": {
        const { values, positionals } = parseArgs({ args: rest, options: { root: { type: "string" }, scope: { type: "string", multiple: true }, k: { type: "string" }, "min-cos": { type: "string" }, "lexical-floor": { type: "string" }, fusion: { type: "string" }, explain: { type: "boolean" }, all: { type: "boolean" }, json: { type: "boolean" } }, allowPositionals: true });
        const query = positionals.join(" ").trim();
        if (!query) { err("usage: mneme search \"<query>\" [--scope s] [-k N] [--min-cos c] [--lexical-floor b] [--fusion rrf] [--json]"); return 1; }
        if (values.fusion !== undefined && values.fusion !== "rrf") { err("search: --fusion only accepts 'rrf' (hybrid vector+BM25 order); omit it for the default cosine order."); return 1; }
        // --explain renders a human diagnostic table; --json is a machine contract.
        // Silently letting explain win would hand a `--json` caller un-parseable
        // text, so refuse the combination instead of ignoring one of the two.
        if (values.json && values.explain) { err("search: --json and --explain cannot be combined (explain output is not JSON); use `explain` for the diagnostic view."); return 1; }
        const root = resolveRoot(values.root);
        const db = openIndex(root);
        const lazy = await reindex({ root, db, embedder: embedder(root), clock: systemClock, ...(values.scope ? { scopes: values.scope } : {}) }); // lazy reindex before search
        if (lazy.embeddingMismatch) err("warning: embedding model changed; index fully rebuilt.");
        const minCos = configuredMinCos(values["min-cos"], root);
        const lexicalFloor = configuredLexicalFloor(values["lexical-floor"], root);
        const searchOpts = { query, ...(values.scope ? { scopes: values.scope } : {}), ...(values.k ? { k: Number(values.k) } : {}), ...(minCos === undefined ? {} : { minCos }), ...(lexicalFloor === undefined ? {} : { lexicalFloor }), ...(values.fusion === "rrf" ? { fusion: "rrf" as const } : {}) };
        if (values.explain) {
          // Diagnostic path: still instrumented, so an explained search is not
          // a hole in the log — then rendered candidate-by-candidate.
          const corrIdX = newCorrId(systemClock);
          const deps = { db, root, embedder: embedder(root), clock: systemClock };
          const result = await searchExplainInstrumented(deps, searchOpts, corrIdX);
          out(formatExplain(result, values.all ? { limit: null } : {}));
          return result.candidates.some((c) => c.included) ? 0 : 2;
        }
        const corrId = newCorrId(systemClock);
        const result = await searchExplainInstrumented({ db, root, embedder: embedder(root), clock: systemClock }, searchOpts, corrId);
        const hits = result.candidates.filter((c) => c.included);
        if (values.json) {
          // Machine contract: one JSON array, nothing else — even when empty. The
          // "nothing relevant" signal travels in the exit code (2), as it does for
          // the human path, not as prose a parser would choke on.
          out(JSON.stringify(hits.map((h) => ({ slug: h.slug, scope: h.scope, score: h.score, snippet: h.snippet, isDerived: h.isDerived }))));
        } else {
          for (const h of hits) out(`${h.score.toFixed(3)}  ${h.slug}${h.isDerived ? " (derived)" : ""}  [${h.scope}]  ${h.snippet}`);
          if (hits.length === 0) out(emptySearchMessage(result.candidates, result.minCos));
        }
        appendEvalLog(root, { ts: systemClock.nowIso(), cmd: "search", scope: (values.scope ?? []).join(",") || "*", slugs: hits.map((h) => h.slug) });
        return hits.length === 0 ? 2 : 0;
      }
      case "context": {
        let scope = DEFAULT_SCOPE;
        let budget = DEFAULT_CONTEXT_BUDGET;
        /**
         * Read BEFORE parseArgs on purpose. Everything below is wrapped in a
         * catch that must still print something a harness can read, and under
         * Codex "something readable" means the JSON envelope — a bare digest
         * there is dropped without a word. If the flag were parsed with the
         * rest, a typo anywhere on the line would cost the session its memory
         * and look identical to having none.
         */
        const emitCodex = rest.some((a) => a === "codex-session-start" || a === "--emit=codex-session-start")
          && rest.some((a) => a.startsWith("--emit"));
        // Read before parseArgs for the same reason as emitCodex: the catch below
        // must still answer in the caller's format even if argument parsing throws.
        const emitJson = rest.includes("--json");
        /**
         * Root of the store we would log to. Undefined only while the arguments
         * are still unparsed: if parseArgs itself throws we do not know WHICH
         * store this invocation meant, and guessing would write telemetry into
         * an unrelated store — so that one case stays deliberately unrecorded.
         */
        let root: string | undefined;
        /**
         * Why this digest is not what a healthy run would have served. Empty is
         * the healthy case, and the field is then left off the event entirely.
         * Budget truncation is NOT in here: it is deliberate, configured, and
         * already reported by `droppedForBudget`. Conflating the two would peg
         * the degraded rate at 100% for anyone running a tight budget.
         */
        const degraded: string[] = [];
        /** The one thing stdout ever carries, wrapped if the harness needs it. */
        const emitDigest = (digest: string): void => { out(emitCodex ? codexSessionStartEnvelope(digest) : digest); };

        /**
         * What stdout carries this run: the JSON envelope for `--json` consumers
         * (the Hermes provider / MCP wrapper read `context --json` once), or the
         * plain/codex digest otherwise. `degraded` is read at call time, so push
         * every degradation BEFORE emitting.
         */
        const emitResult = (digestOnly: string, includedSlugs: string[], omitted: number): void => {
          // MNE-111: at most one line, from a local cache — never waits on the network.
          const newer = updateNotice({ root: root ?? resolveRoot() });
          const digest = newer ? `${digestOnly}\n${newer}` : digestOnly;
          if (emitJson) { out(JSON.stringify({ scope, budget, digest, included: includedSlugs, omitted, degraded })); return; }
          emitDigest(digest);
        };

        /** Best-effort by contract, exactly like the digest itself. */
        const emitInjected = (injectedSlugs: string[], droppedForBudget: number): void => {
          if (root === undefined) return;
          emitEvent(root, systemClock, {
            kind: "retrieval.injected",
            corrId: newCorrId(systemClock),
            scope,
            budget,
            injectedSlugs,
            droppedForBudget,
            ...(degraded.length > 0 ? { degraded } : {}),
          });
        };
        try {
          const { values } = parseArgs({ args: rest, options: { root: { type: "string" }, scope: { type: "string" }, budget: { type: "string" }, cwd: { type: "string" }, emit: { type: "string" }, json: { type: "boolean" } }, allowPositionals: true });
          root = resolveRoot(values.root);
          // Codex passes no --cwd: the session directory arrives on the hook's
          // stdin. Never read from a terminal, where there is no payload coming
          // and the read would hang until someone types EOF.
          const cwdArg = values.cwd ?? (emitCodex && !process.stdin.isTTY ? hookPayloadCwd() : undefined);
          try {
            const scopeArg = values.scope?.trim();
            scope = scopeArg ? scopeArg : resolveScope(loadScopeMap(scopeMapPath(root), homedir()), callerCwd(cwdArg), DEFAULT_SCOPE);
          } catch { degraded.push("scope-unresolved"); } // fell back to the default scope
          const parsedBudget = Number(values.budget ?? process.env.MNEMOSYNE_CONTEXT_BUDGET);
          budget = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : DEFAULT_CONTEXT_BUDGET;
          const db = openIndex(root);
          // Serving whatever the index already holds is the right call — a stale
          // digest beats no digest — but it can be arbitrarily old, so say so.
          try { await reindex({ root, db, embedder: embedder(root), clock: systemClock, scopes: [scope] }); } catch { degraded.push("reindex-failed"); }
          const ranked = rankContext(db, root, scope, systemClock.now());
          // Selectivity guard (MNE-29): cap the number of lines too, not only the
          // token budget, so a scope of many tiny notes cannot flood the digest.
          const parsedMax = Number(process.env.MNEMOSYNE_CONTEXT_MAX_ENTRIES);
          const maxEntries = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : DEFAULT_CONTEXT_MAX_ENTRIES;
          const { included, omitted } = selectWithinBudget(ranked, budget, maxEntries);
          emitResult(formatContextDigest(included, scope, omitted), included.map((e) => e.slug), omitted);
          // What the agent actually saw this session, and what the budget cut.
          // Injection is the point where memory becomes behaviour, so a scorecard
          // that only measured ranking would miss the truncation entirely.
          emitInjected(included.map((e) => e.slug), omitted);
          appendEvalLog(root, { ts: systemClock.nowIso(), cmd: "context", scope, slugs: included.map((e) => e.slug) });
        } catch {
          // A session beginning with NO memory is the single most important
          // thing this log can record, and it used to be the one thing it
          // recorded nothing about. Push before emitting so `--json` carries it.
          degraded.push("fatal");
          emitResult(formatContextDigest([], scope, 0), [], 0); // never break session start
          emitInjected([], 0);
        }
        if (degraded.length > 0) {
          // stdout stays a clean digest for the agent; the human gets the
          // warning. The durable signal is the event above — a hook's stderr
          // reaches nobody reliably when the hook exits 0.
          err(`warning: memory digest degraded (${degraded.join(", ")}); this session may be missing memory.`);
        }
        // MNE-94: the catch-all hazard is warned about PER WRITE now (in `add`
        // and `update`, when a write actually resolves through the catch-all), not
        // per condition here. A read never routes a write, so warning on every
        // `context` was a recurring false positive in a correct, deliberate setup
        // (personal + work, all mapped). `snapshot` still records the condition as
        // the durable signal.
        return 0;
      }
      case "explain": {
        const { values, positionals } = parseArgs({ args: rest, options: { root: { type: "string" }, scope: { type: "string", multiple: true }, k: { type: "string" }, "min-cos": { type: "string" }, "lexical-floor": { type: "string" }, all: { type: "boolean" } }, allowPositionals: true });
        const query = positionals.join(" ").trim();
        if (!query) { err("usage: mneme explain \"<query>\" [--scope s] [-k N] [--min-cos c] [--lexical-floor b]"); return 1; }
        const root = resolveRoot(values.root);
        const db = openIndex(root);
        await reindex({ root, db, embedder: embedder(root), clock: systemClock, ...(values.scope ? { scopes: values.scope } : {}) });
        const deps = { db, root, embedder: embedder(root), clock: systemClock };
        const minCos = configuredMinCos(values["min-cos"], root);
        const lexicalFloor = configuredLexicalFloor(values["lexical-floor"], root);
        const opts = { query, ...(values.scope ? { scopes: values.scope } : {}), ...(values.k ? { k: Number(values.k) } : {}), ...(minCos === undefined ? {} : { minCos }), ...(lexicalFloor === undefined ? {} : { lexicalFloor }) };
        out(formatExplain(await searchExplainInstrumented(deps, opts, newCorrId(systemClock)), values.all ? { limit: null } : {}));
        return 0;
      }
      case "snapshot": {
        const { values } = parseArgs({ args: rest, options: { root: { type: "string" }, list: { type: "boolean" } }, allowPositionals: true });
        const root = resolveRoot(values.root);
        if (values.list) {
          out(formatSnapshotSeries(readSnapshots(root)));
          return 0;
        }
        out(`wrote ${writeSnapshot(openIndex(root), root, systemClock)}`);
        return 0;
      }
      case "purge-telemetry": {
        const { values } = parseArgs({
          args: rest,
          options: { root: { type: "string" }, scope: { type: "string" }, apply: { type: "boolean" } },
          allowPositionals: true,
        });
        const scope = values.scope?.trim();
        if (!scope) { err("usage: mneme purge-telemetry --scope <scope> [--apply]"); return 1; }
        const root = resolveRoot(values.root);
        // Simulating is the DEFAULT and --apply the opt-in, not the other way
        // round: this deletes data that cannot be regenerated, and it is run
        // on the day a client relationship ends — the worst moment to discover
        // a typo in a scope name.
        const r = purgeTelemetryScope(root, scope, { dryRun: !values.apply });
        out(r.dryRun ? `DRY RUN — nothing written. Would purge scope '${scope}':` : `Purged scope '${scope}':`);
        out(`  events removed        ${r.eventsRemoved}`);
        out(`  events narrowed       ${r.eventsNarrowed}   (multi-scope, kept without '${scope}')`);
        out(`  day files rewritten   ${r.filesRewritten}`);
        out(`  day files deleted     ${r.filesDeleted}`);
        out(`  snapshots redacted    ${r.snapshotsRedacted}`);
        if (r.snapshotsRedacted > 0) {
          out(`\n  note: snapshot aggregates (countsByType, strengthHistogram) have no per-scope`);
          out(`  breakdown, so '${scope}' stays folded into those totals. The scope name and its`);
          out(`  size are gone; delete the snapshots outright if even the totals are unacceptable.`);
        }
        if (r.dryRun && (r.eventsRemoved > 0 || r.snapshotsRedacted > 0)) {
          out(`\n  re-run with --apply to write these changes.`);
        }
        return 0;
      }
      case "trace": {
        const { values, positionals } = parseArgs({ args: rest, options: { root: { type: "string" } }, allowPositionals: true });
        const slug = positionals[0];
        if (!slug) { err("usage: mneme trace <slug>"); return 1; }
        const root = resolveRoot(values.root);
        out(formatTrace(traceEngram(root, slug), slug));
        return 0;
      }
      case "stats": {
        const { values } = parseArgs({ args: rest, options: { root: { type: "string" }, json: { type: "boolean" } }, allowPositionals: true });
        const root = resolveRoot(values.root);
        const stats = computeStats(openIndex(root), root);
        out(values.json ? JSON.stringify(stats, null, 2) : formatStats(stats));
        // On-screen stats show everything; snapshots do not. Say so, so the
        // difference between the two is never a surprise.
        const excluded = loadTelemetryConfig(root).excludeScopes;
        if (!values.json && excluded.length > 0) {
          out(`\n  (scope${excluded.length > 1 ? "s" : ""} ${excluded.join(", ")} shown here but excluded from snapshots)`);
        }
        return 0;
      }
      case "get": {
        const { values, positionals } = parseArgs({ args: rest, options: { root: { type: "string" }, scope: { type: "string" }, json: { type: "boolean" } }, allowPositionals: true });
        const slug = positionals[0];
        if (!slug) { err("usage: mneme get <slug> [--scope s] [--json]"); return 1; }
        const root = resolveRoot(values.root);
        const db = openIndex(root);
        const doc = getEngramWithRevision(db, root, slug, systemClock, values.scope);
        // --json is the machine contract behind `update`: one object, nothing
        // else on stdout, and a revision taken from the same read as `content`.
        if (values.json) {
          out(JSON.stringify({ slug: doc.slug, scope: doc.scope, path: doc.path, content: doc.content, revision: doc.revision }));
          return 0;
        }
        out(doc.content);
        return 0;
      }
      case "install-hook": {
        const { values } = parseArgs({ args: rest, options: { write: { type: "boolean" }, harness: { type: "string" } }, allowPositionals: true });
        const harness = values.harness?.trim() || "claude-code";
        if (harness !== "claude-code" && harness !== "codex") {
          err(`unknown harness: ${harness}. Supported: claude-code, codex.`);
          return 1;
        }
        // Codex reads `hooks.json` from CODEX_HOME, and a hook it has not been
        // told to trust never runs — without a word about why. Everything else
        // is the same file surgery as Claude Code's settings.
        const codex = harness === "codex";
        const settingsPath = codex
          ? join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "hooks.json")
          : join(homedir(), ".claude", "settings.json");
        const snippet = codex ? codexHookSnippet() : hookSnippet();
        const trustNote = codex
          ? "\n\nThen open Codex and trust it: /hooks. Until you do, the hook is inert and Codex will not tell you so."
          : "";
        if (!values.write) {
          out(`Add this to ${settingsPath}:\n\n${snippet}${trustNote}`);
          return 0;
        }
        const hookResult = installSessionStartHook(settingsPath, { codex });
        if (hookResult === "parse-error") {
          err(`Could not parse ${settingsPath}; not modifying it. Paste manually:\n\n${snippet}`);
          return 1;
        }
        out(`${hookResult === "unchanged" ? "SessionStart hook already in" : "Installed SessionStart hook into"} ${settingsPath}.${trustNote}`);
        return 0;
      }
      case "uninstall-hook": {
        // MNE-97: the installer's uninstall. Dry run by default, like init.
        const { values } = parseArgs({ args: rest, options: { write: { type: "boolean" }, harness: { type: "string" } }, allowPositionals: true });
        const harness = values.harness?.trim() || "claude-code";
        if (harness !== "claude-code" && harness !== "codex") {
          err(`unknown harness: ${harness}. Supported: claude-code, codex.`);
          return 1;
        }
        const settingsPath = harness === "codex"
          ? join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "hooks.json")
          : join(homedir(), ".claude", "settings.json");
        const result = uninstallSessionStartHook(settingsPath, { dryRun: !values.write });
        if (result.status === "parse-error") {
          err(`Could not parse ${settingsPath}; not modifying it. Remove any 'mneme context' SessionStart hook by hand.`);
          return 1;
        }
        if (result.status === "absent") { out(`No Mnemosyne SessionStart hook in ${settingsPath}; nothing to remove.`); return 0; }
        const list = result.removed.map((c) => `  ${c}`).join("\n");
        out(values.write
          ? `Removed from ${settingsPath}:\n${list}`
          : `Would remove from ${settingsPath} (dry run — pass --write to apply):\n${list}`);
        return 0;
      }
      case "init": {
        const { values } = parseArgs({ args: rest, options: { root: { type: "string" }, write: { type: "boolean" }, model: { type: "string" }, embedder: { type: "string" }, "min-cos": { type: "string" }, "lexical-floor": { type: "string" } }, allowPositionals: true });
        // Absolute, and independent of the invoking environment: the hook runs in
        // future sessions with a different cwd and without this process's env, so
        // a relative or MNEMOSYNE_ROOT-derived path would target the wrong store.
        const root = resolve(resolveRoot(values.root));
        const paths = storePaths(root);
        const settingsPath = join(homedir(), ".claude", "settings.json");
        // Always bake the absolute store root into the hook, even for the default
        // location: a bare `mneme context` follows MNEMOSYNE_ROOT at session time
        // and could read a different store than the one just initialized.
        // Single-quoted for the shell.
        const quoteArg = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
        const hookCommand = `${SESSION_START_COMMAND} --root ${quoteArg(root)}`;

        // MNE-97: the embedding settings are persisted so the normal case needs no
        // env vars. Each comes from the flag, else the env var present right now
        // (so a ~/.zshenv setup is captured once and can then be dropped), else
        // what this store's config already says — a re-run (the installer's
        // `update`) preserves rather than re-decides. Validated BEFORE anything
        // is written: a half-applied init is worse than a refused one.
        let existing: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(readFileSync(paths.config, "utf8")) as unknown;
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
        } catch { /* no config yet, or unreadable: start fresh, as before */ }
        const prior = loadStoreConfig(root);
        if (values.embedder !== undefined && values.embedder !== "ollama" && values.embedder !== "none") {
          err(`init: --embedder must be 'ollama' or 'none', got '${values.embedder}'.`);
          return 1;
        }
        const explicitModel = values.model?.trim() || process.env.OLLAMA_MODEL?.trim() || prior.model;
        if (explicitModel !== undefined) resolveEmbeddingDim(explicitModel, process.env.OLLAMA_EMBEDDING_DIM); // unknown model → throws
        const minCos = configuredMinCos(values["min-cos"], root);
        const configuredFloor = configuredLexicalFloor(values["lexical-floor"], root);
        if (minCos !== undefined && (minCos < -1 || minCos > 1)) { err("init: --min-cos must be a number between -1 and 1."); return 1; }
        // Tier: an explicit flag, else the tier this store already has (an
        // Ollama that is down during an update must not demote a working store),
        // else detection: the embedder if Ollama serves the model, tier 0 (BM25
        // over FTS) otherwise. The probe never throws.
        // Probe for the model this store will actually use, not the bare default.
        const hasOllama = await probeOllama(undefined, explicitModel);
        const priorTier = typeof existing.embedder === "string" ? existing.embedder : undefined;
        const tier = values.embedder ?? priorTier ?? (hasOllama ? "ollama" : "none");
        const model = explicitModel ?? (tier === "ollama" ? DEFAULT_EMBEDDING_MODEL : undefined);
        // MNE-97: a v2-moe store on the embedder tier gets the calibrated lexical
        // rescue unless something already says otherwise (flag, env, or a value
        // this store's config holds). Tier 0 ranks by BM25 and ignores it.
        const lexicalFloor = configuredFloor
          ?? (tier === "ollama" && model !== undefined ? defaultLexicalFloorForModel(model) : undefined);
        const nextConfig: Record<string, unknown> = {
          ...existing,
          embedder: tier,
          ...(model === undefined ? {} : { model }),
          ...(minCos === undefined ? {} : { minCos }),
          ...(lexicalFloor === undefined ? {} : { lexicalFloor }),
        };
        const tierLine = tier === "ollama"
          ? `embedder (Ollama, model ${model})${hasOllama ? "" : " — but Ollama does not serve it right now"}`
          : "0 — no embedder; search/context use BM25 over FTS";
        if (!values.write) {
          out([
            "mneme init (dry run — pass --write to apply):",
            `  hook:     SessionStart -> "${hookCommand}" in ${settingsPath}`,
            `  scopemap: ${paths.scopeMap} (catch-all '~ = ${DEFAULT_SCOPE}')`,
            `  tier:     ${tierLine}`,
            `  config:   ${paths.config}`,
            ...JSON.stringify(nextConfig, null, 2).split("\n").map((l) => `            ${l}`),
          ].join("\n"));
          return 0;
        }
        const hookResult = installSessionStartHook(settingsPath, { root });
        if (hookResult === "parse-error") {
          err(`Could not parse ${settingsPath}; not modifying it. Fix or remove it and re-run 'mneme init --write'.`);
          return 1;
        }
        const wroteScopeMap = ensureCatchAllScopeMap(paths.scopeMap, DEFAULT_SCOPE);
        // Persist the tier so EVERY mneme invocation honours it, not just the
        // hook. `MNEMOSYNE_EMBEDDER` still overrides this at runtime.
        mkdirSync(dirname(paths.config), { recursive: true });
        const configText = `${JSON.stringify(nextConfig, null, 2)}\n`;
        const configChanged = !existsSync(paths.config) || readFileSync(paths.config, "utf8") !== configText;
        if (configChanged) writeFileSync(paths.config, configText);
        if (tier === "ollama" && !hasOllama) {
          err(`warning: Ollama is not serving '${model}' right now. Start Ollama and run 'ollama pull ${model}'; until then search fails (or choose tier 0 with 'mneme init --write --embedder none').`);
        }
        if (tier === "none" && hasOllama && priorTier === "none" && values.embedder === undefined) {
          err("note: Ollama is available, but this store stays on tier 0 as configured. Switch with 'mneme init --write --embedder ollama'.");
        }
        out([
          hookResult === "unchanged" ? `SessionStart hook already in ${settingsPath}.` : `Installed SessionStart hook into ${settingsPath}.`,
          wroteScopeMap ? `Wrote ${paths.scopeMap} (catch-all '~ = ${DEFAULT_SCOPE}').` : `Left existing ${paths.scopeMap} untouched.`,
          tier === "ollama" ? `Tier: embedder (Ollama, model ${model}).` : "Tier 0: no embedder; search/context use BM25 over FTS.",
          configChanged ? `Wrote ${paths.config}.` : `Left ${paths.config} unchanged.`,
        ].join("\n"));
        return 0;
      }
      case "scan": {
        const { values, positionals } = parseArgs({ args: rest, options: { file: { type: "string" }, scope: { type: "string", multiple: true }, all: { type: "boolean" }, root: { type: "string" } }, allowPositionals: true });
        const scanUsage = COMMAND_USAGE.scan!;
        // Same command, same exit code, one more input: a whole store instead of
        // one text. The write-path gate never sees a note edited by hand, so the
        // re-scan lives where someone already looks for "is this clean?".
        const storeMode = Boolean(values.all) || (values.scope?.length ?? 0) > 0;
        if (storeMode) {
          if (values.file !== undefined || positionals.length > 0) { err(scanUsage); return 1; }
          if (values.all && (values.scope?.length ?? 0) > 0) { err(scanUsage); return 1; }
          const root = resolveRoot(values.root);
          // Streamed: one note in memory at a time, printed as it is found, so a
          // large store neither buffers nor waits to say the first thing.
          const summary = rescanStore(root, (f) => out(formatStoreFinding(f)), values.all ? {} : { scopes: values.scope ?? [] });
          out(formatRescanSummary(summary));
          return summary.rejectCount > 0 ? 1 : 0;
        }
        let text: string;
        if (values.file) {
          text = readFileSync(values.file, "utf8");
        } else {
          text = positionals.join(" ");
        }
        if (!text.trim()) { err(scanUsage); return 1; }
        const findings = scanForSecrets(text);
        for (const f of findings) out(`${f.severity}  ${f.pattern}  L${f.line}  ${f.masked}`);
        return hasRejectFinding(findings) ? 1 : 0;
      }
      case "compliance-lint": {
        // Exit codes are three-valued ON PURPOSE (acceptance): a hit, an error
        // and a clean scan must be distinguishable by a cron wrapper.
        //   0 = clean, 1 = findings, 2 = error (bad usage / config / scope /
        //   incomplete scan). Every failure path — including parseArgs throwing
        //   on a bad flag and any unexpected error — maps to 2, never to the
        //   generic exit 1, so automation never mistakes a failure for a leak.
        const usage = COMMAND_USAGE["compliance-lint"]!;
        try {
          const { values } = parseArgs({ args: rest, options: { config: { type: "string" }, scope: { type: "string", multiple: true }, root: { type: "string" } }, allowPositionals: false });
          if (!values.config) { err(usage); return 2; }
          const root = resolveRoot(values.root);
          // The config carries client-entity terms; it must live on the authorized
          // boundary, NOT inside a synced store — copying it in to scan would be the
          // very leak this tool guards against. Compare CANONICAL paths so a symlink
          // (or a symlinked store root) cannot smuggle the config inside the store.
          let realConfig: string;
          try {
            realConfig = realpathSync(resolve(values.config));
          } catch (error) {
            err(`compliance-lint: cannot read config at ${values.config}: ${error instanceof Error ? error.message : String(error)}`);
            return 2;
          }
          let realRoot: string;
          try {
            realRoot = realpathSync(resolve(root));
          } catch {
            realRoot = resolve(root); // store dir may not exist yet; nothing can be inside it
          }
          if (realConfig === realRoot || realConfig.startsWith(realRoot + sep)) {
            err(`compliance-lint: the config resolves inside the store (${realRoot}). Keep client entities on the authorized boundary, not in a synced store.`);
            return 2;
          }
          let config: ComplianceConfig;
          try {
            config = JSON.parse(readFileSync(realConfig, "utf8")) as ComplianceConfig;
          } catch {
            // A JSON syntax error can echo a snippet of the file (which holds
            // client entities). Never print the parser's message — just say it is
            // invalid, so a sensitive term cannot leak into a cron log.
            err("compliance-lint: config is not valid JSON");
            return 2;
          }
          const summary = complianceLintStore(root, config, (f) => out(formatComplianceFinding(f)), values.scope ? { scopes: values.scope } : {});
          out(formatComplianceSummary(summary));
          // An unreadable file means the scan could not see everything: report it
          // as an error, not a clean pass — a reader must not trust "clean" over a
          // file nobody could open. Incomplete trumps both clean and findings.
          if (summary.unreadable.length > 0) return 2;
          return summary.findings > 0 ? 1 : 0;
        } catch (error) {
          err(`compliance-lint: ${error instanceof Error ? error.message : String(error)}`);
          return 2;
        }
      }
      case "scope": {
        const { values, positionals } = parseArgs({ args: rest, options: { root: { type: "string" } }, allowPositionals: true });
        // Canonicalized exactly like a write's cwd: this command is the gate a
        // human uses BEFORE importing into a scope, so it must answer the same
        // question `add`/`update`/`context` ask of the map, not a lookalike.
        const path = callerCwd(positionals[0]);
        const root = resolveRoot(values.root);
        const scope = resolveScopeStrict(loadScopeMap(scopeMapPath(root), homedir()), path);
        if (scope === null) {
          out("unmapped → pass --scope");
          return 0;
        }
        const owned = ownsScope(loadOwnerPolicy(storePaths(root).ownerPolicy), scope);
        out(`${scope}  ${owned ? "owned" : "not owned by this machine"}`);
        return 0;
      }
      case "add": {
        const { values, positionals } = parseArgs({
          args: rest,
          options: {
            type: { type: "string" }, scope: { type: "string" }, description: { type: "string" },
            importance: { type: "string" }, slug: { type: "string" }, root: { type: "string" },
            cwd: { type: "string" }, file: { type: "string" },
          },
          allowPositionals: true,
        });
        // Kept in sync with the schema so a new type (e.g. snapshot, MNE-29) is
        // accepted here the moment it is added to NOTE_TYPES/FACT_TYPES.
        const ADD_TYPES = [...FACT_TYPES, ...NOTE_TYPES] as readonly string[];
        const usage = COMMAND_USAGE.add!;
        const type = values.type ?? "";
        if (!ADD_TYPES.includes(type)) { err(`--type is required: ${ADD_TYPES.join(" | ")}`); return 1; }
        let importance: number | undefined;
        if (values.importance !== undefined) {
          const parsed = parseImportance(values.importance);
          if (parsed === null) { err(`--importance must be a whole number between 1 and 10 (got '${values.importance}')`); return 1; }
          importance = parsed;
        }
        const root = resolveRoot(values.root);
        try {
          // Inside the try: a bad --file is a refusal of THIS command and gets
          // the same treatment (message + usage) as every other one.
          const content = resolveBody(positionals.join(" "), values.file);
          if (content === undefined) { err(usage); return 1; }
          const res = addMemory(
            { root, cwd: callerCwd(values.cwd), home: homedir(), now: systemClock.nowIso().slice(0, 19) },
            {
              content, type: type as EngramType,
              ...(values.scope ? { scope: values.scope } : {}),
              ...(values.description ? { description: values.description } : {}),
              ...(importance !== undefined ? { importance } : {}),
              ...(values.slug ? { slug: values.slug } : {}),
            },
          );
          out(`wrote ${res.kind} [${res.scope}] ${res.slug} → ${res.path}`);
          warnCatchAllWrite(root, values.cwd, res.scope, values.scope);
          return 0;
        } catch (e) {
          if (e instanceof ScopeUnresolvedError) { err("cannot resolve a scope for this cwd; pass --scope explicitly (write is fail-closed — it never defaults to personal)"); return 1; }
          if (e instanceof NotOwnerError) { err(`this machine does not own scope '${e.scope}'. Declare it in ${storePaths(root).ownerPolicy} ({"owns":[...]}), or write from a machine that owns it.`); return 1; }
          if (e instanceof SecretDetectedError) { err("refusing to write — possible secret(s) detected:"); for (const f of e.findings) err(`  ${f.pattern} (line ${f.line}): ${f.masked}`); return 1; }
          if (e instanceof NoteExistsError) {
            // Notes are canonical: the way to change one is a checked update, not a hand edit.
            const existing = basename(e.path, ".md");
            err(`note already exists: ${e.path}. Read it with \`mneme get ${existing} --json\` and rewrite it with \`mneme update ${existing} --if-match <revision>\`.`);
            return 1;
          }
          if (e instanceof FactExistsError) { err(`fact already exists: ${e.path} (facts are append-only; retry to get a fresh id)`); return 1; }
          if (e instanceof SlugTakenError) {
            // (scope, slug) is unique in the index, so a second document under
            // the same slug would be on disk and retrievable by nothing.
            err(`slug '${e.slug}' is already claimed in scope '${e.scope}' by ${e.path}. Nothing was written — pass a different --slug (a slug identifies exactly one memory in a scope, feedback facts included).`);
            return 1;
          }
          if (e instanceof BodyInputError) { err(`${e.message}\n${usage}`); return 1; }
          if (e instanceof LockBusyError) { err(`another mneme write holds this scope: ${e.lockPath}${e.holder ? ` (held by ${e.holder})` : ""}. Locks are never broken by age — check no mneme process is still writing, then remove that file.`); return 1; }
          err((e as Error).message); return 1;
        }
      }
      case "update": {
        const { values, positionals } = parseArgs({
          args: rest,
          options: {
            "if-match": { type: "string" }, scope: { type: "string" }, description: { type: "string" },
            importance: { type: "string" }, root: { type: "string" }, cwd: { type: "string" },
            file: { type: "string" }, status: { type: "string" }, "superseded-by": { type: "string" },
            pinned: { type: "boolean" }, unpinned: { type: "boolean" },
          },
          allowPositionals: true,
        });
        const usage = COMMAND_USAGE.update!;
        const slug = positionals[0];
        if (!slug) { err(usage); return 1; }
        const ifMatch = values["if-match"]?.trim();
        // Never optional: without it this would be a blind overwrite, which is
        // the exact failure `update` exists to prevent.
        if (!ifMatch) { err(`--if-match <revision> is required. Read the note first: \`mneme get ${slug} --json\`.\n${usage}`); return 1; }
        let importance: number | undefined;
        if (values.importance !== undefined) {
          const parsed = parseImportance(values.importance);
          if (parsed === null) { err(`--importance must be a whole number between 1 and 10 (got '${values.importance}')`); return 1; }
          importance = parsed;
        }
        // Validated here rather than let through to a schema error: the caller
        // typed a word, and the answer to a mistyped word is the list of words.
        const STATUSES = ["active", "superseded", "flagged"] as const;
        type Status = (typeof STATUSES)[number];
        let status: Status | undefined;
        if (values.status !== undefined) {
          const given = values.status.trim();
          if (!(STATUSES as readonly string[]).includes(given)) {
            err(`--status must be one of ${STATUSES.join(", ")} (got '${given}')`);
            return 1;
          }
          status = given as Status;
        }
        // Pin/unpin (MNE-62). Mutually exclusive: the two contradict, so refuse
        // rather than silently letting one win.
        if (values.pinned && values.unpinned) { err("--pinned and --unpinned cannot be combined"); return 1; }
        const pinned: boolean | undefined = values.pinned ? true : values.unpinned ? false : undefined;
        const root = resolveRoot(values.root);
        try {
          // Inside the try, like every other refusal of this command.
          const content = resolveBody(positionals.slice(1).join(" "), values.file);
          const res = updateNote(
            { root, cwd: callerCwd(values.cwd), home: homedir() },
            {
              slug, ifMatch,
              ...(content !== undefined ? { content } : {}),
              ...(values.scope ? { scope: values.scope } : {}),
              ...(values.description ? { description: values.description } : {}),
              ...(importance !== undefined ? { importance } : {}),
              ...(status !== undefined ? { status } : {}),
              ...(values["superseded-by"] ? { supersededBy: values["superseded-by"].trim() } : {}),
              ...(pinned !== undefined ? { pinned } : {}),
            },
          );
          out(`updated note [${res.scope}] ${res.slug} → ${res.path} (revision ${res.revision})`);
          warnCatchAllWrite(root, values.cwd, res.scope, values.scope);
          return 0;
        } catch (e) {
          if (e instanceof NoChangesError) { err(`${e.message}\n${usage}`); return 1; }
          if (e instanceof BodyInputError) { err(`${e.message}\n${usage}`); return 1; }
          if (e instanceof ScopeUnresolvedError) { err("cannot resolve a scope for this cwd; pass --scope explicitly (write is fail-closed — it never defaults to personal)"); return 1; }
          if (e instanceof NotOwnerError) { err(`this machine does not own scope '${e.scope}'. Declare it in ${storePaths(root).ownerPolicy} ({"owns":[...]}), or write from a machine that owns it.`); return 1; }
          if (e instanceof NoteNotFoundError) { err(`${e.message}. \`update\` never creates a note — use \`mneme add\` for a new one.`); return 1; }
          if (e instanceof UnknownSupersederError) { err(`${e.message}. Write the replacement first, or check the slug — a pointer at a note that does not exist hides this one and names nothing readable.`); return 1; }
          if (e instanceof DuplicateSlugError) { err(`${e.message}. Resolve the duplicate by hand (rename or delete one) before updating.`); return 1; }
          if (e instanceof NotEditableError) { err(`${e.message}. Facts are append-only — record a new one with \`mneme add ... --type feedback\`.`); return 1; }
          if (e instanceof IdentityMismatchError) { err(`${e.message}. Fix the file by hand; \`update\` never changes a memory's identity.`); return 1; }
          if (e instanceof RevisionMismatchError) {
            // No retry, no --force: the other writer's content is on disk and
            // only the caller can decide how to merge its own edit into it.
            err(`conflict: ${slug} changed since you read it (on disk ${e.actual}, --if-match ${e.expected}). Nothing was written.`);
            err(`Re-read it with \`mneme get ${slug} --json\`, reconcile your edit against that content, and update again with the revision it returns.`);
            return 1;
          }
          if (e instanceof NotRegularFileError) { err(`${e.message} (a symlink or device where a note should be). Refusing to write through it.`); return 1; }
          if (e instanceof SecretDetectedError) { err("refusing to write — possible secret(s) detected:"); for (const f of e.findings) err(`  ${f.pattern} (line ${f.line}): ${f.masked}`); return 1; }
          if (e instanceof LockBusyError) { err(`another mneme write holds this scope: ${e.lockPath}${e.holder ? ` (held by ${e.holder})` : ""}. Locks are never broken by age — check no mneme process is still writing, then remove that file.`); return 1; }
          err((e as Error).message); return 1;
        }
      }
      case "import-claude": {
        const { values } = parseArgs({
          args: rest,
          options: {
            source: { type: "string" }, "source-id": { type: "string" }, scope: { type: "string" },
            apply: { type: "boolean" }, root: { type: "string" },
          },
          allowPositionals: true,
        });
        const usage = COMMAND_USAGE["import-claude"]!;
        const source = values.source?.trim();
        if (!source) { err(usage); return 1; }
        const root = resolveRoot(values.root);
        try {
          // Dry run is the DEFAULT and --apply the opt-in: this creates memories
          // in a scope the operator named by hand, from a directory nobody has
          // reviewed yet. The report is the review.
          const report = importClaudeMemory(
            { root, home: homedir(), now: systemClock.nowIso().slice(0, 19), clock: systemClock },
            {
              // Relative is the natural reading for a path typed at a shell; the
              // report echoes the absolute one actually used.
              source: resolve(source),
              sourceId: values["source-id"]?.trim() ?? "",
              scope: values.scope?.trim() ?? "",
              apply: Boolean(values.apply),
            },
          );
          for (const line of formatImportReport(report)) out(line);
          // Conflicts and failures need a human: never a silent 0.
          return importFailed(report) ? 1 : 0;
        } catch (e) {
          if (e instanceof ImportUsageError) { err(`${e.message}\n${usage}`); return 1; }
          if (e instanceof LockBusyError) { err(`another mneme write holds this scope: ${e.lockPath}${e.holder ? ` (held by ${e.holder})` : ""}. Locks are never broken by age — check no mneme process is still writing, then remove that file.`); return 1; }
          if (e instanceof NotOwnerError) { err(`this machine does not own scope '${e.scope}'. Declare it in ${storePaths(root).ownerPolicy} ({"owns":[...]}), or write from a machine that owns it.`); return 1; }
          err((e as Error).message); return 1;
        }
      }
      case "dream": {
        const { values, positionals } = parseArgs({
          args: rest,
          options: { run: { type: "string" }, scope: { type: "string" }, root: { type: "string" }, apply: { type: "boolean" } },
          allowPositionals: true,
        });
        const verb = positionals[0];
        const usage = COMMAND_USAGE.dream!;
        if (verb !== "apply" && verb !== "revert") { err(usage); return 1; }
        const run = values.run?.trim();
        const scope = values.scope?.trim();
        if (!run || !scope) { err(usage); return 1; }
        const root = resolveRoot(values.root);
        const commit = Boolean(values.apply);
        const now = systemClock.nowIso().slice(0, 19);
        try {
          if (verb === "apply") {
            const plan = loadPlan(root, scope, run);
            if (!commit) {
              // Dry run: show exactly the batch --apply would accept. Validate and
              // filter proposals the same way apply does, so renderPlan never trips
              // on a malformed one and the budget matches what apply will enforce.
              const { valid, malformed } = partitionProposals(plan.proposals);
              const links = validLinks(plan.links);
              out(renderPlan({ ...plan, proposals: valid, links }));
              for (const m of malformed) out(`would skip ${m.slug} (invalid-schema)`);
              const stale = revalidateSources(root, plan);
              if (stale.length > 0) out(`STALE: ${stale.length} source(s) changed since the plan was built: ${stale.map((s) => s.slug).join(", ")}`);
              const bv = computeBudgetVerdict(valid, links, plan.budget);
              if (!bv.within) out(`OVER BUDGET (recomputed): notes ${bv.notes.proposed}/${bv.notes.limit}, links ${bv.links.proposed}/${bv.links.limit}${bv.oversizeNotes.length > 0 ? `, ${bv.oversizeNotes.length} oversize` : ""} — will be rejected on --apply.`);
              out("(dry run — re-run with --apply to write these derived notes)");
              return 0;
            }
            const res = applyPlan({ root, now, clock: systemClock }, plan);
            // Report the committed mutation FIRST — it has already happened.
            for (const a of res.applied) out(`applied ${a.slug} → ${a.path}`);
            for (const s of res.skipped) out(`skipped ${s.slug} (${s.reason})`);
            if (res.linksSkipped > 0) out(`links not applied (${res.linksSkipped}): v1 creates derived notes only`);
            out(`done: ${res.applied.length} applied, ${res.skipped.length} skipped`);
            // Reindex is a SEPARATE, self-healing step: a failure here does not undo
            // the writes above (lazy reindex catches up on the next search/context).
            try {
              await reindex({ root, db: openIndex(root), embedder: embedder(root), clock: systemClock, scopes: [scope] });
            } catch (ri) {
              err(`warning: changes applied, but reindex failed (${(ri as Error).message}). Run \`mneme reindex --scope ${scope}\` to make them searchable.`);
            }
            return 0;
          }
          // verb === "revert"
          if (!commit) {
            const prev = previewRevert({ root, now, clock: systemClock }, scope, run);
            for (const r of prev.wouldRevert) out(`would revert ${r.slug}`);
            for (const k of prev.kept) out(`would keep ${k.slug} (${k.reason})`);
            out(`(dry run — re-run with --apply to revert ${prev.wouldRevert.length} note(s))`);
            return 0;
          }
          const res = revertPlan({ root, now, clock: systemClock }, scope, run);
          for (const r of res.reverted) out(`reverted ${r.slug}`);
          for (const k of res.kept) out(`kept ${k.slug} (${k.reason})`);
          out(`done: ${res.reverted.length} reverted, ${res.kept.length} kept`);
          try {
            await reindex({ root, db: openIndex(root), embedder: embedder(root), clock: systemClock, scopes: [scope] });
          } catch (ri) {
            err(`warning: changes reverted, but reindex failed (${(ri as Error).message}). Run \`mneme reindex --scope ${scope}\` to update the index.`);
          }
          return 0;
        } catch (e) {
          if (e instanceof PlanNotFoundError) { err(e.message); return 1; }
          if (e instanceof MalformedPlanError) { err(e.message); return 1; }
          if (e instanceof StalePlanError) { err(`${e.message}\nre-build the plan: its sources changed since review.`); return 1; }
          if (e instanceof PlanOverBudgetError) { err("plan is over budget; re-review and re-build it rather than applying."); return 1; }
          if (e instanceof NotOwnerError) { err(`this machine does not own scope '${e.scope}'. Declare it in ${storePaths(root).ownerPolicy} ({"owns":[...]}), or apply from a machine that owns it.`); return 1; }
          if (e instanceof LockBusyError) { err(`another mneme write holds this scope: ${e.lockPath}${e.holder ? ` (held by ${e.holder})` : ""}.`); return 1; }
          err((e as Error).message); return 1;
        }
      }
      case "--version":
      case "-V": {
        out(versionLine());
        return 0;
      }
      case "upgrade":
        return runUpgrade(rest, { err });
      default:
        err(`unknown command: ${command ?? "(none)"}. Commands: ${Object.keys(COMMAND_USAGE).join(", ")}.`);
        return 1;
    }
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
}
