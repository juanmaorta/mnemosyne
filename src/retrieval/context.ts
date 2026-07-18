import type { Db } from "../index/db.js";
import { materializeHotState } from "../hotstate.js";
import { recencyScore, importanceNorm, blendedScore } from "../scoring.js";

export interface ContextEntry {
  slug: string;
  scope: string;
  description: string;
  score: number;
  created: string;
}

const CONTEXT_WEIGHTS = { recency: 1, importance: 1, relevance: 0 };

export function rankContext(db: Db, root: string, scope: string, nowMs: number): ContextEntry[] {
  materializeHotState(db, root, [scope], nowMs);
  const rows = db
    .prepare(
      `select e.slug as slug, e.scope as scope, e.description as description, e.importance as importance,
              e.created as created, h.last_access as lastAccess, h.access_count as accessCount
       from engrams e
       left join hot_state h on h.scope = e.scope and h.slug = e.slug
       where e.scope = ?`,
    )
    .all(scope) as {
    slug: string; scope: string; description: string; importance: number; created: string;
    lastAccess: string | null; accessCount: number | null;
  }[];

  return rows
    .map((r) => ({
      slug: r.slug,
      scope: r.scope,
      description: r.description,
      created: r.created,
      score: blendedScore(
        {
          recency: r.accessCount && r.accessCount > 0 ? recencyScore(nowMs, Date.parse(r.lastAccess as string)) : 1,
          importance: importanceNorm(r.importance),
          relevance: 0,
        },
        CONTEXT_WEIGHTS,
      ),
    }))
    .sort((a, b) => b.score - a.score || b.created.localeCompare(a.created) || a.slug.localeCompare(b.slug));
}

function lineFor(e: ContextEntry): string {
  return `- [${e.slug}] ${e.description}`;
}

export function selectWithinBudget(entries: ContextEntry[], budgetTokens: number): { included: ContextEntry[]; omitted: number } {
  const included: ContextEntry[] = [];
  let spent = 0;
  for (const e of entries) {
    const cost = Math.ceil(lineFor(e).length / 4);
    if (spent + cost > budgetTokens) break;
    spent += cost;
    included.push(e);
  }
  return { included, omitted: entries.length - included.length };
}

export function formatContextDigest(included: ContextEntry[], scope: string, omitted: number): string {
  const lines = [`# Memory — scope: ${scope} (ambient)`];
  if (included.length === 0) {
    lines.push(omitted > 0
      ? `_(${omitted} memories; none fit the token budget)_`
      : "_(no memory in this scope yet)_");
  } else {
    for (const e of included) lines.push(lineFor(e));
    if (omitted > 0) lines.push(`… +${omitted} more — use \`mneme search "<topic>"\``);
  }
  lines.push(`This is the ${scope} ambient view; \`mneme search\` recalls across all your scopes.`);
  return lines.join("\n");
}
