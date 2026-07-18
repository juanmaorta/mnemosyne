import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadOwnerPolicy, ownsScope } from "./owner.js";

function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mneme-owner-"));
  const path = join(dir, ".owner");
  writeFileSync(path, contents);
  return path;
}

describe("loadOwnerPolicy", () => {
  test("loadOwnerPolicy_reads_declared_scopes", () => {
    const path = tmpFile(JSON.stringify({ owns: ["personal", "acme"] }));
    expect(loadOwnerPolicy(path)).toEqual({ owns: ["personal", "acme"] });
  });

  test("loadOwnerPolicy_missing_file_defaults_to_personal_only", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mneme-owner-")), "does-not-exist");
    expect(loadOwnerPolicy(path)).toEqual({ owns: ["personal"] });
  });

  test("loadOwnerPolicy_unparseable_file_defaults_to_personal_only", () => {
    const path = tmpFile("{ not valid json");
    expect(loadOwnerPolicy(path)).toEqual({ owns: ["personal"] });
  });

  test("loadOwnerPolicy_missing_owns_array_defaults_to_personal_only", () => {
    const path = tmpFile(JSON.stringify({ something: "else" }));
    expect(loadOwnerPolicy(path)).toEqual({ owns: ["personal"] });
  });

  test("loadOwnerPolicy_filters_non_string_entries", () => {
    const path = tmpFile(JSON.stringify({ owns: ["personal", 42, null, "acme"] }));
    expect(loadOwnerPolicy(path)).toEqual({ owns: ["personal", "acme"] });
  });
});

describe("ownsScope", () => {
  test("ownsScope_true_when_declared", () => {
    expect(ownsScope({ owns: ["personal", "acme"] }, "acme")).toBe(true);
  });
  test("ownsScope_false_when_not_declared", () => {
    expect(ownsScope({ owns: ["personal"] }, "acme")).toBe(false);
  });
});
