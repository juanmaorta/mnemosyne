/**
 * Vector width of each embedding model we know about.
 *
 * The dimension is a property OF THE MODEL, not of Mnemosyne: a single constant
 * starts lying the moment anyone points `OLLAMA_MODEL` at a 1024-dim model, and
 * a lying dimension means vectors written into a table of the wrong width — the
 * one failure the index cannot recover from on its own.
 *
 * Models outside this table are usable by declaring `OLLAMA_EMBEDDING_DIM`;
 * guessing is deliberately not an option (see `resolveEmbeddingDim`).
 */
export const MODEL_DIMS: Readonly<Record<string, number>> = {
  "nomic-embed-text": 768,
  "nomic-embed-text-v2-moe": 768,
  "bge-m3": 1024,
  "qwen3-embedding:0.6b": 1024,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
};

export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";

/**
 * Width a fresh vector table is created at, and the fake embedder's default.
 *
 * NOT the width of whatever model is configured: `reindex` resizes the table to
 * `EmbeddingClient.dim` whenever the two disagree.
 */
export const DEFAULT_EMBEDDING_DIM = MODEL_DIMS[DEFAULT_EMBEDDING_MODEL]!;

export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Model+dimension fingerprint, stamped into the index. Vectors from two
   * different models are not comparable, so a change here has to invalidate
   * every embedding rather than silently degrade every cosine distance.
   */
  readonly id: string;
  /** Vector width this client produces. The index table is sized from it. */
  readonly dim: number;
}

export interface OllamaConfig {
  host: string;
  model: string;
  /** Explicit width, for a model absent from `MODEL_DIMS`. */
  dim: number;
}

/**
 * The model's vector width: from the model registry, or from an explicit
 * declaration for a model we do not know.
 *
 * An unknown model throws instead of falling back to 768. A wrong dimension is
 * not a degraded search, it is an index whose table width contradicts its
 * contents — and the cheapest place to notice is before the first write.
 */
export function resolveEmbeddingDim(model: string, declared?: string | number): number {
  if (declared !== undefined && declared !== "") {
    const n = typeof declared === "number" ? declared : Number(String(declared).trim());
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`OLLAMA_EMBEDDING_DIM must be a positive integer, got ${JSON.stringify(declared)}.`);
    }
    return n;
  }
  // Ollama's implicit `:latest` tag names the same weights as the bare model.
  const known = MODEL_DIMS[model] ?? (model.endsWith(":latest") ? MODEL_DIMS[model.slice(0, -":latest".length)] : undefined);
  if (known !== undefined) return known;
  const catalogue = Object.entries(MODEL_DIMS).map(([m, d]) => `${m}=${d}`).join(", ");
  throw new Error(
    `Unknown embedding model "${model}": its vector dimension is not known, and guessing it would corrupt the index. ` +
      `Set OLLAMA_EMBEDDING_DIM=<n> to declare it, or use a known model (${catalogue}).`,
  );
}

function defaults(): { host: string; model: string; declaredDim: string | undefined } {
  // Read per call, not at import: the env belongs to the process invoking the
  // CLI, and a module-level snapshot makes the value untestable and stale.
  return {
    host: process.env.OLLAMA_HOST ?? "http://localhost:11434",
    model: process.env.OLLAMA_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    declaredDim: process.env.OLLAMA_EMBEDDING_DIM,
  };
}

export function createOllamaClient(
  config: Partial<OllamaConfig> = {},
  fetchImpl: typeof fetch = fetch,
): EmbeddingClient {
  const base = defaults();
  const host = config.host ?? base.host;
  const model = config.model ?? base.model;
  const dim = resolveEmbeddingDim(model, config.dim ?? base.declaredDim);
  return {
    id: `${model}/dim${dim}`,
    dim,
    async embed(texts) {
      let res: Response;
      try {
        res = await fetchImpl(`${host}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, input: texts }),
        });
      } catch (cause) {
        throw new Error(
          `Cannot reach Ollama at ${host}. Is it running? Set OLLAMA_HOST or run 'ollama serve'.`,
          { cause },
        );
      }
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(
          `Ollama embed failed (${res.status}): ${detail}. If the model is missing, run 'ollama pull ${model}'.`,
        );
      }
      const json = (await res.json()) as { embeddings?: number[][] };
      if (!json.embeddings) throw new Error(`Ollama returned no embeddings: ${JSON.stringify(json)}`);
      // The model is the only authority on its own width, and this is the one
      // moment it speaks — for free, on a batch we already asked for. A table
      // sized `dim` receiving vectors of another width is the corruption this
      // whole fingerprint mechanism exists to prevent, so it fails loudly here
      // rather than per row, or worse, silently under a coincidental width.
      const got = json.embeddings[0]?.length;
      if (got !== undefined && got !== dim) {
        throw new Error(
          `Model "${model}" returned ${got}-dimensional vectors but Mnemosyne is configured for ${dim}. ` +
            `Fix OLLAMA_EMBEDDING_DIM (or the model registry) — writing these vectors would corrupt the index.`,
        );
      }
      return json.embeddings;
    },
  };
}
