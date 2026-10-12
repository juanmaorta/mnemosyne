#!/usr/bin/env node
// Scale scenario (g) of the bench (MNE-65): measure retrieval latency at scale.
//
// Populates an EPHEMERAL temp store with N synthetic engrams (deterministic fake
// embedder, injected clock), reindexes it and times `search`. Never touches the
// real store (~/memory): it works in a throwaway directory it creates and removes.
//
//   npm run bench:scale -- [--n 10000] [--queries 25] [--threshold-ms 500] [--scope personal]
//
// Exits non-zero when p95 search latency exceeds the threshold, so a latency
// regression fails the bench exactly as a quality regression would.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runScaleScenario } from "../dist/bench/scale.js";
import { createFakeEmbedder } from "../dist/embeddings.fake.js";
import { ALGO_VERSION } from "../dist/version.js";

function parseArgs(argv) {
  const opts = { n: 10_000, queries: 25, thresholdMs: 500, scope: "personal" };
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${argv[i - 1]}`);
      return v;
    };
    if (argv[i] === "--n") opts.n = Number(next());
    else if (argv[i] === "--queries") opts.queries = Number(next());
    else if (argv[i] === "--threshold-ms") opts.thresholdMs = Number(next());
    else if (argv[i] === "--scope") opts.scope = next();
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  for (const [k, v] of [["n", opts.n], ["queries", opts.queries], ["threshold-ms", opts.thresholdMs]]) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`--${k} must be a positive number`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = mkdtempSync(join(tmpdir(), "mnemosyne-scale-"));
  try {
    console.log(`scale bench: ${opts.n} synthetic engrams, ${opts.queries} queries, threshold ${opts.thresholdMs}ms`);
    const card = await runScaleScenario({
      n: opts.n,
      root,
      scope: opts.scope,
      queries: opts.queries,
      embedder: createFakeEmbedder(),
      thresholdMs: opts.thresholdMs,
    });

    const outDir = resolve(process.env.MNEMOSYNE_BENCH_DIR ?? join(homedir(), ".cache", "mnemosyne", "scale"));
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, `scale-${ALGO_VERSION}-n${opts.n}.json`);
    writeFileSync(out, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o600 });

    const s = card.search;
    console.log(`reindex: ${card.reindex.indexed} engrams in ${card.reindex.ms.toFixed(0)}ms`);
    console.log(`search latency ms: p50=${s.p50Ms?.toFixed(2)} p95=${s.p95Ms?.toFixed(2)} mean=${s.meanMs?.toFixed(2)}`);
    console.log(`candidate set: p50=${s.candidateSet.p50} p95=${s.candidateSet.p95} max=${s.candidateSet.max}`);
    console.log(`verdict: p95 ${s.p95Ms?.toFixed(2)}ms ${card.within ? "<=" : ">"} ${card.thresholdMs}ms -> ${card.within ? "WITHIN" : "OVER THRESHOLD"}`);
    console.log(`scorecard: ${out}`);
    if (!card.within) process.exitCode = 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
