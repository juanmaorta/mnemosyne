// src/compliance/lint.test.ts
//
// MNE-47: compliance-lint. Scan a target scope (default `personal`) against
// EXPLICITLY-configured client-scope entities (literal terms and/or regex), with
// no LLM, to catch leaks toward personal. Read-only: it reports location and a
// masked value, and never moves, deletes or rewrites a note. It differentiates
// a hit, an error (unknown scope / invalid config) and a clean scan — a typo'd
// scope reporting "clean" is the one failure a security tool must not have.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { serializeFrontmatter } from "../frontmatter.js";
import { UnknownScopeError } from "../secrets/rescan.js";
import {
  scanTextForCompliance,
  compileComplianceConfig,
  complianceLintStore,
  ComplianceConfigError,
  type ComplianceConfig,
} from "./lint.js";

const CFG: ComplianceConfig = {
  rules: [
    { label: "client-acme", terms: ["Acme", "sol"] },
    { label: "client-globex", patterns: ["GLX-\\d{4}"] },
  ],
};

function store(): string {
  return mkdtempSync(join(tmpdir(), "mne-compliance-"));
}

function writeNote(root: string, scope: string, slug: string, body: string): string {
  const dir = join(root, scope);
  mkdirSync(dir, { recursive: true });
  const fm = { name: slug, description: `${slug} desc`, scope, created: "2026-09-01T10:00:00", importance: 5, type: "reference" };
  const path = join(dir, `${slug}.md`);
  writeFileSync(path, serializeFrontmatter(fm, body));
  return path;
}

describe("compileComplianceConfig — validation", () => {
  test("rejects an empty rule set (an empty config is not a clean scan)", () => {
    expect(() => compileComplianceConfig({ rules: [] })).toThrow(ComplianceConfigError);
  });

  test("rejects a rule without a label", () => {
    expect(() => compileComplianceConfig({ rules: [{ label: "", terms: ["x"] }] })).toThrow(ComplianceConfigError);
  });

  test("rejects a rule with neither terms nor patterns", () => {
    expect(() => compileComplianceConfig({ rules: [{ label: "c" }] })).toThrow(ComplianceConfigError);
  });

  test("rejects an invalid regex pattern instead of scanning silently", () => {
    expect(() => compileComplianceConfig({ rules: [{ label: "c", patterns: ["GLX-(\\d"] }] })).toThrow(ComplianceConfigError);
  });

  test("an invalid-regex error does not echo the (sensitive) pattern source", () => {
    // The source may itself be a client entity; a validation error must not leak it.
    expect(() => compileComplianceConfig({ rules: [{ label: "c", patterns: ["Acme-(secret"] }] }))
      .toThrow(/^(?!.*Acme).*$/);
  });

  test("rejects a non-array `terms` instead of iterating a string char-by-char", () => {
    // A JSON config with terms: "Acme" must be rejected, not compiled as 4 terms.
    expect(() => compileComplianceConfig({ rules: [{ label: "c", terms: "Acme" as unknown as string[] }] }))
      .toThrow(ComplianceConfigError);
  });

  test("rejects a non-array `patterns`", () => {
    expect(() => compileComplianceConfig({ rules: [{ label: "c", patterns: "GLX" as unknown as string[] }] }))
      .toThrow(ComplianceConfigError);
  });

  test("rejects a rule that is not an object", () => {
    expect(() => compileComplianceConfig({ rules: ["Acme" as unknown as never] })).toThrow(ComplianceConfigError);
  });
});

describe("scanTextForCompliance", () => {
  const compiled = compileComplianceConfig(CFG);

  test("flags a client term, case-insensitively, with a masked value", () => {
    const f = scanTextForCompliance("Met with acme about the migration", compiled);
    expect(f).toHaveLength(1);
    expect(f[0]!.label).toBe("client-acme");
    expect(f[0]!.kind).toBe("term");
    expect(f[0]!.masked).not.toContain("acme"); // the value is masked, not echoed
  });

  test("flags a regex pattern match without carrying the (sensitive) source", () => {
    const f = scanTextForCompliance("ticket GLX-1234 is open", compiled);
    expect(f).toHaveLength(1);
    expect(f[0]!.label).toBe("client-globex");
    expect(f[0]!.kind).toBe("pattern");
    expect(Object.keys(f[0]!)).not.toContain("pattern"); // source is never carried
    expect(f[0]!.masked).not.toContain("GLX-1234");
  });

  test("a term only matches on word boundaries, not inside another word", () => {
    expect(scanTextForCompliance("the acmecorp product", compiled)).toHaveLength(0);
  });

  test("reports the correct line number", () => {
    const f = scanTextForCompliance("line one\nline two Acme here\nline three", compiled);
    expect(f[0]!.line).toBe(2);
  });

  test("no match yields a clean (empty) result", () => {
    expect(scanTextForCompliance("nothing sensitive here", compiled)).toEqual([]);
  });

  test("predictable false positive: a term that is also a common word still matches", () => {
    // 'sol' is configured as a client term but is also the Spanish word for sun.
    // The tool does not promise exhaustive precision: this is a documented FP.
    const f = scanTextForCompliance("hoy hace sol en la playa", compiled);
    expect(f).toHaveLength(1);
    expect(f[0]!.label).toBe("client-acme");
  });
});

describe("complianceLintStore — index adapter", () => {
  test("finds a client term leaked into a personal note, with path/scope/line", () => {
    const root = store();
    const path = writeNote(root, "personal", "leak", "I had coffee, then Acme called about billing");
    writeNote(root, "personal", "clean", "just a normal note about plants");
    const findings: { path: string; label: string; line: number }[] = [];
    const summary = complianceLintStore(root, CFG, (f) => findings.push(f), { scopes: ["personal"] });
    expect(summary.filesScanned).toBe(2);
    expect(summary.findings).toBe(1);
    expect(findings[0]!.path).toBe(path);
    expect(findings[0]!.label).toBe("client-acme");
  });

  test("a clean scope reports a clean scan, not an empty success by accident", () => {
    const root = store();
    writeNote(root, "personal", "n1", "nothing to see");
    const summary = complianceLintStore(root, CFG, () => {}, { scopes: ["personal"] });
    expect(summary.filesScanned).toBe(1);
    expect(summary.findings).toBe(0);
  });

  test("an unknown target scope throws instead of reporting clean", () => {
    const root = store();
    writeNote(root, "personal", "n1", "x");
    expect(() => complianceLintStore(root, CFG, () => {}, { scopes: ["ghost"] })).toThrow(UnknownScopeError);
  });

  test("records a file it could not read instead of skipping it silently", () => {
    const root = store();
    const path = writeNote(root, "personal", "locked", "Acme is here");
    chmodSync(path, 0o000);
    try {
      // Root can read a 0o000 file, so this assertion only holds for a normal user.
      if (typeof process.getuid === "function" && process.getuid() === 0) return;
      const summary = complianceLintStore(root, CFG, () => {}, { scopes: ["personal"] });
      expect(summary.unreadable).toContain(path);
    } finally {
      chmodSync(path, 0o600); // restore so cleanup can remove it
    }
  });

  test("surfaces an unreadable scope directory as incomplete, not clean", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root reads 0o000 dirs
    const root = store();
    writeNote(root, "personal", "n", "x");
    chmodSync(join(root, "personal"), 0o000);
    try {
      const summary = complianceLintStore(root, CFG, () => {}, { scopes: ["personal"] });
      expect(summary.unreadable.length).toBeGreaterThan(0);
    } finally {
      chmodSync(join(root, "personal"), 0o700); // restore so cleanup can remove it
    }
  });

  test("never rewrites a scanned note", () => {
    const root = store();
    const path = writeNote(root, "personal", "leak", "Acme is here");
    const before = readFileSync(path, "utf8");
    complianceLintStore(root, CFG, () => {}, { scopes: ["personal"] });
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
