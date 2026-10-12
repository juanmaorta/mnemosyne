import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });

/** A store with the given scopes (each owned) and a `.scopemap`. */
function store(scopes: string[], scopeMap: string): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-catchall-"));
  for (const s of scopes) {
    mkdirSync(join(root, s), { recursive: true });
    writeFileSync(join(root, s, "n.md"),
      ["---", "name: n", "description: d", `scope: ${s}`, "type: reference",
        "created: 2026-06-01T10:00:00", "importance: 5", "---", "body", ""].join("\n"));
  }
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns: scopes }));
  writeFileSync(join(root, ".scopemap"), scopeMap);
  return root;
}

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const o: string[] = []; const e: string[] = [];
  return runCli(args, (s) => o.push(s), (s) => e.push(s)).then((code) => ({ code, out: o.join("\n"), err: e.join("\n") }));
}

// MNE-94: the catch-all hazard is warned PER WRITE (when a write really resolves
// through `~`), not per condition on every `context`.
describe("catch-all hazard warning — per write (MNE-94)", () => {
  test("add warns when the write resolved via the catch-all and ≥2 scopes exist", async () => {
    const root = store(["personal", "acme"], "~ = personal\n");
    // --cwd = home → only the `~` catch-all matches → resolves to personal via it.
    const r = await run(["add", "probe", "--type", "reference", "--slug", "probe", "--cwd", homedir(), "--root", root]);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/catch-all/i);
  });

  test("update warns when the write resolved via the catch-all", async () => {
    const root = store(["personal", "acme"], "~ = personal\n");
    const notePath = join(root, "personal", "n.md");
    const rev = createHash("sha256").update(readFileSync(notePath)).digest("hex");
    const r = await run(["update", "n", "--if-match", rev, "--description", "d2", "--cwd", homedir(), "--root", root]);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/catch-all/i);
  });

  test("context no longer warns about the catch-all condition (the old false positive)", async () => {
    const root = store(["personal", "acme"], "~ = personal\n");
    const r = await run(["context", "--root", root, "--scope", "personal"]);
    expect(r.code).toBe(0);
    expect(r.err).not.toMatch(/catch-all/i);
  });

  test("an explicit --scope never trips the warning (it does not resolve via the catch-all)", async () => {
    const root = store(["personal", "acme"], "~ = personal\n");
    const r = await run(["add", "probe", "--type", "reference", "--slug", "probe", "--scope", "personal", "--cwd", homedir(), "--root", root]);
    expect(r.code).toBe(0);
    expect(r.err).not.toMatch(/catch-all/i);
  });

  test("a single-scope store stays quiet even under a catch-all", async () => {
    const root = store(["personal"], "~ = personal\n");
    const r = await run(["add", "probe", "--type", "reference", "--slug", "probe", "--cwd", homedir(), "--root", root]);
    expect(r.code).toBe(0);
    expect(r.err).not.toMatch(/catch-all/i);
  });

  test("a '# catch-all: intentional' marker silences the warning", async () => {
    const root = store(["personal", "acme"], "# catch-all: intentional\n~ = personal\n");
    const r = await run(["add", "probe", "--type", "reference", "--slug", "probe", "--cwd", homedir(), "--root", root]);
    expect(r.code).toBe(0);
    expect(r.err).not.toMatch(/catch-all/i);
  });
});
