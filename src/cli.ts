import { parseArgs } from "node:util";
import { storePaths, DEFAULT_SCOPE } from "./store.js";
import { resolveRoot } from "./config.js";
import { openDb } from "./index/db.js";
import { reindex } from "./index/reindex.js";
import { searchInstrumented } from "./retrieval/instrumented.js";
import { newCorrId } from "./telemetry/corr.js";
import { computeStats } from "./observability/stats.js";
import { formatExplain } from "./observability/explain.js";
import { traceEngram, formatTrace } from "./observability/trace.js";
import { searchExplain } from "./retrieval/search.js";
import { formatStats } from "./observability/format.js";
import { emitEvent } from "./telemetry/events.js";
import { getEngramAndRecord } from "./retrieval/get.js";
import { createOllamaClient, type EmbeddingClient } from "./embeddings.js";
import { createFakeEmbedder } from "./embeddings.fake.js";
import { resolveScope, resolveScopeStrict, loadScopeMap, scopeMapPath } from "./scope/scopemap.js";
import { loadOwnerPolicy, ownsScope } from "./scope/owner.js";
import { rankContext, selectWithinBudget, formatContextDigest } from "./retrieval/context.js";
import { appendEvalLog } from "./eval/log.js";
import { systemClock } from "./clock.js";
import { homedir } from "node:os";
import { hookSnippet, mergeSessionStartHook, SESSION_START_COMMAND } from "./hook.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scanForSecrets, hasRejectFinding } from "./secrets/scanner.js";
import {
  addMemory,
  ScopeUnresolvedError,
  NotOwnerError,
  SecretDetectedError,
  NoteExistsError,
  type EngramType,
} from "./write/add.js";

type Out = (s: string) => void;

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
        const { values } = parseArgs({ args: rest, options: { root: { type: "string" }, scope: { type: "string", multiple: true } }, allowPositionals: true });
        const root = resolveRoot(values.root);
        const db = openIndex(root);
        const stats = await reindex({ root, db, embedder: embedder(), clock: systemClock, ...(values.scope ? { scopes: values.scope } : {}) });
        if (stats.embeddingMismatch) err("warning: embedding model changed; index fully rebuilt.");
        out(`indexed ${stats.indexed}, skipped ${stats.skipped}, deleted ${stats.deleted}, errors ${stats.errors}`);
        return 0;
      }
      case "search": {
        const { values, positionals } = parseArgs({ args: rest, options: { root: { type: "string" }, scope: { type: "string", multiple: true }, k: { type: "string" }, explain: { type: "boolean" }, all: { type: "boolean" } }, allowPositionals: true });
        const query = positionals.join(" ").trim();
        if (!query) { err("usage: mneme search \"<query>\" [--scope s] [-k N]"); return 1; }
        const root = resolveRoot(values.root);
        const db = openIndex(root);
        const lazy = await reindex({ root, db, embedder: embedder(), clock: systemClock, ...(values.scope ? { scopes: values.scope } : {}) }); // lazy reindex before search
        if (lazy.embeddingMismatch) err("warning: embedding model changed; index fully rebuilt.");
        const searchOpts = { query, ...(values.scope ? { scopes: values.scope } : {}), ...(values.k ? { k: Number(values.k) } : {}) };
        if (values.explain) {
          // Diagnostic path: still instrumented, so an explained search is not
          // a hole in the log — then rendered candidate-by-candidate.
          const corrIdX = newCorrId(systemClock);
          const deps = { db, root, embedder: embedder(), clock: systemClock };
          await searchInstrumented(deps, searchOpts, corrIdX);
          out(formatExplain(await searchExplain(deps, searchOpts), values.all ? { limit: null } : {}));
          return 0;
        }
        const corrId = newCorrId(systemClock);
        const hits = await searchInstrumented({ db, root, embedder: embedder(), clock: systemClock }, { query, ...(values.scope ? { scopes: values.scope } : {}), ...(values.k ? { k: Number(values.k) } : {}) }, corrId);
        for (const h of hits) out(`${h.score.toFixed(3)}  ${h.slug}  [${h.scope}]  ${h.snippet}`);
        appendEvalLog(root, { ts: systemClock.nowIso(), cmd: "search", scope: (values.scope ?? []).join(",") || "*", slugs: hits.map((h) => h.slug) });
        return 0;
      }
      case "context": {
        let scope = DEFAULT_SCOPE;
        try {
          const { values } = parseArgs({ args: rest, options: { root: { type: "string" }, scope: { type: "string" }, budget: { type: "string" } }, allowPositionals: true });
          const root = resolveRoot(values.root);
          try {
            const scopeArg = values.scope?.trim();
            scope = scopeArg ? scopeArg : resolveScope(loadScopeMap(scopeMapPath(root), homedir()), process.cwd(), DEFAULT_SCOPE);
          } catch { /* keep personal */ }
          const parsedBudget = Number(values.budget ?? process.env.MNEMOSYNE_CONTEXT_BUDGET);
          const budget = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : 1000;
          const db = openIndex(root);
          try { await reindex({ root, db, embedder: embedder(), clock: systemClock, scopes: [scope] }); } catch { /* serve existing index */ }
          const ranked = rankContext(db, root, scope, systemClock.now());
          const { included, omitted } = selectWithinBudget(ranked, budget);
          out(formatContextDigest(included, scope, omitted));
          // What the agent actually saw this session, and what the budget cut.
          // Injection is the point where memory becomes behaviour, so a scorecard
          // that only measured ranking would miss the truncation entirely.
          emitEvent(root, systemClock, {
            kind: "retrieval.injected",
            corrId: newCorrId(systemClock),
            scope,
            budget,
            injectedSlugs: included.map((e) => e.slug),
            droppedForBudget: omitted,
          });
          appendEvalLog(root, { ts: systemClock.nowIso(), cmd: "context", scope, slugs: included.map((e) => e.slug) });
        } catch {
          out(formatContextDigest([], scope, 0)); // never break session start
        }
        return 0;
      }
      case "explain": {
        const { values, positionals } = parseArgs({ args: rest, options: { root: { type: "string" }, scope: { type: "string", multiple: true }, k: { type: "string" }, all: { type: "boolean" } }, allowPositionals: true });
        const query = positionals.join(" ").trim();
        if (!query) { err("usage: mneme explain \"<query>\" [--scope s] [-k N]"); return 1; }
        const root = resolveRoot(values.root);
        const db = openIndex(root);
        await reindex({ root, db, embedder: embedder(), clock: systemClock, ...(values.scope ? { scopes: values.scope } : {}) });
        const deps = { db, root, embedder: embedder(), clock: systemClock };
        const opts = { query, ...(values.scope ? { scopes: values.scope } : {}), ...(values.k ? { k: Number(values.k) } : {}) };
        await searchInstrumented(deps, opts, newCorrId(systemClock));
        out(formatExplain(await searchExplain(deps, opts), values.all ? { limit: null } : {}));
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
        return 0;
      }
      case "get": {
        const { values, positionals } = parseArgs({ args: rest, options: { root: { type: "string" }, scope: { type: "string" } }, allowPositionals: true });
        const slug = positionals[0];
        if (!slug) { err("usage: mneme get <slug> [--scope s]"); return 1; }
        const root = resolveRoot(values.root);
        const db = openIndex(root);
        out(getEngramAndRecord(db, root, slug, systemClock, values.scope).content);
        return 0;
      }
      case "install-hook": {
        const { values } = parseArgs({ args: rest, options: { write: { type: "boolean" } }, allowPositionals: true });
        const settingsPath = join(homedir(), ".claude", "settings.json");
        if (!values.write) {
          out(`Add this to ${settingsPath}:\n\n${hookSnippet()}`);
          return 0;
        }
        let current: Record<string, unknown> = {};
        try {
          current = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            err(`Could not parse ${settingsPath}; not modifying it. Paste manually:\n\n${hookSnippet()}`);
            return 1;
          }
        }
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, `${JSON.stringify(mergeSessionStartHook(current, SESSION_START_COMMAND), null, 2)}\n`);
        out(`Installed SessionStart hook into ${settingsPath}.`);
        return 0;
      }
      case "scan": {
        const { values, positionals } = parseArgs({ args: rest, options: { file: { type: "string" } }, allowPositionals: true });
        let text: string;
        if (values.file) {
          text = readFileSync(values.file, "utf8");
        } else {
          text = positionals.join(" ");
        }
        if (!text.trim()) { err("usage: mneme scan \"<text>\" | --file <path>"); return 1; }
        const findings = scanForSecrets(text);
        for (const f of findings) out(`${f.severity}  ${f.pattern}  L${f.line}  ${f.masked}`);
        return hasRejectFinding(findings) ? 1 : 0;
      }
      case "scope": {
        const { values, positionals } = parseArgs({ args: rest, options: { root: { type: "string" } }, allowPositionals: true });
        const path = positionals[0] ?? process.cwd();
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
          },
          allowPositionals: true,
        });
        const content = positionals.join(" ").trim();
        if (!content) { err('usage: mneme add "<content>" --type feedback|reference|project|user [--scope s] [--description d] [--importance n] [--slug s]'); return 1; }
        const type = values.type ?? "";
        if (!["feedback", "reference", "project", "user"].includes(type)) { err("--type is required: feedback | reference | project | user"); return 1; }
        const root = resolveRoot(values.root);
        try {
          const res = addMemory(
            { root, cwd: process.cwd(), home: homedir(), now: systemClock.nowIso().slice(0, 19) },
            {
              content, type: type as EngramType,
              ...(values.scope ? { scope: values.scope } : {}),
              ...(values.description ? { description: values.description } : {}),
              ...(values.importance ? { importance: Number(values.importance) } : {}),
              ...(values.slug ? { slug: values.slug } : {}),
            },
          );
          out(`wrote ${res.kind} [${res.scope}] ${res.slug} → ${res.path}`);
          return 0;
        } catch (e) {
          if (e instanceof ScopeUnresolvedError) { err("cannot resolve a scope for this cwd; pass --scope explicitly (write is fail-closed — it never defaults to personal)"); return 1; }
          if (e instanceof NotOwnerError) { err(`this machine does not own scope '${e.scope}'. Declare it in ${storePaths(root).ownerPolicy} ({"owns":[...]}), or write from a machine that owns it.`); return 1; }
          if (e instanceof SecretDetectedError) { err("refusing to write — possible secret(s) detected:"); for (const f of e.findings) err(`  ${f.pattern} (line ${f.line}): ${f.masked}`); return 1; }
          if (e instanceof NoteExistsError) { err(`note already exists: ${e.path} (authored notes are edited directly, not re-added)`); return 1; }
          err((e as Error).message); return 1;
        }
      }
      default:
        err(`unknown command: ${command ?? "(none)"}. Commands: context, search, explain, get, stats, trace, reindex, scan, scope, install-hook, add.`);
        return 1;
    }
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
}
