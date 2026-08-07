import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTelemetryConfig, TELEMETRY_CONFIG_FILE, clearTelemetryConfigCache } from "./config.js";
import { emitEvent, emitEvents, readTelemetry } from "./events.js";
import { fixedClock } from "../clock.js";

const T0 = 1_700_000_000_000;

function root(config?: unknown) {
  const r = mkdtempSync(join(tmpdir(), "mneme-telcfg-"));
  if (config !== undefined) writeFileSync(join(r, TELEMETRY_CONFIG_FILE), JSON.stringify(config));
  return r;
}

beforeEach(() => { clearTelemetryConfigCache(); delete process.env.MNEMOSYNE_TELEMETRY; });
afterEach(() => { clearTelemetryConfigCache(); delete process.env.MNEMOSYNE_TELEMETRY; });

describe("loadTelemetryConfig", () => {
  it("defaults to enabled with no scopes excluded", () => {
    expect(loadTelemetryConfig(root())).toEqual({ enabled: true, excludeScopes: [] });
  });

  it("reads enabled and excludeScopes from the store-local config file", () => {
    const r = root({ enabled: false, excludeScopes: ["acme"] });
    expect(loadTelemetryConfig(r)).toEqual({ enabled: false, excludeScopes: ["acme"] });
  });

  it("lets MNEMOSYNE_TELEMETRY override the file both ways", () => {
    const off = root({ enabled: true });
    process.env.MNEMOSYNE_TELEMETRY = "0";
    expect(loadTelemetryConfig(off).enabled).toBe(false);

    clearTelemetryConfigCache();
    const on = root({ enabled: false });
    process.env.MNEMOSYNE_TELEMETRY = "1";
    expect(loadTelemetryConfig(on).enabled).toBe(true);
  });

  it("falls back to the default when the config file is malformed", () => {
    const r = mkdtempSync(join(tmpdir(), "mneme-telcfg-"));
    writeFileSync(join(r, TELEMETRY_CONFIG_FILE), "{ not json");
    // A broken config must not disable observability silently, nor throw into
    // the command that happens to emit an event.
    expect(loadTelemetryConfig(r)).toEqual({ enabled: true, excludeScopes: [] });
  });
});

describe("telemetry gating", () => {
  it("writes nothing at all when disabled", () => {
    const r = root({ enabled: false });
    emitEvent(r, fixedClock(T0), { kind: "engram.created", scope: "personal", slug: "a" });
    emitEvents(r, fixedClock(T0), [{ kind: "retrieval.candidate", scope: "personal", slug: "b" }]);
    expect(readTelemetry(r)).toEqual([]);
  });

  it("drops events belonging to an excluded scope", () => {
    // Client scopes must not leave slugs behind in a diagnostic log that the
    // client-offboarding runbook does not delete.
    const r = root({ excludeScopes: ["acme"] });
    emitEvents(r, fixedClock(T0), [
      { kind: "retrieval.candidate", scope: "personal", slug: "mine" },
      { kind: "retrieval.candidate", scope: "acme", slug: "client-contract-renewal" },
      { kind: "retrieval.candidate", scope: "personal", slug: "also-mine" },
    ]);

    const evs = readTelemetry(r);

    expect(evs.map((e) => e.slug)).toEqual(["mine", "also-mine"]);
    expect(JSON.stringify(evs)).not.toContain("acme");
    expect(JSON.stringify(evs)).not.toContain("client-contract-renewal");
  });

  it("strips excluded scopes from a multi-scope event and drops it if none remain", () => {
    const r = root({ excludeScopes: ["acme"] });
    emitEvent(r, fixedClock(T0), { kind: "retrieval.query", scopes: ["personal", "acme"], k: 5 });
    emitEvent(r, fixedClock(T0), { kind: "retrieval.query", scopes: ["acme"], k: 5 });

    const evs = readTelemetry(r);

    expect(evs).toHaveLength(1); // the acme-only query is not recorded at all
    expect(evs[0]!.scopes).toEqual(["personal"]);
  });

  it("keeps scope-less events, which belong to no scope by nature", () => {
    const r = root({ excludeScopes: ["acme"] });
    emitEvent(r, fixedClock(T0), { kind: "retrieval.injected", corrId: "c1" });
    expect(readTelemetry(r)).toHaveLength(1);
  });
});
