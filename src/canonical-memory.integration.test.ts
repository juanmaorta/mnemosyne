// src/canonical-memory.integration.test.ts
//
// The canonical-memory cutover rests on six claims about the STORE, not about
// any model: an import that can be re-run, history that survives it, one scope
// reachable from several working directories, a checked update, a fail-closed
// write, and a `.index` that can be thrown away without losing anything. Each
// test below is one of those claims, end to end through the real CLI.
//
// Where a scenario says ANOTHER PROCESS it really is one: the compiled
// `dist/bin/mneme.js` spawned with `execFile`, the way a second harness in
// another repo would invoke it. Two calls inside this process would prove
// nothing about two clients sharing one store. Everything else runs in-process
// for speed.
//
// Fixtures are synthetic and live in `mkdtemp` roots: no real memory store,
// `~/.claude` directory or personal note is ever read. The embedder is the fake
// one, so nothing here depends on Ollama.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { parseFrontmatter } from "./frontmatter.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Built once by the `globalSetup` in vitest.config.ts, before any test file runs.
const binary = join(repoRoot, "dist", "bin", "mneme.js");

beforeAll(() => { process.env.MNEMOSYNE_FAKE_EMBED = "1"; });

/** Every temporary directory this file made, so none of them outlives the run. */
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * Exit status of one invocation. `code` is a string when the child never ran at
 * all (`ENOENT` and friends): a spawn failure is not an exit code, and folding
 * the two together would let "the binary is missing" pass for "the CLI refused
 * the write".
 */
interface Run { code: number | string; stdout: string; stderr: string }

/** This process. Used wherever the scenario does not require a second one. */
async function cli(...args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, (s) => out.push(s), (s) => err.push(s));
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** A real second process against the same store, as another harness would run it. */
function spawned(...args: string[]): Promise<Run> {
  return execFileAsync(process.execPath, [binary, ...args], {
    env: { ...process.env, MNEMOSYNE_FAKE_EMBED: "1" },
  })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
    .catch((e: { code?: number; stdout?: string; stderr?: string }) =>
      ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
}

/**
 * A temporary store owning `owns` and mapping every directory in `map`.
 * Working directories live OUTSIDE the root, as real repos do.
 */
function makeStore(owns: string[], map: Record<string, string> = {}): string {
  const root = temp("mneme-canon-");
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns }));
  writeFileSync(join(root, ".scopemap"), `${Object.entries(map).map(([dir, scope]) => `${dir} = ${scope}`).join("\n")}\n`);
  return root;
}

function workdir(name: string): string {
  return temp(`mneme-wd-${name}-`);
}

function engram(front: string[], body: string): string {
  return ["---", ...front, "---", "", body, ""].join("\n");
}

/** Names of the synthetic native files, split the way the assertions need them. */
const SOURCE_NOTES = ["convencion-ramas.md", "politica-backups.md"];
const SOURCE_FACTS = ["feedback-editor.md", "feedback-ventana-backup.md"];

/**
 * A synthetic stand-in for a native memory directory: two notes, two facts, and
 * two files that must be ignored (the native index and a non-markdown file).
 * "kraken" is the distinctive term the retrieval scenarios search for.
 */
function nativeSource(): string {
  const dir = temp("mneme-canon-native-");
  writeFileSync(join(dir, "politica-backups.md"), engram(
    ["type: reference", "description: politica de backups del cluster kraken"],
    "Los backups del cluster kraken se cifran con restic y se verifican cada domingo.",
  ));
  writeFileSync(join(dir, "convencion-ramas.md"), engram(
    ["type: reference", "description: convencion de ramas del repositorio"],
    "Las ramas de trabajo salen de dev y se integran con squash merge.",
  ));
  writeFileSync(join(dir, "feedback-ventana-backup.md"), engram(
    ["type: feedback", "description: ventana de backup corregida por el usuario"],
    "La ventana de backup del cluster kraken es de 02:00 a 04:00, no a medianoche.",
  ));
  writeFileSync(join(dir, "feedback-editor.md"), engram(
    ["type: feedback", "description: preferencia de editor del usuario"],
    "El usuario edita los manifiestos con helix, no con nano.",
  ));
  writeFileSync(join(dir, "MEMORY.md"), engram(["type: reference", "description: indice nativo"], "no es una memoria"));
  writeFileSync(join(dir, "apuntes.txt"), "no es markdown");
  return dir;
}

/** The report's verdict for one source file: `imported`, `skipped-identical`… */
function statusOf(stdout: string, filename: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const m = /^(\S+)\s+(\S+)/.exec(line);
    if (m && m[2] === filename) return m[1];
  }
  return undefined;
}

function notesIn(root: string, scope: string): string[] {
  const dir = join(root, scope);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
}

function factsIn(root: string, scope: string): string[] {
  const dir = join(root, scope, "facts");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
}

/** Every path under `root`, so "nothing was written anywhere" is checkable. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      out.push(relative(root, path));
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out;
}

/** The frontmatter `name` of the fact whose body carries `needle`. */
function factSlugMatching(root: string, scope: string, needle: string): string {
  for (const file of factsIn(root, scope)) {
    const raw = readFileSync(join(root, scope, "facts", file), "utf8");
    if (raw.includes(needle)) return parseFrontmatter(raw).data.name as string;
  }
  throw new Error(`no fact in ${scope} contains ${needle}`);
}

interface JsonDoc { slug: string; scope: string; path: string; content: string; revision: string }

describe("canonical memory: one store, many clients", () => {
  test("importing a native memory directory twice creates the memories exactly once", async () => {
    const root = makeStore(["acme"]);
    const source = nativeSource();
    const args = ["import-claude", "--source", source, "--source-id", "repo-a", "--scope", "acme", "--apply", "--root", root];

    const first = await cli(...args);
    expect(first.code).toBe(0);

    // Notes and facts are counted apart on purpose: a fact filename is a fresh
    // ULID on every run, so only the content fingerprint stops the second
    // import from appending a duplicate of the whole history.
    for (const f of SOURCE_NOTES) expect(statusOf(first.stdout, f)).toBe("imported");
    for (const f of SOURCE_FACTS) expect(statusOf(first.stdout, f)).toBe("imported");
    expect(statusOf(first.stdout, "MEMORY.md")).toBe("ignored");
    expect(statusOf(first.stdout, "apuntes.txt")).toBe("ignored");
    const notesAfterFirst = notesIn(root, "acme");
    const factsAfterFirst = factsIn(root, "acme");
    expect(notesAfterFirst).toHaveLength(SOURCE_NOTES.length);
    expect(factsAfterFirst).toHaveLength(SOURCE_FACTS.length);

    const second = await cli(...args);

    expect(second.code).toBe(0);
    for (const f of [...SOURCE_NOTES, ...SOURCE_FACTS]) expect(statusOf(second.stdout, f)).toBe("skipped-identical");
    expect(second.stdout).toMatch(/summary: imported 0, skipped-identical 4, conflict 0, failed 0/);
    // The disk is the real assertion: same files, same names, same bytes.
    expect(notesIn(root, "acme")).toEqual(notesAfterFirst);
    expect(factsIn(root, "acme")).toEqual(factsAfterFirst);
    // The source was only ever read.
    expect(readdirSync(source).sort()).toEqual([...SOURCE_FACTS, "MEMORY.md", "apuntes.txt", ...SOURCE_NOTES].sort());
  }, 60_000);

  test("imported history is retrievable after a reindex, in the scope it was imported into", async () => {
    const root = makeStore(["acme"]);
    expect((await cli("import-claude", "--source", nativeSource(), "--source-id", "repo-a",
      "--scope", "acme", "--apply", "--root", root)).code).toBe(0);
    // The importer deliberately does not touch the index: on disk is not the
    // same as retrievable until this runs.
    expect((await cli("reindex", "--root", root)).code).toBe(0);

    const file = factsIn(root, "acme").find((f) => readFileSync(join(root, "acme", "facts", f), "utf8").includes("02:00 a 04:00"))!;
    const slug = factSlugMatching(root, "acme", "02:00 a 04:00");
    const found = await cli("search", "ventana de backup del cluster kraken", "--scope", "acme", "-k", "10", "--root", root);

    expect(found.code).toBe(0);
    expect(found.stdout).toContain(slug);
    expect(found.stdout).toContain("[acme]");

    const read = await cli("get", slug, "--scope", "acme", "--json", "--root", root);
    expect(read.code).toBe(0);
    const doc = JSON.parse(read.stdout) as JsonDoc;
    // Scope and content are the claim: the history came across whole, under the
    // scope the operator named, not under `personal`.
    expect(doc.scope).toBe("acme");
    expect(doc.path).toBe(join(root, "acme", "facts", file));
    expect(doc.content).toContain("La ventana de backup del cluster kraken es de 02:00 a 04:00, no a medianoche.");
    expect(parseFrontmatter(doc.content).data).toMatchObject({ name: slug, scope: "acme", type: "feedback" });
    expect(existsSync(join(root, "personal"))).toBe(false);
  }, 60_000);

  test("a memory written from one repo is retrieved by another process from a different repo in the same scope", async () => {
    const wdA = workdir("repo-a");
    const wdB = workdir("repo-b");
    // Two working directories, one scope: this is the whole cross-repo claim.
    const root = makeStore(["acme"], { [wdA]: "acme", [wdB]: "acme" });

    const written = await cli("add", "El despliegue de kraken exige aprobacion de dos revisores.",
      "--type", "project", "--slug", "despliegue-kraken", "--description", "regla de despliegue de kraken",
      "--cwd", wdA, "--root", root);
    expect(written.code).toBe(0);
    expect(written.stdout).toContain("[acme]");
    expect(existsSync(join(root, "acme", "despliegue-kraken.md"))).toBe(true);

    // Another process, another repo, no --scope: the scope comes from its cwd.
    const digest = await spawned("context", "--cwd", wdB, "--root", root, "--budget", "100000");
    expect(digest.code).toBe(0);
    expect(digest.stdout).toContain("scope: acme");
    expect(digest.stdout).toContain("- [despliegue-kraken]");

    const read = await spawned("get", "despliegue-kraken", "--scope", "acme", "--json", "--root", root);
    expect(read.code).toBe(0);
    const doc = JSON.parse(read.stdout) as JsonDoc;
    expect(doc.content).toContain("El despliegue de kraken exige aprobacion de dos revisores.");
    // Retrieved from the one store, not from a copy next to the second repo.
    expect(doc.path).toBe(join(root, "acme", "despliegue-kraken.md"));
    expect(readdirSync(wdB)).toEqual([]);
  }, 120_000);

  test("another process updates a note against the revision this one read, and the new version is what comes back", async () => {
    const root = makeStore(["personal"]);
    expect((await cli("add", "El backup corre a medianoche.", "--type", "project", "--scope", "personal",
      "--slug", "ventana-backup", "--description", "ventana de backup", "--root", root)).code).toBe(0);
    expect((await cli("reindex", "--root", root)).code).toBe(0);

    const before = JSON.parse((await cli("get", "ventana-backup", "--scope", "personal", "--json", "--root", root)).stdout) as JsonDoc;
    const identity = parseFrontmatter(before.content).data;

    const edit = await spawned("update", "ventana-backup", "El backup corre de 02:00 a 04:00 tras el corte de kraken.",
      "--if-match", before.revision, "--scope", "personal", "--root", root);

    expect(edit.code).toBe(0);
    expect((await cli("reindex", "--root", root)).code).toBe(0);
    const after = JSON.parse((await cli("get", "ventana-backup", "--scope", "personal", "--json", "--root", root)).stdout) as JsonDoc;
    expect(after.content).toContain("El backup corre de 02:00 a 04:00 tras el corte de kraken.");
    expect(after.content).not.toContain("El backup corre a medianoche.");
    expect(after.revision).not.toBe(before.revision);
    // An update is an edit, not a new memory: identity and path are unchanged
    // and no second note appeared claiming the same slug.
    expect(parseFrontmatter(after.content).data).toMatchObject({
      name: identity.name, scope: identity.scope, type: identity.type, created: identity.created,
    });
    expect(after.path).toBe(before.path);
    expect(notesIn(root, "personal")).toEqual(["ventana-backup.md"]);

    // Retrieval, not just the file: the reindexed store serves the new version.
    const found = await cli("search", "backup tras el corte de kraken", "--scope", "personal", "-k", "5", "--root", root);
    expect(found.stdout).toContain("ventana-backup");
    expect(found.stdout).toContain("02:00 a 04:00");
  }, 120_000);

  test("a stale revision is refused and leaves the file untouched", async () => {
    const root = makeStore(["personal"]);
    expect((await cli("add", "Version uno del procedimiento.", "--type", "project", "--scope", "personal",
      "--slug", "procedimiento", "--description", "procedimiento de guardia", "--root", root)).code).toBe(0);
    expect((await cli("reindex", "--root", root)).code).toBe(0);
    const stale = (JSON.parse((await cli("get", "procedimiento", "--scope", "personal", "--json", "--root", root)).stdout) as JsonDoc).revision;

    // Another process gets there first; our revision now describes bytes that
    // are gone.
    expect((await spawned("update", "procedimiento", "Version dos, escrita por el otro proceso.",
      "--if-match", stale, "--scope", "personal", "--root", root)).code).toBe(0);
    const winner = readFileSync(join(root, "personal", "procedimiento.md"), "utf8");

    const late = await spawned("update", "procedimiento", "Version tres, basada en lo que ya no existe.",
      "--if-match", stale, "--scope", "personal", "--root", root);

    // A refusal — exit 1, not merely "not 0", which a child that failed to spawn
    // would also satisfy — explained, and never a retry or a --force: only the
    // caller can decide how to merge its edit into the content that is there.
    expect(late.code).toBe(1);
    expect(late.stderr).toContain("conflict");
    expect(late.stderr).toContain("mneme get procedimiento --json");
    expect(late.stderr).not.toMatch(/--force/);
    expect(readFileSync(join(root, "personal", "procedimiento.md"), "utf8")).toBe(winner);
    expect(notesIn(root, "personal")).toEqual(["procedimiento.md"]);
    expect(readdirSync(join(root, "personal")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  }, 120_000);

  test("a write to a scope this machine does not own, or to no scope at all, lands nowhere", async () => {
    const unmapped = workdir("sin-mapear");
    const mapped = workdir("personal");
    // The machine owns `personal` only, and `unmapped` appears in no mapping.
    const root = makeStore(["personal"], { [mapped]: "personal" });
    const before = tree(root);

    const notOwned = await cli("add", "dato del cliente", "--type", "feedback", "--scope", "acme", "--root", root);
    expect(notOwned.code).toBe(1);
    expect(notOwned.stderr).toContain("does not own scope 'acme'");
    // A refused write must not even materialize the scope directory: the folder
    // IS the compliance boundary, and an empty one says the scope lives here.
    expect(existsSync(join(root, "acme"))).toBe(false);

    const unresolved = await cli("add", "dato sin destino", "--type", "feedback", "--cwd", unmapped, "--root", root);
    expect(unresolved.code).toBe(1);
    expect(unresolved.stderr).toMatch(/cannot resolve a scope/i);

    // Fail-closed means nothing moved anywhere — not into `personal`, which is
    // owned and would have accepted the write had anyone defaulted to it.
    expect(tree(root)).toEqual(before);
    expect(existsSync(join(root, "personal"))).toBe(false);
  }, 60_000);

  test("deleting the index loses nothing: the truth is the Markdown", async () => {
    const root = makeStore(["acme"]);
    expect((await cli("import-claude", "--source", nativeSource(), "--source-id", "repo-a",
      "--scope", "acme", "--apply", "--root", root)).code).toBe(0);
    expect((await cli("add", "El runbook de kraken vive en el repo de infraestructura.",
      "--type", "reference", "--scope", "acme", "--slug", "runbook-kraken",
      "--description", "donde vive el runbook de kraken", "--root", root)).code).toBe(0);
    expect((await cli("reindex", "--root", root)).code).toBe(0);

    const query = ["search", "kraken backup runbook", "--scope", "acme", "-k", "10", "--root", root];
    const before = await cli(...query);
    expect(before.code).toBe(0);
    const slugsBefore = before.stdout.split("\n").map((l) => l.trim().split(/\s+/)[1]).filter(Boolean);
    expect(slugsBefore).toContain("runbook-kraken");
    const contentBefore = (JSON.parse((await cli("get", "runbook-kraken", "--scope", "acme", "--json", "--root", root)).stdout) as JsonDoc).content;

    rmSync(join(root, ".index"), { recursive: true, force: true });
    expect(existsSync(join(root, ".index"))).toBe(false);

    expect((await cli("reindex", "--root", root)).code).toBe(0);

    const after = await cli(...query);
    expect(after.code).toBe(0);
    const slugsAfter = after.stdout.split("\n").map((l) => l.trim().split(/\s+/)[1]).filter(Boolean);
    // Same memories, same bytes: the index is derived state and rebuilding it
    // from scratch is always allowed.
    expect(slugsAfter.sort()).toEqual(slugsBefore.sort());
    expect((JSON.parse((await cli("get", "runbook-kraken", "--scope", "acme", "--json", "--root", root)).stdout) as JsonDoc).content).toBe(contentBefore);
  }, 60_000);
});
