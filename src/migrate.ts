import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { EngramSchema, FACT_TYPES, type Engram } from "./schema.js";
import { factFilename, newFactId, DEFAULT_SCOPE } from "./store.js";

const LEGACY_PREFIXES = ["feedback", "user", "project", "reference"] as const;

/** Default importance for migrated engrams; dreaming re-scores globally later. */
const DEFAULT_IMPORTANCE = 5;

export interface LegacyInput {
  /** Raw legacy markdown (frontmatter + body). */
  raw: string;
  /** Legacy filename, e.g. "project_yogurtera.md". */
  filename: string;
  /** ISO datetime injected by the caller (file birthtime) — keeps this pure. */
  created: string;
  /** Target scope; defaults to `personal`. */
  scope?: string;
}

export interface MigrationResult {
  kind: "note" | "fact";
  /** Destination filename: "<slug>.md" for notes, "<ulid>.md" for facts. */
  filename: string;
  content: string;
  engram: Engram;
}

/** Legacy frontmatter is inconsistent: type may sit at the top level or nested under `metadata`. */
function extractType(data: Record<string, unknown>): unknown {
  if (typeof data.type === "string") return data.type;
  const metadata = data.metadata;
  if (metadata && typeof metadata === "object" && "type" in metadata) {
    return (metadata as Record<string, unknown>).type;
  }
  return undefined;
}

/** Some legacy files carry no `type` in frontmatter — the filename prefix is the fallback signal. */
function typeFromFilename(filename: string): string | undefined {
  const prefix = LEGACY_PREFIXES.find((p) => filename.startsWith(`${p}_`));
  return prefix;
}

/** Coerce arbitrary text into a kebab-case slug (lowercase, non-alphanumeric → dash). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Derive a kebab-case slug from the legacy filename, stripping the type prefix. */
function slugFromFilename(filename: string): string {
  const base = filename.replace(/\.md$/i, "");
  const stripped = base.replace(new RegExp(`^(${LEGACY_PREFIXES.join("|")})_`), "");
  return slugify(stripped);
}

const WIKILINK_RE = /\[\[([^\]|#\r\n]+)([#|][^\]\r\n]*)?\]\]/g;

/**
 * Rewrite `[[wikilinks]]` whose target uses the legacy filename convention
 * (`project_yogurtera`) to the migrated slug (`yogurtera`), preserving any
 * `|alias` or `#heading` suffix. Idempotent from the second call onward.
 *
 * Limitation (acceptable for a one-shot personal migration): does NOT skip
 * fenced/inline code, so a note that documents `[[link]]` syntax inside a code
 * span would have that example rewritten too.
 */
export function rewriteBodyLinks(body: string): string {
  return body.replace(WIKILINK_RE, (match, target: string, suffix?: string) => {
    const slug = slugFromFilename(target);
    return slug ? `[[${slug}${suffix ?? ""}]]` : match;
  });
}

export function migrateLegacy(input: LegacyInput): MigrationResult {
  const { data, body } = parseFrontmatter(input.raw);

  const type = extractType(data) ?? typeFromFilename(input.filename);
  const slug = slugFromFilename(input.filename);
  const description = data.description;

  const frontmatter: Record<string, unknown> = {
    name: slug,
    description,
    scope: input.scope ?? DEFAULT_SCOPE,
    type,
    created: input.created,
    importance: DEFAULT_IMPORTANCE,
  };
  // Legacy links/sources predate the kebab-case slug rule → normalize them.
  if (Array.isArray(data.links)) frontmatter.links = data.links.map((l) => slugify(String(l)));
  if (Array.isArray(data.sources)) frontmatter.sources = data.sources.map((s) => slugify(String(s)));

  const engram = EngramSchema.parse(frontmatter);
  const isFact = (FACT_TYPES as readonly string[]).includes(engram.type);
  const seedMs = Date.parse(input.created);
  const filename = isFact
    ? factFilename(newFactId(Number.isNaN(seedMs) ? undefined : seedMs))
    : `${slug}.md`;

  return {
    kind: isFact ? "fact" : "note",
    filename,
    content: serializeFrontmatter(engram, rewriteBodyLinks(body)),
    engram,
  };
}
