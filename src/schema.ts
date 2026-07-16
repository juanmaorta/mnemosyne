import { z } from "zod";

/**
 * Frontmatter schema for an engram.
 *
 * Two classes, discriminated by `type` (plan.md — "Dos clases de memoria"):
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
 * invariant (plan.md §4, fail-closed on scope).
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
};

export const NOTE_TYPES = ["user", "reference", "project"] as const;
export const FACT_TYPES = ["feedback"] as const;

export const NoteSchema = z
  .object({ ...baseFields, type: z.enum(NOTE_TYPES) })
  .strict();

export const FactSchema = z
  .object({ ...baseFields, type: z.enum(FACT_TYPES) })
  .strict();

export const EngramSchema = z.discriminatedUnion("type", [NoteSchema, FactSchema]);

export type Note = z.infer<typeof NoteSchema>;
export type Fact = z.infer<typeof FactSchema>;
export type Engram = z.infer<typeof EngramSchema>;
