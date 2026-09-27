// src/embeddings.test.ts
import { afterEach, describe, expect, test, vi } from "vitest";
import { createOllamaClient, DEFAULT_EMBEDDING_DIM } from "./embeddings.js";
import { createFakeEmbedder } from "./embeddings.fake.js";

describe("createOllamaClient", () => {
  test("embed_posts_input_batch_and_returns_vectors", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ embeddings: [[1, 0, 0], [0, 1, 0]] }), { status: 200 }),
    );
    const client = createOllamaClient({ host: "http://h:1", model: "m", dim: 3 }, fetchImpl as unknown as typeof fetch);

    const out = await client.embed(["a", "b"]);

    expect(out).toEqual([[1, 0, 0], [0, 1, 0]]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://h:1/api/embed");
    expect(JSON.parse(init.body as string)).toEqual({ model: "m", input: ["a", "b"] });
  });

  test("embed_throws_actionable_error_when_host_unreachable", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const client = createOllamaClient({ host: "http://h:1", model: "m", dim: 3 }, fetchImpl as unknown as typeof fetch);

    await expect(client.embed(["a"])).rejects.toThrow(/Ollama.*http:\/\/h:1|OLLAMA_HOST|ollama serve/i);
  });

  test("embed_throws_actionable_error_when_model_missing", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "model 'm' not found" }), { status: 404 }));
    const client = createOllamaClient({ host: "http://h:1", model: "m", dim: 3 }, fetchImpl as unknown as typeof fetch);

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
    expect(v).toHaveLength(DEFAULT_EMBEDDING_DIM);
    const norm = Math.sqrt(v!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe("embedding model configuration", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  const okResponse = (dim: number) =>
    vi.fn(async () => new Response(JSON.stringify({ embeddings: [new Array(dim).fill(0)] }), { status: 200 }));

  test("model_comes_from_OLLAMA_MODEL_when_no_config_is_passed", async () => {
    vi.stubEnv("OLLAMA_MODEL", "bge-m3");
    const fetchImpl = okResponse(1024);
    const client = createOllamaClient({}, fetchImpl as unknown as typeof fetch);

    await client.embed(["a"]);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe("bge-m3");
  });

  test("model_defaults_to_nomic_embed_text_when_the_env_is_unset", () => {
    vi.stubEnv("OLLAMA_MODEL", undefined);
    expect(createOllamaClient().id).toBe("nomic-embed-text/dim768/task-prefix-v1");
  });

  test("nomic_prefixes_documents_and_queries_and_fingerprints_the_new_embedding_space", async () => {
    const fetchImpl = okResponse(768);
    const client = createOllamaClient({ model: "nomic-embed-text" }, fetchImpl as unknown as typeof fetch);
    await client.embed(["a document"], "document");
    await client.embed(["a query"], "query");
    const [, docInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [, queryInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(docInit.body as string).input).toEqual(["search_document: a document"]);
    expect(JSON.parse(queryInit.body as string).input).toEqual(["search_query: a query"]);
    expect(client.id).toBe("nomic-embed-text/dim768/task-prefix-v1");
  });

  test("other models receive the original unprefixed input", async () => {
    const fetchImpl = okResponse(1024);
    const client = createOllamaClient({ model: "bge-m3" }, fetchImpl as unknown as typeof fetch);
    await client.embed(["a document"], "document");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).input).toEqual(["a document"]);
  });

  test("dimension_is_derived_from_the_model_not_from_a_constant", () => {
    expect(createOllamaClient({ model: "bge-m3" }).dim).toBe(1024);
    expect(createOllamaClient({ model: "bge-m3" }).id).toBe("bge-m3/dim1024");
    expect(createOllamaClient({ model: "qwen3-embedding:0.6b" }).dim).toBe(1024);
    expect(createOllamaClient({ model: "nomic-embed-text" }).dim).toBe(768);
  });

  test("a_latest_tag_resolves_to_the_same_dimension_as_the_bare_model", () => {
    expect(createOllamaClient({ model: "bge-m3:latest" }).dim).toBe(1024);
  });

  test("an_unknown_model_is_refused_instead_of_assumed_to_be_768", () => {
    expect(() => createOllamaClient({ model: "mystery-embed" })).toThrow(/OLLAMA_EMBEDDING_DIM/);
  });

  test("an_unknown_model_is_usable_once_its_dimension_is_declared", () => {
    vi.stubEnv("OLLAMA_EMBEDDING_DIM", "512");
    const client = createOllamaClient({ model: "mystery-embed" });
    expect(client.dim).toBe(512);
    expect(client.id).toBe("mystery-embed/dim512");
  });

  test("a_nonsense_declared_dimension_is_refused", () => {
    vi.stubEnv("OLLAMA_EMBEDDING_DIM", "not-a-number");
    expect(() => createOllamaClient({ model: "mystery-embed" })).toThrow(/OLLAMA_EMBEDDING_DIM/);
  });

  test("embed_refuses_vectors_whose_width_contradicts_the_declared_dimension", async () => {
    // The index table is created at the DECLARED width; writing vectors of
    // another width is what silently mixes two embedding spaces.
    const fetchImpl = okResponse(1024);
    const client = createOllamaClient({ model: "nomic-embed-text" }, fetchImpl as unknown as typeof fetch);

    await expect(client.embed(["a"])).rejects.toThrow(/1024/);
    await expect(client.embed(["a"])).rejects.toThrow(/768/);
  });
});

describe("createFakeEmbedder dimension", () => {
  test("fake_reports_the_dimension_it_was_built_with", async () => {
    const e = createFakeEmbedder(8);
    expect(e.dim).toBe(8);
    expect(e.id).toBe("fake-bow/dim8");
    expect((await e.embed(["hello"]))[0]).toHaveLength(8);
  });

  test("fake_defaults_to_the_default_model_dimension", () => {
    expect(createFakeEmbedder().dim).toBe(DEFAULT_EMBEDDING_DIM);
  });
});
