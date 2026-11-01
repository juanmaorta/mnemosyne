/**
 * Versions and updates (MNE-111): `mneme --version`, `mneme upgrade`, and the
 * once-a-day "a new version is available" line in the SessionStart digest.
 *
 * The notice is the ONLY network call Mnemosyne makes on its own, so it is
 * built around three promises:
 *
 *  - It never slows the hook. The digest is served from a small cache file; a
 *    stale cache starts a DETACHED background process to refresh it and the
 *    hook returns without waiting. What that process learns shows up in the
 *    next session, not this one. Awaiting the request instead would put up to
 *    the full timeout on a session start once a day, for a line that can wait.
 *  - It is bounded: at most one request per 24 h (the cache is claimed before
 *    the refresh starts, so concurrent sessions do not each fire one), and the
 *    request itself is cut off after FETCH_TIMEOUT_MS. Any failure is silent
 *    and still counts as the day's check.
 *  - It only runs where it can help: an install the installer manages (where
 *    `mneme upgrade` works), outside CI, and not when the user opted out.
 *
 * The cache lives in the install dir, next to the code — never in the memory
 * store, which may be synced, shared or committed by its owner.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStoreConfig } from "./config.js";
import { storePaths } from "./store.js";

/** Written by install.sh into the clone it owns (see OWNER_MARK there). */
export const OWNER_MARK = ".mnemosyne-installer";
export const UPDATE_CHECK_FILE = ".update-check.json";
/** Held for the instant it takes to claim the day's check (see claimDailyCheck). */
export const UPDATE_CHECK_LOCK = ".update-check.lock";
/** A lock older than this was left by a process that died mid-claim. */
const STALE_LOCK_MS = 60_000;
export const RELEASES_LATEST_URL = "https://api.github.com/repos/juanmaorta/mnemosyne/releases/latest";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 1500;

/**
 * The directory this code runs from: `dist/release.js` and `src/release.ts`
 * both sit one level below it. For an installer-managed install that is
 * `$INSTALL_DIR`; for a developer it is their checkout.
 */
export function codeDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function isManagedInstall(dir: string): boolean {
  return existsSync(join(dir, OWNER_MARK));
}

// ------------------------------------------------------------------ semver ---

export interface Semver { major: number; minor: number; patch: number; pre: string[] }

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(raw: string): Semver | null {
  const m = SEMVER.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/** Sign of a − b by semver precedence, or null when either is not a version. */
export function compareSemver(a: string, b: string): number | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  // A pre-release sorts before its release; otherwise identifier by identifier.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ----------------------------------------------------------------- version ---

export function packageVersion(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** `git describe` for a checkout, or null. Best effort: git may not even exist. */
function gitDescribe(dir: string): string | null {
  const out = execFileSync("git", ["-C", dir, "describe", "--tags", "--always", "--dirty"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });
  return out.trim() || null;
}

/** What `mneme --version` prints: the package version, plus the git position when there is one. */
export function versionLine(dir: string = codeDir(), describe: (dir: string) => string | null = gitDescribe): string {
  const base = `mneme ${packageVersion(dir) ?? "unknown"}`;
  if (!existsSync(join(dir, ".git"))) return base;
  try {
    const where = describe(dir);
    return where ? `${base} (${where})` : base;
  } catch {
    return base;
  }
}

// ------------------------------------------------------------ update check ---

type Env = Record<string, string | undefined>;

function envFlag(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** Why the check is off for this run, or null when it is on. */
export function updateCheckDisabledReason(opts: { installDir: string; root: string; env?: Env }): string | null {
  const env = opts.env ?? process.env;
  if (envFlag(env.MNEMOSYNE_NO_UPDATE_CHECK)) return "MNEMOSYNE_NO_UPDATE_CHECK is set";
  if (envFlag(env.CI)) return "running in CI";
  if (!isManagedInstall(opts.installDir)) return "not an installer-managed install";
  // A config nobody can read may be someone's attempt to opt out (a trailing
  // comma, `"false"` in quotes): fail closed. loadStoreConfig reads an
  // unparseable file as empty, which is right for search but not here, so the
  // file is parsed once more on its own; only a MISSING file means "no opinion".
  const configPath = storePaths(opts.root).config;
  try {
    JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return "the store's .config.json could not be read (updateCheck)";
  }
  try {
    if (loadStoreConfig(opts.root).updateCheck === false) return "updateCheck is false in .config.json";
  } catch {
    return "the store's .config.json could not be read (updateCheck)";
  }
  return null;
}

export interface UpdateCheckCache { checkedAt: number; latest?: string }

function readCache(dir: string): UpdateCheckCache | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, UPDATE_CHECK_FILE), "utf8")) as Record<string, unknown>;
    if (typeof raw.checkedAt !== "number" || !Number.isFinite(raw.checkedAt)) return null;
    return typeof raw.latest === "string" ? { checkedAt: raw.checkedAt, latest: raw.latest } : { checkedAt: raw.checkedAt };
  } catch {
    return null;
  }
}

function writeCache(dir: string, cache: UpdateCheckCache): void {
  // Write-then-rename, so a session reading it mid-write never sees half a file.
  const path = join(dir, UPDATE_CHECK_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
  renameSync(tmp, path);
}

/** Starts `dist/bin/update-check.js` fully detached: the hook never waits on it. */
function spawnDetachedRefresh(dir: string): void {
  const script = join(dir, "dist", "bin", "update-check.js");
  if (!existsSync(script)) return;
  const child = spawn(process.execPath, [script, dir], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function isStale(cache: UpdateCheckCache | null, now: number): boolean {
  return !cache || now - cache.checkedAt >= CHECK_INTERVAL_MS || now < cache.checkedAt;
}

/**
 * Claim today's check for this process, or return false when another one has
 * it. Renaming the cache is atomic but not exclusive — two sessions starting
 * together would both read the stale cache and both refresh — so the claim is
 * an exclusively created lock file, and freshness is checked again while
 * holding it. A lock left by a crashed process is cleared after a minute.
 */
function claimDailyCheck(dir: string, now: number, retry = true): boolean {
  const lock = join(dir, UPDATE_CHECK_LOCK);
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch {
    let abandoned = false;
    try {
      abandoned = Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS;
      if (abandoned) rmSync(lock, { force: true });
    } catch { /* gone already */ }
    return abandoned && retry ? claimDailyCheck(dir, now, false) : false;
  }
  try {
    const cache = readCache(dir);
    if (!isStale(cache, now)) return false;
    writeCache(dir, cache?.latest ? { checkedAt: now, latest: cache.latest } : { checkedAt: now });
    return true;
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

export interface UpdateNoticeOptions {
  root: string;
  installDir?: string;
  env?: Env;
  now?: () => number;
  spawnRefresh?: (installDir: string) => void;
}

/**
 * The line the SessionStart digest carries when a newer release exists, or
 * null. Synchronous and network-free by construction; never throws.
 */
export function updateNotice(opts: UpdateNoticeOptions): string | null {
  try {
    const dir = opts.installDir ?? codeDir();
    if (updateCheckDisabledReason({ installDir: dir, root: opts.root, env: opts.env ?? process.env }) !== null) return null;
    const now = (opts.now ?? Date.now)();
    const cache = readCache(dir);
    if (isStale(cache, now)) {
      try {
        if (claimDailyCheck(dir, now)) (opts.spawnRefresh ?? spawnDetachedRefresh)(dir);
      } catch { /* the notice is a courtesy; nothing here may cost the digest */ }
    }
    const current = packageVersion(dir);
    const latest = cache?.latest;
    if (!current || !latest) return null;
    const cmp = compareSemver(latest, current);
    if (cmp === null || cmp <= 0) return null;
    const tag = latest.startsWith("v") ? latest : `v${latest}`;
    return `Mnemosyne ${tag} is available (you have v${current}) — run \`mneme upgrade\`.`;
  } catch {
    return null;
  }
}

export interface RefreshOptions {
  installDir: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * The background half: one HTTPS GET to the releases API, bounded by the
 * timeout. Whatever happens, the attempt is recorded so it is not retried
 * before tomorrow; on failure the last known release is kept.
 */
export async function refreshUpdateCheck(opts: RefreshOptions): Promise<void> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const previous = readCache(opts.installDir)?.latest;
  let latest = previous;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(RELEASES_LATEST_URL, {
      signal: controller.signal,
      headers: { accept: "application/vnd.github+json", "user-agent": "mnemosyne" },
    });
    if (res.ok) {
      const body = (await res.json()) as { tag_name?: unknown };
      if (typeof body.tag_name === "string" && parseSemver(body.tag_name)) latest = body.tag_name;
    }
  } catch {
    // Offline, DNS, timeout, rate limit: all mean "no news today".
  } finally {
    clearTimeout(timer);
  }
  try {
    writeCache(opts.installDir, latest ? { checkedAt: now(), latest } : { checkedAt: now() });
  } catch { /* read-only install dir: nothing to remember, nothing to report */ }
}

// ----------------------------------------------------------------- upgrade ---

export const UPGRADE_USAGE = "usage: mneme upgrade [--yes] [--dry-run]";

export interface UpgradeOptions {
  installDir?: string;
  err: (s: string) => void;
  /** Runs `sh <args>` with the terminal attached; returns its exit code. */
  run?: (args: string[]) => number;
}

function runShInherit(args: string[]): number {
  const r = spawnSync("sh", args, { stdio: "inherit" });
  return r.status ?? 1;
}

/**
 * `mneme upgrade`: hand over to the installer that put this copy here, which
 * already knows how to update, rebuild and keep the user's setup. A developer
 * checkout has no installer to hand over to — moving someone's own clone is
 * not this command's business.
 */
export function runUpgrade(args: string[], opts: UpgradeOptions): number {
  const pass: string[] = [];
  for (const a of args) {
    if (a === "--yes" || a === "-y") pass.push("--yes");
    else if (a === "--dry-run") pass.push("--dry-run");
    else { opts.err(`upgrade: unknown argument '${a}'\n${UPGRADE_USAGE}`); return 1; }
  }
  const dir = opts.installDir ?? codeDir();
  if (!isManagedInstall(dir)) {
    opts.err([
      `mneme is running from a development checkout (${dir}), not from an install the installer manages.`,
      "Update it yourself:",
      `  cd ${dir} && git pull && npm ci && npm run build`,
    ].join("\n"));
    return 1;
  }
  return (opts.run ?? runShInherit)([join(dir, "install.sh"), "upgrade", ...pass]);
}
