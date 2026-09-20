// src/cli.update.test.ts
//
// The CLI surface of the compare-and-swap: `--if-match` is mandatory, a conflict
// tells the caller to re-read and reconcile (never retry, never `--force`), and
// every refusal is exit 1 with the original untouched.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { scopeLockPath } from "./write/lock.js";

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });

function store(owns: string[] = ["personal"], scopemap?: string): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-cliupd-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns }));
  if (scopemap) writeFileSync(join(root, ".scopemap"), scopemap);
  return root;
}

async function addNote(root: string, scope: string, slug: string, body = "cuerpo original"): Promise<string> {
  const code = await runCli(
    ["add", body, "--type", "reference", "--scope", scope, "--description", "una nota", "--slug", slug, "--root", root],
    () => {}, () => {},
  );
  expect(code).toBe(0);
  return join(root, scope, `${slug}.md`);
}

function revisionOnDisk(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The revision as the agent would obtain it: straight out of `get --json`. */
async function revisionViaGet(root: string, slug: string): Promise<string> {
  expect(await runCli(["reindex", "--root", root], () => {}, () => {})).toBe(0);
  const lines: string[] = [];
  expect(await runCli(["get", slug, "--json", "--root", root], (s) => lines.push(s), () => {})).toBe(0);
  return (JSON.parse(lines[0]!) as { revision: string }).revision;
}

describe("runCli update", () => {
  test("cli_update_rewrites_the_body_and_reports_the_new_revision", async () => {
    const root = store();
    const path = await addNote(root, "personal", "yogurtera");
    const revision = await revisionViaGet(root, "yogurtera");

    const lines: string[] = [];
    const code = await runCli(
      ["update", "yogurtera", "cuerpo reescrito", "--if-match", revision, "--scope", "personal", "--root", root],
      (s) => lines.push(s), (s) => lines.push(s),
    );

    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("updated note [personal] yogurtera");
    expect(out).toContain(path);
    expect(out).toContain(`revision ${revisionOnDisk(path)}`);
    expect(readFileSync(path, "utf8")).toContain("cuerpo reescrito");
  });

  test("cli_update_reads_the_body_from_a_file_preserving_newlines", async () => {
    const root = store();
    const path = await addNote(root, "personal", "yogurtera");
    const bodyFile = join(root, "nuevo-cuerpo.md");
    writeFileSync(bodyFile, "linea uno\n\n  linea tres sangrada\n");

    const code = await runCli(
      ["update", "yogurtera", "--file", bodyFile, "--if-match", revisionOnDisk(path), "--scope", "personal", "--root", root],
      () => {}, () => {},
    );

    expect(code).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("linea uno\n\n  linea tres sangrada\n");
  });

  test("cli_update_without_if_match_is_a_usage_error", async () => {
    const root = store();
    const path = await addNote(root, "personal", "yogurtera");
    const before = readFileSync(path);
    const errs: string[] = [];

    const code = await runCli(["update", "yogurtera", "x", "--scope", "personal", "--root", root], () => {}, (s) => errs.push(s));

    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("--if-match");
    expect(readFileSync(path)).toEqual(before);
  });

  test("cli_update_without_any_change_is_a_usage_error", async () => {
    const root = store();
    const path = await addNote(root, "personal", "yogurtera");
    const errs: string[] = [];

    const code = await runCli(
      ["update", "yogurtera", "--if-match", revisionOnDisk(path), "--scope", "personal", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/--description|--importance|--file/);
  });

  test("cli_update_conflict_tells_the_caller_to_re_read_and_reconcile", async () => {
    const root = store();
    const path = await addNote(root, "personal", "yogurtera");
    const stale = revisionOnDisk(path);
    // Somebody else updated it in the meantime.
    expect(await runCli(
      ["update", "yogurtera", "version de otro", "--if-match", stale, "--scope", "personal", "--root", root],
      () => {}, () => {},
    )).toBe(0);
    const theirs = readFileSync(path);

    const errs: string[] = [];
    const code = await runCli(
      ["update", "yogurtera", "mi version", "--if-match", stale, "--scope", "personal", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    const out = errs.join("\n");
    expect(out).toMatch(/mneme get yogurtera --json/);
    expect(out).toMatch(/reconcil/i);
    expect(out).not.toMatch(/--force/);
    // The other writer's content survives untouched; nothing is retried for us.
    expect(readFileSync(path)).toEqual(theirs);
    expect(readdirSync(join(root, "personal")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("cli_update_refuses_a_feedback_fact", async () => {
    const root = store();
    expect(await runCli(
      ["add", "riego a las 7", "--type", "feedback", "--scope", "personal", "--description", "riego", "--slug", "riego", "--root", root],
      () => {}, () => {},
    )).toBe(0);
    const factFile = readdirSync(join(root, "personal", "facts"))[0]!;
    const factPath = join(root, "personal", "facts", factFile);
    const before = readFileSync(factPath);

    const errs: string[] = [];
    const code = await runCli(
      ["update", "riego", "otra cosa", "--if-match", revisionOnDisk(factPath), "--scope", "personal", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/append-only|feedback/i);
    expect(readFileSync(factPath)).toEqual(before);
  });

  test("cli_update_refuses_an_unmapped_cwd_fail_closed", async () => {
    const root = store();
    const path = await addNote(root, "personal", "yogurtera");
    const unmapped = mkdtempSync(join(tmpdir(), "mneme-wd-"));
    const errs: string[] = [];

    const code = await runCli(
      ["update", "yogurtera", "x", "--if-match", revisionOnDisk(path), "--cwd", unmapped, "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/cannot resolve a scope/i);
  });

  test("cli_update_resolves_the_scope_from_the_cwd_flag", async () => {
    const wd = mkdtempSync(join(tmpdir(), "mneme-wd-"));
    const root = store(["personal"], `${wd} = personal\n`);
    const path = await addNote(root, "personal", "yogurtera");

    const lines: string[] = [];
    const code = await runCli(
      ["update", "yogurtera", "desde el cwd", "--if-match", revisionOnDisk(path), "--cwd", wd, "--root", root],
      (s) => lines.push(s), (s) => lines.push(s),
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("[personal]");
    expect(readFileSync(path, "utf8")).toContain("desde el cwd");
  });

  test("cli_update_refuses_a_secret_and_leaves_no_lock_or_temporary", async () => {
    const root = store();
    const path = await addNote(root, "personal", "yogurtera");
    const before = readFileSync(path);

    const errs: string[] = [];
    const code = await runCli(
      ["update", "yogurtera", "la clave es sk-abcdefghij0123456789", "--if-match", revisionOnDisk(path), "--scope", "personal", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    const out = errs.join("\n");
    expect(out).toMatch(/secret/i);
    expect(out).not.toContain("sk-abcdefghij0123456789");
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(join(root, "personal")).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(join(root, "personal"))).not.toContain(".mneme-write.lock");
  });

  test("cli_update_reports_a_busy_scope_lock_without_breaking_it", async () => {
    const root = store();
    const path = await addNote(root, "personal", "yogurtera");
    const before = readFileSync(path);
    const lock = scopeLockPath(join(root, "personal"));
    writeFileSync(lock, "99999 2026-09-11T10:00:00.000Z\n");

    const errs: string[] = [];
    const code = await runCli(
      ["update", "yogurtera", "x", "--if-match", revisionOnDisk(path), "--scope", "personal", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    expect(errs.join("\n")).toContain(lock);
    expect(readFileSync(path)).toEqual(before);
  }, 15_000);

  // `parseArgs` refuses a positional beginning with `-`, so a bulleted body can
  // only reach `update` through `--file` or after `--` (with the flags before
  // it). Both are documented; this pins the argv form.
  test("cli_update_accepts_a_bulleted_body_after_a_double_dash", async () => {
    const root = store();
    const path = await addNote(root, "personal", "nota-a");
    const revision = await revisionViaGet(root, "nota-a");

    const code = await runCli(
      ["update", "--if-match", revision, "--scope", "personal", "--root", root, "--", "nota-a", "- uno\n- dos"],
      () => {}, () => {},
    );

    expect(code).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("- uno\n- dos\n");
  }, 30_000);

  test("cli_update_usage_points_at_file_or_double_dash_for_a_body_starting_with_a_dash", async () => {
    const root = store();
    const errs: string[] = [];

    const code = await runCli(["update", "nota-a", "--root", root], () => {}, (s) => errs.push(s));

    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/first character is '-'/);
  });

  test("cli_update_refuses_a_non_numeric_importance_in_its_own_language", async () => {
    const root = store();
    const path = await addNote(root, "personal", "nota-a");
    const before = readFileSync(path);
    const errs: string[] = [];

    const code = await runCli(
      ["update", "nota-a", "--importance", "abc", "--if-match", revisionOnDisk(path), "--scope", "personal", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    const out = errs.join("\n");
    expect(out).toContain("--importance");
    expect(out).not.toContain("invalid_type");
    expect(readFileSync(path)).toEqual(before);
  });

  test("cli_update_reports_an_unreadable_body_file_with_the_usage_line", async () => {
    const root = store();
    const path = await addNote(root, "personal", "nota-a");
    const errs: string[] = [];

    const code = await runCli(
      ["update", "nota-a", "--file", join(root, "no-existe.md"), "--if-match", revisionOnDisk(path), "--scope", "personal", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    const out = errs.join("\n");
    expect(out).toContain(join(root, "no-existe.md"));
    expect(out).toContain("usage: mneme update");
  });

  test("cli_update_then_reindex_serves_the_new_content_under_the_same_slug", async () => {
    const root = store();
    const path = await addNote(root, "personal", "yogurtera", "leche y fermento a 42 grados");
    const revision = await revisionViaGet(root, "yogurtera");

    expect(await runCli(
      ["update", "yogurtera", "ahora usamos yogur griego como iniciador", "--if-match", revision, "--scope", "personal", "--root", root],
      () => {}, () => {},
    )).toBe(0);

    // Identity is unchanged, so the same slug now resolves to the new content —
    // an update must never fork a memory into a second engram.
    expect(await runCli(["reindex", "--root", root], () => {}, () => {})).toBe(0);
    const got: string[] = [];
    expect(await runCli(["get", "yogurtera", "--root", root], (s) => got.push(s), () => {})).toBe(0);
    expect(got.join("\n")).toContain("yogur griego");
    expect(got.join("\n")).not.toContain("leche y fermento");

    const hits: string[] = [];
    expect(await runCli(["search", "yogur griego iniciador", "--root", root, "-k", "5"], (s) => hits.push(s), () => {})).toBe(0);
    expect(hits.join("\n")).toContain("yogurtera");
    expect(readdirSync(join(root, "personal")).filter((f) => f.endsWith(".md"))).toEqual(["yogurtera.md"]);
    expect(readFileSync(path, "utf8")).toContain("yogur griego");
  }, 30_000);
});

describe("supersession through the CLI", () => {
  test("cli_update_supersedes_a_note_and_records_the_replacement", async () => {
    const root = store();
    const old = await addNote(root, "personal", "network-upgrade");
    await addNote(root, "personal", "network-upgrade-mesh");

    const code = await runCli(
      ["update", "network-upgrade", "--superseded-by", "network-upgrade-mesh",
        "--if-match", revisionOnDisk(old), "--scope", "personal", "--root", root],
      () => {}, () => {},
    );

    expect(code).toBe(0);
    const raw = readFileSync(old, "utf8");
    expect(raw).toContain("status: superseded");
    expect(raw).toContain("superseded_by: network-upgrade-mesh");
  });

  test("cli_update_refuses_an_unknown_status_and_names_the_valid_ones", async () => {
    // The caller typed a word; the answer to a mistyped word is the list of
    // words, not a schema dump.
    const root = store();
    const path = await addNote(root, "personal", "yogurtera");
    const before = readFileSync(path, "utf8");
    const errs: string[] = [];

    const code = await runCli(
      ["update", "yogurtera", "--status", "borrada", "--if-match", revisionOnDisk(path),
        "--scope", "personal", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/active, superseded, flagged/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("cli_update_refuses_a_replacement_that_does_not_exist", async () => {
    const root = store();
    const path = await addNote(root, "personal", "yogurtera");
    const before = readFileSync(path, "utf8");
    const errs: string[] = [];

    const code = await runCli(
      ["update", "yogurtera", "--superseded-by", "no-existe", "--if-match", revisionOnDisk(path),
        "--scope", "personal", "--root", root],
      () => {}, (s) => errs.push(s),
    );

    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/no-existe/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
