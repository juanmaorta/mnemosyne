// src/write/update.pinned.test.ts
//
// MNE-62: pin/unpin a note through `update`. A pin is written by hand or by the
// agent (never by dreaming), so `update --pinned/--unpinned` is the agent's way
// in. Absent means not pinned, so unpinning deletes the key rather than writing
// `pinned: false`, and an unrelated update must carry an existing pin through
// untouched (it is spread from the raw frontmatter like links/sources).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseFrontmatter } from "../frontmatter.js";
import { EngramSchema } from "../schema.js";
import { updateNote, NoChangesError } from "./update.js";

function store(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "mneme-pin-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns: ["personal"] }));
  return { root, home: mkdtempSync(join(tmpdir(), "mneme-home-")) };
}

function note(root: string, slug: string, extra: string[] = []): string {
  const fm = [
    `name: ${slug}`, "description: d", "scope: personal",
    "created: 2026-06-01T10:00:00", "importance: 5", ...extra, "type: reference",
  ];
  const path = join(root, "personal", `${slug}.md`);
  writeFileSync(path, `---\n${fm.join("\n")}\n---\nbody\n`);
  return path;
}

function rev(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("updateNote — pins (MNE-62)", () => {
  test("--pinned writes pinned: true, schema-valid", () => {
    const { root, home } = store();
    const path = note(root, "keepme");
    updateNote({ root, cwd: "/anywhere", home }, { slug: "keepme", scope: "personal", ifMatch: rev(path), pinned: true });
    const { data } = parseFrontmatter(readFileSync(path, "utf8"));
    expect(data.pinned).toBe(true);
    expect(EngramSchema.safeParse(data).success).toBe(true);
  });

  test("--unpinned deletes the key (absent means not pinned), not pinned: false", () => {
    const { root, home } = store();
    const path = note(root, "keepme", ["pinned: true"]);
    updateNote({ root, cwd: "/anywhere", home }, { slug: "keepme", scope: "personal", ifMatch: rev(path), pinned: false });
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("pinned");
    expect("pinned" in parseFrontmatter(raw).data).toBe(false);
  });

  test("an unrelated update carries an existing pin through untouched", () => {
    const { root, home } = store();
    const path = note(root, "keepme", ["pinned: true"]);
    updateNote({ root, cwd: "/anywhere", home }, { slug: "keepme", scope: "personal", ifMatch: rev(path), description: "new desc" });
    const { data } = parseFrontmatter(readFileSync(path, "utf8"));
    expect(data.pinned).toBe(true);
    expect(data.description).toBe("new desc");
  });

  test("--pinned alone counts as a change (not NoChangesError)", () => {
    const { root, home } = store();
    const path = note(root, "keepme");
    expect(() => updateNote({ root, cwd: "/anywhere", home }, { slug: "keepme", scope: "personal", ifMatch: rev(path), pinned: true }))
      .not.toThrow(NoChangesError);
  });
});
