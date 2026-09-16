// src/import/claude.test.ts
//
// Every fixture here is synthetic and lives in a temp dir: the importer is
// never pointed at a real `~/.claude` or `~/memory` by a test.
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseFrontmatter } from "../frontmatter.js";
import {
  fingerprintOf, importSlug, normalizeCreated, normalizeSourceFile,
} from "./plan.js";
import { ImportUsageError, importClaudeMemory, type ImportFileResult, type ImportReport } from "./claude.js";

function sourceDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mneme-native-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function store(owns: string[] = ["personal"]): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-import-"));
  writeFileSync(join(root, ".owner"), JSON.stringify({ owns }));
  return root;
}

/** A native Claude memory file: frontmatter as Claude Code writes it, plus a body. */
function native(front: string[], body: string): string {
  return ["---", ...front, "---", "", body, ""].join("\n");
}

function deps(root: string) {
  return { root, home: root };
}

function byName(report: ImportReport): Record<string, ImportFileResult> {
  return Object.fromEntries(report.files.map((f) => [f.filename, f]));
}

function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    out[name] = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  }
  return out;
}

function notesIn(root: string, scope = "personal"): string[] {
  const dir = join(root, scope);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
}

function factsIn(root: string, scope = "personal"): string[] {
  const dir = join(root, scope, "facts");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
}

/** The local-ISO format the schema wants, recomputed here so the test does not
 *  simply mirror the production formatter. */
function localIso(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function frontmatterOf(path: string): Record<string, unknown> {
  return parseFrontmatter(readFileSync(path, "utf8")).data;
}

describe("import planning (pure)", () => {
  test("import_slug_is_deterministic_namespaced_and_kebab", () => {
    // claude-<source-id>-<slugified filename without .md>-<sha256(filename)[0:12]>
    expect(importSlug("repo-a", "project_yogurtera.md")).toBe(
      "claude-repo-a-project-yogurtera-2dbc94ab80cc",
    );
    // Same filename, another logical source → a different identity.
    expect(importSlug("repo-b", "project_yogurtera.md")).toBe(
      "claude-repo-b-project-yogurtera-2dbc94ab80cc",
    );
    // The hash is over the basename INCLUDING .md.
    expect(importSlug("repo-a", "riego.md")).toBe("claude-repo-a-riego-228878a4046f");
  });

  test("fingerprint_covers_type_description_body_and_nothing_else", () => {
    const base = { type: "reference" as const, description: "riego", body: "linea uno\nlinea dos\n" };
    // CRLF and trailing-newline noise are normalized away.
    expect(fingerprintOf({ ...base, body: "linea uno\r\nlinea dos\r\n\n\n" })).toBe(fingerprintOf(base));
    expect(fingerprintOf({ ...base, description: "  riego  " })).toBe(fingerprintOf(base));
    // Inner whitespace is content.
    expect(fingerprintOf({ ...base, body: "linea  uno\nlinea dos\n" })).not.toBe(fingerprintOf(base));
    expect(fingerprintOf({ ...base, description: "otra" })).not.toBe(fingerprintOf(base));
    expect(fingerprintOf({ ...base, type: "project" })).not.toBe(fingerprintOf(base));
  });

  test("normalize_created_accepts_local_and_zoned_iso_and_falls_back", () => {
    expect(normalizeCreated("2026-01-02T03:04:05", "2020-01-01T00:00:00")).toBe("2026-01-02T03:04:05");
    expect(normalizeCreated("nonsense", "2020-01-01T00:00:00")).toBe("2020-01-01T00:00:00");
    expect(normalizeCreated(undefined, "2020-01-01T00:00:00")).toBe("2020-01-01T00:00:00");
    // A zoned stamp is converted, not copied verbatim (the schema is local-only).
    expect(normalizeCreated("2026-01-02T03:04:05Z", "2020-01-01T00:00:00")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
    );
  });

  test("normalize_reads_type_from_top_level_metadata_or_filename_prefix", () => {
    const input = { sourceId: "repo-a", fallbackCreated: "2026-01-01T00:00:00" };
    const top = normalizeSourceFile({ ...input, filename: "a.md", raw: native(["type: reference", "description: d"], "cuerpo") });
    expect(top.ok && top.candidate.type).toBe("reference");
    const nested = normalizeSourceFile({ ...input, filename: "b.md", raw: native(["metadata:", "  type: project", "description: d"], "cuerpo") });
    expect(nested.ok && nested.candidate.type).toBe("project");
    const prefixed = normalizeSourceFile({ ...input, filename: "feedback_x.md", raw: native(["description: d"], "cuerpo") });
    expect(prefixed.ok && prefixed.candidate.type).toBe("feedback");
  });

  test("normalize_rejects_unknown_or_missing_type", () => {
    const input = { sourceId: "repo-a", fallbackCreated: "2026-01-01T00:00:00" };
    const weird = normalizeSourceFile({ ...input, filename: "a.md", raw: native(["type: diary", "description: d"], "cuerpo") });
    expect(weird.ok).toBe(false);
    expect(!weird.ok && weird.reason).toBe("unknown-type");
    const none = normalizeSourceFile({ ...input, filename: "a.md", raw: native(["description: d"], "cuerpo") });
    expect(!none.ok && none.reason).toBe("unknown-type");
  });

  test("normalize_falls_back_to_first_body_line_for_description_and_warns", () => {
    const r = normalizeSourceFile({
      sourceId: "repo-a", fallbackCreated: "2026-01-01T00:00:00", filename: "a.md",
      raw: native(["type: reference"], "primera linea util\nsegunda"),
    });
    expect(r.ok && r.candidate.description).toBe("primera linea util");
    expect(r.ok && r.candidate.warnings.join(" ")).toMatch(/description/i);
  });

  test("normalize_rejects_non_empty_links_or_sources", () => {
    const input = { sourceId: "repo-a", fallbackCreated: "2026-01-01T00:00:00", filename: "a.md" };
    const linked = normalizeSourceFile({ ...input, raw: native(["type: reference", "description: d", "links:", "  - otra-nota"], "cuerpo") });
    expect(!linked.ok && linked.reason).toBe("relations-need-review");
    const sourced = normalizeSourceFile({ ...input, raw: native(["type: reference", "description: d", "sources:", "  - vieja"], "cuerpo") });
    expect(!sourced.ok && sourced.reason).toBe("relations-need-review");
    // An empty list is not a relation to migrate.
    const empty = normalizeSourceFile({ ...input, raw: native(["type: reference", "description: d", "links: []"], "cuerpo") });
    expect(empty.ok).toBe(true);
  });

  test("normalize_warns_about_wikilinks_and_native_file_references", () => {
    const r = normalizeSourceFile({
      sourceId: "repo-a", fallbackCreated: "2026-01-01T00:00:00", filename: "a.md",
      raw: native(["type: reference", "description: d"], "ver [[otra_nota]] y ~/.claude/projects/x/memory/MEMORY.md"),
    });
    expect(r.ok).toBe(true);
    const warnings = (r.ok ? r.candidate.warnings : []).join(" ");
    expect(warnings).toMatch(/wikilink/i);
    expect(warnings).toMatch(/manual/i);
    // A warning names the problem, never the content.
    expect(warnings).not.toContain("otra_nota");
  });
});

describe("importClaudeMemory", () => {
  const NOTE = native(["type: reference", "description: como regar"], "regar cada dos dias");
  const FACT = native(["type: feedback", "description: prefiere terse"], "el usuario prefiere respuestas cortas");

  test("import_requires_a_kebab_source_id_and_an_existing_directory", () => {
    const root = store();
    const src = sourceDir({ "a.md": NOTE });
    expect(() => importClaudeMemory(deps(root), { source: src, sourceId: "Repo A", scope: "personal", apply: false }))
      .toThrow(ImportUsageError);
    expect(() => importClaudeMemory(deps(root), { source: join(src, "nope"), sourceId: "repo-a", scope: "personal", apply: false }))
      .toThrow(ImportUsageError);
    expect(() => importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "", apply: false }))
      .toThrow(ImportUsageError);
  });

  test("dry_run_plans_without_touching_the_store", () => {
    const root = store();
    const src = sourceDir({ "riego.md": NOTE, "feedback_terse.md": FACT });

    const report = importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: false });

    expect(report.counts.importable).toBe(2);
    expect(report.counts.imported).toBe(0);
    expect(report.files.every((f) => f.status === "importable")).toBe(true);
    // Not even the scope directory, the lock or the telemetry dir appear.
    expect(existsSync(join(root, "personal"))).toBe(false);
    expect(existsSync(join(root, ".telemetry"))).toBe(false);
    expect(existsSync(join(root, ".index"))).toBe(false);
  });

  test("apply_imports_notes_as_slugs_and_feedback_as_ulid_facts", () => {
    const root = store();
    const src = sourceDir({ "riego.md": NOTE, "feedback_terse.md": FACT });

    const report = importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: true });

    expect(report.counts.imported).toBe(2);
    expect(notesIn(root)).toEqual(["claude-repo-a-riego-228878a4046f.md"]);
    const facts = factsIn(root);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.md$/);
    // The fact keeps the ULID filename but carries the deterministic slug.
    const fact = parseFrontmatter(readFileSync(join(root, "personal", "facts", facts[0]!), "utf8"));
    expect(fact.data.name).toBe(importSlug("repo-a", "feedback_terse.md"));
    expect(fact.data.type).toBe("feedback");
    expect(fact.data.scope).toBe("personal");
    // Native-only fields never reach the canonical schema.
    expect(fact.data).not.toHaveProperty("metadata");
    expect(fact.data).not.toHaveProperty("modified");
    // The body is preserved verbatim.
    expect(fact.body).toContain("el usuario prefiere respuestas cortas");
    // No lock survives.
    expect(existsSync(join(root, "personal", ".mneme-write.lock"))).toBe(false);
  });

  test("second_run_writes_nothing_new_for_notes_and_for_feedback", () => {
    const root = store();
    const src = sourceDir({ "riego.md": NOTE, "feedback_terse.md": FACT });
    const opts = { source: src, sourceId: "repo-a", scope: "personal", apply: true };

    importClaudeMemory(deps(root), opts);
    const notesAfterFirst = notesIn(root);
    const factsAfterFirst = factsIn(root);

    const second = importClaudeMemory(deps(root), opts);

    expect(second.counts.imported).toBe(0);
    expect(second.counts["skipped-identical"]).toBe(2);
    expect(notesIn(root)).toEqual(notesAfterFirst);
    expect(factsIn(root)).toEqual(factsAfterFirst); // facts dedupe by fingerprint, not filename
    for (const f of second.files) expect(f.existing?.length).toBeGreaterThan(0);
  });

  test("dedupes_against_an_existing_note_with_a_different_slug", () => {
    // Models Fase 0 output: the same content already in the store under the old
    // migration's slug. The importer must not create a second copy.
    const root = store();
    mkdirSync(join(root, "personal"), { recursive: true });
    writeFileSync(join(root, "personal", "riego.md"), [
      "---", "name: riego", "description: como regar", "scope: personal", "type: reference",
      "created: 2026-01-01T10:00:00", "importance: 5", "---", "", "regar cada dos dias", "",
    ].join("\n"));
    const src = sourceDir({ "riego.md": NOTE });

    const report = importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: true });

    expect(report.counts["skipped-identical"]).toBe(1);
    expect(report.files[0]!.existing).toEqual([join(root, "personal", "riego.md")]);
    expect(notesIn(root)).toEqual(["riego.md"]);
  });

  test("same_filename_under_two_source_ids_creates_two_notes", () => {
    const root = store();
    const a = sourceDir({ "riego.md": NOTE });
    const b = sourceDir({ "riego.md": native(["type: reference", "description: otra cosa"], "otro cuerpo") });

    importClaudeMemory(deps(root), { source: a, sourceId: "repo-a", scope: "personal", apply: true });
    importClaudeMemory(deps(root), { source: b, sourceId: "repo-b", scope: "personal", apply: true });

    expect(notesIn(root)).toEqual([
      "claude-repo-a-riego-228878a4046f.md",
      "claude-repo-b-riego-228878a4046f.md",
    ]);
  });

  test("a_source_edited_between_runs_is_a_conflict_and_never_overwrites", () => {
    const root = store();
    const src = sourceDir({ "riego.md": NOTE });
    const opts = { source: src, sourceId: "repo-a", scope: "personal", apply: true };
    importClaudeMemory(deps(root), opts);
    const dest = join(root, "personal", "claude-repo-a-riego-228878a4046f.md");
    const before = readFileSync(dest, "utf8");

    writeFileSync(join(src, "riego.md"), native(["type: reference", "description: como regar"], "regar cada TRES dias"));
    const second = importClaudeMemory(deps(root), opts);

    expect(second.counts.conflict).toBe(1);
    expect(second.files[0]!.status).toBe("conflict");
    expect(second.files[0]!.existing).toEqual([dest]);
    expect(readFileSync(dest, "utf8")).toBe(before);
    expect(notesIn(root)).toHaveLength(1);
  });

  test("intra_batch_duplicates_are_deduped_against_each_other", () => {
    const root = store();
    // Two different filenames (so two different slugs) with identical content.
    const src = sourceDir({ "a-riego.md": NOTE, "b-riego.md": NOTE });

    const report = importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: true });

    expect(report.counts.imported).toBe(1);
    expect(report.counts["skipped-identical"]).toBe(1);
    expect(notesIn(root)).toHaveLength(1);
  });

  test("dry_run_also_dedupes_within_the_batch_and_needs_no_scope_dir", () => {
    const root = store();
    const src = sourceDir({ "a-riego.md": NOTE, "b-riego.md": NOTE });

    const report = importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: false });

    expect(report.counts.importable).toBe(1);
    expect(report.counts["skipped-identical"]).toBe(1);
    expect(existsSync(join(root, "personal"))).toBe(false);
  });

  test("a_scope_this_machine_does_not_own_fails_every_candidate_in_both_modes", () => {
    const root = store(["personal"]);
    const src = sourceDir({ "riego.md": NOTE });

    for (const apply of [false, true]) {
      const report = importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "acme", apply });
      expect(report.counts.failed).toBe(1);
      expect(report.files[0]!.reason).toBe("not-owner");
      expect(existsSync(join(root, "acme"))).toBe(false);
    }
  });

  test("secrets_in_body_or_description_fail_the_file_without_echoing_them", () => {
    const root = store();
    const src = sourceDir({
      "body.md": native(["type: reference", "description: claves"], "el token es sk-abcdefghij0123456789"),
      "desc.md": native(["type: reference", "description: token sk-abcdefghij0123456789"], "cuerpo"),
    });

    for (const apply of [false, true]) {
      const report = importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply });
      expect(report.counts.failed).toBe(2);
      for (const f of report.files) expect(f.reason).toBe("secret-detected");
      expect(JSON.stringify(report)).not.toContain("sk-abcdefghij0123456789");
    }
    expect(notesIn(root)).toEqual([]);
    // Nothing was importable, so the scope was never materialized either.
    expect(existsSync(join(root, "personal"))).toBe(false);
  });

  test("a_bad_file_does_not_abort_the_batch_and_the_rerun_is_clean", () => {
    const root = store();
    const src = sourceDir({
      "a-good.md": NOTE,
      "b-bad.md": native(["type: diary", "description: d"], "cuerpo"),
      "c-good.md": FACT,
    });
    const opts = { source: src, sourceId: "repo-a", scope: "personal", apply: true };

    const first = importClaudeMemory(deps(root), opts);
    expect(first.counts.imported).toBe(2);
    expect(first.counts.failed).toBe(1);
    const notes = notesIn(root);
    const facts = factsIn(root);

    const second = importClaudeMemory(deps(root), opts);
    expect(second.counts.imported).toBe(0);
    expect(second.counts["skipped-identical"]).toBe(2);
    expect(second.counts.failed).toBe(1); // the bad file is still reported
    expect(notesIn(root)).toEqual(notes);
    expect(factsIn(root)).toEqual(facts);
  });

  test("ignores_index_files_dotfiles_symlinks_and_non_markdown", () => {
    const root = store();
    const src = sourceDir({
      "riego.md": NOTE,
      "MEMORY.md": native(["type: reference", "description: indice"], "indice"),
      "INDEX.md": native(["type: reference", "description: indice"], "indice"),
      ".hidden.md": NOTE,
      "notes.txt": "texto",
    });
    symlinkSync(join(src, "riego.md"), join(src, "link.md"));

    const report = importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: true });

    const results = byName(report);
    for (const name of ["MEMORY.md", "INDEX.md", ".hidden.md", "notes.txt", "link.md"]) {
      expect(results[name]!.status).toBe("ignored");
    }
    expect(report.counts.imported).toBe(1);
    expect(notesIn(root)).toEqual(["claude-repo-a-riego-228878a4046f.md"]);
    // Stable order: by filename.
    expect(report.files.map((f) => f.filename)).toEqual([...report.files.map((f) => f.filename)].sort());
  });

  test("an_unparseable_document_already_in_the_scope_is_reported_not_fatal", () => {
    const root = store();
    mkdirSync(join(root, "personal"), { recursive: true });
    writeFileSync(join(root, "personal", "roto.md"), "no frontmatter at all\n");
    const src = sourceDir({ "riego.md": NOTE });

    const report = importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: true });

    expect(report.inventoryErrors).toEqual([join(root, "personal", "roto.md")]);
    expect(report.counts.imported).toBe(1);
  });

  test("an_unreadable_file_at_the_destination_is_a_conflict_never_an_overwrite", () => {
    // Skipped by the inventory (it parses as nothing), so the decision says
    // "create" — and `O_EXCL` is what actually protects it.
    const root = store();
    mkdirSync(join(root, "personal"), { recursive: true });
    const dest = join(root, "personal", "claude-repo-a-riego-228878a4046f.md");
    writeFileSync(dest, "contenido ajeno sin frontmatter\n");
    const src = sourceDir({ "riego.md": NOTE });

    const report = importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: true });

    expect(report.counts.conflict).toBe(1);
    expect(report.files[0]!.existing).toEqual([dest]);
    expect(readFileSync(dest, "utf8")).toBe("contenido ajeno sin frontmatter\n");
  });

  test("a_document_claiming_the_slug_that_the_inventory_cannot_read_is_a_conflict", () => {
    // The inventory answers "is this slug taken?" first, but it can only see
    // documents it can read. This one it cannot (no `description`), so the
    // decision says "create" and the write path's slug check is what stops it —
    // as a reported conflict for a human, never a crash and never a second
    // document under one identity.
    const root = store();
    mkdirSync(join(root, "personal", "facts"), { recursive: true });
    const squatter = join(root, "personal", "facts", "01M2AYKFMRE6P89J1B7FEKQVH4.md");
    writeFileSync(squatter, native(
      ["name: claude-repo-a-riego-228878a4046f", "type: feedback", "scope: personal"],
      "un hecho sin description",
    ));
    const src = sourceDir({ "riego.md": NOTE });

    const report = importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: true });

    expect(report.inventoryErrors).toEqual([squatter]);
    expect(report.counts.conflict).toBe(1);
    expect(report.counts.imported).toBe(0);
    expect(report.files[0]!.existing).toEqual([squatter]);
    expect(report.files[0]!.reason).toBe("slug already claimed");
    expect(notesIn(root)).toEqual([]);
    expect(factsIn(root)).toEqual(["01M2AYKFMRE6P89J1B7FEKQVH4.md"]);
  });

  test("importance_is_kept_when_valid_and_defaulted_to_5_otherwise", () => {
    const root = store();
    const src = sourceDir({
      "alta.md": native(["type: reference", "description: alta", "importance: 8"], "cuerpo alto"),
      "fuera.md": native(["type: reference", "description: fuera", "importance: 99"], "cuerpo fuera"),
      "sin.md": native(["type: reference", "description: sin"], "cuerpo sin"),
    });

    importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: true });

    const at = (f: string): Record<string, unknown> =>
      frontmatterOf(join(root, "personal", `${importSlug("repo-a", f)}.md`));
    expect(at("alta.md").importance).toBe(8);
    expect(at("fuera.md").importance).toBe(5); // out of the 1..10 range → default
    expect(at("sin.md").importance).toBe(5);
  });

  test("created_falls_back_to_the_source_file_times_when_absent", () => {
    const root = store();
    const src = sourceDir({ "riego.md": NOTE, "fechada.md": native(["type: reference", "description: fechada", "created: 2019-03-04T05:06:07"], "cuerpo fechado") });
    const info = statSync(join(src, "riego.md"));
    const expected = localIso(info.birthtime.getTime() ? info.birthtime : info.mtime);

    importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: true });

    expect(frontmatterOf(join(root, "personal", `${importSlug("repo-a", "riego.md")}.md`)).created).toBe(expected);
    // A usable source stamp still wins over the file times.
    expect(frontmatterOf(join(root, "personal", `${importSlug("repo-a", "fechada.md")}.md`)).created)
      .toBe("2019-03-04T05:06:07");
  });

  test("a_crlf_source_round_trips_as_lf_and_dedupes_on_the_second_run", () => {
    const root = store();
    const src = sourceDir({
      "crlf.md": ["---", "type: reference", "description: con crlf", "---", "", "linea uno", "linea dos", ""].join("\r\n"),
    });
    const opts = { source: src, sourceId: "repo-a", scope: "personal", apply: true };

    const first = importClaudeMemory(deps(root), opts);
    expect(first.counts.imported).toBe(1);
    const dest = join(root, "personal", `${importSlug("repo-a", "crlf.md")}.md`);
    const written = readFileSync(dest, "utf8");
    expect(written).not.toContain("\r");
    expect(written).toContain("linea uno\nlinea dos\n");

    // The fingerprint of what we wrote must match the fingerprint of the source
    // we normalized, or every run would re-import the same file forever.
    const second = importClaudeMemory(deps(root), opts);
    expect(second.counts["skipped-identical"]).toBe(1);
    expect(second.files[0]!.existing).toEqual([dest]);
  });

  test("apply_does_not_materialize_a_scope_when_nothing_is_importable", () => {
    const root = store();
    const src = sourceDir({
      "bad.md": native(["type: diary", "description: d"], "cuerpo"),
      "MEMORY.md": "indice\n",
    });

    const report = importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: true });

    expect(report.counts.failed).toBe(1);
    // An empty owned scope would show up in `listScopes` as a real one.
    expect(existsSync(join(root, "personal"))).toBe(false);

    // Same for a source with nothing in it at all.
    const emptyReport = importClaudeMemory(deps(root), { source: sourceDir({}), sourceId: "repo-a", scope: "personal", apply: true });
    expect(emptyReport.files).toEqual([]);
    expect(existsSync(join(root, "personal"))).toBe(false);
  });

  test("originals_are_never_modified_or_deleted", () => {
    const root = store();
    const src = sourceDir({
      "riego.md": NOTE,
      "feedback_terse.md": FACT,
      "bad.md": native(["type: diary", "description: d"], "cuerpo"),
      "MEMORY.md": "indice\n",
    });
    const before = snapshotDir(src);

    importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: true });
    importClaudeMemory(deps(root), { source: src, sourceId: "repo-a", scope: "personal", apply: true });

    expect(snapshotDir(src)).toEqual(before);
  });
});

describe("a note already migrated under its own slug (MNE-60)", () => {
  // Fase 0 migrated these files into the store under their bare slug, and they
  // have been edited since. The importer deduplicates by content fingerprint
  // only, and its destination slug carries a source prefix and a hash, so it
  // can never collide with the migrated copy. Measured on the real store: what
  // the dry run called `conflict 0, importable 13` was in fact 13 pending
  // duplicates, each one OLDER than what the store already held.
  const NATIVE = native(["type: project", "description: el HGU pierde el bridge"], "version corta de julio");

  /** The same engram as the store holds it: bare slug, richer body. */
  function migrated(slug: string): string {
    return [
      "---", `name: ${slug}`, "description: el HGU pierde el bridge", "scope: personal",
      "type: project", "created: 2026-07-01T10:00:00", "importance: 5", "---",
      "version larga, ampliada despues de migrar", "",
    ].join("\n");
  }

  function storeWithMigrated(slug: string): string {
    const root = store();
    mkdirSync(join(root, "personal"), { recursive: true });
    writeFileSync(join(root, "personal", `${slug}.md`), migrated(slug));
    return root;
  }

  test("is reported as a conflict, not as importable", () => {
    const root = storeWithMigrated("modem-bridge-reboot");
    const src = sourceDir({ "modem-bridge-reboot.md": NATIVE });

    const report = importClaudeMemory(deps(root), { source: src, sourceId: "home", scope: "personal", apply: false });

    const r = byName(report)["modem-bridge-reboot.md"]!;
    expect(r.status).toBe("conflict");
    expect(r.existing).toEqual([join(root, "personal", "modem-bridge-reboot.md")]);
    expect(report.counts.conflict).toBe(1);
    expect(report.counts.importable).toBe(0);
  });

  test("--apply creates nothing for it and leaves the store untouched", () => {
    const root = storeWithMigrated("modem-bridge-reboot");
    const src = sourceDir({ "modem-bridge-reboot.md": NATIVE });
    const before = snapshotDir(join(root, "personal"));

    importClaudeMemory(deps(root), { source: src, sourceId: "home", scope: "personal", apply: true });

    expect(snapshotDir(join(root, "personal"))).toEqual(before);
    expect(notesIn(root)).toEqual(["modem-bridge-reboot.md"]);
  });

  test("a genuinely new note still imports alongside the conflicting one", () => {
    // The fix must not turn the importer into a no-op: only the colliding
    // identity is held back.
    const root = storeWithMigrated("modem-bridge-reboot");
    const src = sourceDir({
      "modem-bridge-reboot.md": NATIVE,
      "nota-nueva.md": native(["type: reference", "description: algo nuevo"], "nunca migrado"),
    });

    const report = importClaudeMemory(deps(root), { source: src, sourceId: "home", scope: "personal", apply: true });

    expect(report.counts.conflict).toBe(1);
    expect(report.counts.imported).toBe(1);
    expect(notesIn(root)).toContain("modem-bridge-reboot.md");
    expect(notesIn(root).some((n) => n.startsWith("claude-home-nota-nueva-"))).toBe(true);
  });

  test("identical content still wins over the slug check", () => {
    // Byte-identical to what the store holds is a skip, not a conflict: the
    // slug rule must not shadow the cheaper, stronger signal.
    const root = store();
    mkdirSync(join(root, "personal"), { recursive: true });
    const body = "mismo cuerpo exacto";
    writeFileSync(join(root, "personal", "misma.md"), [
      // The blank line after the fences matters: `native()` has one, and the
      // fingerprint covers the body verbatim. Without it these two differ.
      "---", "name: misma", "description: d", "scope: personal", "type: reference",
      "created: 2026-07-01T10:00:00", "importance: 5", "---", "", body, "",
    ].join("\n"));
    const src = sourceDir({ "misma.md": native(["type: reference", "description: d"], body) });

    const report = importClaudeMemory(deps(root), { source: src, sourceId: "home", scope: "personal", apply: false });

    expect(byName(report)["misma.md"]!.status).toBe("skipped-identical");
    expect(report.counts.conflict).toBe(0);
  });
});
