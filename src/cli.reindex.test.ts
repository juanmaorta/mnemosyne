// src/cli.reindex.test.ts
//
// MNE-115: a note whose frontmatter names another scope than its folder is left
// out of the index. `mneme reindex` must say which one and why, or the note
// just silently stops showing up.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });

describe("runCli reindex", () => {
  test("names_a_note_left_out_because_its_scope_is_not_its_folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "mneme-clireindex-"));
    mkdirSync(join(root, "acme"), { recursive: true });
    const path = join(root, "acme", "leak.md");
    writeFileSync(path, [
      "---", "name: leak", "description: misfiled", "scope: personal",
      "type: reference", "created: 2026-06-01T10:00:00", "importance: 5", "---", "body", "",
    ].join("\n"));
    const out: string[] = [];
    const errs: string[] = [];
    expect(await runCli(["reindex", "--root", root], (s) => out.push(s), (s) => errs.push(s))).toBe(0);
    expect(out.join("\n")).toMatch(/errors 1/);
    expect(errs.join("\n")).toContain(path);
    expect(errs.join("\n")).toMatch(/scope: personal.*folder.*acme/);
  });
});
