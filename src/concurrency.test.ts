// src/concurrency.test.ts
//
// Two harnesses (Claude Code + OpenCode, say) each invoke the `mneme` binary as
// a short-lived process against ONE store. The markdown layer is safe by
// construction — notes are created with O_EXCL, facts are ULID-named, nothing is
// mutated in place — but the SQLite index has exactly one writer lock, so these
// tests exercise the only layer that can actually lose data under concurrency.
//
// They must run as real child processes: better-sqlite3 is synchronous, so two
// connections inside one process cannot contend the way two processes do (the
// holder can never release while the waiter blocks).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Built once by the vitest globalSetup (`src/test-support/ensure-dist.ts`),
// before any test file runs: a per-file guard here would race the other suites
// that spawn this same binary.
const cli = join(repoRoot, "dist", "bin", "mneme.js");

const ENGRAMS = 40;

/** A store of `ENGRAMS` notes and a COLD index — every process races to index all of them. */
function coldStore(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-conc-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  for (let i = 0; i < ENGRAMS; i++) {
    const slug = `nota-${String(i).padStart(2, "0")}`;
    writeFileSync(join(root, "personal", `${slug}.md`),
      ["---", `name: ${slug}`, `description: ${slug} sobre riego y plantas`, "scope: personal",
        "type: reference", "created: 2026-06-01T10:00:00", "importance: 5", "---",
        `cuerpo de ${slug} con texto suficiente para embeber`, ""].join("\n"));
  }
  return root;
}

/** An empty, owned store — the writers create everything themselves. */
function writableStore(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-conc-add-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns: ["personal"] }));
  return root;
}

/**
 * Run K commands at once, as the two harnesses would. `args` is either the one
 * command every process runs, or a function of the process index for the cases
 * where each writer must carry its own identity.
 */
function race(k: number, args: string[] | ((i: number) => string[]), env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }[]> {
  const argsFor = typeof args === "function" ? args : (): string[] => args;
  return Promise.all(Array.from({ length: k }, (_, i) =>
    execFileAsync(process.execPath, [cli, ...argsFor(i)], {
      env: { ...process.env, MNEMOSYNE_FAKE_EMBED: "1", ...env },
    })));
}

interface Run { code: number; stdout: string; stderr: string }

function run(args: string[]): Promise<Run> {
  return execFileAsync(process.execPath, [cli, ...args], { env: { ...process.env, MNEMOSYNE_FAKE_EMBED: "1" } })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
    .catch((e: { code?: number; stdout?: string; stderr?: string }) =>
      ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
}

/** Launch commands simultaneously and keep the losers instead of rejecting. */
function raceSettled(argv: string[][]): Promise<Run[]> {
  return Promise.all(argv.map(run));
}

describe("concurrent harnesses on one store", () => {
  test("concurrent_reindex_indexes_every_engram_without_swallowed_errors", async () => {
    const root = coldStore();

    const runs = await race(8, ["reindex", "--root", root]);

    // reindex counts a failed upsert and carries on, so a lock storm surfaces
    // here and nowhere else: exit 0, empty stderr, and a store that never got
    // indexed. No run may report an error, and the store must end up complete.
    for (const { stdout } of runs) expect(stdout).toMatch(/errors 0$/m);
    const { stdout: after } = await execFileAsync(process.execPath, [cli, "search", "riego plantas", "--root", root, "-k", String(ENGRAMS)],
      { env: { ...process.env, MNEMOSYNE_FAKE_EMBED: "1" } });
    // Deduped: a hit prints both the slug and a description containing it.
    expect(new Set(after.match(/nota-\d\d/g)).size).toBe(ENGRAMS);
  }, 120_000);

  test("concurrent_context_never_serves_a_truncated_digest", async () => {
    const root = coldStore();

    // --budget and the entry cap are both set far above the store so truncation
    // can only come from lock loss, never from a limit legitimately cutting the
    // tail (the token budget, or the MNE-29 selectivity cap on line count).
    const runs = await race(8, ["context", "--root", root, "--budget", "100000"], { MNEMOSYNE_CONTEXT_MAX_ENTRIES: "100000" });

    // The SessionStart path swallows every failure to avoid breaking session
    // start, so a losing process serves a SHORT OR EMPTY digest with exit 0 —
    // the session simply begins with no memory and nobody is told.
    for (const { stdout } of runs) {
      expect(stdout).not.toMatch(/no memory in this scope yet/);
      expect(stdout.match(/^- \[nota-\d\d\]/gm)?.length ?? 0).toBe(ENGRAMS);
    }
  }, 120_000);

  test("concurrent_add_feedback_writes_every_fact_and_leaves_no_lock", async () => {
    const root = writableStore();
    const writers = 8;

    // Each writer records its OWN observation, with its own slug — which is what
    // the instruction block tells agents to do, and the only shape that is
    // retrievable afterwards: (scope, slug) is unique, so eight facts sharing
    // one slug would be eight files and one indexable memory. What is under test
    // here is the lock, not the slug rule (see `cli.add.test.ts` for that).
    const runs = await race(writers, (i) => [
      "add", `riego automatico a las ${7 + i}`, "--type", "feedback", "--scope", "personal",
      "--description", `riego ${i}`, "--slug", `riego-${i}`, "--root", root,
    ]);

    for (const { stdout } of runs) expect(stdout).toMatch(/wrote fact \[personal\]/);
    const facts = readdirSync(join(root, "personal", "facts"));
    expect(new Set(facts).size).toBe(writers);
    // Eight distinct memories, none of them shadowing another.
    const slugs = facts.map((f) => parseFrontmatter(readFileSync(join(root, "personal", "facts", f), "utf8")).data.name);
    expect(new Set(slugs).size).toBe(writers);
    // Every writer released what it took.
    expect(existsSync(join(root, "personal", ".mneme-write.lock"))).toBe(false);
  }, 120_000);

  test("concurrent_import_claude_imports_every_file_exactly_once", async () => {
    const root = writableStore();
    const source = mkdtempSync(join(tmpdir(), "mneme-conc-native-"));
    const NOTES = 6;
    const FACTS = 4;
    for (let i = 0; i < NOTES; i++) {
      writeFileSync(join(source, `nota-${i}.md`),
        ["---", "type: reference", `description: nota ${i} sobre riego`, "---", "", `cuerpo de la nota ${i}`, ""].join("\n"));
    }
    for (let i = 0; i < FACTS; i++) {
      writeFileSync(join(source, `feedback_${i}.md`),
        ["---", "type: feedback", `description: hecho ${i}`, "---", "", `observacion numero ${i}`, ""].join("\n"));
    }

    // Two harnesses import the same directory at once. Facts are the dangerous
    // half: their filenames are fresh ULIDs every run, so only the content
    // fingerprint — computed under the lock — keeps the second process from
    // appending a duplicate of everything.
    const args = ["import-claude", "--source", source, "--source-id", "repo-a", "--scope", "personal", "--apply", "--root", root];
    const runs = await raceSettled([args, args]);

    for (const r of runs) expect(r.code).toBe(0);
    const imported = runs.reduce((n, r) => n + (r.stdout.match(/^imported\s+\S+\.md/gm)?.length ?? 0), 0);
    const skipped = runs.reduce((n, r) => n + (r.stdout.match(/^skipped-identical\s+\S+\.md/gm)?.length ?? 0), 0);
    expect(imported).toBe(NOTES + FACTS);
    expect(skipped).toBe(NOTES + FACTS);

    const notes = readdirSync(join(root, "personal")).filter((f) => f.endsWith(".md"));
    expect(notes).toHaveLength(NOTES);
    expect(new Set(notes).size).toBe(NOTES);
    const facts = readdirSync(join(root, "personal", "facts")).filter((f) => f.endsWith(".md"));
    expect(facts).toHaveLength(FACTS);
    // Every fact is a distinct memory, not the same one appended twice.
    const bodies = facts.map((f) => parseFrontmatter(readFileSync(join(root, "personal", "facts", f), "utf8")).data.name);
    expect(new Set(bodies).size).toBe(FACTS);
    // Nothing left behind, and the originals are untouched.
    const left = readdirSync(join(root, "personal"));
    expect(left.filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(existsSync(join(root, "personal", ".mneme-write.lock"))).toBe(false);
    expect(readdirSync(source)).toHaveLength(NOTES + FACTS);
  }, 120_000);

  test("concurrent_update_from_one_revision_lets_exactly_one_writer_win", async () => {
    const root = writableStore();
    const path = join(root, "personal", "fermentor.md");

    expect((await run(["add", "cuerpo original", "--type", "reference", "--scope", "personal",
      "--description", "como hacer yogur", "--slug", "fermentor", "--root", root])).code).toBe(0);
    expect((await run(["reindex", "--root", root])).code).toBe(0);
    const read = await run(["get", "fermentor", "--json", "--root", root]);
    expect(read.code).toBe(0);
    const revision = (JSON.parse(read.stdout) as { revision: string }).revision;

    // Both harnesses read the same note and now write back a different edit.
    // Last-write-wins would silently destroy one of them; this is the whole
    // reason `update` is a compare-and-swap and not a write.
    const runs = await raceSettled([
      ["update", "fermentor", "version A", "--if-match", revision, "--scope", "personal", "--root", root],
      ["update", "fermentor", "version B", "--if-match", revision, "--scope", "personal", "--root", root],
    ]);

    expect(runs.filter((r) => r.code === 0)).toHaveLength(1);
    const loser = runs.find((r) => r.code !== 0)!;
    expect(loser.stderr).toContain("mneme get fermentor --json");
    expect(loser.stderr).not.toMatch(/--force/);

    const text = readFileSync(path, "utf8");
    const doc = parseFrontmatter(text);
    expect(doc.data).toMatchObject({ name: "fermentor", scope: "personal", type: "reference" });
    // Exactly one of the two edits survives — never a splice of both.
    expect(text.includes("version A")).toBe(!text.includes("version B"));
    expect(text).not.toContain("cuerpo original");
    // No temporary and no lock survived the race, and no second note appeared.
    const left = readdirSync(join(root, "personal"));
    expect(left.filter((f) => f.endsWith(".md"))).toEqual(["fermentor.md"]);
    expect(left.filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(existsSync(join(root, "personal", ".mneme-write.lock"))).toBe(false);
  }, 120_000);
});
