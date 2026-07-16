import { describe, expect, test } from "vitest";
import { migrateLegacy, rewriteBodyLinks } from "./migrate.js";
import { parseFrontmatter } from "./frontmatter.js";

const CREATED = "2026-01-15T09:00:00";

describe("migrateLegacy", () => {
  test("migrates an authored note into a scoped, kebab-named engram", () => {
    const raw = [
      "---",
      "name: Yogurtera DIY thermostat",
      "description: M5StickC + DS18B20 + Tapo governed by HA",
      "type: project",
      "originSessionId: 6aab4ca7-1917-49a3-99bf-bfaf3306796d",
      "---",
      "Body content.",
      "",
    ].join("\n");

    const result = migrateLegacy({ raw, filename: "project_yogurtera.md", created: CREATED });

    expect(result.kind).toBe("note");
    expect(result.filename).toBe("yogurtera.md");
    expect(result.engram).toMatchObject({
      name: "yogurtera",
      type: "project",
      scope: "personal",
      importance: 5,
      created: CREATED,
      description: "M5StickC + DS18B20 + Tapo governed by HA",
    });
  });

  test("drops non-schema legacy fields (originSessionId)", () => {
    const raw = [
      "---",
      "name: Whatever",
      "description: d",
      "type: reference",
      "originSessionId: abc",
      "---",
      "b",
      "",
    ].join("\n");

    const result = migrateLegacy({ raw, filename: "reference_home_network.md", created: CREATED });

    const { data } = parseFrontmatter(result.content);
    expect(data).not.toHaveProperty("originSessionId");
    expect(result.filename).toBe("lan-setup.md");
  });

  test("reads type from a nested legacy metadata block", () => {
    const raw = [
      "---",
      "name: lan-setup",
      "description: d",
      "metadata:",
      "  node_type: memory",
      "  type: reference",
      "  originSessionId: c92",
      "---",
      "b",
      "",
    ].join("\n");

    const result = migrateLegacy({ raw, filename: "reference_home_network.md", created: CREATED });

    expect(result.kind).toBe("note");
    expect(result.engram.type).toBe("reference");
  });

  test("uses the provided scope instead of the personal default", () => {
    const raw = ["---", "name: n", "description: d", "type: project", "---", "b", ""].join("\n");

    const result = migrateLegacy({ raw, filename: "project_x.md", created: CREATED, scope: "acme" });

    expect(result.engram.scope).toBe("acme");
  });

  test("routes observed feedback into the fact stream with a ULID filename", () => {
    const raw = [
      "---",
      "name: Communication style",
      "description: prefers terse surgical responses",
      "type: feedback",
      "---",
      "Keep it surgical.",
      "",
    ].join("\n");

    const result = migrateLegacy({ raw, filename: "feedback_communication_style.md", created: CREATED });

    expect(result.kind).toBe("fact");
    expect(result.filename).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.md$/);
    expect(result.engram).toMatchObject({ type: "feedback", scope: "personal", name: "communication-style" });
  });

  test("normalizes underscore legacy links and sources to kebab slugs", () => {
    const raw = [
      "---",
      "name: X",
      "description: d",
      "type: reference",
      "links:",
      "  - home_network",
      "sources:",
      "  - some_fact",
      "---",
      "b",
      "",
    ].join("\n");

    const result = migrateLegacy({ raw, filename: "reference_x.md", created: CREATED });

    expect(result.engram).toMatchObject({ links: ["lan-setup"], sources: ["some-fact"] });
  });

  test("seeds the fact ULID from created so migrated facts keep chronology", () => {
    const mk = (created: string) =>
      migrateLegacy({
        raw: ["---", "name: n", "description: d", "type: feedback", "---", "b", ""].join("\n"),
        filename: "feedback_n.md",
        created,
      }).filename;

    expect(mk("2020-01-01T00:00:00") < mk("2026-01-01T00:00:00")).toBe(true);
  });

  test("slugifies filenames with spaces and unknown prefixes", () => {
    const raw = ["---", "name: n", "description: d", "type: user", "---", "b", ""].join("\n");
    expect(migrateLegacy({ raw, filename: "Home Network.md", created: CREATED }).filename).toBe(
      "lan-setup.md",
    );
  });

  test("falls back to the filename type prefix when frontmatter lacks a type", () => {
    const raw = ["---", "name: Idea validation", "description: d", "---", "b", ""].join("\n");

    const result = migrateLegacy({ raw, filename: "feedback_idea_validation.md", created: CREATED });

    expect(result.kind).toBe("fact");
    expect(result.engram.type).toBe("feedback");
  });

  test("throws when neither frontmatter nor filename yields a known type", () => {
    const raw = ["---", "name: n", "description: d", "---", "b", ""].join("\n");
    expect(() => migrateLegacy({ raw, filename: "unknown_n.md", created: CREATED })).toThrow();
  });

  test("preserves the body verbatim", () => {
    const raw = ["---", "name: X", "description: d", "type: user", "---", "line 1", "line 2", ""].join("\n");

    const result = migrateLegacy({ raw, filename: "user_profile.md", created: CREATED });

    expect(parseFrontmatter(result.content).body).toBe("line 1\nline 2\n");
  });

  test("rewrites stale legacy wikilinks in the body to the new slug", () => {
    const raw = ["---", "name: n", "description: d", "type: project", "---", "see [[project_yogurtera]]", ""].join("\n");

    const result = migrateLegacy({ raw, filename: "project_x.md", created: CREATED });

    expect(parseFrontmatter(result.content).body).toBe("see [[yogurtera]]\n");
  });
});

describe("rewriteBodyLinks", () => {
  test("maps a legacy-prefixed target to its migrated slug", () => {
    expect(rewriteBodyLinks("[[project_yogurtera]]")).toBe("[[yogurtera]]");
  });

  test("preserves an alias after the pipe", () => {
    expect(rewriteBodyLinks("[[reference_home_network|la red]]")).toBe("[[lan-setup|la red]]");
  });

  test("preserves a heading anchor", () => {
    expect(rewriteBodyLinks("[[project_riego_automatico#Seguridad]]")).toBe("[[auto-watering#Seguridad]]");
  });

  test("is idempotent on already-kebab targets", () => {
    expect(rewriteBodyLinks("[[sensor-plants]]")).toBe("[[sensor-plants]]");
  });

  test("leaves a target that slugifies to empty untouched (no [[]])", () => {
    expect(rewriteBodyLinks("[[!!!]]")).toBe("[[!!!]]");
  });

  test("does not collapse across newlines", () => {
    expect(rewriteBodyLinks("[[oops\nfoo]]")).toBe("[[oops\nfoo]]");
  });

  test("rewrites multiple links on one line and a combined suffix", () => {
    expect(rewriteBodyLinks("[[project_a]] y [[project_b#h|alias]]")).toBe("[[a]] y [[b#h|alias]]");
  });
});
