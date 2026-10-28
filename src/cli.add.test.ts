// src/cli.add.test.ts
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { scopeLockPath } from "./write/lock.js";

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });

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

  test("cli_add_snapshot_writes_an_ephemeral_note", async () => {
    const root = store();
    const lines: string[] = [];
    const code = await runCli(["add", "proyecto a medias, B7 pendiente", "--type", "snapshot", "--scope", "personal", "--description", "estado 2026-06-02", "--slug", "estado-2026-06-02", "--root", root], (s) => lines.push(s));
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/note.*personal/); // a snapshot is a note, not a fact
    expect(existsSync(join(root, "personal", "estado-2026-06-02.md"))).toBe(true);
    expect(readFileSync(join(root, "personal", "estado-2026-06-02.md"), "utf8")).toMatch(/type: snapshot/);
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
      ["add", "some content", "--type", "feedback", "--scope", "work", "--description", "d", "--root", root],
      () => {},
      (s) => errs.push(s),
    );
    expect(code).toBe(1);
    const out = errs.join("\n");
    expect(out).toContain("work");
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
    const out = errs.join("\n");
    expect(out).toMatch(/already exists/);
    // The note is canonical now: read it and update it with a revision, never
    // "edit the file directly".
    expect(out).toContain("mneme get foo");
    expect(out).toContain("--if-match");
  });

  test("cli_add_refuses_a_secret_hidden_in_description_and_writes_nothing", async () => {
    const root = store();
    const errs: string[] = [];
    const code = await runCli(
      ["add", "innocent body", "--type", "feedback", "--scope", "personal", "--description", "token sk-abcdefghij0123456789", "--root", root],
      () => {},
      (s) => errs.push(s),
    );

    expect(code).toBe(1);
    const out = errs.join("\n");
    expect(out).toMatch(/secret/i);
    expect(out).not.toContain("sk-abcdefghij0123456789");
    // A rejected write leaves nothing behind: no fact, no note, no lock.
    expect(readdirSync(join(root, "personal")).filter((f) => f.endsWith(".md"))).toEqual([]);
    expect(existsSync(join(root, "personal", "facts"))).toBe(false);
    expect(existsSync(scopeLockPath(join(root, "personal")))).toBe(false);
  });

  test("cli_add_rejected_by_the_secret_gate_never_materializes_the_scope", async () => {
    // Owned scope whose directory does not exist yet: a refused write must not
    // create it — the gates run before anything touches the filesystem.
    const root = mkdtempSync(join(tmpdir(), "mneme-cliadd-"));
    writeFileSync(join(root, ".owner"), JSON.stringify({ owns: ["personal"] }));

    const errs: string[] = [];
    const code = await runCli(
      ["add", "key is sk-abcdefghij0123456789", "--type", "feedback", "--scope", "personal", "--description", "d", "--root", root],
      () => {},
      (s) => errs.push(s),
    );

    expect(code).toBe(1);
    expect(existsSync(join(root, "personal"))).toBe(false);
  });

  test("cli_add_reports_a_busy_scope_lock_with_manual_recovery", async () => {
    const root = store();
    const lock = scopeLockPath(join(root, "personal"));
    writeFileSync(lock, "99999 2026-09-11T10:00:00.000Z\n"); // another writer holds it

    const errs: string[] = [];
    const code = await runCli(
      ["add", "some content", "--type", "feedback", "--scope", "personal", "--description", "d", "--root", root],
      () => {},
      (s) => errs.push(s),
    );

    expect(code).toBe(1);
    const out = errs.join("\n");
    expect(out).toContain(lock);
    expect(out).toMatch(/remove/i);
    // Never recovered automatically, and nothing was written.
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(join(root, "personal", "facts"))).toBe(false);
  }, 15_000);

  // A note body is a document, not a shell argument: newlines, blank lines and
  // indentation have to survive, which argv quoting makes painful.
  test("cli_add_reads_the_body_from_a_file_preserving_newlines", async () => {
    const root = store();
    const bodyFile = join(root, "body.md");
    writeFileSync(bodyFile, "primera linea\n\n  tercera sangrada\n");

    const code = await runCli(
      ["add", "--file", bodyFile, "--type", "reference", "--scope", "personal", "--description", "d", "--slug", "desde-fichero", "--root", root],
      () => {}, () => {},
    );

    expect(code).toBe(0);
    expect(readFileSync(join(root, "personal", "desde-fichero.md"), "utf8"))
      .toContain("primera linea\n\n  tercera sangrada\n");
  });

  test("cli_add_refuses_positional_text_and_file_together", async () => {
    const root = store();
    const bodyFile = join(root, "body.md");
    writeFileSync(bodyFile, "desde el fichero\n");
    const errs: string[] = [];

    const code = await runCli(
      ["add", "desde argv", "--file", bodyFile, "--type", "reference", "--scope", "personal", "--slug", "ambiguo", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    // Silently picking one would mean writing a memory the caller did not mean.
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/--file/);
    expect(existsSync(join(root, "personal", "ambiguo.md"))).toBe(false);
  });

  test("cli_add_refuses_an_empty_body_file", async () => {
    const root = store();
    const bodyFile = join(root, "body.md");
    writeFileSync(bodyFile, "   \n\n");
    const errs: string[] = [];

    const code = await runCli(
      ["add", "--file", bodyFile, "--type", "reference", "--scope", "personal", "--slug", "vacio", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/empty/i);
    expect(existsSync(join(root, "personal", "vacio.md"))).toBe(false);
  });

  test("cli_add_refuses_an_unreadable_body_file", async () => {
    const root = store();
    const errs: string[] = [];

    const code = await runCli(
      ["add", "--file", join(root, "no-existe.md"), "--type", "reference", "--scope", "personal", "--slug", "ausente", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    const out = errs.join("\n");
    expect(out).toContain(join(root, "no-existe.md"));
    // Same treatment as every other refusal of this command: the usage line,
    // not a bare message from the generic handler.
    expect(out).toContain("usage: mneme add");
  });

  // A bulleted list is the most common shape of an agent-written body, and
  // `parseArgs` rejects a positional starting with `-` before `resolveBody` ever
  // sees it. `--` (after the flags) is the documented way through; this pins it.
  test("cli_add_accepts_a_bulleted_body_after_a_double_dash", async () => {
    const root = store();

    const code = await runCli(
      ["add", "--type", "reference", "--scope", "personal", "--description", "d", "--slug", "lista", "--root", root,
        "--", "- uno\n- dos"],
      () => {}, () => {},
    );

    expect(code).toBe(0);
    expect(readFileSync(join(root, "personal", "lista.md"), "utf8")).toContain("- uno\n- dos\n");
  });

  test("cli_add_usage_points_at_file_or_double_dash_for_a_body_starting_with_a_dash", async () => {
    const root = store();
    const errs: string[] = [];

    const code = await runCli(["add", "--type", "reference", "--scope", "personal", "--root", root], () => {}, (s) => errs.push(s));

    expect(code).toBe(1);
    const out = errs.join("\n");
    expect(out).toContain("--file");
    expect(out).toContain("--");
    expect(out).toMatch(/first character is '-'/);
  });

  test("cli_add_refuses_a_non_numeric_importance_in_its_own_language", async () => {
    const root = store();
    const errs: string[] = [];

    const code = await runCli(
      ["add", "cuerpo", "--type", "reference", "--scope", "personal", "--slug", "imp", "--importance", "abc", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    const out = errs.join("\n");
    expect(out).toContain("--importance");
    expect(out).not.toContain("invalid_type"); // never raw zod JSON
    expect(existsSync(join(root, "personal", "imp.md"))).toBe(false);
  });
});

// The index enforces UNIQUE(scope, slug). A fact that reuses a claimed slug is
// written to disk under its own ULID filename and is then permanently
// unretrievable: `reindex` reports it only as `errors 1`.
describe("runCli add refuses a slug already claimed in the scope", () => {
  test("cli_add_feedback_refuses_a_slug_another_fact_already_claims", async () => {
    const root = store();
    expect(await runCli(
      ["add", "hecho uno", "--type", "feedback", "--scope", "personal", "--slug", "hecho-x", "--root", root],
      () => {}, () => {},
    )).toBe(0);

    const errs: string[] = [];
    const code = await runCli(
      ["add", "hecho dos", "--type", "feedback", "--scope", "personal", "--slug", "hecho-x", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    const out = errs.join("\n");
    expect(out).toContain("hecho-x");
    expect(out).toMatch(/--slug/);
    // The second observation must NOT be on disk: a fact nobody can retrieve is
    // worse than a refused write.
    expect(readdirSync(join(root, "personal", "facts")).filter((f) => f.endsWith(".md"))).toHaveLength(1);

    const lines: string[] = [];
    expect(await runCli(["reindex", "--root", root], (s) => lines.push(s), () => {})).toBe(0);
    expect(lines.join("\n")).toMatch(/errors 0/);
  }, 30_000);

  test("cli_add_note_refuses_a_slug_a_fact_already_claims", async () => {
    const root = store();
    expect(await runCli(
      ["add", "hecho uno", "--type", "feedback", "--scope", "personal", "--slug", "hecho-x", "--root", root],
      () => {}, () => {},
    )).toBe(0);

    const errs: string[] = [];
    const code = await runCli(
      ["add", "una nota", "--type", "reference", "--scope", "personal", "--slug", "hecho-x", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    // The mirror image of the fact collision, and just as unretrievable.
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("hecho-x");
    expect(existsSync(join(root, "personal", "hecho-x.md"))).toBe(false);
  });

  test("cli_add_feedback_refuses_a_slug_a_note_already_claims", async () => {
    const root = store();
    expect(await runCli(
      ["add", "una nota", "--type", "reference", "--scope", "personal", "--slug", "nota-a", "--root", root],
      () => {}, () => {},
    )).toBe(0);

    const errs: string[] = [];
    const code = await runCli(
      ["add", "un hecho", "--type", "feedback", "--scope", "personal", "--slug", "nota-a", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    // The other direction of the same defect: a fact never owns `<slug>.md`, so
    // it has no own target to exclude from the claim search.
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("nota-a");
    expect(existsSync(join(root, "personal", "facts"))).toBe(false);
    expect(readdirSync(join(root, "personal")).filter((f) => f.endsWith(".md"))).toEqual(["nota-a.md"]);

    const lines: string[] = [];
    expect(await runCli(["reindex", "--root", root], (s) => lines.push(s), () => {})).toBe(0);
    expect(lines.join("\n")).toMatch(/errors 0/);
  }, 30_000);

  test("cli_add_still_reports_an_existing_note_as_a_note_to_update", async () => {
    const root = store();
    expect(await runCli(
      ["add", "cuerpo", "--type", "reference", "--scope", "personal", "--slug", "nota-a", "--root", root],
      () => {}, () => {},
    )).toBe(0);

    const errs: string[] = [];
    const code = await runCli(
      ["add", "otro cuerpo", "--type", "reference", "--scope", "personal", "--slug", "nota-a", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    // A note colliding with ITSELF keeps the message that teaches the update
    // path — the new slug check must not swallow it.
    expect(errs.join("\n")).toContain("mneme get nota-a");
  });
});
