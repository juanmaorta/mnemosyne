import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Machine-local telemetry settings; never synced (see `.stignore` in Phase 4). */
export const TELEMETRY_CONFIG_FILE = ".telemetry.json";

export interface TelemetryConfig {
  /** When false, nothing is written at all. */
  enabled: boolean;
  /**
   * Scopes whose events are never recorded. Telemetry stores slugs and scope
   * names in clear, and the client-offboarding runbook deletes
   * `<root>/<scope>/` — not `<root>/.telemetry/`. Excluding a client scope
   * here is the preventive half: nothing to purge later because nothing was
   * ever written.
   */
  excludeScopes: string[];
}

const DEFAULT: TelemetryConfig = { enabled: true, excludeScopes: [] };

const cache = new Map<string, TelemetryConfig>();

/** Test seam — config is cached per root for the process lifetime. */
export function clearTelemetryConfigCache(): void {
  cache.clear();
}

/**
 * Read `<root>/.telemetry.json`, with `MNEMOSYNE_TELEMETRY=0|1` overriding the
 * `enabled` flag. Cached per root: this is consulted on every emit, which sits
 * on the retrieval hot path.
 *
 * A missing or malformed file yields the default rather than throwing —
 * telemetry must never break the command that emits it, and a typo in a config
 * file should not silently switch observability off.
 */
export function loadTelemetryConfig(root: string): TelemetryConfig {
  const envOverride = process.env.MNEMOSYNE_TELEMETRY;
  const cached = cache.get(root);
  if (cached) return applyEnv(cached, envOverride);

  let parsed: TelemetryConfig = DEFAULT;
  try {
    const raw = JSON.parse(readFileSync(join(root, TELEMETRY_CONFIG_FILE), "utf8")) as Partial<TelemetryConfig>;
    parsed = {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT.enabled,
      excludeScopes: Array.isArray(raw.excludeScopes) ? raw.excludeScopes.filter((s) => typeof s === "string") : [],
    };
  } catch { /* missing or malformed → default */ }

  cache.set(root, parsed);
  return applyEnv(parsed, envOverride);
}

function applyEnv(config: TelemetryConfig, envOverride: string | undefined): TelemetryConfig {
  if (envOverride === undefined) return config;
  return { ...config, enabled: envOverride !== "0" };
}
