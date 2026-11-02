import { z } from "zod";

/**
 * Frontmatter schema for an engram.
 *
 * Two classes, discriminated by `type` (docs/architecture.md — "Two kinds of memory"):
 *  - Authored / reference (`user`, `reference`, `project`): note = truth, hand-editable.
 *  - Observed / learned (`feedback`): append-only fact stream, distilled by dreaming.
 *
 * Hot state (`strength`, `last_access`, `access_count`) NEVER lives in frontmatter —
 * it is derived state materialized per-machine in `.index/`. The schema is strict so
 * any leak is caught at parse time.
 */

/** kebab-case slug: lowercase alphanumerics separated by single dashes. */
export const Slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "name must be kebab-case");

/**
 * Scope is an extensible but constrained folder name: a kebab-case slug.
 * It maps directly to a directory on disk, so it must never contain path
 * separators or traversal — that would break the blast-radius-of-deletion
 * invariant (docs/architecture.md, principle 4: fail-closed on scope).
 */
export const Scope = Slug;

/** Local ISO datetime without timezone, e.g. 2026-06-22T10:00:00. */
export const CreatedAt = z.string().datetime({ local: true });

export const Importance = z.number().int().min(1).max(10);

const baseFields = {
  name: Slug,
  description: z.string().min(1),
  scope: Scope,
  created: CreatedAt,
  importance: Importance,
  /** Associative graph edges (also mirrored as [[wikilinks]] in the body). */
  links: z.array(Slug).optional(),
  /** Provenance of derived memories → scope taint. */
  sources: z.array(Slug).optional(),
  /**
   * Pin: a note the user never wants archived, whatever its `strength` (MNE-62).
   * Archival (lethe) decides by `strength`, which measures "never surfaced by an
   * inverted ranker" as much as "irrelevant"; a pin is the explicit escape hatch
   * that protects against a bad INPUT, which the dry-run cannot. It affects only
   * archival — a pinned note still decays in the ranking. Absent means not
   * pinned, so every note already on disk stays valid. Written by hand or by the
   * agent, NEVER by dreaming.
   */
  pinned: z.boolean().optional(),
  /**
   * Lifecycle of the note's claim, NOT of the file. Absent means `active`: every
   * note already on disk omits it, and requiring it would invalidate the store
   * at parse time.
   *
   * `superseded` says another note now holds the truth this one used to hold.
   * Nothing is deleted — the note stays readable and `mneme get` still serves
   * it; what changes is that the ranking stops offering it as current.
   * `flagged` marks a contradiction someone noticed but has not resolved, and
   * is deliberately NOT hidden: an unresolved conflict is worth surfacing.
   */
  status: z.enum(["active", "superseded", "flagged"]).optional(),
  /** The note that supersedes this one. Only meaningful with `status: superseded`. */
  superseded_by: Slug.optional(),
};

/**
 * `snapshot` is an authored note like the rest (hand-editable, note = truth),
 * but it records a dated PHOTO OF STATE — "where this project stood on 2026-10-04"
 * — not a durable fact. It never carries its own expiry: a snapshot does not
 * expire by a clock (you cannot know when its state stops being true at write
 * time), it expires by an EVENT — a newer snapshot or the work moving on. The
 * ambient digest therefore leaves snapshots out (see `rankContext`): they are
 * recalled deliberately via `search`/`get`, not fossilised into session start.
 * Decay by `strength` and manual supersession apply to them like any note (MNE-29).
 */
export const NOTE_TYPES = ["user", "reference", "project", "snapshot"] as const;
export const FACT_TYPES = ["feedback"] as const;

export const NoteSchema = z
  .object({ ...baseFields, type: z.enum(NOTE_TYPES) })
  .strict();

export const FactSchema = z
  .object({ ...baseFields, type: z.enum(FACT_TYPES) })
  .strict();

/**
 * The two supersession fields only mean something together, so the pair is
 * checked here rather than left to every caller.
 *
 * `superseded` without a pointer is strictly worse than leaving the note alone:
 * it drops out of the digest and names no replacement, so the knowledge is gone
 * from view with nothing to follow. A pointer without `superseded` is the same
 * incoherence read from the other side.
 */
export const EngramSchema = z
  .discriminatedUnion("type", [NoteSchema, FactSchema])
  .superRefine((engram, ctx) => {
    const superseded = engram.status === "superseded";
    if (superseded && engram.superseded_by === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["superseded_by"],
        message: "status 'superseded' requires superseded_by naming the note that replaces it",
      });
    }
    if (!superseded && engram.superseded_by !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "superseded_by is only meaningful with status 'superseded'",
      });
    }
    // A note superseding itself would be excluded from the ranking and point at
    // the thing that is excluded: a memory that quietly erases itself.
    if (engram.superseded_by === engram.name) {
      ctx.addIssue({
        code: "custom",
        path: ["superseded_by"],
        message: "a note cannot supersede itself",
      });
    }
  });

export type Note = z.infer<typeof NoteSchema>;
export type Fact = z.infer<typeof FactSchema>;
export type Engram = z.infer<typeof EngramSchema>;
