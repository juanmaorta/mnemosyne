// src/dreaming/remote-policy.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isLoopbackHost, loadRemotePolicy, resolveEndpoint, remotePolicyPath } from "./remote-policy.js";

const LOCAL = "http://localhost:11434";

describe("isLoopbackHost", () => {
  test("loopback hosts are local", () => {
    expect(isLoopbackHost("http://localhost:11434")).toBe(true);
    expect(isLoopbackHost("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackHost("http://[::1]:11434")).toBe(true);
  });
  test("off-box hosts are not local (cloud or LAN)", () => {
    expect(isLoopbackHost("https://api.example.com")).toBe(false);
    expect(isLoopbackHost("http://192.0.2.41:11434")).toBe(false);
  });
});

describe("loadRemotePolicy", () => {
  function policyFile(contents: string): string {
    const root = mkdtempSync(join(tmpdir(), "mneme-rp-"));
    writeFileSync(remotePolicyPath(root), contents);
    return remotePolicyPath(root);
  }

  test("absent file fails closed to no remote scopes", () => {
    expect(loadRemotePolicy(join(mkdtempSync(join(tmpdir(), "mneme-rp-")), ".dreaming.json"))).toEqual({ allowScopes: [] });
  });
  test("malformed file fails closed", () => {
    expect(loadRemotePolicy(policyFile("{ not json"))).toEqual({ allowScopes: [] });
  });
  test("parses endpoint, model, apiKeyEnv and allowScopes", () => {
    const p = loadRemotePolicy(policyFile(JSON.stringify({ remote: { endpoint: "https://infra.example", model: "qwen2.5:32b", apiKeyEnv: "OLLAMA_API_KEY", allowScopes: ["personal"] } })));
    expect(p).toEqual({ endpoint: "https://infra.example", model: "qwen2.5:32b", apiKeyEnv: "OLLAMA_API_KEY", allowScopes: ["personal"] });
  });
  test("ignores non-string scopes", () => {
    const p = loadRemotePolicy(policyFile(JSON.stringify({ remote: { endpoint: "https://x", allowScopes: ["personal", 3, null] } })));
    expect(p.allowScopes).toEqual(["personal"]);
  });
});

describe("resolveEndpoint", () => {
  test("no endpoint → local", () => {
    const r = resolveEndpoint({ scope: "personal", policy: { allowScopes: [] }, localHost: LOCAL });
    expect(r).toEqual({ host: LOCAL, remote: false });
  });
  test("endpoint + scope opted in → remote with model", () => {
    const r = resolveEndpoint({ scope: "personal", policy: { endpoint: "https://infra.example", model: "qwen2.5:32b", allowScopes: ["personal"] }, localHost: LOCAL });
    expect(r).toEqual({ host: "https://infra.example", model: "qwen2.5:32b", remote: true });
  });

  test("carries apiKeyEnv on the remote path, not the local one", () => {
    const remote = resolveEndpoint({ scope: "personal", policy: { endpoint: "https://infra.example", apiKeyEnv: "OLLAMA_API_KEY", allowScopes: ["personal"] }, localHost: LOCAL });
    expect(remote).toMatchObject({ remote: true, apiKeyEnv: "OLLAMA_API_KEY" });
    const local = resolveEndpoint({ scope: "acme", policy: { endpoint: "https://infra.example", apiKeyEnv: "OLLAMA_API_KEY", allowScopes: ["personal"] }, localHost: LOCAL });
    expect(local).toEqual({ host: LOCAL, remote: false });
  });
  test("endpoint but scope NOT opted in → local, never remote", () => {
    const r = resolveEndpoint({ scope: "acme", policy: { endpoint: "https://infra.example", model: "qwen2.5:32b", allowScopes: ["personal"] }, localHost: LOCAL });
    expect(r).toEqual({ host: LOCAL, remote: false });
  });
  test("a loopback endpoint is not treated as remote even if opted in", () => {
    const r = resolveEndpoint({ scope: "personal", policy: { endpoint: "http://127.0.0.1:1234", allowScopes: ["personal"] }, localHost: LOCAL });
    expect(r.remote).toBe(false);
  });

  test("a non-loopback localHost is NOT inherited without opt-in (forces a loopback default)", () => {
    // e.g. OLLAMA_HOST pointing off-box must not become a silent egress path.
    const r = resolveEndpoint({ scope: "acme", policy: { allowScopes: [] }, localHost: "https://unapproved.example" });
    expect(r.remote).toBe(false);
    expect(isLoopbackHost(r.host)).toBe(true);
  });

  test("an opted-in loopback endpoint is honoured (another local Ollama) with its model", () => {
    const r = resolveEndpoint({ scope: "personal", policy: { endpoint: "http://127.0.0.1:1234", model: "qwen2.5:32b", allowScopes: ["personal"] }, localHost: LOCAL });
    expect(r).toEqual({ host: "http://127.0.0.1:1234", model: "qwen2.5:32b", remote: false });
  });

  test("an invalid endpoint falls back to local instead of being sent to fetch", () => {
    for (const bad of ["", "not a url", "ftp://x"]) {
      const r = resolveEndpoint({ scope: "personal", policy: { endpoint: bad, allowScopes: ["personal"] }, localHost: LOCAL });
      expect(r).toEqual({ host: LOCAL, remote: false });
    }
  });
});
