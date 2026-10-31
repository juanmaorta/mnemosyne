#!/usr/bin/env node
// Background refresh of the new-version notice (MNE-111). Started detached by
// `mneme context` when its cache is stale, so the SessionStart hook never waits
// for the network; see src/release.ts. Never prints, always exits 0.
import { codeDir, refreshUpdateCheck } from "../release.js";

refreshUpdateCheck({ installDir: process.argv[2] ?? codeDir() }).finally(() => process.exit(0));
