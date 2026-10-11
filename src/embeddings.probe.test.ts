// src/embeddings.probe.test.ts
import { describe, expect, test } from "vitest";
import { probeOllama } from "./embeddings.js";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  })) as unknown as typeof fetch;
}

describe("probeOllama", () => {
  test("true_when_the_configured_embedding_model_is_present", async () => {
    const ok = await probeOllama("http://h", "nomic-embed-text", 500,
      fakeFetch(200, { models: [{ name: "nomic-embed-text:latest" }, { name: "llama3:8b" }] }));
    expect(ok).toBe(true);
  });

  test("false_when_the_server_is_up_but_the_model_is_missing", async () => {
    // Regression (Codex): /api/tags returns 200 with only chat models; the
    // embedding tier must not be enabled, or searches fail with model-not-found.
    const ok = await probeOllama("http://h", "nomic-embed-text", 500,
      fakeFetch(200, { models: [{ name: "llama3:8b" }] }));
    expect(ok).toBe(false);
  });

  test("false_when_a_different_tag_of_the_model_is_installed", async () => {
    // Regression (Codex): an explicit tag must match exactly — :0.6b requested,
    // :8b installed is NOT a match (embeds would use the missing :0.6b).
    const ok = await probeOllama("http://h", "qwen3-embedding:0.6b", 500,
      fakeFetch(200, { models: [{ name: "qwen3-embedding:8b" }] }));
    expect(ok).toBe(false);
  });

  test("true_for_an_exact_tag_match", async () => {
    const ok = await probeOllama("http://h", "qwen3-embedding:0.6b", 500,
      fakeFetch(200, { models: [{ name: "qwen3-embedding:0.6b" }] }));
    expect(ok).toBe(true);
  });

  test("false_when_there_are_no_models_at_all", async () => {
    const ok = await probeOllama("http://h", "nomic-embed-text", 500, fakeFetch(200, { models: [] }));
    expect(ok).toBe(false);
  });

  test("false_on_a_non_ok_status", async () => {
    const ok = await probeOllama("http://h", "nomic-embed-text", 500, fakeFetch(500, {}));
    expect(ok).toBe(false);
  });

  test("false_when_the_server_is_unreachable", async () => {
    const throwing = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await probeOllama("http://h", "nomic-embed-text", 500, throwing)).toBe(false);
  });
});
