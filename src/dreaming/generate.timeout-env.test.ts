import { afterEach, describe, expect, test, vi } from "vitest";
import { createLocalGenerator } from "./generate.js";

// A fetch that never resolves until aborted, so only the timeout ends it.
const hang = ((_url: string, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    (init!.signal as AbortSignal).addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
  })) as unknown as typeof fetch;

describe("DREAMING_TIMEOUT_MS", () => {
  afterEach(() => { delete process.env.DREAMING_TIMEOUT_MS; });

  test("honours the env timeout when no timeoutMs is configured", async () => {
    vi.useFakeTimers();
    try {
      process.env.DREAMING_TIMEOUT_MS = "1000";
      const gen = createLocalGenerator({}, hang); // no timeoutMs in config
      const assertion = expect(gen.generate("x")).rejects.toThrow(/timed out after 1000ms/i);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("an explicit config.timeoutMs still wins over the env", async () => {
    vi.useFakeTimers();
    try {
      process.env.DREAMING_TIMEOUT_MS = "9000";
      const gen = createLocalGenerator({ timeoutMs: 500 }, hang);
      const assertion = expect(gen.generate("x")).rejects.toThrow(/timed out after 500ms/i);
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("a non-numeric env is ignored (falls back to the default, not NaN)", async () => {
    vi.useFakeTimers();
    try {
      process.env.DREAMING_TIMEOUT_MS = "abc";
      const gen = createLocalGenerator({}, hang);
      const assertion = expect(gen.generate("x")).rejects.toThrow(/timed out after 120000ms/i);
      await vi.advanceTimersByTimeAsync(120000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
