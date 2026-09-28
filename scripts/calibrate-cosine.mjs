// Reproducible small-corpus calibration for Nomic's search task prefixes.
// Run with `node scripts/calibrate-cosine.mjs` while Ollama serves nomic-embed-text.
import { documents, positives, negatives } from "./retrieval-bench-fixtures.mjs";

const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const model = process.env.OLLAMA_MODEL ?? "nomic-embed-text";
const floor = Number(process.env.MNEMOSYNE_MIN_COS ?? "0.70");
async function embed(input) {
  const response = await fetch(`${host}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  return (await response.json()).embeddings;
}
function cosine(a, b) {
  let dot = 0, a2 = 0, b2 = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    a2 += a[i] * a[i];
    b2 += b[i] * b[i];
  }
  return dot / Math.sqrt(a2 * b2);
}
const docVectors = await embed(documents.map(([, body]) => `search_document: ${body}`));
const queryVectors = await embed([...positives.map(([, q]) => q), ...negatives].map((q) => `search_query: ${q}`));
const results = queryVectors.map((vector, i) => {
  const ranked = documents.map(([slug], j) => ({ slug, cos: cosine(vector, docVectors[j]) }))
    .sort((a, b) => b.cos - a.cos);
  const positive = i < positives.length;
  const target = positive ? positives[i][0] : null;
  return { kind: positive ? "positive" : "negative", query: positive ? positives[i][1] : negatives[i - positives.length], target, best: ranked[0], targetCos: positive ? ranked.find((r) => r.slug === target)?.cos : null };
});
for (const r of results) console.log(`${r.kind.padEnd(8)} best=${r.best.cos.toFixed(3)} ${r.best.slug.padEnd(8)} target=${r.target ?? "-"} targetCos=${r.targetCos?.toFixed(3) ?? "-"} ${r.query}`);
const minPositive = Math.min(...results.filter((r) => r.kind === "positive").map((r) => r.targetCos));
const maxNegative = Math.max(...results.filter((r) => r.kind === "negative").map((r) => r.best.cos));
console.log(`model=${model} documents=${documents.length} positives=${positives.length} negatives=${negatives.length}`);
console.log(`min positive target cosine=${minPositive.toFixed(3)}; max negative best cosine=${maxNegative.toFixed(3)}; gap=${(minPositive - maxNegative).toFixed(3)}`);
const falseNegatives = results.filter((r) => r.kind === "positive" && r.targetCos < floor).length;
const falsePositives = results.filter((r) => r.kind === "negative" && r.best.cos >= floor).length;
console.log(`floor=${floor.toFixed(3)} false negatives=${falseNegatives}/${positives.length} false positives=${falsePositives}/${negatives.length}`);
if (falseNegatives > 0 || falsePositives > 0) process.exitCode = 1;
