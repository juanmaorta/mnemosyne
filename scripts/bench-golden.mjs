#!/usr/bin/env node
// Local-only 5b-golden workflow. Query text, slugs, and relevance labels stay
// under ~/.cache and are never written to the repository or telemetry.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { EngramSchema } from "../dist/schema.js";
import { parseFrontmatter } from "../dist/frontmatter.js";
import { listEngramFiles, listScopes } from "../dist/index/walk.js";
import { createOllamaClient } from "../dist/embeddings.js";
import { openDb, resetVectorIndex } from "../dist/index/db.js";
import { toBlob } from "../dist/index/vecBlob.js";
import { searchExplain } from "../dist/retrieval/search.js";
import { fixedClock } from "../dist/clock.js";
import { ALGO_VERSION } from "../dist/version.js";
import { percentile, queryMetrics, summarizeEvaluation } from "../dist/golden-metrics.js";

const DEFAULT_QUERY_MODEL = "gemma4:e2b";
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const MAX_QUERIES_PER_SCOPE = 25;
const TOP_K = 10;
const DEFAULT_CLUSTER_COSINE = 0.8;
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const ROOT = resolve(process.env.MNEMOSYNE_ROOT ?? join(homedir(), "memory"));
const OUTPUT_ROOT = resolve(process.env.MNEMOSYNE_GOLDEN_DIR ?? join(homedir(), ".cache", "mnemosyne", "5b-golden"));

function options(argv) {
  const [command, ...rest] = argv;
  if (!["prepare", "run"].includes(command)) {
    throw new Error("usage: node scripts/bench-golden.mjs <prepare|run> [--scope <scope>] [--force]");
  }
  const opts = { command, scopes: [], force: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--scope" && rest[i + 1]) opts.scopes.push(rest[++i]);
    else if (rest[i] === "--force") opts.force = true;
    else throw new Error(`unknown option: ${rest[i]}`);
  }
  return opts;
}

function localHostOnly() {
  const host = new URL(OLLAMA_HOST).hostname;
  if (!new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(host)) {
    throw new Error("5b-golden sends private note content only to local Ollama; OLLAMA_HOST must resolve to localhost.");
  }
}

async function assertLocalModel(model) {
  const response = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Cannot list local Ollama models (${response.status}). Is Ollama running?`);
  const body = await response.json();
  const wanted = model.includes(":") ? model : `${model}:latest`;
  const found = body.models?.find((entry) => entry.name === model || entry.name === wanted);
  if (!found) throw new Error(`Local Ollama model '${model}' is not installed. Remote/cloud models are not allowed for this benchmark.`);
  if (found.remote_model || found.remote_host) throw new Error(`Model '${model}' is remote/cloud; 5b-golden requires a local-only model.`);
}

function scopeFile(scope) {
  const hash = createHash("sha256").update(scope).digest("hex").slice(0, 10);
  return join(OUTPUT_ROOT, `scope-${hash}.json`);
}

function scopeScorecardFile(scope, model) {
  const scopeHash = createHash("sha256").update(scope).digest("hex").slice(0, 10);
  const modelHash = createHash("sha256").update(model).digest("hex").slice(0, 8);
  return join(OUTPUT_ROOT, `scorecard-${scopeHash}-${modelHash}.json`);
}

function readCorpus(root, scope) {
  const documents = [];
  let skipped = 0;
  for (const file of listEngramFiles(root, [scope])) {
    const { data, body } = parseFrontmatter(readFileSync(file.path, "utf8"));
    const parsed = EngramSchema.safeParse(data);
    if (!parsed.success || parsed.data.scope !== scope || parsed.data.status === "superseded") {
      skipped++;
      continue;
    }
    documents.push({
      slug: parsed.data.name,
      scope,
      type: parsed.data.type,
      status: parsed.data.status ?? "active",
      created: parsed.data.created,
      importance: parsed.data.importance,
      description: parsed.data.description,
      text: `${parsed.data.description}\n\n${body.trim()}`.trim(),
      path: file.path,
    });
  }
  documents.sort((a, b) => a.slug.localeCompare(b.slug));
  return { documents, skipped };
}

function corpusDigest(documents) {
  const hash = createHash("sha256");
  for (const doc of documents) hash.update(`${doc.scope}\0${doc.slug}\0${doc.created}\0${doc.text}\0`);
  return hash.digest("hex");
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

function clusterDocuments(documents, vectors, threshold) {
  const parent = documents.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  for (let i = 0; i < documents.length; i++) {
    for (let j = i + 1; j < documents.length; j++) if (cosine(vectors[i], vectors[j]) >= threshold) union(i, j);
  }
  const groups = new Map();
  for (let i = 0; i < documents.length; i++) {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  }
  return [...groups.values()].map((indices) => indices.map((i) => documents[i].slug));
}

function stableScore(value) {
  return createHash("sha256").update(value).digest("hex");
}

function chooseAnchors(documents, clusters) {
  const bySlug = new Map(documents.map((doc) => [doc.slug, doc]));
  const orderedClusters = clusters.map((slugs) => [...slugs].sort()).sort((a, b) => stableScore(a.join("\0")).localeCompare(stableScore(b.join("\0"))));
  const selected = [];
  for (const cluster of orderedClusters) {
    const candidates = cluster.map((slug) => bySlug.get(slug)).filter(Boolean);
    candidates.sort((a, b) => stableScore(a.scope + a.slug).localeCompare(stableScore(b.scope + b.slug)));
    if (candidates.length) selected.push(candidates[0]);
  }
  const selectedSlugs = new Set(selected.map((doc) => doc.slug));
  const fill = [...documents].filter((doc) => !selectedSlugs.has(doc.slug));
  fill.sort((a, b) => stableScore(a.scope + a.slug).localeCompare(stableScore(b.scope + b.slug)));
  return [...selected, ...fill].slice(0, Math.min(MAX_QUERIES_PER_SCOPE, documents.length));
}

async function embedCorpus(documents, model) {
  const client = clientWithKeepAlive(model, "5m");
  const vectors = [];
  const batchSize = 24;
  for (let i = 0; i < documents.length; i += batchSize) {
    const chunk = documents.slice(i, i + batchSize);
    vectors.push(...await client.embed(chunk.map((doc) => doc.text), "document"));
    process.stdout.write(`embedded ${Math.min(i + chunk.length, documents.length)}/${documents.length} documents\n`);
  }
  return { client, vectors };
}

function clientWithKeepAlive(model, keepAlive) {
  return createOllamaClient({ host: OLLAMA_HOST, model }, async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    body.keep_alive = keepAlive;
    return fetch(url, { ...init, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  });
}

async function generateQuery(model, doc) {
  let parsed;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model,
        stream: false,
        format: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        keep_alive: "5m",
        options: { temperature: 0.2 },
        messages: [
          { role: "system", content: "Escribe una sola consulta de recuperación realista en español, desde la situación de quien necesita recordar la información. No respondas la consulta. No copies nombres propios, slugs ni frases distintivas del texto; evita mencionar que existe una nota. Responde solo un objeto JSON con la propiedad query." },
          { role: "user", content: `Información disponible para recordar:\n${doc.text.slice(0, 12_000)}\n\nFormula una pregunta que alguien podría hacer antes de recordar esta información, sin reutilizar términos distintivos del texto.` },
          ...(attempt ? [{ role: "assistant", content: "Devuelve un objeto JSON válido con una sola propiedad string llamada query." }] : []),
        ],
      }),
    });
    if (!response.ok) throw new Error(`Local Ollama query generation failed (${response.status}).`);
    const payload = await response.json();
    const content = payload.message?.content ?? "";
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(content.slice(start, end + 1)); } catch { /* retry with a JSON reminder */ }
    }
    if (typeof parsed?.query === "string" && parsed.query.trim().length >= 8) break;
  }
  if (typeof parsed?.query !== "string" || parsed.query.trim().length < 8) throw new Error("Local model returned an invalid query; no query set was written.");
  return parsed.query.trim();
}

async function prepareScope(scope, opts) {
  const path = scopeFile(scope);
  if (existsSync(path) && !opts.force) throw new Error(`Review set already exists at ${path}; use --force only if you intend to replace manual edits.`);
  const evaluationTime = new Date().toISOString();
  const { documents, skipped } = readCorpus(ROOT, scope);
  if (documents.length === 0) throw new Error(`No valid active engrams found for scope '${scope}'.`);
  const embeddingModel = process.env.OLLAMA_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  const queryModel = process.env.OLLAMA_QUERY_MODEL ?? DEFAULT_QUERY_MODEL;
  await assertLocalModel(embeddingModel);
  await assertLocalModel(queryModel);
  const threshold = Number(process.env.MNEMOSYNE_GOLDEN_CLUSTER_COS ?? DEFAULT_CLUSTER_COSINE);
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) throw new Error("MNEMOSYNE_GOLDEN_CLUSTER_COS must be between -1 and 1.");
  const { client, vectors } = await embedCorpus(documents, embeddingModel);
  const clusters = clusterDocuments(documents, vectors, threshold);
  const clusterForSlug = new Map();
  for (const members of clusters) {
    const clusterId = `c-${stableScore(members.slice().sort().join("\0")).slice(0, 10)}`;
    for (const slug of members) clusterForSlug.set(slug, { clusterId, members });
  }
  const anchors = chooseAnchors(documents, clusters);
  const queries = [];
  for (let i = 0; i < anchors.length; i++) {
    const doc = anchors[i];
    const query = await generateQuery(queryModel, doc);
    const cluster = clusterForSlug.get(doc.slug);
    queries.push({
      id: `q-${String(i + 1).padStart(2, "0")}`,
      query,
      anchorSlug: doc.slug,
      clusterId: cluster.clusterId,
      relevance: cluster.members.map((slug) => ({ slug, grade: slug === doc.slug ? 3 : 2 })).sort((a, b) => b.grade - a.grade || a.slug.localeCompare(b.slug)),
      approved: false,
      reviewNotes: "",
    });
    process.stdout.write(`generated ${i + 1}/${anchors.length} for local scope review set\n`);
  }
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  const reviewSet = {
    schemaVersion: 1,
    createdAt: evaluationTime,
    evaluationTime,
    scope,
    corpus: { documents: documents.length, skippedInvalidOrSuperseded: skipped, sha256: corpusDigest(documents) },
    embeddingModel,
    queryModel,
    clusterCosineThreshold: threshold,
    clusterCount: clusters.length,
    queries,
    reviewInstructions: "Review each question from a user's perspective; edit query and graded relevance as needed, then set approved=true. Grade 3 is directly relevant, 2 is a relevant cluster sibling, 1 is partially relevant. Omit irrelevant notes; leave relevance empty when no note answers the query. This file is private and must not be committed.",
  };
  writeFileSync(path, `${JSON.stringify(reviewSet, null, 2)}\n`, { mode: 0o600 });
  // Release the local embedding model before the cold-latency pass.
  await clientWithKeepAlive(embeddingModel, 0).embed(["benchmark model unload"], "document");
  console.log(`prepared local review set: scope has ${documents.length} documents, ${queries.length} queries, ${clusters.length} cosine clusters; file: ${path}`);
}

function buildMemoryIndex(db, docs, vectors, dim) {
  resetVectorIndex(db, dim);
  const insert = db.prepare(`insert into engrams(slug,scope,type,importance,created,description,path,snippet,mtime,size,hash,status)
    values(@slug,@scope,@type,@importance,@created,@description,@path,@snippet,@mtime,@size,@hash,@status)`);
  const vectorInsert = db.prepare("insert into vec_engrams(rowid,embedding) values (?, ?)");
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const result = insert.run({ slug: doc.slug, scope: doc.scope, type: doc.type, importance: doc.importance,
      created: doc.created, description: doc.description, path: doc.path, snippet: "", mtime: 0, size: 0, hash: "", status: doc.status });
    vectorInsert.run(BigInt(result.lastInsertRowid), toBlob(vectors[i]));
  }
}

function summarizeLatencies(samples) {
  return { samples: samples.length, p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), meanMs: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null };
}

async function evaluatePass({ queries, docs, db, embedder, now, warmup }) {
  const deps = { db, root: ROOT, embedder, clock: fixedClock(now) };
  const all = [];
  const latencies = [];
  if (warmup && queries.length) await searchExplain(deps, { query: queries[0].query, scopes: [queries[0].scope], k: docs.length });
  for (const query of queries) {
    const started = performance.now();
    const result = await searchExplain(deps, { query: query.query, scopes: [query.scope], k: docs.length });
    latencies.push(performance.now() - started);
    const ranked = result.candidates.filter((candidate) => candidate.included).map((candidate) => candidate.slug);
    const metric = queryMetrics(ranked, query.relevance, TOP_K);
    all.push({ id: query.id, ...metric, answerable: query.relevance.some((item) => item.grade > 0), returnedCount: ranked.length });
  }
  return { metrics: summarizeEvaluation(all), latency: summarizeLatencies(latencies), perQuery: all };
}

async function runScope(scope, embeddingModel) {
  const path = scopeFile(scope);
  if (!existsSync(path)) throw new Error(`No local review set for scope '${scope}'. Run prepare first.`);
  const reviewSet = JSON.parse(readFileSync(path, "utf8"));
  const pending = reviewSet.queries.filter((query) => query.approved !== true);
  if (pending.length) throw new Error(`Scope '${scope}' has ${pending.length} queries not human-reviewed. Approve them in ${path} before running.`);
  const { documents, skipped } = readCorpus(ROOT, scope);
  if (corpusDigest(documents) !== reviewSet.corpus.sha256) throw new Error(`Corpus changed since review set creation for scope '${scope}'. Re-run prepare and review the refreshed queries.`);
  if (skipped !== reviewSet.corpus.skippedInvalidOrSuperseded) throw new Error(`Corpus validation changed since review set creation for scope '${scope}'.`);
  const documentSlugs = new Set(documents.map((doc) => doc.slug));
  const queryIds = new Set();
  for (const query of reviewSet.queries) {
    if (!query.id || queryIds.has(query.id)) throw new Error(`Review set for '${scope}' has a missing or duplicate query id.`);
    queryIds.add(query.id);
    if (typeof query.query !== "string" || query.query.trim().length < 8) throw new Error(`Review set for '${scope}' has an empty or too-short query (${query.id}).`);
    if (!documentSlugs.has(query.anchorSlug) || !Array.isArray(query.relevance)) throw new Error(`Review set for '${scope}' has invalid relevance labels (${query.id}).`);
    const judged = new Set();
    for (const item of query.relevance) {
      if (!documentSlugs.has(item.slug) || judged.has(item.slug) || !Number.isInteger(item.grade) || item.grade < 1 || item.grade > 3) {
        throw new Error(`Review set for '${scope}' has an invalid graded document in ${query.id}.`);
      }
      judged.add(item.slug);
    }
  }
  const queries = reviewSet.queries.map((query) => ({ ...query, scope }));
  const client = clientWithKeepAlive(embeddingModel, "5m");
  const vectors = [];
  for (let i = 0; i < documents.length; i += 24) vectors.push(...await client.embed(documents.slice(i, i + 24).map((doc) => doc.text), "document"));
  const db = openDb(":memory:");
  buildMemoryIndex(db, documents, vectors, client.dim);
  const now = Date.parse(reviewSet.evaluationTime ?? reviewSet.createdAt);
  if (!Number.isFinite(now)) throw new Error(`Review set for '${scope}' has an invalid evaluation time.`);
  // Cold pass unloads the model after each query. Warm pass includes a model warm-up,
  // then measures every labeled query with the local model resident.
  await clientWithKeepAlive(embeddingModel, 0).embed(["benchmark model unload"], "document");
  const cold = await evaluatePass({ queries, docs: documents, db, embedder: clientWithKeepAlive(embeddingModel, 0), now, warmup: false });
  const warm = await evaluatePass({ queries, docs: documents, db, embedder: client, now, warmup: true });
  db.close();
  const scorecard = {
    benchmark: "mnemosyne-5b-golden-v1",
    algoVersion: ALGO_VERSION,
    evaluationTime: new Date(now).toISOString(),
    scope,
    corpusDocuments: documents.length,
    corpusSha256: reviewSet.corpus.sha256,
    embeddingModel,
    queryModel: reviewSet.queryModel,
    queryCount: queries.length,
    topK: TOP_K,
    clusterCosineThreshold: reviewSet.clusterCosineThreshold,
    relevance: { cold: cold.metrics, warm: warm.metrics },
    latency: { coldModelUnloadPerQuery: cold.latency, warmModelResident: warm.latency },
    perQuery: { cold: cold.perQuery, warm: warm.perQuery },
    limitations: [
      "Real query/relevance data stays in the local review set; this scorecard contains only query IDs and aggregate/per-query metrics.",
      "Generated questions and cosine-derived clusters require human review; results describe this local corpus and are not general quality claims.",
      "Cold samples unload the local embedding model after each query; warm samples use the resident model after one unmeasured warm-up.",
    ],
  };
  const output = scopeScorecardFile(scope, embeddingModel);
  writeFileSync(output, `${JSON.stringify(scorecard, null, 2)}\n`, { mode: 0o600 });
  console.log(`scope benchmark complete: ${documents.length} documents, ${queries.length} reviewed queries`);
  console.log(`nDCG@${TOP_K}: cold=${cold.metrics.answerable.meanNdcgAt10?.toFixed(3)} warm=${warm.metrics.answerable.meanNdcgAt10?.toFixed(3)}; MRR: cold=${cold.metrics.answerable.mrr?.toFixed(3)} warm=${warm.metrics.answerable.mrr?.toFixed(3)}`);
  console.log(`unanswerable queries: cold false positives=${cold.metrics.unanswerable.falsePositives}/${cold.metrics.unanswerable.queries}; warm=${warm.metrics.unanswerable.falsePositives}/${warm.metrics.unanswerable.queries}`);
  console.log(`latency ms: cold p50=${cold.latency.p50Ms?.toFixed(1)} p95=${cold.latency.p95Ms?.toFixed(1)}; warm p50=${warm.latency.p50Ms?.toFixed(1)} p95=${warm.latency.p95Ms?.toFixed(1)}`);
  console.log(`local scorecard: ${output}`);
}

async function main() {
  localHostOnly();
  const opts = options(process.argv.slice(2));
  const available = listScopes(ROOT);
  const scopes = opts.scopes.length ? [...new Set(opts.scopes)] : available;
  if (scopes.length === 0 || scopes.some((scope) => !available.includes(scope))) throw new Error("Choose an existing scope from the local memory store.");
  const embeddingModel = process.env.OLLAMA_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  await assertLocalModel(embeddingModel);
  for (const scope of scopes) {
    if (opts.command === "prepare") await prepareScope(scope, opts);
    else await runScope(scope, embeddingModel);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
