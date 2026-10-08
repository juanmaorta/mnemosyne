#!/usr/bin/env node
// Dreaming synthesis eval battery (MNE-84). Local-only: the golden cases (real
// `personal` slugs + required/forbidden data) live under ~/.cache and never
// touch the repo or telemetry. Prints a per-model scorecard so a model swap
// (7b vs 14b vs 32b vs cloud) is a measured comparison, not a hand-written one.
//
// Usage:
//   npm run build
//   MNE_DREAM_BASE=<isolated corpus root> DREAMING_MODEL=qwen2.5:14b \
//     node scripts/eval-dream-synthesis.mjs
//
// Env:
//   MNE_DREAM_BASE   isolated copy of the corpus root (never ~/memory directly)
//   DREAMING_MODEL   generation model (default qwen2.5:7b, read by the client)
//   MNE_DREAM_SEED   RNG seed for reproducibility (default 42)
//   DREAMING_TIMEOUT_MS  per-generation timeout (default 120000); raise it for
//                    big local models that need minutes to load+infer (MNE-92)
//   MNEMOSYNE_GOLDEN_DIR  golden dir (default ~/.cache/mnemosyne/dream-golden)
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { synthesize } from "../dist/dreaming/synthesize.js";
import { createDreamingGenerator } from "../dist/dreaming/make-generator.js";
import { scoreCoverage, scoreConciseness, scoreStability, casePassed, renderScorecard } from "../dist/eval/synthesis-score.js";

// Validate BEFORE resolving: resolve("") returns the cwd, which would silently
// run the eval against the wrong root instead of erroring.
const BASE_RAW = process.env.MNE_DREAM_BASE;
if (!BASE_RAW || !BASE_RAW.trim()) {
  console.error("MNE_DREAM_BASE must point at an isolated corpus root (never ~/memory).");
  process.exit(2);
}
const BASE = resolve(BASE_RAW);
const SEED = process.env.MNE_DREAM_SEED ? Number(process.env.MNE_DREAM_SEED) : 42;
const GOLDEN = resolve(process.env.MNEMOSYNE_GOLDEN_DIR ?? join(homedir(), ".cache", "mnemosyne", "dream-golden"));
const NOW = "2026-10-04T03:00:00";

const cases = JSON.parse(readFileSync(join(GOLDEN, "cases.json"), "utf8"));
// Scope-aware: local by default; honours an opt-in `.dreaming.json` at BASE for a
// remote endpoint (MNE-83). Egress secret gate applies automatically when remote.
const generator = createDreamingGenerator({ root: BASE, scope: "personal" });
const rows = [];

for (const c of cases) {
  const group = { sources: c.sources, type: c.type, topic: c.topic };
  let r1, r2;
  try {
    r1 = await synthesize({ root: BASE, scope: "personal", group, generator, now: NOW, seed: SEED });
    r2 = await synthesize({ root: BASE, scope: "personal", group, generator, now: NOW, seed: SEED });
  } catch (e) {
    rows.push({ id: c.id, coverage: { requiredTotal: c.required.length, requiredHit: 0, missing: c.required, forbiddenPresent: [] }, conciseness: { chars: 0, within: false }, applicable: false, passed: false, error: String(e.message) });
    continue;
  }
  const applicable = Boolean(r1.proposal);
  const body = r1.proposal?.body ?? "";
  const coverage = scoreCoverage(body, { required: c.required, forbidden: c.forbidden });
  const conciseness = scoreConciseness(body, c.maxChars);
  // Stability is only meaningful when the first pass produced a proposal. A
  // rerun that gets rejected is NOT unmeasured — it failed to reproduce an
  // applicable proposal, so it counts as unstable (and we keep its reason).
  let stableWithRerun;
  let rerunRejection;
  if (applicable) {
    if (r2.proposal) stableWithRerun = scoreStability(body, r2.proposal.body).identical;
    else { stableWithRerun = false; rerunRejection = r2.rejection?.reason; }
  }
  const passed = casePassed(coverage, conciseness, applicable);
  rows.push({ id: c.id, coverage, conciseness, applicable, passed, ...(stableWithRerun !== undefined ? { stableWithRerun } : {}), rejection: r1.rejection?.reason, ...(rerunRejection ? { rerunRejection } : {}), outTokens: r1.generation?.outputTokens });
}

const scorecard = renderScorecard(generator.id, rows);
console.log("\n" + scorecard + "\n");
const outPath = join(GOLDEN, `results-${generator.id.replace(/[^a-z0-9.]+/gi, "_")}.json`);
writeFileSync(outPath, JSON.stringify({ model: generator.id, seed: SEED, rows }, null, 2) + "\n");
console.log(`scorecard JSON → ${outPath}`);
