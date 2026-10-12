// src/cli.compliancelint.test.ts — `mneme compliance-lint` command (MNE-47).
// Three-valued exit code: 0 clean, 1 findings, 2 error (usage/config/scope).
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "./cli.js";

function note(body: string): string {
  return ["---", "name: n", "scope: personal", "type: reference", "---", body, ""].join("\n");
}

function store(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-cli-compliance-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, "personal", "clean.md"), note("just plants and coffee"));
  return root;
}

/** A config living OUTSIDE the store, as the tool requires. */
function configOutside(rules: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "mneme-compliance-cfg-"));
  const path = join(dir, "entities.json");
  writeFileSync(path, JSON.stringify({ rules }));
  return path;
}

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return runCli(args, (s) => outLines.push(s), (s) => errLines.push(s)).then((code) => ({
    code,
    out: outLines.join("\n"),
    err: errLines.join("\n"),
  }));
}

describe("mneme compliance-lint", () => {
  test("flags a client term leaked into personal and exits 1", async () => {
    const root = store();
    writeFileSync(join(root, "personal", "leaky.md"), note("then Acme called about billing"));
    const config = configOutside([{ label: "client-acme", terms: ["Acme"] }]);
    const r = await run(["compliance-lint", "--config", config, "--scope", "personal", "--root", root]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/client-acme/);
    expect(r.out).toContain(join(root, "personal", "leaky.md"));
    expect(r.out).not.toContain("Acme called"); // never echo the surrounding value in full
  });

  test("a clean store exits 0", async () => {
    const root = store();
    const config = configOutside([{ label: "client-acme", terms: ["Acme"] }]);
    const r = await run(["compliance-lint", "--config", config, "--scope", "personal", "--root", root]);
    expect(r.code).toBe(0);
  });

  test("an unknown scope is an error (exit 2), not a clean scan", async () => {
    const root = store();
    const config = configOutside([{ label: "client-acme", terms: ["Acme"] }]);
    const r = await run(["compliance-lint", "--config", config, "--scope", "ghost", "--root", root]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown scope/i);
  });

  test("an invalid config is an error (exit 2)", async () => {
    const root = store();
    const config = configOutside([]); // empty rule set
    const r = await run(["compliance-lint", "--config", config, "--scope", "personal", "--root", root]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/config/i);
  });

  test("a missing --config is a usage error (exit 2)", async () => {
    const root = store();
    const r = await run(["compliance-lint", "--scope", "personal", "--root", root]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/usage/i);
  });

  test("refuses a config stored inside the synced store (exit 2)", async () => {
    const root = store();
    const inside = join(root, "entities.json");
    writeFileSync(inside, JSON.stringify({ rules: [{ label: "c", terms: ["Acme"] }] }));
    const r = await run(["compliance-lint", "--config", inside, "--scope", "personal", "--root", root]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/store/i);
  });

  test("refuses a config symlink that resolves into the store (exit 2)", async () => {
    const root = store();
    const realInside = join(root, "entities.json");
    writeFileSync(realInside, JSON.stringify({ rules: [{ label: "c", terms: ["Acme"] }] }));
    const outsideDir = mkdtempSync(join(tmpdir(), "mneme-compliance-link-"));
    const link = join(outsideDir, "entities.json");
    symlinkSync(realInside, link); // lives outside, but resolves inside the store
    const r = await run(["compliance-lint", "--config", link, "--scope", "personal", "--root", root]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/store/i);
  });

  test("a bare --config with no value is an error (exit 2), never run against a store", async () => {
    const r = await run(["compliance-lint", "--config"]);
    expect(r.code).toBe(2);
  });

  test("malformed JSON is an error (exit 2) and never echoes the config contents", async () => {
    const root = store();
    const dir = mkdtempSync(join(tmpdir(), "mneme-compliance-cfg-"));
    const path = join(dir, "entities.json");
    // Invalid JSON whose text contains a sensitive client term.
    writeFileSync(path, '{ rules: [ SensitiveClientName ] }');
    const r = await run(["compliance-lint", "--config", path, "--scope", "personal", "--root", root]);
    expect(r.code).toBe(2);
    expect(`${r.out}\n${r.err}`).not.toContain("SensitiveClientName");
  });

  test("an unreadable scope directory makes the scan incomplete (exit 2), not a false clean", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const root = store();
    const config = configOutside([{ label: "client-acme", terms: ["Acme"] }]);
    chmodSync(join(root, "personal"), 0o000);
    try {
      const r = await run(["compliance-lint", "--config", config, "--scope", "personal", "--root", root]);
      expect(r.code).toBe(2);
    } finally {
      chmodSync(join(root, "personal"), 0o700);
    }
  });

  test("an unreadable note makes the scan incomplete (exit 2), not a false clean", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root reads 0o000
    const root = store();
    const locked = join(root, "personal", "locked.md");
    writeFileSync(locked, note("nothing special"));
    chmodSync(locked, 0o000);
    const config = configOutside([{ label: "client-acme", terms: ["Acme"] }]);
    try {
      const r = await run(["compliance-lint", "--config", config, "--scope", "personal", "--root", root]);
      expect(r.code).toBe(2);
    } finally {
      chmodSync(locked, 0o600);
    }
  });
});
