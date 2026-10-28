// src/cli.cwd.test.ts
//
// Scope resolution used to read the CALLING PROCESS's cwd, which is only right
// while the caller is ephemeral and started in the project — exactly what Claude
// Code does, one process per invocation. A long-running agent server that
// multiplexes sessions breaks both premises: its cwd is wherever it was started,
// so every session would resolve against that one directory. `--cwd` lets the
// caller state the path it means, because it is the only party that knows.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });

interface Fixture { root: string; workWd: string; unmappedWd: string }

/**
 * A store owning two scopes, with three working directories: one mapped to each
 * scope and one mapped to neither. The PROCESS's own cwd is mapped as well, on
 * purpose — otherwise a passing test could not tell "the flag was honoured"
 * apart from "the ambient value happened to agree".
 */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mneme-clicwd-"));
  for (const scope of ["personal", "work"]) mkdirSync(join(root, scope), { recursive: true });
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns: ["personal", "work"] }));

  const personalWd = join(root, "wd-personal");
  const workWd = join(root, "wd-work");
  const unmappedWd = join(root, "wd-unmapped");
  for (const d of [personalWd, workWd, unmappedWd]) mkdirSync(d);

  writeFileSync(join(root, ".scopemap"), [
    `${process.cwd()} = personal`, // the ambient answer, deliberately different
    `${personalWd} = personal`,
    `${workWd} = work`,
  ].join("\n"));
  return { root, workWd, unmappedWd };
}

describe("symlinked paths resolve to the same scope", () => {
  /** A store owning `work`, plus a real directory and a symlink pointing at it. */
  function linked(): { root: string; realWd: string; linkWd: string } {
    const root = mkdtempSync(join(tmpdir(), "mneme-clilink-"));
    mkdirSync(join(root, "work"), { recursive: true });
    writeFileSync(join(root, ".owner"), JSON.stringify({ owns: ["work"] }));
    const realWd = join(root, "real-client");
    const linkWd = join(root, "link-client");
    mkdirSync(realWd);
    symlinkSync(realWd, linkWd);
    return { root, realWd, linkWd };
  }

  test("cli_add_matches_a_scopemap_prefix_written_through_a_symlink", async () => {
    const { root, realWd, linkWd } = linked();
    // The map names the symlink — the path a human would cd into.
    writeFileSync(join(root, ".scopemap"), `${linkWd} = work\n`);
    const lines: string[] = [];

    // ...while the caller passes the canonical path, as process.cwd() would.
    const code = await runCli(
      ["add", "vlan 40", "--type", "feedback", "--cwd", realpathSync(realWd), "--root", root],
      (s) => lines.push(s), (s) => lines.push(s),
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/\[work\]/);
  });

  // `mneme scope <dir>` is the runbook's gate before importing anything into a
  // scope. If it answered a different question than a write does, the gate would
  // bless the wrong scope — so it canonicalizes the path exactly like `--cwd`.
  test("cli_scope_agrees_with_the_write_for_a_symlinked_directory", async () => {
    const { root, realWd, linkWd } = linked();
    writeFileSync(join(root, ".scopemap"), `${realpathSync(realWd)} = work\n`);

    const said: string[] = [];
    expect(await runCli(["scope", linkWd, "--root", root], (s) => said.push(s), (s) => said.push(s))).toBe(0);
    expect(said.join("\n")).toMatch(/^work\s+owned/);

    // …and the write it is a gate for resolves the same scope from the same path.
    const wrote: string[] = [];
    expect(await runCli(
      ["add", "vlan 60", "--type", "feedback", "--slug", "vlan-60", "--cwd", linkWd, "--root", root],
      (s) => wrote.push(s), (s) => wrote.push(s),
    )).toBe(0);
    expect(wrote.join("\n")).toMatch(/\[work\]/);
  });

  test("cli_add_accepts_a_cwd_flag_given_through_a_symlink", async () => {
    const { root, realWd, linkWd } = linked();
    // The mirror image: the map is canonical, the caller passes the symlink.
    writeFileSync(join(root, ".scopemap"), `${realpathSync(realWd)} = work\n`);
    const lines: string[] = [];

    const code = await runCli(
      ["add", "vlan 50", "--type", "feedback", "--cwd", linkWd, "--root", root],
      (s) => lines.push(s), (s) => lines.push(s),
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/\[work\]/);
  });
});

describe("--cwd decides the scope, not the process", () => {
  test("cli_add_resolves_scope_from_the_cwd_flag", async () => {
    const { root, workWd } = fixture();
    const lines: string[] = [];
    const code = await runCli(
      ["add", "el cliente usa vlans", "--type", "feedback", "--cwd", workWd, "--root", root],
      (s) => lines.push(s),
      (s) => lines.push(s),
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/\[work\]/);
    // The fact must land in the client's folder — that folder IS the compliance
    // boundary, so a misrouted write is the failure that matters.
    expect(readdirSync(join(root, "work", "facts")).some((f) => f.endsWith(".md"))).toBe(true);
    expect(existsSync(join(root, "personal", "facts"))).toBe(false);
  });

  test("cli_add_refuses_an_unmapped_cwd_flag_even_when_the_process_cwd_maps", async () => {
    const { root, unmappedWd } = fixture();
    const errs: string[] = [];
    const code = await runCli(
      ["add", "x", "--type", "feedback", "--cwd", unmappedWd, "--root", root],
      () => {},
      (s) => errs.push(s),
    );

    // Falling back to the process cwd here would write a client's memory into
    // `personal` without any error — the fail-closed gate covers "I don't know
    // which scope", not "I think I know and I'm wrong".
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/cannot resolve a scope/i);
  });

  test("cli_context_resolves_scope_from_the_cwd_flag", async () => {
    const { root, workWd } = fixture();
    const lines: string[] = [];
    const code = await runCli(["context", "--cwd", workWd, "--root", root], (s) => lines.push(s), () => {});

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("scope: work");
  });

  test("cli_scope_flag_still_wins_over_the_cwd_flag", async () => {
    const { root, workWd } = fixture();
    const lines: string[] = [];
    const code = await runCli(
      ["add", "y", "--type", "feedback", "--scope", "personal", "--cwd", workWd, "--root", root],
      (s) => lines.push(s),
      (s) => lines.push(s),
    );

    // An explicit scope is the most specific thing the caller can say; --cwd is
    // only a way to ask the map a question.
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/\[personal\]/);
  });
});
