// src/cli.context.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { readTelemetry } from "./telemetry/events.js";

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });

function storeWith(slug: string): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-cli-ctx-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, "personal", `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${slug} one-liner`, "scope: personal", "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", `body ${slug}`, ""].join("\n"));
  return root;
}

describe("runCli context", () => {
  test("cli_context_prints_digest_with_hint_and_scope", async () => {
    const root = storeWith("yogurtera");
    const lines: string[] = [];
    const code = await runCli(["context", "--root", root, "--scope", "personal"], (s) => lines.push(s));
    const out = lines.join("\n");
    expect(code).toBe(0);
    expect(out).toContain("- [yogurtera] yogurtera one-liner");
    expect(out).toContain("mneme search");
  });

  test("cli_context_returns_0_and_degrades_on_missing_store", async () => {
    const lines: string[] = [];
    const code = await runCli(["context", "--root", "/no/such/store", "--scope", "personal"], (s) => lines.push(s));
    expect(code).toBe(0); // MUST NOT break session start
    expect(lines.join("\n")).toContain("mneme search"); // still emits a valid digest+hint
  });

  test("cli_context_emits_retrieval_injected_with_what_the_budget_cut", async () => {
    const root = storeWith("yogurtera");
    await runCli(["context", "--root", root, "--scope", "personal"], () => {});

    const ev = readTelemetry(root).find((e) => e.kind === "retrieval.injected")!;
    expect(ev).toMatchObject({ scope: "personal", droppedForBudget: 0 });
    expect(ev.injectedSlugs).toEqual(["yogurtera"]);
    expect(ev.corrId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("cli_context_records_the_engrams_dropped_for_budget", async () => {
    const root = storeWith("yogurtera");
    // Budget of 1 token starves the digest: nothing is injected, and the log
    // has to say so — a scorecard reading only the ranking would never see it.
    await runCli(["context", "--root", root, "--scope", "personal", "--budget", "1"], () => {});

    const ev = readTelemetry(root).find((e) => e.kind === "retrieval.injected")!;
    expect(ev.injectedSlugs).toEqual([]);
    expect(ev.droppedForBudget).toBe(1);
    expect(ev.budget).toBe(1);
  });

  test("cli_context_respects_budget", async () => {
    const root = storeWith("yogurtera");
    const lines: string[] = [];
    await runCli(["context", "--root", root, "--scope", "personal", "--budget", "1"], (s) => lines.push(s));
    const out = lines.join("\n");
    expect(out).toContain("none fit the token budget"); // starved, not empty-scope wording
    expect(out).not.toContain("no memory in this scope yet");
  });

  test("cli_context_treats_blank_scope_flag_as_unset", async () => {
    const root = storeWith("yogurtera");
    mkdirSync(join(root, "acme"), { recursive: true }); // arbitrary scope map dir presence isn't required; default falls back to "personal"
    const lines: string[] = [];
    const code = await runCli(["context", "--root", root, "--scope", ""], (s) => lines.push(s));
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("scope: personal"); // empty --scope treated as unset, resolves to default
  });

  test("cli_context_returns_0_on_malformed_flag", async () => {
    const lines: string[] = [];
    const code = await runCli(["context", "--budget"], (s) => lines.push(s));
    expect(code).toBe(0); // MUST NOT break session start, even on a parseArgs throw
    expect(lines.join("\n")).toContain("mneme search"); // still emits a valid digest+hint
  });

  test("cli_context_falls_back_to_default_budget_on_non_numeric_env", async () => {
    const prevEnv = process.env.MNEMOSYNE_CONTEXT_BUDGET;
    process.env.MNEMOSYNE_CONTEXT_BUDGET = "abc";
    try {
      const root = storeWith("yogurtera");
      const lines: string[] = [];
      const code = await runCli(["context", "--root", root, "--scope", "personal"], (s) => lines.push(s));
      const out = lines.join("\n");
      expect(code).toBe(0);
      expect(out).toContain("- [yogurtera] yogurtera one-liner"); // default budget (1000) applied, not NaN-unbounded
    } finally {
      if (prevEnv === undefined) delete process.env.MNEMOSYNE_CONTEXT_BUDGET;
      else process.env.MNEMOSYNE_CONTEXT_BUDGET = prevEnv;
    }
  });
});
