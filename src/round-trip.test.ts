import { describe, expect, test } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { EngramSchema } from "./schema.js";

/**
 * Obsidian's Properties UI reorders keys, rewrites lists as block sequences,
 * and reformats YAML on save. A note round-tripped through Obsidian must survive
 * our parse → validate → reserialize without schema drift (docs/architecture.md, phase 0).
 */
describe("Obsidian round-trip", () => {
  // Frontmatter as Obsidian would rewrite it: keys reordered, list as a block
  // sequence, datetime as an unquoted scalar.
  const obsidianSaved = [
    "---",
    "importance: 8",
    "created: 2026-06-22T10:00:00",
    "type: reference",
    "name: fermentor-config",
    "description: How to run the yogurt maker",
    "links:",
    "  - other-note",
    "  - another-note",
    "scope: personal",
    "---",
    "Body content here.",
    "",
  ].join("\n");

  test("a datetime scalar stays a string (not coerced to a Date)", () => {
    const { data } = parseFrontmatter(obsidianSaved);
    expect(typeof data.created).toBe("string");
    expect(data.created).toBe("2026-06-22T10:00:00");
  });

  test("parses and validates against the schema despite reordering", () => {
    const { data } = parseFrontmatter(obsidianSaved);
    const engram = EngramSchema.parse(data);

    expect(engram).toMatchObject({
      name: "fermentor-config",
      type: "reference",
      importance: 8,
      links: ["other-note", "another-note"],
    });
  });

  test("re-serializing and re-parsing is idempotent at the schema level", () => {
    const { data, body } = parseFrontmatter(obsidianSaved);
    const engram = EngramSchema.parse(data);

    const reserialized = serializeFrontmatter(engram, body);
    const reparsed = EngramSchema.parse(parseFrontmatter(reserialized).data);

    expect(reparsed).toEqual(engram);
  });
});
