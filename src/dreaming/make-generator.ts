/**
 * Scope-aware generator factory for dreaming (MNE-83).
 *
 * Builds the local generator by default and only reaches a remote endpoint when
 * the machine-local policy has opted THIS scope in (see `remote-policy.ts`). The
 * two non-negotiable guards live here, at the egress point:
 *  - scope boundary: a scope that is not opted in never goes remote, so a client
 *    scope cannot leak to a cloud the user did not approve for it;
 *  - secret egress: before any remote call, the outgoing prompt+system is run
 *    through the secret scanner, so an API key sitting in a memory is never sent
 *    off the box. Local calls keep the content on the machine, so they are not
 *    gated here (the write-time secret gate still applies to what gets stored).
 */
import { createLocalGenerator, type LocalGenerator } from "./generate.js";
import { loadRemotePolicy, remotePolicyPath, resolveEndpoint } from "./remote-policy.js";
import { assertNoSecrets } from "../write/validation.js";

export interface DreamingGeneratorOptions {
  root: string;
  scope: string;
  /** Overrides the local endpoint; defaults to OLLAMA_HOST or localhost. */
  localHost?: string;
}

export function createDreamingGenerator(
  opts: DreamingGeneratorOptions,
  fetchImpl: typeof fetch = fetch,
): LocalGenerator {
  const localHost = opts.localHost ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const policy = loadRemotePolicy(remotePolicyPath(opts.root));
  const endpoint = resolveEndpoint({ scope: opts.scope, policy, localHost });

  // Resolve the Bearer token from the NAMED env var, never from disk. Fail closed:
  // an opted-in remote whose key is missing must not run (and must not fall back
  // to local with content already shaped for the remote).
  let apiKey: string | undefined;
  if (endpoint.remote && endpoint.apiKeyEnv !== undefined) {
    apiKey = process.env[endpoint.apiKeyEnv];
    if (apiKey === undefined || apiKey.trim() === "") {
      throw new Error(`remote dreaming endpoint needs API key env '${endpoint.apiKeyEnv}', but it is unset`);
    }
  }

  const inner = createLocalGenerator(
    {
      host: endpoint.host,
      ...(endpoint.model !== undefined ? { model: endpoint.model } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
    },
    fetchImpl,
  );
  if (!endpoint.remote) return inner;

  // Remote: scan what is about to leave the machine, and refuse on a reject-level
  // finding (API keys, tokens, private keys). `assertNoSecrets` throws then.
  return {
    id: inner.id,
    async generate(prompt, genOpts) {
      assertNoSecrets(`${genOpts?.system ?? ""}\n${prompt}`);
      return inner.generate(prompt, genOpts);
    },
  };
}
