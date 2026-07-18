export type Severity = "reject" | "warn";

export interface SecretFinding {
  pattern: string;
  line: number;
  masked: string;
  severity: Severity;
}

function maskSecret(token: string, revealPrefix: boolean): string {
  if (!revealPrefix || token.length <= 8) return "****";
  return `${token.slice(0, 4)}…****`;
}

const ENTROPY_RE = /[A-Za-z0-9+/=_-]{40,}/g;
const ENTROPY_THRESHOLD = 3.5;

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

interface RejectRule {
  name: string;
  re: RegExp; // whole match (m[0]) is the secret token to mask
}

const REJECT_RULES: RejectRule[] = [
  { name: "openai-key", re: /sk-[A-Za-z0-9_-]{16,}/g },
  { name: "github-token", re: /gh[posru]_[A-Za-z0-9]{20,}/g },
  { name: "github-pat", re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "slack-token", re: /xox[bpasr]-[A-Za-z0-9-]{10,}/g },
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

const ASSIGNMENT_RE = /\b(password|passwd|api[_-]?key|secret|token)\s*[=:]\s*(\S+)/gi;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];

  for (const rule of REJECT_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      findings.push({
        pattern: rule.name,
        line: lineOf(text, m.index),
        masked: maskSecret(m[0], true),
        severity: "reject",
      });
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++; // guard zero-width
    }
  }

  ASSIGNMENT_RE.lastIndex = 0;
  let a: RegExpExecArray | null;
  while ((a = ASSIGNMENT_RE.exec(text)) !== null) {
    const key = (a[1] ?? "").toLowerCase();
    const value = a[2] ?? "";
    findings.push({
      pattern: `assignment:${key}`,
      line: lineOf(text, a.index),
      masked: maskSecret(value, false),
      severity: "reject",
    });
  }

  ENTROPY_RE.lastIndex = 0;
  let e: RegExpExecArray | null;
  while ((e = ENTROPY_RE.exec(text)) !== null) {
    const run = e[0];
    if (shannonEntropy(run) >= ENTROPY_THRESHOLD) {
      findings.push({
        pattern: "high-entropy",
        line: lineOf(text, e.index),
        masked: maskSecret(run, false),
        severity: "warn",
      });
    }
  }

  return findings;
}

export function hasRejectFinding(findings: SecretFinding[]): boolean {
  return findings.some((f) => f.severity === "reject");
}
