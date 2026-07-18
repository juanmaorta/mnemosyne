import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { storePaths } from "../store.js";

export interface EvalRecord {
  ts: string;
  cmd: string;
  scope: string;
  slugs: string[];
}

function logPath(root: string): string {
  return join(storePaths(root).indexDir, "eval-log.jsonl");
}

export function appendEvalLog(root: string, rec: EvalRecord): void {
  try {
    mkdirSync(storePaths(root).indexDir, { recursive: true });
    appendFileSync(logPath(root), `${JSON.stringify(rec)}\n`);
  } catch {
    // best-effort: eval logging must never break the command that emits it
  }
}

export function readEvalLog(root: string): EvalRecord[] {
  const path = logPath(root);
  if (!existsSync(path)) return [];
  const out: EvalRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as EvalRecord);
    } catch {
      // tolerate a torn last line
    }
  }
  return out;
}
