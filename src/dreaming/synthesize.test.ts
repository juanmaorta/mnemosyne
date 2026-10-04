// src/dreaming/synthesize.test.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { synthesize, isDerivedSlug, type SynthesisGroup } from "./synthesize.js";
import { buildPlan } from "./plan.js";
import type { LocalGenerator } from "./generate.js";
import { serializeFrontmatter } from "../frontmatter.js";

const NOW = "2026-10-04T03:00:00.000Z";
const MODEL_OUT = "Ventana de despliegue\nLos despliegues corren a las 3am UTC en el cluster main.";

function store(): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-synth-"));
  mkdirSync(join(root, "personal", "facts"), { recursive: true });
  return root;
}

function writeFact(root: string, scope: string, slug: string, ulid: string, body: string): void {
  const fm = { name: slug, description: `${slug} fact`, scope, created: "2026-09-02T10:00:00", importance: 5, type: "feedback" };
  mkdirSync(join(root, scope, "facts"), { recursive: true });
  writeFileSync(join(root, scope, "facts", `${ulid}.md`), serializeFrontmatter(fm, body));
}

/** A generator that returns canned text and records what it was asked. */
function fakeGen(text: string, cap?: { prompt?: string; system?: string; seed?: number }): LocalGenerator {
  return {
    id: "fake-model",
    async generate(prompt, opts) {
      if (cap) {
        cap.prompt = prompt;
        if (opts?.system !== undefined) cap.system = opts.system;
        if (opts?.seed !== undefined) cap.seed = opts.seed;
      }
      return { text, durationMs: 0, inputTokens: 1, outputTokens: 1 };
    },
  };
}

function group(over: Partial<SynthesisGroup> = {}): SynthesisGroup {
  return { sources: ["fact-a"], type: "reference", ...over };
}

describe("synthesize — bounded dry-run synthesis", () => {
  test("proposes a derived note from an explicit fact group", async () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "deploy a las 3am");

    const res = await synthesize({ root, scope: "personal", group: group(), generator: fakeGen(MODEL_OUT), now: NOW });

    expect(res.proposal).toBeDefined();
    const p = res.proposal!;
    expect(p.sources).toEqual(["fact-a"]);
    expect(p.type).toBe("reference");
    expect(p.description).toBe("Ventana de despliegue");
    expect(p.body).toContain("3am UTC");
    expect(isDerivedSlug(p.slug)).toBe(true);
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0]!.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(res.generation?.durationMs).toBe(0);
  });

  test("derived-note slug is stable across model output and clock", async () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "x");

    const a = await synthesize({ root, scope: "personal", group: group(), generator: fakeGen("Uno\ncuerpo uno"), now: NOW });
    const b = await synthesize({ root, scope: "personal", group: group(), generator: fakeGen("Dos\ncuerpo dos"), now: "2026-12-01T00:00:00.000Z" });

    expect(a.proposal!.slug).toBe(b.proposal!.slug);
  });

  test("a different source group yields a different slug", async () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "x");
    writeFact(root, "personal", "fact-b", "01J0000000000000000000000B", "y");

    const one = await synthesize({ root, scope: "personal", group: group({ sources: ["fact-a"] }), generator: fakeGen(MODEL_OUT), now: NOW });
    const two = await synthesize({ root, scope: "personal", group: group({ sources: ["fact-a", "fact-b"] }), generator: fakeGen(MODEL_OUT), now: NOW });

    expect(one.proposal!.slug).not.toBe(two.proposal!.slug);
  });

  test("prompt carries the sources as data and instructs to surface contradictions without resolving", async () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "el despliegue es a las 2am");
    writeFact(root, "personal", "fact-b", "01J0000000000000000000000B", "el despliegue es a las 3am");
    const cap: { prompt?: string; system?: string } = {};

    await synthesize({ root, scope: "personal", group: group({ sources: ["fact-a", "fact-b"] }), generator: fakeGen(MODEL_OUT, cap), now: NOW });

    expect(cap.prompt).toContain("2am");
    expect(cap.prompt).toContain("3am");
    const sys = (cap.system ?? "").toLowerCase();
    expect(sys).toContain("contradic");
    expect(sys).toContain("no resuelv");
  });

  test("the system prompt is extractive: verbatim data, no invented identifiers, concise", async () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "deploy");
    const cap: { system?: string } = {};

    await synthesize({ root, scope: "personal", group: group(), generator: fakeGen(MODEL_OUT, cap), now: NOW });

    const sys = (cap.system ?? "").toLowerCase();
    expect(sys).toContain("exacta");          // copy data verbatim
    expect(sys).toContain("no inventes");     // no fabrication
    expect(sys).toContain("identificador");   // names/IPs/numbers must not be altered
    expect(sys).toContain("concis");          // keep it short (c1/c5 were verbose)
  });

  test("maintenance reads leave sources byte-identical and write no index/reinforcement", async () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "deploy a las 3am");
    const factPath = join(root, "personal", "facts", "01J0000000000000000000000A.md");
    const before = readFileSync(factPath);

    await synthesize({ root, scope: "personal", group: group(), generator: fakeGen(MODEL_OUT), now: NOW });

    expect(readFileSync(factPath).equals(before)).toBe(true);
    expect(existsSync(join(root, ".index"))).toBe(false);
    expect(existsSync(join(root, ".telemetry", "events-2026-10-04.jsonl"))).toBe(false);
    expect(existsSync(join(root, "personal", "ventana-de-despliegue.md"))).toBe(false);
  });

  test("rejects a group citing a source missing from the scope, without calling the model", async () => {
    const root = store();
    let called = false;
    const spy: LocalGenerator = { id: "spy", async generate() { called = true; return { text: "x", durationMs: 0 }; } };

    await expect(
      synthesize({ root, scope: "personal", group: group({ sources: ["ghost"] }), generator: spy, now: NOW }),
    ).rejects.toThrow(/sources not found/i);
    expect(called).toBe(false);
  });

  test("rejects a source that exists only in another scope (no scope mixing)", async () => {
    const root = store();
    writeFact(root, "acme", "fact-a", "01J0000000000000000000000A", "otro scope");

    await expect(
      synthesize({ root, scope: "personal", group: group(), generator: fakeGen(MODEL_OUT), now: NOW }),
    ).rejects.toThrow(/sources not found/i);
  });

  test("a generated body containing a secret is rejected, not proposed", async () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "deploy");
    const withSecret = "Credenciales\nla clave es sk-ABCD1234EFGH5678IJKL y no debería salir";

    const res = await synthesize({ root, scope: "personal", group: group(), generator: fakeGen(withSecret), now: NOW });

    expect(res.proposal).toBeUndefined();
    expect(res.rejection?.reason).toMatch(/secret/i);
    expect(res.rejection?.findings?.length).toBeGreaterThan(0);
  });

  test("rejects a synthesis that asserts an identifier not grounded in its sources", async () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "el proyecto proj-orbital es gratis y MIT");
    // The model corrupts the project name — a classic MNE-80 failure.
    const corrupted = "Estado del proyecto\nEl proyecto prog-orbital sigue siendo MIT.";

    const res = await synthesize({ root, scope: "personal", group: group(), generator: fakeGen(corrupted), now: NOW });

    expect(res.proposal).toBeUndefined();
    expect(res.rejection?.reason).toMatch(/fundad|grounded|prog-orbital/i);
  });

  test("a body over the size limit is rejected as not applicable", async () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "deploy");
    const big = `Titulo\n${"a".repeat(200)}`;

    const res = await synthesize({ root, scope: "personal", group: group(), generator: fakeGen(big), now: NOW, maxNoteChars: 50 });

    expect(res.proposal).toBeUndefined();
    expect(res.rejection?.reason).toMatch(/size|limit/i);
  });

  test("accepts a single-paragraph generation (no title/body split) as a note", async () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "deploy");
    const oneParagraph = "WLED: light.wled era el segmento 0; borrarla apagó los LEDs 1-20. Fix: repuntar a light.wled_monitor_main.";

    const res = await synthesize({ root, scope: "personal", group: group(), generator: fakeGen(oneParagraph), now: NOW });

    expect(res.rejection).toBeUndefined();
    expect(res.proposal).toBeDefined();
    expect(res.proposal!.body).toContain("segmento 0");
    expect(res.proposal!.description.length).toBeGreaterThan(0);
  });

  test("an empty generation is rejected (fails the schema)", async () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "deploy");

    const res = await synthesize({ root, scope: "personal", group: group(), generator: fakeGen("   \n  "), now: NOW });

    expect(res.proposal).toBeUndefined();
    expect(res.rejection).toBeDefined();
  });

  test("rejects an empty source group before calling the model", async () => {
    const root = store();
    let called = false;
    const spy: LocalGenerator = { id: "spy", async generate() { called = true; return { text: "x", durationMs: 0 }; } };

    await expect(
      synthesize({ root, scope: "personal", group: group({ sources: [] }), generator: spy, now: NOW }),
    ).rejects.toThrow(/empty source group|at least one source/i);
    expect(called).toBe(false);
  });

  test("passes a configured seed through to the generator (reproducible re-run)", async () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "deploy");
    const cap: { seed?: number } = {};

    await synthesize({ root, scope: "personal", group: group(), generator: fakeGen(MODEL_OUT, cap), now: NOW, seed: 123 });

    expect(cap.seed).toBe(123);
  });

  test("derives the note's importance from its sources", async () => {
    const root = store();
    const fm = { name: "fact-a", description: "d", scope: "personal", created: "2026-09-02T10:00:00", importance: 8, type: "feedback" };
    writeFileSync(join(root, "personal", "facts", "01J0000000000000000000000A.md"), serializeFrontmatter(fm, "deploy"));

    const res = await synthesize({ root, scope: "personal", group: group(), generator: fakeGen(MODEL_OUT), now: NOW });

    expect(res.proposal!.importance).toBe(8);
  });

  test("proposals feed buildPlan and are evaluable in a dry-run plan", async () => {
    const root = store();
    writeFact(root, "personal", "fact-a", "01J0000000000000000000000A", "deploy a las 3am");

    const res = await synthesize({ root, scope: "personal", group: group(), generator: fakeGen(MODEL_OUT), now: NOW });
    const plan = buildPlan({ root, scope: "personal", model: { id: "fake-model" }, now: NOW, runId: "r1", proposals: [res.proposal!] });

    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]!.slug).toBe(res.proposal!.slug);
    expect(plan.budgetVerdict.within).toBe(true);
  });
});
