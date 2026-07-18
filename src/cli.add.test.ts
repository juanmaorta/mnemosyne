// src/cli.add.test.ts
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "./cli.js";

function store(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-cliadd-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns: ["personal"] }));
  return root;
}

describe("runCli add", () => {
  test("cli_add_feedback_writes_fact_and_reports", async () => {
    const root = store();
    const lines: string[] = [];
    const code = await runCli(["add", "deploys at 3am", "--type", "feedback", "--scope", "personal", "--description", "deploy window", "--root", root], (s) => lines.push(s));
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/fact.*personal/);
    expect(readdirSync(join(root, "personal", "facts")).some((f) => f.endsWith(".md"))).toBe(true);
  });

  test("cli_add_missing_type_exits_nonzero", async () => {
    const root = store();
    const errs: string[] = [];
    const code = await runCli(["add", "x", "--scope", "personal", "--root", root], () => {}, (s) => errs.push(s));
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/--type/);
  });

  test("cli_add_refuses_secret_with_masked_message", async () => {
    const root = store();
    const errs: string[] = [];
    const code = await runCli(["add", "token sk-abcdefghij0123456789", "--type", "feedback", "--scope", "personal", "--description", "d", "--root", root], () => {}, (s) => errs.push(s));
    expect(code).toBe(1);
    const out = errs.join("\n");
    expect(out).toMatch(/secret/i);
    expect(out).not.toContain("sk-abcdefghij0123456789"); // never echo the full secret
  });

  test("cli_add_unmapped_scope_refuses_fail_closed", async () => {
    const root = store();
    const errs: string[] = [];
    // no --scope, cwd won't match an (absent) .scopemap → fail-closed refuse
    const code = await runCli(["add", "x", "--type", "feedback", "--description", "d", "--root", root], () => {}, (s) => errs.push(s));
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/--scope/);
  });

  test("cli_add_not_owner_refuses_with_scope_and_owner_path", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-cliadd-"));
    mkdirSync(join(root, "personal"), { recursive: true });
    writeFileSync(join(root, ".owner"), JSON.stringify({ owns: ["personal"] }));
    const errs: string[] = [];
    const code = await runCli(
      ["add", "some content", "--type", "feedback", "--scope", "acme", "--description", "d", "--root", root],
      () => {},
      (s) => errs.push(s),
    );
    expect(code).toBe(1);
    const out = errs.join("\n");
    expect(out).toContain("acme");
    expect(out).toContain(join(root, ".owner"));
  });

  test("cli_add_refuses_note_overwrite", async () => {
    const root = store();
    const out1: string[] = [];
    const first = await runCli(
      ["add", "some reference content", "--type", "reference", "--scope", "personal", "--description", "d", "--slug", "foo", "--root", root],
      (s) => out1.push(s),
    );
    expect(first).toBe(0);

    const errs: string[] = [];
    const second = await runCli(
      ["add", "some reference content", "--type", "reference", "--scope", "personal", "--description", "d", "--slug", "foo", "--root", root],
      () => {},
      (s) => errs.push(s),
    );
    expect(second).toBe(1);
    expect(errs.join("\n")).toMatch(/already exists/);
  });
});
