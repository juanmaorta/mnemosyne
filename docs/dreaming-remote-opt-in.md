# Dreaming — relaxing local-first (opt-in) for a larger model

> Status: mechanism implemented; applying plans to a real store is a separate, manual step
> (see [Dreaming](dev/dreaming.md)).

Dreaming is **local-first by default**: synthesis generation talks to Ollama on `localhost`.
Evaluation showed that a small local model (qwen2.5:7b) does not consolidate dense cases well,
and a larger local model needs RAM not everyone has. So as not to exclude those users, you can
**explicitly opt in** to a larger endpoint, in the cloud or on your own infrastructure —
**without** that being the default behaviour and **without** a setting turning it on by
accident.

## How to turn it on

A **machine-local** file at the store root: `~/memory/.dreaming.json`. It is not synced (like
`.owner`/`.scopemap`): opting into a remote endpoint is a decision **of this machine**, and it
does not travel with the memories.

```jsonc
{
  "remote": {
    "endpoint": "https://ollama.com",       // your cloud, or your GPU on a LAN/VPN
    "model": "gemma4:31b-cloud",            // model at that endpoint
    "apiKeyEnv": "OLLAMA_API_KEY",          // env var holding the Bearer token (NOT the key)
    "allowScopes": ["personal"]             // ONLY these scopes leave the machine
  }
}
```

The key is **not** stored in the file: `apiKeyEnv` names the **environment variable** to read
it from. If the endpoint is opted in and the variable is missing, it fails closed (no call, no
fallback to local). The key is only ever sent as `Authorization: Bearer` on the remote path;
it is never written to disk, logs, telemetry or frontmatter.

No file, a malformed file, or an empty `allowScopes` → **everything stays local**
(fail-closed).

## Guarantees (non-negotiable)

- **Scope boundary.** A scope that is not in `allowScopes` **never** leaves the machine, even
  with an `endpoint` configured. A client scope (e.g. `acme`) is not leaked to a remote that
  was not approved for it.
- **Secret egress.** Before any remote call, the prompt and system text go through the secret
  scanner; a reject-level key, token or private key **aborts** the request. Local calls are
  not gated here (the content does not leave the machine; the write-path secret gate still
  applies to whatever gets saved).
- **Loopback = local.** An `endpoint` that resolves to loopback (`localhost`/`127.0.0.1`/`::1`)
  is treated as local, not remote. Conversely, an `OLLAMA_HOST` pointing **off** the machine
  is **not** used as "local" without opting in: the path without an opt-in is always loopback,
  so that an environment variable cannot become a silent leak that bypassed the scope gate. To
  use an Ollama on your LAN/VPN, declare it here with its `allowScopes`.
- **Generation only.** Embeddings and retrieval always stay local; this affects only dreaming
  generation.

## Trade-off

| | Local (default) | Remote (opt-in) |
|---|---|---|
| Privacy | content never leaves the machine | the scope's memories go to your endpoint |
| Cost | free (your hardware) | provider cost / your infrastructure |
| Quality | limited by the local model | larger model → better coverage of dense cases |
| RAM | you need RAM for the model | no local RAM needed |

The decision is the user's, per scope, and reversible by deleting or editing `.dreaming.json`.
