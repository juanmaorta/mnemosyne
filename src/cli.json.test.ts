import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });

function storeWith(slug: string): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-clijson-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, "personal", `${slug}.md`),
    ["---", `name: ${slug}`, `description: ${slug} sobre riego y plantas`, "scope: personal", "type: reference",
      "created: 2026-06-01T10:00:00", "importance: 5", "---", `cuerpo de ${slug} con texto suficiente`, ""].join("\n"));
  return root;
}

describe("search --json", () => {
  test("emits_one_json_array_of_hits_with_the_machine_fields", async () => {
    const root = storeWith("yogurtera");
    const lines: string[] = [];
    const code = await runCli(["search", "riego plantas", "--root", root, "--json"], (s) => lines.push(s));

    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({ slug: "yogurtera", scope: "personal", isDerived: false });
    expect(typeof parsed[0].score).toBe("number");
    expect(typeof parsed[0].snippet).toBe("string");
  });

  test("rejects_combining_json_with_explain_instead_of_silently_ignoring_it", async () => {
    const root = storeWith("yogurtera");
    const errors: string[] = [];
    const code = await runCli(["search", "riego", "--root", root, "--json", "--explain"], () => {}, (s) => errors.push(s));

    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/--json and --explain cannot be combined/);
  });

  test("emits_an_empty_array_and_exits_two_when_nothing_is_relevant", async () => {
    const root = storeWith("yogurtera");
    const lines: string[] = [];
    const code = await runCli(["search", "consulta sin respuesta", "--root", root, "--min-cos", "1", "--json"], (s) => lines.push(s));

    expect(code).toBe(2);
    expect(JSON.parse(lines.join("\n"))).toEqual([]);
  });
});

describe("context --json", () => {
  test("emits_a_json_object_with_the_digest_and_its_metadata", async () => {
    const root = storeWith("yogurtera");
    const lines: string[] = [];
    const code = await runCli(["context", "--root", root, "--scope", "personal", "--json"], (s) => lines.push(s));

    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed).toMatchObject({ scope: "personal" });
    expect(typeof parsed.digest).toBe("string");
    expect(parsed.included).toContain("yogurtera");
    expect(typeof parsed.omitted).toBe("number");
    expect(Array.isArray(parsed.degraded)).toBe(true);
  });
});
