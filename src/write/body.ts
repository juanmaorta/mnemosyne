// src/write/body.ts
import { readFileSync } from "node:fs";

/**
 * Where a memory's body comes from: positional argv text, or `--file`.
 *
 * A note body is a document — blank lines, indentation, code fences — and argv
 * quoting mangles all of it, so `--file` is the honest path for anything longer
 * than a sentence. The file carries the BODY ONLY: frontmatter is the store's to
 * write, never the caller's to supply.
 */
export class BodyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyInputError";
  }
}

/**
 * Resolves the body from exactly one source. Returns `undefined` when the caller
 * gave neither, so the command can print its own usage line.
 *
 * `trim()` is used ONLY to decide whether a body is empty — the returned text is
 * the file's bytes as written, newlines included, because that is what ends up
 * in the note.
 */
export function resolveBody(positionalText: string, file?: string): string | undefined {
  const positional = positionalText.trim();
  if (file !== undefined) {
    // Two sources means the caller has two different intentions on screen and we
    // would have to guess which one to persist. Refuse instead.
    if (positional) throw new BodyInputError("pass either positional text or --file, not both");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      throw new BodyInputError(`cannot read --file ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    if (!text.trim()) throw new BodyInputError(`--file ${file} is empty`);
    return text;
  }
  return positional ? positional : undefined;
}
