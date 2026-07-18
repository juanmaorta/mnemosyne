export const EMBEDDING_DIM = 768;

export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>;
}

export interface OllamaConfig {
  host: string;
  model: string;
}

const DEFAULT_CONFIG: OllamaConfig = {
  host: process.env.OLLAMA_HOST ?? "http://localhost:11434",
  model: "nomic-embed-text",
};

export function createOllamaClient(
  config: Partial<OllamaConfig> = {},
  fetchImpl: typeof fetch = fetch,
): EmbeddingClient {
  const { host, model } = { ...DEFAULT_CONFIG, ...config };
  return {
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
      return json.embeddings;
    },
  };
}
