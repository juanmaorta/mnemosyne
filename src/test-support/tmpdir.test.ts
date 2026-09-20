// src/test-support/tmpdir.test.ts
//
// Guards the mechanism that keeps the suite from filling the machine's disk.
//
// 34 of the 37 test files that call `mkdtempSync` never delete what they make,
// and each store they leave behind carries a SQLite index. This was found the
// way these things are always found: a disk at zero bytes free. The fix is not
// to police 37 files but to move `os.tmpdir()` for the run, so that forgetting
// is harmless — and this test is what notices if that move ever goes away.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("the suite's temp directory", () => {
  test("tests_write_their_temp_dirs_inside_the_disposable_run_root", () => {
    expect(tmpdir()).toMatch(/mneme-run-/);
  });

  test("a_temp_dir_made_the_usual_way_lands_inside_that_root", () => {
    // The exact call every test file makes. If this ever resolves outside the
    // run root, the run leaks again and nobody finds out for weeks.
    const dir = mkdtempSync(join(tmpdir(), "mneme-guard-"));
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(dir).toMatch(/mneme-run-/);
  });
});
