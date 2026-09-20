// src/cli.context.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test, vi } from "vitest";
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

  // --- degraded injection: the read path has to be able to say it failed ------
  //
  // Every failure below already exits 0 and prints a digest, by policy ("never
  // break session start"). What was missing is a RECORD: without one, a short
  // digest is indistinguishable from "you have little memory", both to the
  // agent reading it and to the scorecard measuring retrieval quality.

  test("cli_context_records_a_reindex_failure_as_degraded", async () => {
    const prevFake = process.env.MNEMOSYNE_FAKE_EMBED;
    const prevHost = process.env.OLLAMA_HOST;
    delete process.env.MNEMOSYNE_FAKE_EMBED;        // use the real client...
    process.env.OLLAMA_HOST = "http://127.0.0.1:1"; // ...pointed at nothing
    // embeddings.ts captures OLLAMA_HOST into a module-level default at IMPORT
    // time, so setting it here only takes effect on a freshly evaluated graph.
    vi.resetModules();
    try {
      const { runCli: freshCli } = await import("./cli.js");
      const root = storeWith("yogurtera");
      const code = await freshCli(["context", "--root", root, "--scope", "personal"], () => {}, () => {});
      expect(code).toBe(0);

      // Ollama unreachable aborts the whole reindex, so the digest is served
      // from whatever the index already held — here, nothing.
      const ev = readTelemetry(root).find((e) => e.kind === "retrieval.injected")!;
      expect(ev.degraded).toEqual(["reindex-failed"]);
      expect(ev.injectedSlugs).toEqual([]);
    } finally {
      if (prevFake === undefined) delete process.env.MNEMOSYNE_FAKE_EMBED;
      else process.env.MNEMOSYNE_FAKE_EMBED = prevFake;
      if (prevHost === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = prevHost;
      vi.resetModules();
    }
  }, 30_000);

  test("cli_context_degrades_instead_of_failing_on_an_unusable_embedding_model", async () => {
    // A model whose dimension is unknown makes the embedder refuse to exist —
    // a config error, but session start must never break over one.
    const prevFake = process.env.MNEMOSYNE_FAKE_EMBED;
    const prevModel = process.env.OLLAMA_MODEL;
    delete process.env.MNEMOSYNE_FAKE_EMBED;
    process.env.OLLAMA_MODEL = "mystery-embed";
    try {
      const root = storeWith("yogurtera");
      const code = await runCli(["context", "--root", root, "--scope", "personal"], () => {}, () => {});

      expect(code).toBe(0);
      const ev = readTelemetry(root).find((e) => e.kind === "retrieval.injected")!;
      expect(ev.degraded).toEqual(["reindex-failed"]);
    } finally {
      if (prevFake === undefined) delete process.env.MNEMOSYNE_FAKE_EMBED;
      else process.env.MNEMOSYNE_FAKE_EMBED = prevFake;
      if (prevModel === undefined) delete process.env.OLLAMA_MODEL;
      else process.env.OLLAMA_MODEL = prevModel;
    }
  });

  test("cli_context_still_emits_an_injected_event_when_it_dies_outright", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-cli-ctx-dead-"));
    writeFileSync(join(root, ".telemetry-marker"), ""); // root exists, store does not
    mkdirSync(join(root, "personal"), { recursive: true });
    writeFileSync(join(root, "personal", "corrupt.md"), "not frontmatter at all\n");
    mkdirSync(join(root, ".index"), { recursive: true });
    writeFileSync(join(root, ".index", "store.db"), "this is not a sqlite database");

    const code = await runCli(["context", "--root", root, "--scope", "personal"], () => {});
    expect(code).toBe(0); // still MUST NOT break session start

    // A session that starts with NO memory is the most important thing the log
    // can record, and it was the one thing it recorded nothing about.
    const ev = readTelemetry(root).find((e) => e.kind === "retrieval.injected")!;
    expect(ev).toBeDefined();
    expect(ev.degraded).toEqual(["fatal"]);
    expect(ev.injectedSlugs).toEqual([]);
  });

  test("cli_context_does_not_call_budget_truncation_degraded", async () => {
    const root = storeWith("yogurtera");
    // A starved budget is a deliberate, configured outcome — already reported
    // by droppedForBudget. Conflating it with failure would make the degraded
    // rate useless, since a tight budget would peg it at 100%.
    await runCli(["context", "--root", root, "--scope", "personal", "--budget", "1"], () => {});

    const ev = readTelemetry(root).find((e) => e.kind === "retrieval.injected")!;
    expect(ev.droppedForBudget).toBe(1);
    expect(ev.degraded).toBeUndefined();
  });

  test("cli_context_warns_on_stderr_when_degraded", async () => {
    const errs: string[] = [];
    await runCli(["context", "--root", "/no/such/store", "--scope", "personal"], () => {}, (s) => errs.push(s));
    // stdout stays a clean digest for the agent; the human gets the warning.
    expect(errs.join("\n")).toMatch(/degraded/i);
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
