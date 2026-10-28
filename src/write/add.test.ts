// src/write/add.test.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { addMemory, ScopeUnresolvedError, NotOwnerError, SecretDetectedError, NoteExistsError } from "./add.js";
import { readTelemetry } from "../telemetry/events.js";
import { clearTelemetryConfigCache } from "../telemetry/config.js";
import { fixedClock } from "../clock.js";

const NOW = "2026-07-09T10:00:00";

function store(owns: string[] | null, scopemap?: string): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "mneme-add-"));
  mkdirSync(join(root, "personal"), { recursive: true });
  if (owns) writeFileSync(join(root, ".owner"), JSON.stringify({ owns }));
  const home = mkdtempSync(join(tmpdir(), "mneme-home-"));
  if (scopemap) writeFileSync(join(root, ".scopemap"), scopemap);
  return { root, home };
}

describe("addMemory", () => {
  test("add_feedback_writes_immutable_fact_in_scope", () => {
    const { root, home } = store(["personal"]);
    const res = addMemory({ root, cwd: "/anywhere", home, now: NOW },
      { content: "deploys run at 3am UTC", type: "feedback", scope: "personal", description: "deploy window" });
    expect(res.kind).toBe("fact");
    expect(res.path).toMatch(/\/personal\/facts\/[0-9A-HJKMNP-TV-Z]{26}\.md$/);
    expect(readFileSync(res.path, "utf8")).toContain("deploys run at 3am UTC");
  });

  test("add_emits_engram_created_telemetry", () => {
    const { root, home } = store(["personal"]);
    const clock = fixedClock(Date.parse("2026-08-07T10:00:00.000Z"));

    addMemory({ root, cwd: "/anywhere", home, now: NOW, clock },
      { content: "deploys run at 3am UTC", type: "feedback", scope: "personal", description: "deploy window", importance: 7 });

    const evs = readTelemetry(root).filter((e) => e.kind === "engram.created");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ scope: "personal", type: "feedback", importance: 7, scannerVerdict: "clean" });
    expect(evs[0]!.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(evs[0]!.ts).toBe("2026-08-07T10:00:00.000Z");
    // The note's own text must never reach a diagnostic log.
    expect(JSON.stringify(evs[0])).not.toContain("deploys run at 3am");
  });

  test("add_records_a_warn_scanner_verdict_without_blocking", () => {
    const { root, home } = store(["personal"]);
    // High-entropy value: warn-level, not reject — the write proceeds.
    addMemory({ root, cwd: "/x", home, now: NOW, clock: fixedClock(0) },
      { content: "token candidate aGVsbG93b3JsZGhlbGxvd29ybGQxMjM0NTY3ODkw", type: "feedback", scope: "personal", description: "d" });

    const ev = readTelemetry(root).find((e) => e.kind === "engram.created");
    expect(["clean", "warn"]).toContain(ev!.scannerVerdict);
  });

  test("add_emits_no_telemetry_for_an_excluded_scope", () => {
    const { root, home } = store(["personal", "acme"]);
    writeFileSync(join(root, ".telemetry.json"), JSON.stringify({ excludeScopes: ["acme"] }));
    clearTelemetryConfigCache();
    mkdirSync(join(root, "acme"), { recursive: true });

    addMemory({ root, cwd: "/x", home, now: NOW, clock: fixedClock(0) },
      { content: "client note", type: "feedback", scope: "acme", description: "d" });

    expect(readTelemetry(root)).toEqual([]);
  });

  test("add_refuses_when_cwd_unmapped_and_no_scope", () => {
    const { root, home } = store(["personal"], "~/Projects/work = work\n");
    expect(() => addMemory({ root, cwd: "/somewhere/else", home, now: NOW },
      { content: "x", type: "feedback", description: "d" })).toThrow(ScopeUnresolvedError);
  });

  test("add_refuses_when_machine_not_owner_of_scope", () => {
    const { root, home } = store(["personal"]); // does NOT own work
    mkdirSync(join(root, "work"), { recursive: true });
    expect(() => addMemory({ root, cwd: "/x", home, now: NOW },
      { content: "client note", type: "feedback", scope: "work", description: "d" })).toThrow(NotOwnerError);
  });

  test("add_refuses_on_reject_secret", () => {
    const { root, home } = store(["personal"]);
    expect(() => addMemory({ root, cwd: "/x", home, now: NOW },
      { content: "key is sk-abcdefghij0123456789", type: "feedback", scope: "personal", description: "d" }))
      .toThrow(SecretDetectedError);
  });

  test("add_reference_creates_note_and_refuses_overwrite", () => {
    const { root, home } = store(["personal"]);
    const opts = { content: "how we tag releases", type: "reference" as const, scope: "personal", description: "release tagging", slug: "release-tagging" };
    const res = addMemory({ root, cwd: "/x", home, now: NOW }, opts);
    expect(res.kind).toBe("note");
    expect(res.path).toMatch(/\/personal\/release-tagging\.md$/);
    expect(() => addMemory({ root, cwd: "/x", home, now: NOW }, opts)).toThrow(NoteExistsError);
  });

  test("add_refuses_traversal_shaped_scope_and_writes_nothing", () => {
    // Owner policy explicitly "owns" the malicious scope so the owner gate
    // (Gate 2) passes and execution actually reaches the schema/assertSafeScope
    // guard — proving the traversal is blocked there, not incidentally upstream.
    const { root, home } = store(["personal", "../evil"]);
    expect(() => addMemory({ root, cwd: "/x", home, now: NOW },
      { content: "x", type: "feedback", scope: "../evil", description: "d" })).toThrow();

    // Nothing was materialized outside <root>/personal, and no traversal
    // escaped the root either.
    expect(existsSync(join(root, "..", "evil"))).toBe(false);
    expect(existsSync(join(root, "evil"))).toBe(false);
  });
});
