import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigration } from "./migrate-run.js";
import { parseFrontmatter } from "./frontmatter.js";
import { EngramSchema } from "./schema.js";

let source: string;
let destRoot: string;

beforeEach(async () => {
  source = await mkdtemp(join(tmpdir(), "mneme-src-"));
  destRoot = await mkdtemp(join(tmpdir(), "mneme-dst-"));
});

afterEach(async () => {
  await rm(source, { recursive: true, force: true });
  await rm(destRoot, { recursive: true, force: true });
});

const note = ["---", "name: Fermentor", "description: d", "type: project", "---", "body", ""].join("\n");
const feedback = ["---", "name: Style", "description: terse", "type: feedback", "---", "keep it surgical", ""].join("\n");

describe("runMigration", () => {
  test("migrates notes and facts into the personal scope, skipping MEMORY.md", async () => {
    await writeFile(join(source, "project_fermentor.md"), note);
    await writeFile(join(source, "feedback_style.md"), feedback);
    await writeFile(join(source, "MEMORY.md"), "# index\n");

    const summary = await runMigration({ sourceDir: source, destRoot });

    expect(summary).toMatchObject({ notes: 1, facts: 1 });

    const noteOut = await readFile(join(destRoot, "personal", "fermentor.md"), "utf8");
    expect(() => EngramSchema.parse(parseFrontmatter(noteOut).data)).not.toThrow();

    const factFiles = await readdir(join(destRoot, "personal", "facts"));
    expect(factFiles).toHaveLength(1);
    expect(factFiles[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.md$/);
  });

  test("contains per-file failures without aborting the run", async () => {
    await writeFile(join(source, "project_fermentor.md"), note);
    await writeFile(join(source, "broken.md"), ["---", "description: no type", "---", "b", ""].join("\n"));

    const summary = await runMigration({ sourceDir: source, destRoot });

    expect(summary.notes).toBe(1);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.file).toBe("broken.md");
    await expect(readFile(join(destRoot, "personal", "fermentor.md"), "utf8")).resolves.toContain("fermentor");
  });

  test("reports an intra-run slug collision distinctly from data loss", async () => {
    await writeFile(join(source, "project_home_network.md"), note.replace("body", "BODY-A"));
    await writeFile(join(source, "reference_home_network.md"), note.replace("type: project", "type: reference").replace("body", "BODY-B"));

    const summary = await runMigration({ sourceDir: source, destRoot });

    expect(summary.collisions).toHaveLength(1);
    // No file was silently dropped: the collision is surfaced, not swallowed into skipped.
    expect(summary.skipped).toHaveLength(0);
  });

  test("skips dotfiles and derived INDEX.md", async () => {
    await writeFile(join(source, "project_fermentor.md"), note);
    await writeFile(join(source, ".DS_Store"), "junk");
    await writeFile(join(source, "INDEX.md"), "# derived\n");

    const summary = await runMigration({ sourceDir: source, destRoot });

    expect(summary.notes).toBe(1);
    expect(summary.failed).toHaveLength(0);
  });

  test("writes into the given scope folder", async () => {
    await writeFile(join(source, "project_fermentor.md"), note);

    const summary = await runMigration({ sourceDir: source, destRoot, scope: "work" });

    expect(summary.notes).toBe(1);
    await expect(readFile(join(destRoot, "work", "fermentor.md"), "utf8")).resolves.toContain("scope: work");
  });

  test("refuses to overwrite an existing destination note (idempotency guard)", async () => {
    await writeFile(join(source, "project_fermentor.md"), note);
    await mkdir(join(destRoot, "personal"), { recursive: true });
    await writeFile(join(destRoot, "personal", "fermentor.md"), "PRE-EXISTING\n");

    const summary = await runMigration({ sourceDir: source, destRoot });

    expect(summary.skipped).toContain("project_fermentor.md");
    expect(await readFile(join(destRoot, "personal", "fermentor.md"), "utf8")).toBe("PRE-EXISTING\n");
  });
});
