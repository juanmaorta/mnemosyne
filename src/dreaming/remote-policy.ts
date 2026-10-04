/**
 * Remote-generation opt-in policy for dreaming (MNE-83).
 *
 * Dreaming is local-first: generation stays on the box unless the user, on THIS
 * machine, explicitly opts a scope in to a remote endpoint (a cloud API or their
 * own infra). The relaxation is deliberately narrow and fail-closed:
 *  - absent/unreadable/malformed policy → no scope may go remote;
 *  - a scope not listed → stays local even if an endpoint is configured;
 *  - the endpoint must actually be off-box (non-loopback) to count as remote.
 *
 * The policy is machine-local (like `.owner`/`.scopemap`), never synced: opting
 * in is a per-machine choice, not something that travels with the memories.
 * Content egress (not sending secrets to the remote) is enforced where the call
 * is made — see `createDreamingGenerator`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RemoteGenerationPolicy {
  /** Remote endpoint base URL, e.g. https://ollama.my-infra.example. */
  endpoint?: string;
  /** Optional model override used only on the remote endpoint. */
  model?: string;
  /** Scopes explicitly opted in to remote generation. Empty = none. */
  allowScopes: string[];
}

/** Machine-local policy file at the store root; never synced. */
export const REMOTE_POLICY_FILE = ".dreaming.json";

export function remotePolicyPath(root: string): string {
  return join(root, REMOTE_POLICY_FILE);
}

/** A host is local only if it resolves to loopback — same machine, never egress. */
export function isLoopbackHost(host: string): boolean {
  let hostname = host;
  try {
    hostname = new URL(host).hostname;
  } catch {
    // Not a full URL; fall back to treating the string as a bare host[:port].
    hostname = host.replace(/^\[|\]$/g, "").split(":")[0] ?? host;
  }
  hostname = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Load the machine-local policy. Fail-closed: anything wrong → no remote scopes.
 */
export function loadRemotePolicy(path: string): RemoteGenerationPolicy {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const remote = (raw as { remote?: unknown })?.remote;
    if (remote !== null && typeof remote === "object") {
      const r = remote as { endpoint?: unknown; model?: unknown; allowScopes?: unknown };
      const allowScopes = Array.isArray(r.allowScopes)
        ? r.allowScopes.filter((s): s is string => typeof s === "string")
        : [];
      return {
        ...(typeof r.endpoint === "string" ? { endpoint: r.endpoint } : {}),
        ...(typeof r.model === "string" ? { model: r.model } : {}),
        allowScopes,
      };
    }
  } catch {
    // fall through to fail-closed default
  }
  return { allowScopes: [] };
}

export interface ResolvedEndpoint {
  host: string;
  model?: string;
  remote: boolean;
}

/** Hardcoded loopback fallback: a non-opted path is ALWAYS on-box, never an
 *  inherited off-box host (e.g. OLLAMA_HOST pointing at a remote Ollama). */
const LOOPBACK_DEFAULT = "http://localhost:11434";

/** A usable HTTP(S) endpoint. A malformed one fails closed to local, never fetch. */
function isUsableHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Decide the endpoint for a scope. A configured endpoint is used only when this
 * scope is opted in AND the URL is usable; it is marked `remote` only if it is
 * actually off-box (so a second LOCAL Ollama on a loopback port is honoured —
 * model and all — without triggering the egress gate). Every other path is
 * guaranteed loopback: a non-loopback `localHost` (an off-box OLLAMA_HOST) is NOT
 * inherited, or it would be a silent egress that never passed the scope gate.
 */
export function resolveEndpoint(opts: {
  scope: string;
  policy: RemoteGenerationPolicy;
  localHost: string;
}): ResolvedEndpoint {
  const { scope, policy, localHost } = opts;
  const endpoint = policy.endpoint;
  const useEndpoint =
    endpoint !== undefined && policy.allowScopes.includes(scope) && isUsableHttpUrl(endpoint);
  if (useEndpoint) {
    return {
      host: endpoint,
      ...(policy.model !== undefined ? { model: policy.model } : {}),
      remote: !isLoopbackHost(endpoint),
    };
  }
  // Not opted in (or unusable endpoint): only honour a loopback localHost.
  const host = isLoopbackHost(localHost) ? localHost : LOOPBACK_DEFAULT;
  return { host, remote: false };
}
