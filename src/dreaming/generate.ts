/**
 * Minimal local text generation for Dreaming's dry-run synthesis (MNE-57).
 *
 * Mirrors `createOllamaClient` (embeddings) but hits `/api/generate` for a
 * chat/instruct model. Kept separate on purpose: the generation model and its
 * endpoint are configured independently of the embedding model, so swapping one
 * never disturbs the other. Local by default — client scopes reject a remote
 * endpoint, so this never silently reaches outside the box.
 *
 * Guardrails live here because a dreaming run is unattended: a hung daemon, a
 * giant prompt or a runaway output must fail loudly, not stall or produce an
 * unusable plan. Memory content handed to `prompt`/`system` is DATA — the caller
 * (MNE-52) is responsible for delimiting it so the model never treats a note as
 * an instruction; this client only returns text and never acts on it.
 */
export interface GeneratorConfig {
  host: string;
  model: string;
  /** Abort the call after this long; an unattended run must not hang. */
  timeoutMs: number;
  /** Reject before calling if the prompt is larger than this. */
  maxPromptChars: number;
  /** Reject the reply if generation runs away past this. */
  maxOutputChars: number;
  /**
   * Sampling temperature. Defaults to 0 (greedy): a dreaming synthesis must be
   * reproducible so the same sources yield the same note and the fidelity gate
   * is not a coin-flip (MNE-80 found non-determinism flipped coverage between
   * runs). Raise it only to deliberately explore variation.
   */
  temperature: number;
  /** Optional RNG seed. With a fixed seed (and model) a run is reproducible even
   *  above temperature 0. Omitted → Ollama picks its own. */
  seed?: number;
}

export interface GenerationResult {
  text: string;
  /** Wall-clock of the call, for the plan's observable cost/duration. */
  durationMs: number;
  /** Ollama `prompt_eval_count` / `eval_count` when present. */
  inputTokens?: number;
  outputTokens?: number;
}

export interface LocalGenerator {
  /** The model id, recorded in the dreaming plan for provenance. */
  id: string;
  /** Per-call overrides win over the generator's config, so one generator can
   *  serve several cases each with its own seed. */
  generate(prompt: string, opts?: { system?: string; temperature?: number; seed?: number }): Promise<GenerationResult>;
}

/** Decided 2026-10-03 (MNE-57): local qwen, swappable via `DREAMING_MODEL`. */
const DEFAULT_DREAMING_MODEL = "qwen2.5:7b";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PROMPT_CHARS = 32_000;
const DEFAULT_MAX_OUTPUT_CHARS = 8_000;
/** Greedy by default (MNE-81): reproducible synthesis for the fidelity gate. */
const DEFAULT_TEMPERATURE = 0;

function defaults(): { host: string; model: string } {
  return {
    host: process.env.OLLAMA_HOST ?? "http://localhost:11434",
    model: process.env.DREAMING_MODEL ?? DEFAULT_DREAMING_MODEL,
  };
}

export function createLocalGenerator(
  config: Partial<GeneratorConfig> = {},
  fetchImpl: typeof fetch = fetch,
): LocalGenerator {
  const base = defaults();
  const host = config.host ?? base.host;
  const model = config.model ?? base.model;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPromptChars = config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
  const maxOutputChars = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE;
  const seed = config.seed;

  return {
    id: model,
    async generate(prompt, opts = {}) {
      if (prompt.length > maxPromptChars) {
        throw new Error(`Dreaming prompt (${prompt.length} chars) exceeds the input limit of ${maxPromptChars}.`);
      }

      // Per-call overrides win over config; temperature always goes (default 0),
      // seed only when one is set, so an unseeded run stays omitted.
      const effTemperature = opts.temperature ?? temperature;
      const effSeed = opts.seed ?? seed;
      const options = {
        temperature: effTemperature,
        ...(effSeed !== undefined ? { seed: effSeed } : {}),
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = performance.now();
      let res: Response;
      try {
        res = await fetchImpl(`${host}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            prompt,
            stream: false,
            options,
            ...(opts.system ? { system: opts.system } : {}),
          }),
          // Never auto-follow a redirect: a 3xx from the (even local) endpoint
          // would re-send the whole body to another host, slipping past the scope
          // and secret egress gates. A redirect is an error here, not a hop.
          redirect: "error",
          signal: controller.signal,
        });
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new Error(`Ollama generate timed out after ${timeoutMs}ms at ${host}.`, { cause });
        }
        throw new Error(
          `Cannot reach Ollama at ${host}. Is it running? Set OLLAMA_HOST or run 'ollama serve'.`,
          { cause },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const detail = await res.text();
        throw new Error(
          `Ollama generate failed (${res.status}): ${detail}. If the model is missing, run 'ollama pull ${model}'.`,
        );
      }
      const json = (await res.json()) as { response?: string; prompt_eval_count?: number; eval_count?: number };
      if (json.response === undefined) {
        throw new Error(`Ollama returned no response: ${JSON.stringify(json)}`);
      }
      if (json.response.length > maxOutputChars) {
        throw new Error(
          `Dreaming output (${json.response.length} chars) exceeds the limit of ${maxOutputChars}; discarding as unusable.`,
        );
      }
      return {
        text: json.response,
        durationMs: Math.round(performance.now() - startedAt),
        ...(json.prompt_eval_count !== undefined ? { inputTokens: json.prompt_eval_count } : {}),
        ...(json.eval_count !== undefined ? { outputTokens: json.eval_count } : {}),
      };
    },
  };
}
