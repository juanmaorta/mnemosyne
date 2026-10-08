import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });

function store(scopes: string[], scopeMap: string): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-catchall-"));
  for (const s of scopes) {
    mkdirSync(join(root, s), { recursive: true });
    writeFileSync(join(root, s, "n.md"),
      ["---", "name: n", "description: d", `scope: ${s}`, "type: reference",
        "created: 2026-06-01T10:00:00", "importance: 5", "---", "body", ""].join("\n"));
  }
  writeFileSync(join(root, ".scopemap"), scopeMap);
  return root;
}

describe("catch-all hazard warning in context (MNE-59)", () => {
  test("warns_when_a_catch_all_coexists_with_two_or_more_scopes", async () => {
    const root = store(["personal", "acme"], "~ = personal\n");
    const errs: string[] = [];
    const code = await runCli(["context", "--root", root, "--scope", "personal"], () => {}, (s) => errs.push(s));

    expect(code).toBe(0);
    expect(errs.join("\n")).toMatch(/catch-all/i);
  });

  test("stays_quiet_with_a_single_scope_even_under_a_catch_all", async () => {
    const root = store(["personal"], "~ = personal\n");
    const errs: string[] = [];
    await runCli(["context", "--root", root, "--scope", "personal"], () => {}, (s) => errs.push(s));

    expect(errs.join("\n")).not.toMatch(/catch-all/i);
  });

  test("stays_quiet_with_two_scopes_but_no_catch_all", async () => {
    const root = store(["personal", "acme"], "~/Projects/acme = acme\n");
    const errs: string[] = [];
    await runCli(["context", "--root", root, "--scope", "personal"], () => {}, (s) => errs.push(s));

    expect(errs.join("\n")).not.toMatch(/catch-all/i);
  });

  test("the_digest_on_stdout_stays_clean_json_free_of_the_warning", async () => {
    const root = store(["personal", "acme"], "~ = personal\n");
    const out: string[] = [];
    await runCli(["context", "--root", root, "--scope", "personal"], (s) => out.push(s));
    // The warning is an operator signal on stderr; stdout is only the digest.
    expect(out.join("\n")).not.toMatch(/catch-all/i);
  });
});
