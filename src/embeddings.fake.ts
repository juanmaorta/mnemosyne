import { EMBEDDING_DIM, type EmbeddingClient } from "./embeddings.js";

/** Deterministic, dependency-free embedder for tests: bag-of-words over a hashed vocab. */
export function createFakeEmbedder(dim: number = EMBEDDING_DIM): EmbeddingClient {
  return {
    id: `fake-bow/dim${dim}`,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array<number>(dim).fill(0);
        for (const tok of t.toLowerCase().split(/\s+/).filter(Boolean)) {
          let h = 0;
          for (const ch of tok) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          v[h % dim]! += 1;
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
}
