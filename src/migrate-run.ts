import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateLegacy } from "./migrate.js";
import { storePaths, DEFAULT_SCOPE } from "./store.js";

export interface MigrationOptions {
  sourceDir: string;
  destRoot: string;
  /** Target scope; defaults to `personal`. */
  scope?: string;
}

export interface MigrationFailure {
  file: string;
  error: string;
}

export interface MigrationSummary {
  notes: number;
  facts: number;
  /** Source files whose destination already existed before this run. */
  skipped: string[];
  /** Source files dropped because another file in this run claimed the same slug. */
  collisions: string[];
  /** Source files that failed to migrate (parse/schema errors) — run continues. */
  failed: MigrationFailure[];
}

const IGNORED_FILES = new Set(["MEMORY.md", "INDEX.md"]);

/** Local ISO datetime without timezone, matching the CreatedAt schema. */
function toLocalIso(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  );
}

/**
 * Migrate a legacy flat memory folder into the scoped store under destRoot.
 * Authored types → <destRoot>/personal/<slug>.md; observed feedback → the
 * append-only fact stream <destRoot>/personal/facts/<ulid>.md.
 *
 * Refuses to overwrite existing destinations (flag "wx") so re-runs are safe.
 */
export async function runMigration(opts: MigrationOptions): Promise<MigrationSummary> {
  const scope = opts.scope ?? DEFAULT_SCOPE;
  const paths = storePaths(opts.destRoot);
  await mkdir(paths.scopeDir(scope), { recursive: true });
  await mkdir(paths.factsDir(scope), { recursive: true });

  const summary: MigrationSummary = { notes: 0, facts: 0, skipped: [], collisions: [], failed: [] };
  const claimedNoteFiles = new Set<string>();

  const entries = await readdir(opts.sourceDir);
  for (const filename of entries) {
    if (!filename.endsWith(".md") || filename.startsWith(".") || IGNORED_FILES.has(filename)) continue;

    try {
      const sourcePath = join(opts.sourceDir, filename);
      const raw = await readFile(sourcePath, "utf8");
      const info = await stat(sourcePath);
      const created = toLocalIso(info.birthtime.getTime() ? info.birthtime : info.mtime);

      const result = migrateLegacy({ raw, filename, created, scope });
      const destPath =
        result.kind === "fact"
          ? join(paths.factsDir(scope), result.filename)
          : join(paths.scopeDir(scope), result.filename);

      // Two legacy files can slugify to the same note filename — surface it, never overwrite.
      if (result.kind === "note") {
        if (claimedNoteFiles.has(result.filename)) {
          summary.collisions.push(filename);
          continue;
        }
        claimedNoteFiles.add(result.filename);
      }

      try {
        await writeFile(destPath, result.content, { flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          summary.skipped.push(filename);
          continue;
        }
        throw err;
      }

      if (result.kind === "fact") summary.facts++;
      else summary.notes++;
    } catch (err) {
      summary.failed.push({ file: filename, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return summary;
}
