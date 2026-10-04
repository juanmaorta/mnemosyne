import { describe, expect, test, vi } from "vitest";
import { createLocalGenerator } from "./generate.js";

/** A fetch stub that records the request and returns a canned Ollama reply. */
function fakeFetch(captured: { url?: string; body?: Record<string, unknown> }, response: unknown): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    captured.url = String(url);
    if (init?.body) captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("createLocalGenerator", () => {
  test("posts the prompt to Ollama /api/generate and returns the response text", async () => {
    const cap: { url?: string; body?: Record<string, unknown> } = {};
    const gen = createLocalGenerator(
      { host: "http://localhost:11434", model: "qwen2.5:7b" },
      fakeFetch(cap, { response: "nota sintética", prompt_eval_count: 12, eval_count: 7 }),
    );

    const out = await gen.generate("resume estos hechos", { system: "fiel a las fuentes" });

    expect(out.text).toBe("nota sintética");
    expect(out.inputTokens).toBe(12);
    expect(out.outputTokens).toBe(7);
    expect(typeof out.durationMs).toBe("number");
    expect(cap.url).toBe("http://localhost:11434/api/generate");
    expect(cap.body).toMatchObject({
      model: "qwen2.5:7b",
      prompt: "resume estos hechos",
      system: "fiel a las fuentes",
      stream: false,
    });
  });

  test("defaults to the qwen generation model, separate from the embedding model", async () => {
    const cap: { url?: string; body?: Record<string, unknown> } = {};
    const gen = createLocalGenerator({}, fakeFetch(cap, { response: "x" }));

    await gen.generate("hola");

    expect(cap.body!.model).toBe("qwen2.5:7b");
  });

  test("sends an Authorization header when an apiKey is configured", async () => {
    const cap: { init?: RequestInit } = {};
    const capFetch = (async (_url: string, init?: RequestInit) => {
      if (init) cap.init = init;
      return new Response(JSON.stringify({ response: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await createLocalGenerator({ apiKey: "secret-k" }, capFetch).generate("hola");

    expect((cap.init!.headers as Record<string, string>).authorization).toBe("Bearer secret-k");
  });

  test("sends no Authorization header when no apiKey is configured", async () => {
    const cap: { init?: RequestInit } = {};
    const capFetch = (async (_url: string, init?: RequestInit) => {
      if (init) cap.init = init;
      return new Response(JSON.stringify({ response: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await createLocalGenerator({}, capFetch).generate("hola");

    expect((cap.init!.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("never follows redirects (a 3xx must not re-send the body to another host)", async () => {
    const cap: { init?: RequestInit } = {};
    const capturingFetch = (async (_url: string, init?: RequestInit) => {
      if (init) cap.init = init;
      return new Response(JSON.stringify({ response: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await createLocalGenerator({}, capturingFetch).generate("hola");

    expect(cap.init!.redirect).toBe("error");
  });

  test("sends temperature 0 by default (greedy, reproducible dreaming)", async () => {
    const cap: { url?: string; body?: Record<string, unknown> } = {};
    const gen = createLocalGenerator({}, fakeFetch(cap, { response: "x" }));

    await gen.generate("hola");

    expect((cap.body!.options as Record<string, unknown>).temperature).toBe(0);
  });

  test("sends a configured seed in options; omits it when unset", async () => {
    const withSeed: { body?: Record<string, unknown> } = {};
    await createLocalGenerator({ seed: 42 }, fakeFetch(withSeed, { response: "x" })).generate("hola");
    expect((withSeed.body!.options as Record<string, unknown>).seed).toBe(42);

    const noSeed: { body?: Record<string, unknown> } = {};
    await createLocalGenerator({}, fakeFetch(noSeed, { response: "x" })).generate("hola");
    expect((noSeed.body!.options as Record<string, unknown>)).not.toHaveProperty("seed");
  });

  test("per-call opts override temperature and seed", async () => {
    const cap: { body?: Record<string, unknown> } = {};
    const gen = createLocalGenerator({ seed: 1 }, fakeFetch(cap, { response: "x" }));

    await gen.generate("hola", { temperature: 0.7, seed: 99 });

    const opts = cap.body!.options as Record<string, unknown>;
    expect(opts.temperature).toBe(0.7);
    expect(opts.seed).toBe(99);
  });

  test("the same seed produces an identical request body across calls", async () => {
    const a: { body?: Record<string, unknown> } = {};
    const b: { body?: Record<string, unknown> } = {};
    await createLocalGenerator({ seed: 7 }, fakeFetch(a, { response: "x" })).generate("mismo prompt");
    await createLocalGenerator({ seed: 7 }, fakeFetch(b, { response: "x" })).generate("mismo prompt");

    expect(a.body).toEqual(b.body);
  });

  test("throws a clear error when the daemon is unreachable", async () => {
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const gen = createLocalGenerator({ host: "http://localhost:11434" }, boom);

    await expect(gen.generate("x")).rejects.toThrow(/Cannot reach Ollama/);
  });

  test("rejects a prompt over the input limit before calling Ollama", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const gen = createLocalGenerator({ maxPromptChars: 5 }, spy);

    await expect(gen.generate("demasiado largo")).rejects.toThrow(/prompt.*limit/i);
    expect(called).toBe(false);
  });

  test("rejects an output over the limit (no applicable plan from runaway generation)", async () => {
    const cap: { url?: string; body?: Record<string, unknown> } = {};
    const gen = createLocalGenerator({ maxOutputChars: 10 }, fakeFetch(cap, { response: "x".repeat(50) }));

    await expect(gen.generate("hola")).rejects.toThrow(/output.*limit/i);
  });

  test("times out instead of hanging forever", async () => {
    vi.useFakeTimers();
    try {
      const hang = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init!.signal as AbortSignal).addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as unknown as typeof fetch;
      const gen = createLocalGenerator({ timeoutMs: 1000 }, hang);

      const assertion = expect(gen.generate("x")).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
