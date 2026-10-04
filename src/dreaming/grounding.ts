/**
 * Fidelity (grounding) gate for dreaming synthesis (MNE-86).
 *
 * Neither a bigger model (MNE-84) nor decomposition (MNE-85) made local synthesis
 * reliably faithful on dense sources. So instead of trusting generation, we GATE
 * it: a derived note may legitimately OMIT source detail (that is consolidation,
 * measured eval-time by MNE-84), but it must never ASSERT a datum that is not in
 * its sources. This checks precision, not completeness.
 *
 * It flags the salient, copied-verbatim kinds of token where a mismatch means
 * fabrication, not paraphrase:
 *  - IP addresses,
 *  - alphanumeric codes (letters+digits: WS2812B, CTL-LED-10P), and
 *  - hyphenated slugs that are a near-miss of a real source slug (prog-orbital
 *    vs proj-orbital) — i.e. a corrupted identifier.
 * Bare numbers and dates are left alone: their formatting varies too much to tell
 * fabrication from paraphrase, so flagging them would be noise.
 */

export type UngroundedKind = "ip" | "code" | "slug";
export interface Ungrounded {
  token: string;
  kind: UngroundedKind;
}

const IP_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
/** Candidate "word-ish" tokens that may be codes: alnum with dots/hyphens, len≥4. */
const CODE_CANDIDATE_RE = /[a-z0-9][a-z0-9.-]{3,}/gi;
const SLUG_RE = /\b[a-z]+(?:-[a-z]+)+\b/gi;

function hasLetter(s: string): boolean {
  return /[a-z]/i.test(s);
}
function hasDigit(s: string): boolean {
  return /\d/.test(s);
}

/** Levenshtein distance — small inputs (identifiers), so the simple DP is fine. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j]!, row[j - 1]!);
      prev = tmp;
    }
  }
  return row[n]!;
}

function uniqueMatches(re: RegExp, text: string): string[] {
  return [...new Set((text.match(re) ?? []))];
}

/**
 * Returns the salient tokens in `body` that are NOT grounded in `sourcesText`.
 * Matching is case-insensitive. Empty array means every checked identifier traces
 * to a source.
 */
/** Normalized code token, or "" if the candidate is not a code (letters+digits, len≥4). */
function normalizeCode(raw: string): string {
  const tok = raw.replace(/^[.-]+|[.-]+$/g, ""); // drop edge "." / "-"
  return tok.length >= 4 && hasLetter(tok) && hasDigit(tok) ? tok.toLowerCase() : "";
}

export function findUngrounded(body: string, sourcesText: string): Ungrounded[] {
  const out: Ungrounded[] = [];
  const seen = new Set<string>();

  const push = (token: string, kind: UngroundedKind) => {
    const key = `${kind}:${token.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ token, kind });
  };

  // Grounding compares against COMPLETE source tokens, never substrings: a
  // truncated identifier (192.0.2.4 ⊂ 192.0.2.41, WS2812 ⊂ WS2812B) is a
  // corruption, not a match, so substring containment would hide exactly the
  // fabrication this gate exists to catch.
  const sourceIps = new Set(uniqueMatches(IP_RE, sourcesText).map((s) => s.toLowerCase()));
  const sourceCodes = new Set(uniqueMatches(CODE_CANDIDATE_RE, sourcesText).map(normalizeCode).filter(Boolean));
  const sourceSlugs = uniqueMatches(SLUG_RE, sourcesText).map((s) => s.toLowerCase());
  const sourceSlugSet = new Set(sourceSlugs);

  for (const ip of uniqueMatches(IP_RE, body)) {
    if (!sourceIps.has(ip.toLowerCase())) push(ip, "ip");
  }

  for (const raw of uniqueMatches(CODE_CANDIDATE_RE, body)) {
    const tok = normalizeCode(raw);
    if (!tok) continue;
    if (!sourceCodes.has(tok)) push(raw.replace(/^[.-]+|[.-]+$/g, ""), "code");
  }

  // Hyphenated slugs: grounded only by an EXACT source slug; otherwise flag a
  // near-miss of a real one (a corruption), but leave a novel phrase alone.
  for (const slug of uniqueMatches(SLUG_RE, body)) {
    const low = slug.toLowerCase();
    if (sourceSlugSet.has(low)) continue;
    const nearMiss = sourceSlugs.some((src) => {
      const d = editDistance(low, src);
      return d > 0 && d <= 2 && Math.max(low.length, src.length) >= 8;
    });
    if (nearMiss) push(slug, "slug");
  }

  return out;
}
