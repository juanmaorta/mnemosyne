// MNE-78 eval runner: prints, as JSON, what the agent sees from `search` for one
// (query, arm) against an ISOLATED store root. Does not mutate anything: it only
// searches. Reads full note content is the agent's separate step.
//
//   node scripts/mne78-arm.mjs --root <dir> --arm P|S|E --query "<q>" [--scope personal] [--k 10]
import { parseArgs } from "node:util";
import { storePaths } from "../dist/store.js";
import { openDb } from "../dist/index/db.js";
import { createOllamaClient } from "../dist/embeddings.js";
import { systemClock } from "../dist/clock.js";
import { rankForArm } from "../dist/eval/arm.js";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    scope: { type: "string", default: "personal" },
    arm: { type: "string" },
    query: { type: "string" },
    k: { type: "string" },
  },
});

if (!values.root || !values.arm || !values.query) {
  console.error('usage: --root <dir> --arm P|S|E --query "<q>" [--scope personal] [--k 10]');
  process.exit(1);
}
if (!["P", "S", "E"].includes(values.arm)) {
  console.error(`unknown arm '${values.arm}'; expected P, S or E`);
  process.exit(1);
}

const db = openDb(storePaths(values.root).indexDb);
const embedder = createOllamaClient();
const deps = { db, root: values.root, embedder, clock: systemClock };
const opts = { query: values.query, scopes: [values.scope], ...(values.k ? { k: Number(values.k) } : {}) };

const res = await rankForArm(deps, opts, values.arm);
const slim = (h) => ({
  slug: h.slug,
  scope: h.scope,
  cos: Number(h.signals.relevanceCosine.toFixed(4)),
  score: Number(h.score.toFixed(4)),
  snippet: h.snippet,
});
console.log(JSON.stringify({
  arm: values.arm,
  query: values.query,
  embedder: embedder.id,
  primary: res.primary.map(slim),
  fallback: res.fallback.map(slim),
}, null, 2));
