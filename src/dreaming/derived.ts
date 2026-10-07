// The one place that knows how a dreaming-derived note is recognized, so
// retrieval and synthesis cannot drift on it. A derived note is identified by
// its slug carrying the reserved `dream-` prefix (plus `sources` provenance in
// its frontmatter); the prefix is what gives it a stable identity under the
// EXISTING schema, with no new frontmatter field.

export const DERIVED_SLUG_PREFIX = "dream-";

export function isDerivedSlug(slug: string): boolean {
  return slug.startsWith(DERIVED_SLUG_PREFIX);
}
