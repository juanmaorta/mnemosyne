#!/usr/bin/env node
import { argv, exit } from "node:process";
import { runMigration } from "../migrate-run.js";
import { DEFAULT_SCOPE } from "../store.js";

/**
 * Fase 0 migration CLI.
 *   node dist/bin/migrate.js <sourceDir> <destRoot> [scope]
 *
 * Example:
 *   node dist/bin/migrate.js \
 *     ~/.claude/projects/<cwd-slug>/memory \
 *     ~/memory work
 */
const USAGE = "usage: migrate <sourceDir> <destRoot> [scope]";

async function main(): Promise<void> {
  const args = argv.slice(2);
  // MNE-106: every argument is a path or a scope name, so a flag is never one.
  // `migrate <src> --help` used to take `--help` as the destination and create
  // `./--help/personal/facts/` before reading anything.
  if (args.some((a) => a === "--help" || a === "-h")) {
    console.log(USAGE);
    exit(0);
  }
  const [sourceDir, destRoot, scope] = args;
  if (!sourceDir || !destRoot || args.some((a) => a.startsWith("-"))) {
    console.error(USAGE);
    exit(2);
  }

  const summary = await runMigration(scope ? { sourceDir, destRoot, scope } : { sourceDir, destRoot });
  console.log(
    `Migrated ${summary.notes} note(s) and ${summary.facts} fact(s) into ${destRoot}/${scope ?? DEFAULT_SCOPE}.`,
  );
  if (summary.skipped.length > 0) {
    console.log(`Skipped ${summary.skipped.length} existing destination(s): ${summary.skipped.join(", ")}`);
  }
  if (summary.collisions.length > 0) {
    console.warn(`Slug collisions (NOT migrated, resolve manually): ${summary.collisions.join(", ")}`);
  }
  if (summary.failed.length > 0) {
    console.warn(`Failed ${summary.failed.length} file(s):`);
    for (const f of summary.failed) console.warn(`  - ${f.file}: ${f.error}`);
    exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  exit(1);
});
