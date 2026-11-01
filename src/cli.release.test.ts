// src/cli.release.test.ts
//
// MNE-111 at the CLI surface: `--version`, `upgrade` from a dev checkout, and
// the new-version line in the `context` digest. The notice itself is mocked:
// its logic (cache, opt-outs, comparison) is covered in release.test.ts, and
// this suite must never reach for the network or a real install dir.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const notice = vi.hoisted(() => ({ line: null as string | null, roots: [] as string[] }));
vi.mock("./release.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./release.js")>();
  return { ...real, updateNotice: (opts: { root: string }) => { notice.roots.push(opts.root); return notice.line; } };
});

const { runCli } = await import("./cli.js");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });
beforeEach(() => { notice.line = null; notice.roots = []; });

function store(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-cli-release-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  return root;
}

async function capture(argv: string[]) {
  const out: string[] = []; const err: string[] = [];
  const code = await runCli(argv, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("mneme --version", () => {
  test("prints_the_package_version", async () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
    for (const flag of ["--version", "-V"]) {
      const r = await capture([flag]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(new RegExp(`^mneme ${pkg.version.replace(/\./g, "\\.")}( \\(.+\\))?$`));
    }
  });
});

describe("mneme upgrade", () => {
  test("from_a_dev_checkout_says_so_and_fails", async () => {
    // This checkout has no installer owner mark: it is a developer's clone.
    const r = await capture(["upgrade"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/development checkout/);
    expect(r.err).toMatch(/git pull/);
  });

  test("does_not_shadow_the_note_update_command", async () => {
    const r = await capture(["update"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/usage: mneme update <slug>/);
  });
});

describe("mneme context and the new-version notice", () => {
  test("a_newer_release_adds_exactly_one_line_after_the_digest", async () => {
    const root = store();
    notice.line = "Mnemosyne v0.2.0 is available (you have v0.1.0) — run `mneme upgrade`.";
    const r = await capture(["context", "--root", root, "--scope", "personal"]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n").filter((l) => l.includes("is available"))).toEqual([notice.line]);
    expect(r.out.trimEnd().endsWith(notice.line)).toBe(true);
    expect(notice.roots).toEqual([root]);
  });

  test("no_line_when_there_is_nothing_newer", async () => {
    const r = await capture(["context", "--root", store(), "--scope", "personal"]);
    expect(r.out).not.toMatch(/is available/);
  });

  test("the_json_envelope_carries_it_inside_the_digest", async () => {
    notice.line = "Mnemosyne v0.2.0 is available (you have v0.1.0) — run `mneme upgrade`.";
    const r = await capture(["context", "--root", store(), "--scope", "personal", "--json"]);
    expect(JSON.parse(r.out).digest).toContain(notice.line);
  });

  test("a_broken_store_still_gets_the_digest_and_the_line", async () => {
    notice.line = "Mnemosyne v0.2.0 is available (you have v0.1.0) — run `mneme upgrade`.";
    const root = store();
    writeFileSync(join(root, ".config.json"), JSON.stringify({ minCos: "nope" }));
    const r = await capture(["context", "--root", root, "--scope", "personal"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("mneme search");
    expect(r.out).toContain(notice.line);
  });
});
