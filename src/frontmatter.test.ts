import { describe, expect, test } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  test("splits YAML frontmatter from body", () => {
    const raw = ["---", "name: foo", "importance: 7", "---", "body text", ""].join("\n");

    const { data, body } = parseFrontmatter(raw);

    expect(data).toEqual({ name: "foo", importance: 7 });
    expect(body).toBe("body text\n");
  });

  test("returns empty data when no frontmatter block", () => {
    const raw = "just body\nwith lines\n";

    const { data, body } = parseFrontmatter(raw);

    expect(data).toEqual({});
    expect(body).toBe(raw);
  });

  test("handles CRLF line endings", () => {
    const raw = ["---", "name: foo", "---", "body", ""].join("\r\n");

    const { data, body } = parseFrontmatter(raw);

    expect(data).toEqual({ name: "foo" });
    expect(body).toBe("body\n");
  });

  test("does not treat a thematic break in the body as a delimiter", () => {
    const raw = ["---", "name: foo", "---", "intro", "", "---", "", "after break", ""].join("\n");

    const { data, body } = parseFrontmatter(raw);

    expect(data).toEqual({ name: "foo" });
    expect(body).toBe("intro\n\n---\n\nafter break\n");
  });
});

describe("serializeFrontmatter", () => {
  test("emits a delimited YAML block followed by the body", () => {
    const out = serializeFrontmatter({ name: "foo", importance: 7 }, "body text\n");

    expect(out).toBe(["---", "name: foo", "importance: 7", "---", "body text", ""].join("\n"));
  });
});
