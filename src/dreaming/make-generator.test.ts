// src/dreaming/make-generator.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createDreamingGenerator } from "./make-generator.js";
import { remotePolicyPath } from "./remote-policy.js";
import { SecretDetectedError } from "../write/validation.js";

const LOCAL = "http://localhost:11434";

function root(policy?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "mneme-mkgen-"));
  if (policy) writeFileSync(remotePolicyPath(dir), JSON.stringify(policy));
  return dir;
}

function fakeFetch(cap: { url?: string; called?: boolean }): typeof fetch {
  return (async (url: string) => {
    cap.called = true;
    cap.url = String(url);
    return new Response(JSON.stringify({ response: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const REMOTE = { remote: { endpoint: "https://infra.example", model: "qwen2.5:32b", allowScopes: ["personal"] } };
const REMOTE_AUTH = { remote: { endpoint: "https://infra.example", model: "qwen2.5:32b", apiKeyEnv: "TEST_DREAM_KEY", allowScopes: ["personal"] } };

function fakeFetchCapInit(cap: { init?: RequestInit }): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    if (init) cap.init = init;
    return new Response(JSON.stringify({ response: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("createDreamingGenerator", () => {
  test("stays local when there is no policy", async () => {
    const cap: { url?: string } = {};
    await createDreamingGenerator({ root: root(), scope: "personal", localHost: LOCAL }, fakeFetch(cap)).generate("hola");
    expect(cap.url!.startsWith(LOCAL)).toBe(true);
  });

  test("uses the remote endpoint for an opted-in scope", async () => {
    const cap: { url?: string } = {};
    await createDreamingGenerator({ root: root(REMOTE), scope: "personal", localHost: LOCAL }, fakeFetch(cap)).generate("hola");
    expect(cap.url!.startsWith("https://infra.example")).toBe(true);
  });

  test("stays local for a scope that is NOT opted in, even with an endpoint set", async () => {
    const cap: { url?: string } = {};
    await createDreamingGenerator({ root: root(REMOTE), scope: "work", localHost: LOCAL }, fakeFetch(cap)).generate("hola");
    expect(cap.url!.startsWith(LOCAL)).toBe(true);
  });

  test("does not inherit a non-loopback localHost (OLLAMA_HOST off-box) without opt-in", async () => {
    const cap: { url?: string } = {};
    await createDreamingGenerator({ root: root(), scope: "personal", localHost: "https://unapproved.example" }, fakeFetch(cap))
      .generate("hola");
    expect(cap.url!.includes("unapproved.example")).toBe(false);
  });

  test("refuses to send a secret off the box (egress gate) and never calls fetch", async () => {
    const cap: { url?: string; called?: boolean } = {};
    const gen = createDreamingGenerator({ root: root(REMOTE), scope: "personal", localHost: LOCAL }, fakeFetch(cap));

    await expect(gen.generate("la clave es sk-ABCD1234EFGH5678IJKL y no sale")).rejects.toBeInstanceOf(SecretDetectedError);
    expect(cap.called).toBeUndefined();
  });

  test("sends the Authorization header from the named env var on the remote path", async () => {
    const prev = process.env.TEST_DREAM_KEY;
    process.env.TEST_DREAM_KEY = "cloud-token-123";
    try {
      const cap: { init?: RequestInit } = {};
      await createDreamingGenerator({ root: root(REMOTE_AUTH), scope: "personal", localHost: LOCAL }, fakeFetchCapInit(cap)).generate("hola");
      expect((cap.init!.headers as Record<string, string>).authorization).toBe("Bearer cloud-token-123");
    } finally {
      if (prev === undefined) delete process.env.TEST_DREAM_KEY; else process.env.TEST_DREAM_KEY = prev;
    }
  });

  test("fails closed when the API key env var is missing (never calls fetch)", async () => {
    const prev = process.env.TEST_DREAM_KEY;
    delete process.env.TEST_DREAM_KEY;
    try {
      const cap: { called?: boolean } = {};
      expect(() => createDreamingGenerator({ root: root(REMOTE_AUTH), scope: "personal", localHost: LOCAL }, fakeFetch(cap))).toThrow(/api key|TEST_DREAM_KEY/i);
      expect(cap.called).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.TEST_DREAM_KEY = prev;
    }
  });

  test("does not apply the egress gate locally (a local secret stays on the box)", async () => {
    const cap: { url?: string; called?: boolean } = {};
    // No policy → local. A secret in the prompt must not block a purely local call.
    await createDreamingGenerator({ root: root(), scope: "personal", localHost: LOCAL }, fakeFetch(cap))
      .generate("la clave es sk-ABCD1234EFGH5678IJKL");
    expect(cap.called).toBe(true);
  });
});
