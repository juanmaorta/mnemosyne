// src/embeddings.test.ts
import { describe, expect, test, vi } from "vitest";
import { createOllamaClient, EMBEDDING_DIM } from "./embeddings.js";
import { createFakeEmbedder } from "./embeddings.fake.js";

describe("createOllamaClient", () => {
  test("embed_posts_input_batch_and_returns_vectors", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ embeddings: [[1, 0, 0], [0, 1, 0]] }), { status: 200 }),
    );
    const client = createOllamaClient({ host: "http://h:1", model: "m" }, fetchImpl as unknown as typeof fetch);

    const out = await client.embed(["a", "b"]);

    expect(out).toEqual([[1, 0, 0], [0, 1, 0]]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://h:1/api/embed");
    expect(JSON.parse(init.body as string)).toEqual({ model: "m", input: ["a", "b"] });
  });

  test("embed_throws_actionable_error_when_host_unreachable", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const client = createOllamaClient({ host: "http://h:1", model: "m" }, fetchImpl as unknown as typeof fetch);

    await expect(client.embed(["a"])).rejects.toThrow(/Ollama.*http:\/\/h:1|OLLAMA_HOST|ollama serve/i);
  });

  test("embed_throws_actionable_error_when_model_missing", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "model 'm' not found" }), { status: 404 }));
    const client = createOllamaClient({ host: "http://h:1", model: "m" }, fetchImpl as unknown as typeof fetch);

    await expect(client.embed(["a"])).rejects.toThrow(/ollama pull m|not found/i);
  });
});

describe("createFakeEmbedder", () => {
  test("fake_gives_higher_cosine_to_shared_tokens", async () => {
    const e = createFakeEmbedder();
    const [q, near, far] = await e.embed(["yogurt maker", "yogurt maker control", "network router omada"]);
    const cos = (a: number[], b: number[]) =>
      a.reduce((s, x, i) => s + x * b[i]!, 0); // both unit-normalized
    expect(cos(q!, near!)).toBeGreaterThan(cos(q!, far!));
  });

  test("fake_vectors_are_unit_length_and_correct_dim", async () => {
    const [v] = await createFakeEmbedder().embed(["hello world"]);
    expect(v).toHaveLength(EMBEDDING_DIM);
    const norm = Math.sqrt(v!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});
