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
    await createDreamingGenerator({ root: root(REMOTE), scope: "acme", localHost: LOCAL }, fakeFetch(cap)).generate("hola");
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

  test("does not apply the egress gate locally (a local secret stays on the box)", async () => {
    const cap: { url?: string; called?: boolean } = {};
    // No policy → local. A secret in the prompt must not block a purely local call.
    await createDreamingGenerator({ root: root(), scope: "personal", localHost: LOCAL }, fakeFetch(cap))
      .generate("la clave es sk-ABCD1234EFGH5678IJKL");
    expect(cap.called).toBe(true);
  });
});
