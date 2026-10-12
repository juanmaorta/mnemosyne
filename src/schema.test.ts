import { describe, expect, test } from "vitest";
import { EngramSchema, FactSchema, NoteSchema } from "./schema.js";

const baseNote = {
  name: "yogurtera-config",
  description: "How to run the yogurt maker",
  scope: "personal",
  type: "reference",
  created: "2026-06-22T10:00:00",
  importance: 7,
};

describe("NoteSchema", () => {
  test("accepts an authored note (reference/project/user)", () => {
    expect(NoteSchema.parse(baseNote)).toMatchObject({ name: "yogurtera-config", type: "reference" });
  });

  test("rejects an observed type (feedback belongs to the fact stream)", () => {
    expect(() => NoteSchema.parse({ ...baseNote, type: "feedback" })).toThrow();
  });

  test("accepts an ephemeral snapshot note (MNE-29: a dated photo of state)", () => {
    // A snapshot is authored and hand-editable like any note, so it is a NOTE
    // type; what differs is that the ambient digest treats it as ephemeral.
    expect(NoteSchema.parse({ ...baseNote, name: "estado-2026-10-04", type: "snapshot" }))
      .toMatchObject({ type: "snapshot" });
  });

  test("rejects hot state leaking into frontmatter", () => {
    expect(() => NoteSchema.parse({ ...baseNote, strength: 0.5 })).toThrow();
    expect(() => NoteSchema.parse({ ...baseNote, last_access: "2026-06-22T10:00:00" })).toThrow();
    expect(() => NoteSchema.parse({ ...baseNote, access_count: 3 })).toThrow();
  });

  test("rejects a non-kebab-case name", () => {
    expect(() => NoteSchema.parse({ ...baseNote, name: "Not Kebab" })).toThrow();
  });

  test("rejects importance out of the 1-10 range", () => {
    expect(() => NoteSchema.parse({ ...baseNote, importance: 0 })).toThrow();
    expect(() => NoteSchema.parse({ ...baseNote, importance: 11 })).toThrow();
  });

  test("rejects a scope with path-traversal characters", () => {
    expect(() => NoteSchema.parse({ ...baseNote, scope: "../etc" })).toThrow();
    expect(() => NoteSchema.parse({ ...baseNote, scope: "a/b" })).toThrow();
  });
});

describe("FactSchema", () => {
  const baseFact = { ...baseNote, name: "observed-preference", type: "feedback" };

  test("accepts an observed fact (feedback)", () => {
    expect(FactSchema.parse(baseFact)).toMatchObject({ type: "feedback" });
  });

  test("rejects an authored type on the fact stream", () => {
    expect(() => FactSchema.parse({ ...baseFact, type: "reference" })).toThrow();
  });
});

describe("EngramSchema", () => {
  test("discriminates note vs fact by type", () => {
    expect(EngramSchema.parse(baseNote).type).toBe("reference");
    expect(EngramSchema.parse({ ...baseNote, name: "x", type: "feedback" }).type).toBe("feedback");
  });
});

// --- Supersession ----------------------------------------------------------
//
// Contradictions were delegated entirely to the dreaming, which is the most
// destructive part of the system and is not written yet. Meanwhile the only
// move an agent has when it learns something changed is to write ANOTHER nearly
// identical note — which is how half this corpus ended up in near-duplicate
// clusters. These two fields give it a way to say "this one supersedes that
// one" in the session, without deleting anything.
describe("supersession fields", () => {
  const base = {
    name: "network-upgrade",
    description: "el plan viejo",
    scope: "personal",
    created: "2026-06-01T10:00:00",
    importance: 5,
    type: "reference" as const,
  };

  test("schema_defaults_to_no_status_so_existing_notes_stay_valid", () => {
    // Every note already on disk lacks both fields. Requiring them would make
    // the whole store invalid at parse time.
    expect(EngramSchema.safeParse(base).success).toBe(true);
  });

  test("schema_accepts_a_superseded_note_pointing_at_its_replacement", () => {
    const parsed = EngramSchema.safeParse({ ...base, status: "superseded", superseded_by: "network-upgrade-mesh" });
    expect(parsed.success).toBe(true);
  });

  test("schema_accepts_active_and_flagged_without_a_pointer", () => {
    expect(EngramSchema.safeParse({ ...base, status: "active" }).success).toBe(true);
    expect(EngramSchema.safeParse({ ...base, status: "flagged" }).success).toBe(true);
  });

  test("schema_rejects_an_unknown_status", () => {
    expect(EngramSchema.safeParse({ ...base, status: "deleted" }).success).toBe(false);
  });

  test("schema_rejects_superseded_without_saying_by_what", () => {
    // A note marked superseded with no pointer is strictly worse than one left
    // alone: it is hidden from the digest and names no replacement.
    expect(EngramSchema.safeParse({ ...base, status: "superseded" }).success).toBe(false);
  });

  test("schema_rejects_a_pointer_on_a_note_that_is_not_superseded", () => {
    expect(EngramSchema.safeParse({ ...base, superseded_by: "otra" }).success).toBe(false);
    expect(EngramSchema.safeParse({ ...base, status: "active", superseded_by: "otra" }).success).toBe(false);
  });

  test("schema_rejects_a_note_that_supersedes_itself", () => {
    const parsed = EngramSchema.safeParse({ ...base, status: "superseded", superseded_by: base.name });
    expect(parsed.success).toBe(false);
  });
});
