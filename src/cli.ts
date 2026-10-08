import { parseArgs } from "node:util";
import { storePaths, DEFAULT_SCOPE } from "./store.js";
import { resolveRoot } from "./config.js";
import { openDb } from "./index/db.js";
import { reindex } from "./index/reindex.js";
import { searchExplainInstrumented } from "./retrieval/instrumented.js";
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
import { createOllamaClient, type EmbeddingClient } from "./embeddings.js";
import { createFakeEmbedder } from "./embeddings.fake.js";
import { resolveScope, resolveScopeStrict, loadScopeMap, scopeMapPath, realpathOrUndefined, catchAllScope } from "./scope/scopemap.js";
import { listScopes } from "./index/walk.js";
import { loadOwnerPolicy, ownsScope } from "./scope/owner.js";
import { rankContext, selectWithinBudget, formatContextDigest } from "./retrieval/context.js";
import { appendEvalLog } from "./eval/log.js";
import { systemClock } from "./clock.js";
import { homedir } from "node:os";
import {
  CODEX_SESSION_START_COMMAND,
  codexHookSnippet,
  codexSessionStartEnvelope,
  cwdFromHookPayload,
  hookSnippet,
  mergeCodexSessionStartHook,
  mergeSessionStartHook,
  SESSION_START_COMMAND,
} from "./hook.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { scanForSecrets, hasRejectFinding } from "./secrets/scanner.js";
import { rescanStore, formatStoreFinding, formatRescanSummary } from "./secrets/rescan.js";
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

type Out = (s: string) => void;

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

function configuredMinCos(flag: string | undefined): number | undefined {
  const raw = flag ?? process.env.MNEMOSYNE_MIN_COS;
  if (raw === undefined) return undefined;
  if (raw.trim() === "") throw new Error("--min-cos must be a number between -1 and 1.");
  const value = Number(raw);
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error("--min-cos must be a number between -1 and 1.");
  }
  return value;
}

function emptySearchMessage(candidates: { slug: string; scope: string; signals: { relevanceCosine: number } }[], minCos: number | null): string {
  const best = candidates.reduce<(typeof candidates)[number] | undefined>((acc, candidate) =>
    !acc || candidate.signals.relevanceCosine > acc.signals.relevanceCosine ? candidate : acc, undefined);
  if (!best) return "No relevant results; the scope is empty or unindexed.";
  return `No relevant results; best candidate: ${best.slug} [${best.scope}] at cos ${best.signals.relevanceCosine.toFixed(3)}${minCos === null ? "" : ` (minimum ${minCos.toFixed(3)})`}.`;
}

function embedder(): EmbeddingClient {
  return process.env.MNEMOSYNE_FAKE_EMBED === "1" ? createFakeEmbedder() : createOllamaClient();
}

function openIndex(root: string) {
  return openDb(storePaths(root).indexDb);
}

export async function runCli(argv: string[], out: Out = console.log, err: Out = console.error): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "reindex": {
        const { values } = parseArgs({ args: rest, options: { root: { type: "string" }, scope: { type: "string", multiple: true }, "force-embedder": { type: "boolean" } }, allowPositionals: true });
        const root = resolveRoot(values.root);
        const db = openIndex(root);
        // The only place that can consent to re-embedding the whole store:
        // every other entry point reaches reindex lazily, and consent given by
        // something running on its own is not consent.
        const stats = await reindex({ root, db, embedder: embedder(), clock: systemClock, forceEmbedder: Boolean(values["force-embedder"]), ...(values.scope ? { scopes: values.scope } : {}) });
        if (stats.embeddingMismatch) err("warning: embedding model changed; index fully rebuilt.");
        out(`indexed ${stats.indexed}, skipped ${stats.skipped}, deleted ${stats.deleted}, errors ${stats.errors}`);
        return 0;
      }
      case "search": {
        const { values, positionals } = parseArgs({ args: rest, options: { root: { type: "string" }, scope: { type: "string", multiple: true }, k: { type: "string" }, "min-cos": { type: "string" }, explain: { type: "boolean" }, all: { type: "boolean" }, json: { type: "boolean" } }, allowPositionals: true });
        const query = positionals.join(" ").trim();
        if (!query) { err("usage: mneme search \"<query>\" [--scope s] [-k N] [--json]"); return 1; }
        // --explain renders a human diagnostic table; --json is a machine contract.
        // Silently letting explain win would hand a `--json` caller un-parseable
        // text, so refuse the combination instead of ignoring one of the two.
        if (values.json && values.explain) { err("search: --json and --explain cannot be combined (explain output is not JSON); use `explain` for the diagnostic view."); return 1; }
        const root = resolveRoot(values.root);
        const db = openIndex(root);
        const lazy = await reindex({ root, db, embedder: embedder(), clock: systemClock, ...(values.scope ? { scopes: values.scope } : {}) }); // lazy reindex before search
        if (lazy.embeddingMismatch) err("warning: embedding model changed; index fully rebuilt.");
        const minCos = configuredMinCos(values["min-cos"]);
        const searchOpts = { query, ...(values.scope ? { scopes: values.scope } : {}), ...(values.k ? { k: Number(values.k) } : {}), ...(minCos === undefined ? {} : { minCos }) };
        if (values.explain) {
          // Diagnostic path: still instrumented, so an explained search is not
          // a hole in the log — then rendered candidate-by-candidate.
          const corrIdX = newCorrId(systemClock);
          const deps = { db, root, embedder: embedder(), clock: systemClock };
          const result = await searchExplainInstrumented(deps, searchOpts, corrIdX);
          out(formatExplain(result, values.all ? { limit: null } : {}));
          return result.candidates.some((c) => c.included) ? 0 : 2;
        }
        const corrId = newCorrId(systemClock);
        const result = await searchExplainInstrumented({ db, root, embedder: embedder(), clock: systemClock }, searchOpts, corrId);
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
        const emitResult = (digest: string, includedSlugs: string[], omitted: number): void => {
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
          try { await reindex({ root, db, embedder: embedder(), clock: systemClock, scopes: [scope] }); } catch { degraded.push("reindex-failed"); }
          const ranked = rankContext(db, root, scope, systemClock.now());
          const { included, omitted } = selectWithinBudget(ranked, budget);
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
        // MNE-59: a home-level catch-all (`~ = <scope>`) is harmless with one
        // scope but, once a second exists, silently routes any unmapped directory
        // into that scope — the window where it does damage. Detected daily by
        // `snapshot`; surfaced here (the one command seen every session) as an
        // operator warning on stderr, never in the digest. Best-effort.
        if (root !== undefined) {
          try {
            const catchAll = catchAllScope(loadScopeMap(scopeMapPath(root), homedir()), homedir());
            const scopeCount = listScopes(root).length;
            if (catchAll !== undefined && scopeCount >= 2) {
              err(`warning: .scopemap has a catch-all ('~ = ${catchAll}') and ${scopeCount} scopes exist — any unmapped directory writes silently to '${catchAll}'. Map new contexts explicitly, or keep the catch-all on purpose.`);
            }
          } catch { /* never break session start over a hygiene check */ }
        }
        return 0;
      }
      case "explain": {
        const { values, positionals } = parseArgs({ args: rest, options: { root: { type: "string" }, scope: { type: "string", multiple: true }, k: { type: "string" }, "min-cos": { type: "string" }, all: { type: "boolean" } }, allowPositionals: true });
        const query = positionals.join(" ").trim();
        if (!query) { err("usage: mneme explain \"<query>\" [--scope s] [-k N]"); return 1; }
        const root = resolveRoot(values.root);
        const db = openIndex(root);
        await reindex({ root, db, embedder: embedder(), clock: systemClock, ...(values.scope ? { scopes: values.scope } : {}) });
        const deps = { db, root, embedder: embedder(), clock: systemClock };
        const minCos = configuredMinCos(values["min-cos"]);
        const opts = { query, ...(values.scope ? { scopes: values.scope } : {}), ...(values.k ? { k: Number(values.k) } : {}), ...(minCos === undefined ? {} : { minCos }) };
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
        let current: Record<string, unknown> = {};
        try {
          current = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            err(`Could not parse ${settingsPath}; not modifying it. Paste manually:\n\n${snippet}`);
            return 1;
          }
        }
        mkdirSync(dirname(settingsPath), { recursive: true });
        const merged = codex
          ? mergeCodexSessionStartHook(current, CODEX_SESSION_START_COMMAND)
          : mergeSessionStartHook(current, SESSION_START_COMMAND);
        writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
        out(`Installed SessionStart hook into ${settingsPath}.${trustNote}`);
        return 0;
      }
      case "scan": {
        const { values, positionals } = parseArgs({ args: rest, options: { file: { type: "string" }, scope: { type: "string", multiple: true }, all: { type: "boolean" }, root: { type: "string" } }, allowPositionals: true });
        const scanUsage = 'usage: mneme scan "<text>" | --file <path> | --scope <s> [--scope <s2>] | --all [--root <path>]';
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
        const usage = 'usage: mneme add "<content>" | --file <path> --type feedback|reference|project|user [--scope s] [--description d] [--importance n] [--slug s]\n'
          + "       a body whose first character is '-' (a bulleted list) must use --file, or come after `--`: mneme add --type t [flags] -- \"- uno\"";
        const type = values.type ?? "";
        if (!["feedback", "reference", "project", "user"].includes(type)) { err("--type is required: feedback | reference | project | user"); return 1; }
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
          },
          allowPositionals: true,
        });
        const usage = 'usage: mneme update <slug> ["<body>" | --file <path>] --if-match <revision> [--scope s] [--cwd d] [--description d] [--importance n] [--superseded-by <slug> | --status active|superseded|flagged]\n'
          + "       a body whose first character is '-' (a bulleted list) must use --file, or come after `--`: mneme update --if-match <rev> [flags] -- <slug> \"- uno\"";
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
            },
          );
          out(`updated note [${res.scope}] ${res.slug} → ${res.path} (revision ${res.revision})`);
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
        const usage = "usage: mneme import-claude --source <dir> --source-id <slug> --scope <scope> [--apply] [--root r]";
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
      default:
        err(`unknown command: ${command ?? "(none)"}. Commands: context, search, explain, get, stats, trace, snapshot, purge-telemetry, reindex, scan, scope, install-hook, add, update, import-claude.`);
        return 1;
    }
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
}
