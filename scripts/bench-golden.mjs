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
import { searchExplain, resolveMinCos, NOMIC_MIN_COS } from "../dist/retrieval/search.js";
import { readEvents } from "../dist/events.js";
import { fixedClock } from "../dist/clock.js";
import { ALGO_VERSION } from "../dist/version.js";
import { percentile, queryMetrics, summarizeEvaluation } from "../dist/golden-metrics.js";
import { diagnoseQuery, diagnosticTime, rankingMetadataDigest, summarizeDiagnostics } from "../dist/golden-diagnostics.js";
import { assertCalibrationReviewSet, compareCalibrationArms, rankCalibrationCandidates, selectEligibleConfigurations, sweepFloorGrid, selectFloorPair, floorSeparation } from "../dist/golden-calibration.js";

const DEFAULT_QUERY_MODEL = "gemma4:e2b";
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const MAX_QUERIES_PER_SCOPE = 25;
// MNE-98: unanswerable queries generated per scope. assertCalibrationReviewSet
// requires 10 reviewed ones; extra headroom absorbs the ones review discards.
const UNANSWERABLE_PER_SCOPE = 15;
// Floor grids for calibrate-floor. Cosine spans both models' plausible bands
// (v2-moe positives sit ~0.35–0.6, nomic ~0.6–0.8); lexical is raw BM25.
const COSINE_FLOOR_GRID = Array.from({ length: 61 }, (_, i) => Math.round((0.20 + i * 0.01) * 100) / 100);
const LEXICAL_FLOOR_GRID = [null, ...Array.from({ length: 41 }, (_, i) => i * 0.5)];
const TOP_K = 10;
const DEFAULT_CLUSTER_COSINE = 0.8;
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const ROOT = resolve(process.env.MNEMOSYNE_ROOT ?? join(homedir(), "memory"));
const OUTPUT_ROOT = resolve(process.env.MNEMOSYNE_GOLDEN_DIR ?? join(homedir(), ".cache", "mnemosyne", "5b-golden"));

function options(argv) {
  const [command, ...rest] = argv;
  if (!["prepare", "run", "diagnose", "calibrate", "calibrate-floor"].includes(command)) {
    throw new Error("usage: node scripts/bench-golden.mjs <prepare|run|diagnose|calibrate|calibrate-floor> [--scope <scope>] [--force] [--allow-corpus-drift]");
  }
  const opts = { command, scopes: [], force: false, allowCorpusDrift: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--scope" && rest[i + 1]) opts.scopes.push(rest[++i]);
    else if (rest[i] === "--force") opts.force = true;
    else if (rest[i] === "--allow-corpus-drift" && command === "diagnose") opts.allowCorpusDrift = true;
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
      // FTS input, split as reindex stores it (description, body). Not part of
      // any digest, so adding it leaves existing review sets valid.
      body: body.trim(),
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

function eventsDigest(root, scope) {
  const hash = createHash("sha256");
  const events = readEvents(root, [scope]);
  for (const key of [...events.keys()].sort()) {
    hash.update(key);
    for (const event of events.get(key).slice().sort((a, b) => a.ts.localeCompare(b.ts) || a.kind.localeCompare(b.kind))) {
      hash.update(JSON.stringify(event));
    }
  }
  return hash.digest("hex");
}

function currentFingerprint(scope) {
  const { documents, skipped } = readCorpus(ROOT, scope);
  return {
    contentSha256: corpusDigest(documents), rankingSha256: rankingMetadataDigest(documents),
    eventsSha256: eventsDigest(ROOT, scope), documents: documents.length, skipped,
  };
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

// MNE-98: the original 5b-golden only had "natural" queries (generateQuery),
// which forbid the note's own vocabulary — a deliberate bias against BM25 that
// hid both the keyword use case and the lexical signal. Each query is labeled
// with its style so the floor calibration can report recall per style.
const KEYWORD_PROMPT = {
  system: "Escribe una sola consulta corta (de 2 a 5 palabras) como la que alguien teclearía en un buscador para encontrar esta información. Usa términos que aparecen en el texto, incluidos nombres propios o técnicos si son los que alguien recordaría. No escribas una frase completa ni respondas nada. Responde solo un objeto JSON con la propiedad query.",
  user: "Escribe las palabras clave que alguien buscaría para recuperar esta información.",
};

async function chatJson(model, messages, schema, valid) {
  let parsed;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model, stream: false, format: schema, keep_alive: "5m", options: { temperature: 0.2 },
        messages: [...messages, ...(attempt ? [{ role: "assistant", content: "Devuelve solo un objeto JSON válido con el esquema pedido." }] : [])],
      }),
    });
    if (!response.ok) throw new Error(`Local Ollama query generation failed (${response.status}).`);
    const content = (await response.json()).message?.content ?? "";
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(content.slice(start, end + 1)); } catch { /* retry with a JSON reminder */ }
    }
    if (valid(parsed)) return parsed;
  }
  throw new Error("Local model returned an invalid query; no query set was written.");
}

async function generateStyledQuery(model, doc, style) {
  if (style === "natural") return generateQuery(model, doc);
  const parsed = await chatJson(model, [
    { role: "system", content: KEYWORD_PROMPT.system },
    { role: "user", content: `Información disponible para recordar:\n${doc.text.slice(0, 12_000)}\n\n${KEYWORD_PROMPT.user}` },
  ], { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  (value) => typeof value?.query === "string" && value.query.trim().length >= 3);
  return parsed.query.trim();
}

/**
 * Unanswerable queries, generated against the scope's note DESCRIPTIONS so the
 * model can aim next to the store's topics ("near misses", the negatives that
 * actually leak through a floor) as well as far from them. The model cannot
 * know what the notes really cover; review decides which ones stay unanswerable.
 */
async function generateUnanswerableQueries(model, documents, count) {
  const topics = documents.map((doc) => `- ${doc.description}`).join("\n").slice(0, 16_000);
  const parsed = await chatJson(model, [
    { role: "system", content: "Generas consultas de prueba en español para un buscador de notas personales. Cada consulta debe ser algo que alguien podría buscar, pero sobre lo que estas notas NO tienen la respuesta. Mezcla dos tipos a partes iguales: (a) temas vecinos a los de las notas, que comparten vocabulario o dominio pero piden otra cosa; (b) temas cotidianos sin relación. Mezcla preguntas completas y búsquedas cortas por palabras clave. Responde solo un objeto JSON con la propiedad queries (lista de strings)." },
    { role: "user", content: `Temas que SÍ cubren las notas:\n${topics}\n\nEscribe ${count} consultas distintas que estas notas no responden.` },
  ], { type: "object", properties: { queries: { type: "array", items: { type: "string" } } }, required: ["queries"] },
  (value) => Array.isArray(value?.queries) && value.queries.filter((q) => typeof q === "string" && q.trim().length >= 3).length >= Math.ceil(count / 2));
  return [...new Set(parsed.queries.filter((q) => typeof q === "string").map((q) => q.trim()).filter((q) => q.length >= 3))].slice(0, count);
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
  const idPrefix = { natural: "q", keyword: "k" };
  for (let i = 0; i < anchors.length; i++) {
    const doc = anchors[i];
    const cluster = clusterForSlug.get(doc.slug);
    for (const style of ["natural", "keyword"]) {
      const query = await generateStyledQuery(queryModel, doc, style);
      queries.push({
        id: `${idPrefix[style]}-${String(i + 1).padStart(2, "0")}`,
        style,
        query,
        anchorSlug: doc.slug,
        clusterId: cluster.clusterId,
        relevance: cluster.members.map((slug) => ({ slug, grade: slug === doc.slug ? 3 : 2 })).sort((a, b) => b.grade - a.grade || a.slug.localeCompare(b.slug)),
        approved: false,
        reviewNotes: "",
      });
    }
    process.stdout.write(`generated ${i + 1}/${anchors.length} for local scope review set\n`);
  }
  const unanswerable = await generateUnanswerableQueries(queryModel, documents, UNANSWERABLE_PER_SCOPE);
  unanswerable.forEach((query, i) => queries.push({
    id: `n-${String(i + 1).padStart(2, "0")}`, style: "unanswerable", query,
    anchorSlug: null, clusterId: null, relevance: [], approved: false, reviewNotes: "",
  }));
  process.stdout.write(`generated ${unanswerable.length} unanswerable queries\n`);
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  const reviewSet = {
    schemaVersion: 2,
    createdAt: evaluationTime,
    evaluationTime,
    scope,
    corpus: { documents: documents.length, skippedInvalidOrSuperseded: skipped, sha256: corpusDigest(documents), rankingSha256: rankingMetadataDigest(documents) },
    embeddingModel,
    queryModel,
    clusterCosineThreshold: threshold,
    clusterCount: clusters.length,
    queries,
    reviewInstructions: "Review each question from a user's perspective; edit query and graded relevance as needed, then set approved=true. Styles: natural (paraphrase, avoids the note's terms), keyword (2-5 search terms from the note), unanswerable (relevance must stay empty; if some note does answer it, add the labels and an anchorSlug, or delete it). Grade 3 is directly relevant, 2 is a relevant cluster sibling, 1 is partially relevant. Omit irrelevant notes; leave relevance empty when no note answers the query. This file is private and must not be committed.",
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
    // Without FTS rows BM25 matches nothing, silently voiding any lexical
    // measurement (fusion, lexical rescue) taken on this index (MNE-98).
    db.prepare("insert into fts_engrams(rowid, description, body) values(?, ?, ?)").run(result.lastInsertRowid, doc.description, doc.body);
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

function loadReviewedScope(scope, allowCorpusDrift = false) {
  const path = scopeFile(scope);
  if (!existsSync(path)) throw new Error(`No local review set for scope '${scope}'. Run prepare first.`);
  const reviewSet = JSON.parse(readFileSync(path, "utf8"));
  const pending = reviewSet.queries.filter((query) => query.approved !== true);
  if (pending.length) throw new Error(`Scope '${scope}' has ${pending.length} queries not reviewed. Approve them in ${path} before running.`);
  const { documents, skipped } = readCorpus(ROOT, scope);
  const rankingMetadataUnverified = !reviewSet.corpus.rankingSha256;
  const contentChanged = corpusDigest(documents) !== reviewSet.corpus.sha256 || skipped !== reviewSet.corpus.skippedInvalidOrSuperseded;
  const rankingMetadataChanged = !rankingMetadataUnverified && rankingMetadataDigest(documents) !== reviewSet.corpus.rankingSha256;
  const corpusChanged = contentChanged || rankingMetadataChanged;
  if (corpusChanged && !allowCorpusDrift) throw new Error(`Corpus changed since review set creation for scope '${scope}'. Re-run prepare and review the refreshed queries.`);
  const documentSlugs = new Set(documents.map((doc) => doc.slug));
  const queryIds = new Set();
  const excludedQueryIds = [];
  for (const query of reviewSet.queries) {
    if (!query.id || queryIds.has(query.id)) throw new Error(`Review set for '${scope}' has a missing or duplicate query id.`);
    queryIds.add(query.id);
    if (typeof query.query !== "string" || query.query.trim().length < 8) throw new Error(`Review set for '${scope}' has an empty or too-short query (${query.id}).`);
    if (!Array.isArray(query.relevance)) throw new Error(`Review set for '${scope}' has invalid relevance labels (${query.id}).`);
    const judged = new Set();
    let missingDocument = query.anchorSlug !== null && !documentSlugs.has(query.anchorSlug);
    for (const item of query.relevance) {
      if (judged.has(item.slug) || !Number.isInteger(item.grade) || item.grade < 1 || item.grade > 3) {
        throw new Error(`Review set for '${scope}' has an invalid graded document in ${query.id}.`);
      }
      if (!documentSlugs.has(item.slug)) missingDocument = true;
      judged.add(item.slug);
    }
    if (missingDocument) {
      if (!allowCorpusDrift) throw new Error(`Review set for '${scope}' has an invalid graded document in ${query.id}.`);
      excludedQueryIds.push(query.id);
    }
  }
  return { reviewSet, documents, queries: reviewSet.queries.filter((query) => !excludedQueryIds.includes(query.id)).map((query) => ({ ...query, scope })), corpusChanged, rankingMetadataUnverified, excludedQueryIds };
}

function calibrationConfigurations(floor) {
  const blend = { recency: 0.25, importance: 0.25, relevance: 1 };
  const cosineWeights = { recency: 0, importance: 0, relevance: 1 };
  const arms = [
    { name: "production", config: { weights: blend, floor } },
    { name: "blend-no-floor", config: { weights: blend, floor: null } },
    { name: "cosine-with-floor", config: { weights: cosineWeights, floor } },
    { name: "pure-cosine", config: { weights: cosineWeights, floor: null } },
  ];
  const grid = [];
  for (const recency of [0, 0.05, 0.10, 0.15, 0.20, 0.25]) {
    for (const importance of [0, 0.05, 0.10, 0.15, 0.20, 0.25]) {
      for (const candidateFloor of [null, 0.65, 0.66, 0.67, 0.68, 0.69, 0.70, 0.71, 0.72]) {
        grid.push({ name: `r${recency.toFixed(2)}-i${importance.toFixed(2)}-f${candidateFloor === null ? "off" : candidateFloor.toFixed(2)}`,
          config: { weights: { recency, importance, relevance: 1 }, floor: candidateFloor } });
      }
    }
  }
  return { arms, grid };
}

async function calibrateScope(scope, embeddingModel) {
  const { reviewSet, documents, queries } = loadReviewedScope(scope);
  const before = currentFingerprint(scope);
  assertCalibrationReviewSet(reviewSet, {
    contentSha256: before.contentSha256, rankingSha256: before.rankingSha256,
    documentSlugs: new Set(documents.map((doc) => doc.slug)),
  });
  const now = Date.parse(reviewSet.evaluationTime ?? reviewSet.createdAt);
  if (!Number.isFinite(now)) throw new Error(`Review set for '${scope}' has an invalid evaluation time.`);
  const { client, db } = await indexReviewedScope(documents, embeddingModel);
  try {
    const floor = resolveMinCos(client.id);
    if (floor !== NOMIC_MIN_COS) throw new Error("MNE-76 calibration requires local nomic-embed-text with its calibrated cosine floor.");
    const { arms: armConfigs, grid: gridConfigs } = calibrationConfigurations(floor);
    const production = armConfigs[0].config;
    const deps = { db, root: ROOT, embedder: client, clock: fixedClock(now) };
    const cases = [];
    for (const query of queries) {
      const result = await searchExplain(deps, { query: query.query, scopes: [scope], k: documents.length });
      const candidates = result.candidates.map((item) => ({
        slug: item.slug, cosine: item.signals.relevanceCosine, normalized: item.signals.normalized,
      }));
      if (candidates.some((item) => !item.normalized)) throw new Error(`Missing normalized signals in ${scope}/${query.id}.`);
      const actualTop10 = result.candidates.filter((item) => item.included).slice(0, TOP_K).map((item) => item.slug);
      const reconstructed = rankCalibrationCandidates(candidates, production, TOP_K);
      if (JSON.stringify(actualTop10) !== JSON.stringify(reconstructed)) {
        throw new Error(`Calibration failed to reproduce production order for ${scope}/${query.id}.`);
      }
      cases.push({ id: query.id, relevance: query.relevance, candidates });
    }
    const after = currentFingerprint(scope);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`Corpus or access events changed during calibration of '${scope}'; no scorecard written.`);
    const arms = compareCalibrationArms(cases, armConfigs, TOP_K);
    const grid = compareCalibrationArms(cases, gridConfigs, TOP_K).map(({ name, config, result }) => ({
      name, config, answerable: result.answerable, unanswerable: result.unanswerable,
    }));
    const report = {
      benchmark: "mnemosyne-5b-calibration-v1", algoVersion: ALGO_VERSION,
      scope, evaluationTime: new Date(now).toISOString(), embeddingModel,
      queryCount: queries.length, answerableCount: queries.filter((query) => query.relevance.length > 0).length,
      unanswerableCount: queries.filter((query) => query.relevance.length === 0).length,
      corpus: before, topK: TOP_K, arms, grid,
      limitations: [
        "Queries and labels are locally reviewed; they are not committed to git.",
        "A grid search on this small private set can overfit. A candidate requires further validation before changing production defaults.",
      ],
    };
    const output = scopeScorecardFile(scope, `${embeddingModel}-calibration`);
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(`calibration scope=${scope} queries=${queries.length} negatives=${report.unanswerableCount}`);
    for (const arm of arms) console.log(`${arm.name}: nDCG@10=${arm.result.answerable.meanNdcgAt10?.toFixed(3)} MRR=${arm.result.answerable.mrr?.toFixed(3)} false-positive=${arm.result.unanswerable.falsePositives}/${arm.result.unanswerable.queries}`);
    console.log(`local calibration scorecard: ${output}`);
    return report;
  } finally {
    db.close();
  }
}

/** Style of a reviewed query; schema-1 sets predate styles and only had natural + manual negatives. */
function queryStyle(query) {
  return query.style ?? (query.relevance.length === 0 ? "unanswerable" : "natural");
}

/**
 * MNE-98: calibrate the two-signal gate (cosine floor OR raw-BM25 lexical
 * rescue) for the CURRENT embedding model. Unlike `calibrate`, this is not
 * tied to nomic: each model gets its own cosine floor. Ranking is untouched
 * (cosine-only, as production search); only eligibility is swept.
 */
async function calibrateFloorScope(scope, embeddingModel) {
  const { reviewSet, documents, queries } = loadReviewedScope(scope);
  const before = currentFingerprint(scope);
  assertCalibrationReviewSet(reviewSet, {
    contentSha256: before.contentSha256, rankingSha256: before.rankingSha256,
    documentSlugs: new Set(documents.map((doc) => doc.slug)),
  });
  const now = Date.parse(reviewSet.evaluationTime ?? reviewSet.createdAt);
  if (!Number.isFinite(now)) throw new Error(`Review set for '${scope}' has an invalid evaluation time.`);
  const { client, db } = await indexReviewedScope(documents, embeddingModel);
  try {
    const deps = { db, root: ROOT, embedder: client, clock: fixedClock(now) };
    const cases = [];
    for (const query of queries) {
      // Floors wide open (cos -1, lexical 0) so every candidate carries its raw
      // cosine and BM25; the sweep then applies each floor pair offline.
      const result = await searchExplain(deps, { query: query.query, scopes: [scope], k: documents.length, minCos: -1, lexicalFloor: 0 });
      cases.push({
        id: query.id, style: queryStyle(query), relevance: query.relevance,
        candidates: result.candidates.map((item) => ({
          slug: item.slug, cosine: item.signals.relevanceCosine, bm25: item.bm25 ?? null, normalized: item.signals.normalized,
        })),
      });
    }
    const after = currentFingerprint(scope);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`Corpus or access events changed during calibration of '${scope}'; no scorecard written.`);
    const grid = sweepFloorGrid(cases, { cosineFloors: COSINE_FLOOR_GRID, lexicalFloors: LEXICAL_FLOOR_GRID }, TOP_K);
    const productionFloor = resolveMinCos(client.id);
    const production = productionFloor === null ? null
      : sweepFloorGrid(cases, { cosineFloors: [productionFloor], lexicalFloors: [null] }, TOP_K)[0];
    const negatives = cases.filter((item) => item.style === "unanswerable");
    // Answerable styles present in this set: natural and keyword from prepare,
    // plus any added in review (e.g. near: generated negatives the store answers).
    const answerableStyles = [...new Set(cases.map((item) => item.style).filter((style) => style !== "unanswerable"))].sort();
    const bestCosineOnly = selectFloorPair(grid.filter((row) => row.lexicalFloor === null), { maxFalsePositives: 0 });
    const bestCombined = selectFloorPair(grid, { maxFalsePositives: 0 });
    // Recall of the chosen pair per answerable style: a floor that serves
    // keyword queries by starving natural ones is not a win.
    const byStyle = (pair) => pair && Object.fromEntries(answerableStyles.map((style) => {
      const subset = [...cases.filter((item) => item.style === style), ...negatives];
      const [row] = sweepFloorGrid(subset, { cosineFloors: [pair.cosineFloor], lexicalFloors: [pair.lexicalFloor] }, TOP_K);
      return [style, { queries: row.answerable, recall: row.recall, ndcg: row.ndcg }];
    }));
    const separation = Object.fromEntries(["all", ...answerableStyles].map((style) => [style,
      floorSeparation(style === "all" ? cases : [...cases.filter((item) => item.style === style), ...negatives])]));
    const report = {
      benchmark: "mnemosyne-floor-calibration-v1", algoVersion: ALGO_VERSION,
      scope, evaluationTime: new Date(now).toISOString(), embeddingModel, embedderId: client.id,
      queryCount: cases.length,
      styles: Object.fromEntries([...answerableStyles, "unanswerable"].map((style) => [style, cases.filter((item) => item.style === style).length])),
      corpus: before, topK: TOP_K,
      separation,
      production: production && { ...production, byStyle: byStyle(production) },
      bestCosineOnly: bestCosineOnly && { ...bestCosineOnly, byStyle: byStyle(bestCosineOnly) },
      bestCombined: bestCombined && { ...bestCombined, byStyle: byStyle(bestCombined) },
      grid,
      limitations: [
        "Queries and labels are locally reviewed; they are not committed to git.",
        "Raw BM25 depends on this store's size and note lengths; a lexical floor calibrated here does not transfer to another store.",
        "Selection uses zero false positives on a small reviewed negative set; validate with fresh negatives before changing production defaults.",
      ],
    };
    const output = scopeScorecardFile(scope, `${embeddingModel}-floor-calibration`);
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    const fmt = (v) => (v === null || v === undefined ? "—" : v.toFixed(3));
    const line = (name, row) => console.log(row
      ? `${name}: cos≥${row.cosineFloor.toFixed(2)} lexical≥${row.lexicalFloor === null ? "off" : row.lexicalFloor.toFixed(1)} recall=${fmt(row.recall)} nDCG@10=${fmt(row.ndcg)} FP=${row.falsePositives}/${row.unanswerable}`
        + (row.byStyle ? ` | ${Object.entries(row.byStyle).map(([style, r]) => `${style} recall=${fmt(r.recall)}`).join(" ")}` : "")
      : `${name}: none within 0 false positives`);
    console.log(`floor calibration scope=${scope} model=${embeddingModel} queries=${JSON.stringify(report.styles)}`);
    console.log(`separation cosine: positive min ${fmt(separation.all.cosine.positiveMin)} vs negative max ${fmt(separation.all.cosine.negativeMax)}${separation.all.cosine.overlap ? " (OVERLAP)" : ""}`);
    console.log(`separation bm25:   positive min ${fmt(separation.all.bm25.positiveMin)} vs negative max ${fmt(separation.all.bm25.negativeMax)}${separation.all.bm25.overlap ? " (OVERLAP)" : ""}; positives without lexical match=${separation.all.bm25.positivesWithoutMatch}`);
    line("production", report.production);
    line("best cosine-only", report.bestCosineOnly);
    line("best combined", report.bestCombined);
    console.log(`local floor calibration scorecard: ${output}`);
    return report;
  } finally {
    db.close();
  }
}

function reportJointCalibration(reports) {
  const byScope = new Map(reports.map((report) => [report.scope, report]));
  const personal = byScope.get("personal");
  const privateScope = byScope.get("private");
  if (!personal || !privateScope) return;
  if (personal.evaluationTime !== privateScope.evaluationTime) {
    throw new Error("Joint calibration requires the same reviewed evaluation time for both scopes.");
  }
  const productionFor = (report) => report.arms.find((arm) => arm.name === "production").result;
  const personalBaseline = productionFor(personal);
  const privateBaseline = productionFor(privateScope);
  const rows = privateScope.grid.map((row, i) => ({
    name: row.name,
    scopes: {
      private: { ndcg: row.answerable.meanNdcgAt10, falsePositives: row.unanswerable.falsePositives },
      personal: { ndcg: personal.grid[i].answerable.meanNdcgAt10, falsePositives: personal.grid[i].unanswerable.falsePositives },
    },
  }));
  const eligible = selectEligibleConfigurations(rows, [
    { scope: "private", minNdcg: 0.70, maxFalsePositives: privateBaseline.unanswerable.falsePositives },
    { scope: "personal", minNdcg: personalBaseline.answerable.meanNdcgAt10, maxFalsePositives: personalBaseline.unanswerable.falsePositives },
  ]);
  eligible.sort((a, b) => rows.find((row) => row.name === b).scopes.private.ndcg - rows.find((row) => row.name === a).scopes.private.ndcg);
  const output = join(OUTPUT_ROOT, "calibration-joint.json");
  writeFileSync(output, `${JSON.stringify({ benchmark: "mnemosyne-5b-calibration-joint-v1", scopes: ["personal", "private"],
    evaluatedConfigurations: rows.length, targetPrivateNdcgAt10: 0.70,
    production: { personal: personalBaseline, private: privateBaseline },
    eligibleCount: eligible.length, bestEligible: eligible[0] ?? null,
    eligible: eligible.map((name) => rows.find((row) => row.name === name)),
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(`joint eligibility: ${eligible.length}/${rows.length}; best=${eligible[0] ?? "none"}; local scorecard: ${output}`);
}

/**
 * FTS5's bm25() takes IDF and average length from the WHOLE fts table, not from
 * the rows a query's scope filter keeps. Production indexes every scope in one
 * table, so a bench index holding only the evaluated scope measures raw BM25 on
 * a different scale (±9% on the 2026-10-24 store), which voids any absolute
 * lexical floor calibrated on it (MNE-98). Add the other scopes' text to FTS
 * only: no engrams row, so search can never return them, but they weigh in the
 * corpus statistics exactly as in production.
 */
function addCorpusStatistics(db, evaluated) {
  const scope = evaluated[0]?.scope;
  const insert = db.prepare("insert into fts_engrams(rowid, description, body) values(?, ?, ?)");
  let rowid = 1_000_000_000;
  for (const other of listScopes(ROOT).filter((s) => s !== scope)) {
    for (const doc of readCorpus(ROOT, other).documents) insert.run(rowid++, doc.description, doc.body);
  }
}

async function indexReviewedScope(documents, embeddingModel) {
  const client = clientWithKeepAlive(embeddingModel, "5m");
  const vectors = [];
  for (let i = 0; i < documents.length; i += 24) vectors.push(...await client.embed(documents.slice(i, i + 24).map((doc) => doc.text), "document"));
  const db = openDb(":memory:");
  buildMemoryIndex(db, documents, vectors, client.dim);
  addCorpusStatistics(db, documents);
  return { client, db };
}

async function runScope(scope, embeddingModel) {
  const { reviewSet, documents, queries } = loadReviewedScope(scope);
  const { client, db } = await indexReviewedScope(documents, embeddingModel);
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

async function diagnoseScope(scope, embeddingModel, allowCorpusDrift) {
  const { reviewSet, documents, queries, corpusChanged, rankingMetadataUnverified, excludedQueryIds } = loadReviewedScope(scope, allowCorpusDrift);
  const { client, db } = await indexReviewedScope(documents, embeddingModel);
  try {
    const reviewedAt = Date.parse(reviewSet.evaluationTime ?? reviewSet.createdAt);
    if (!Number.isFinite(reviewedAt)) throw new Error(`Review set for '${scope}' has an invalid evaluation time.`);
    const now = diagnosticTime(reviewedAt, corpusChanged || rankingMetadataUnverified, Date.now());
    const deps = { db, root: ROOT, embedder: client, clock: fixedClock(now) };
    const perQuery = [];
    for (const query of queries) {
      const opts = { query: query.query, scopes: [scope], k: documents.length };
      const blend = await searchExplain(deps, opts);
      const cosine = await searchExplain(deps, { ...opts, weights: { recency: 0, importance: 0, relevance: 1 }, minCos: -1 });
      perQuery.push(diagnoseQuery(query.id, query.relevance,
        blend.candidates.filter((candidate) => candidate.included),
        cosine.candidates.filter((candidate) => candidate.included), blend.minCos));
    }
    const report = {
      benchmark: "mnemosyne-5b-diagnosis-v1", algoVersion: ALGO_VERSION,
      scope, evaluationTime: new Date(now).toISOString(), reviewedAt: new Date(reviewedAt).toISOString(), embeddingModel,
      corpusDocuments: documents.length, reviewedCorpusDocuments: reviewSet.corpus.documents,
      corpusChanged, rankingMetadataUnverified,
      reviewedCorpusSha256: reviewSet.corpus.sha256, currentCorpusSha256: corpusDigest(documents),
      reviewedRankingSha256: reviewSet.corpus.rankingSha256 ?? null, currentRankingSha256: rankingMetadataDigest(documents),
      queryCount: queries.length, excludedQueryIds, topK: TOP_K,
      summary: summarizeDiagnostics(perQuery), perQuery,
      limitations: [
        "Cause embedder-or-label requires manual inspection of the private review set; it is not an automatic verdict on the embedding model.",
        ...(corpusChanged ? ["The corpus changed after query review. These metrics cannot be compared directly with the original 5b scorecard."] : []),
        ...(rankingMetadataUnverified ? ["This older review set has no ranking-metadata digest; changes in importance since review cannot be verified."] : []),
        ...(excludedQueryIds.length ? ["Queries whose anchor or graded documents are absent from the current corpus were excluded."] : []),
        "Only query IDs and numeric signals are present; queries, slugs, and note text remain local to the private review set.",
      ],
    };
    const output = scopeScorecardFile(scope, `${embeddingModel}-diagnosis`);
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(`diagnosis scope=${scope} queries=${queries.length} excluded=${excludedQueryIds.length} corpusChanged=${corpusChanged}`);
    console.log(`nDCG@10 blended=${report.summary.blended.meanNdcgAt10?.toFixed(3)} cosine-only=${report.summary.cosine.meanNdcgAt10?.toFixed(3)}`);
    console.log(`causes=${JSON.stringify(report.summary.causes)}`);
    console.log(`unanswerable=${JSON.stringify(report.summary.unanswerable)}`);
    console.log(`local diagnosis: ${output}`);
  } finally {
    db.close();
  }
}

async function main() {
  localHostOnly();
  const opts = options(process.argv.slice(2));
  const available = listScopes(ROOT);
  const scopes = opts.scopes.length ? [...new Set(opts.scopes)] : available;
  if (scopes.length === 0 || scopes.some((scope) => !available.includes(scope))) throw new Error("Choose an existing scope from the local memory store.");
  const embeddingModel = process.env.OLLAMA_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  await assertLocalModel(embeddingModel);
  const calibrationReports = [];
  for (const scope of scopes) {
    if (opts.command === "prepare") await prepareScope(scope, opts);
    else if (opts.command === "run") await runScope(scope, embeddingModel);
    else if (opts.command === "diagnose") await diagnoseScope(scope, embeddingModel, opts.allowCorpusDrift);
    else if (opts.command === "calibrate-floor") await calibrateFloorScope(scope, embeddingModel);
    else calibrationReports.push(await calibrateScope(scope, embeddingModel));
  }
  if (opts.command === "calibrate") reportJointCalibration(calibrationReports);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
