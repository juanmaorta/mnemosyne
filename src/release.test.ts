// src/release.test.ts
//
// MNE-111: versions, the update notice and `mneme upgrade`. Nothing here ever
// touches the network: fetch, the clock and the background refresh are all
// injected, and every install dir is a throwaway temp dir.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CHECK_INTERVAL_MS,
  FETCH_TIMEOUT_MS,
  OWNER_MARK,
  RELEASES_LATEST_URL,
  UPDATE_CHECK_FILE,
  UPDATE_CHECK_LOCK,
  compareSemver,
  parseSemver,
  refreshUpdateCheck,
  runUpgrade,
  updateCheckDisabledReason,
  updateNotice,
  versionLine,
} from "./release.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-01T09:00:00Z");

function installDir(opts: { version?: string; managed?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "mneme-release-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mnemosyne", version: opts.version ?? "0.1.0" }));
  if (opts.managed ?? true) writeFileSync(join(dir, OWNER_MARK), "");
  return dir;
}

function store(config?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "mneme-release-store-"));
  if (config) writeFileSync(join(root, ".config.json"), JSON.stringify(config));
  return root;
}

function writeCache(dir: string, cache: Record<string, unknown>): void {
  writeFileSync(join(dir, UPDATE_CHECK_FILE), JSON.stringify(cache));
}

function readCache(dir: string): { checkedAt: number; latest?: string } {
  return JSON.parse(readFileSync(join(dir, UPDATE_CHECK_FILE), "utf8"));
}

describe("semver", () => {
  test("parses_with_or_without_a_leading_v", () => {
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
    expect(parseSemver("0.10.0")).toEqual({ major: 0, minor: 10, patch: 0, pre: [] });
    expect(parseSemver("v1.0.0-rc.1")).toEqual({ major: 1, minor: 0, patch: 0, pre: ["rc", "1"] });
    expect(parseSemver("main")).toBeNull();
    expect(parseSemver("v1.2")).toBeNull();
  });

  test("compares_numerically_not_lexically", () => {
    expect(compareSemver("v0.10.0", "v0.9.0")).toBeGreaterThan(0);
    expect(compareSemver("0.2.0", "v0.10.0")).toBeLessThan(0);
    expect(compareSemver("v1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("v2.0.0", "v1.99.99")).toBeGreaterThan(0);
  });

  test("a_pre_release_is_older_than_its_release", () => {
    expect(compareSemver("v1.0.0-rc.1", "v1.0.0")).toBeLessThan(0);
    expect(compareSemver("v1.0.0-rc.2", "v1.0.0-rc.10")).toBeLessThan(0);
    expect(compareSemver("v1.0.0-alpha", "v1.0.0-beta")).toBeLessThan(0);
    expect(compareSemver("v1.0.0-rc.1", "v0.9.0")).toBeGreaterThan(0);
  });

  test("unparseable_versions_compare_as_null", () => {
    expect(compareSemver("main", "v1.0.0")).toBeNull();
  });
});

describe("versionLine", () => {
  test("is_the_package_version_alone_outside_git", () => {
    const dir = installDir({ version: "0.3.1" });
    expect(versionLine(dir, () => null)).toBe("mneme 0.3.1");
  });

  test("appends_what_git_describes_in_a_checkout", () => {
    const dir = installDir({ version: "0.3.1" });
    mkdirSync(join(dir, ".git"));
    expect(versionLine(dir, () => "v0.3.1-2-gabc1234")).toBe("mneme 0.3.1 (v0.3.1-2-gabc1234)");
  });

  test("never_fails_when_git_is_missing", () => {
    const dir = installDir({ version: "0.3.1" });
    mkdirSync(join(dir, ".git"));
    expect(versionLine(dir, () => { throw new Error("spawn git ENOENT"); })).toBe("mneme 0.3.1");
  });
});

describe("updateCheckDisabledReason", () => {
  const managed = installDir();

  test("is_on_by_default_in_an_installer_managed_dir", () => {
    expect(updateCheckDisabledReason({ installDir: managed, root: store(), env: {} })).toBeNull();
  });

  test("the_env_var_opts_out", () => {
    expect(updateCheckDisabledReason({ installDir: managed, root: store(), env: { MNEMOSYNE_NO_UPDATE_CHECK: "1" } })).toMatch(/MNEMOSYNE_NO_UPDATE_CHECK/);
    // "0" reads as "not disabled", like most boolean env switches.
    expect(updateCheckDisabledReason({ installDir: managed, root: store(), env: { MNEMOSYNE_NO_UPDATE_CHECK: "0" } })).toBeNull();
  });

  test("the_store_config_opts_out", () => {
    expect(updateCheckDisabledReason({ installDir: managed, root: store({ updateCheck: false }), env: {} })).toMatch(/updateCheck/);
    expect(updateCheckDisabledReason({ installDir: managed, root: store({ updateCheck: true }), env: {} })).toBeNull();
  });

  test("an_unreadable_opt_out_fails_closed", () => {
    // `"false"` (a string) is somebody trying to opt out: never phone home on a guess.
    expect(updateCheckDisabledReason({ installDir: managed, root: store({ updateCheck: "false" }), env: {} })).not.toBeNull();
  });

  test("a_malformed_config_fails_closed_but_a_missing_one_does_not", () => {
    const root = store();
    writeFileSync(join(root, ".config.json"), '{ "updateCheck": false, }'); // trailing comma
    expect(updateCheckDisabledReason({ installDir: managed, root, env: {} })).not.toBeNull();
    expect(updateCheckDisabledReason({ installDir: managed, root: join(root, "missing"), env: {} })).toBeNull();
  });

  test("CI_turns_it_off", () => {
    expect(updateCheckDisabledReason({ installDir: managed, root: store(), env: { CI: "true" } })).toMatch(/CI/);
  });

  test("a_dev_checkout_never_checks", () => {
    expect(updateCheckDisabledReason({ installDir: installDir({ managed: false }), root: store(), env: {} })).toMatch(/installer/);
  });
});

describe("updateNotice (the SessionStart hot path)", () => {
  function deps(dir: string, now: number, root = store()) {
    const spawned: string[] = [];
    return { spawned, opts: { installDir: dir, root, env: {}, now: () => now, spawnRefresh: (d: string) => { spawned.push(d); } } };
  }

  test("a_fresh_cache_with_a_newer_release_prints_one_line_and_starts_nothing", () => {
    const dir = installDir({ version: "0.1.0" });
    writeCache(dir, { checkedAt: T0, latest: "v0.2.0" });
    const { spawned, opts } = deps(dir, T0 + DAY - 1);
    expect(updateNotice(opts)).toBe("Mnemosyne v0.2.0 is available (you have v0.1.0) — run `mneme upgrade`.");
    expect(spawned).toEqual([]);
  });

  test("no_line_when_the_latest_release_is_not_newer", () => {
    for (const latest of ["v0.1.0", "v0.0.9", "garbage"]) {
      const dir = installDir({ version: "0.1.0" });
      writeCache(dir, { checkedAt: T0, latest });
      expect(updateNotice(deps(dir, T0 + 1).opts)).toBeNull();
    }
  });

  test("no_cache_starts_one_background_refresh_and_never_waits_for_it", () => {
    const dir = installDir();
    const { spawned, opts } = deps(dir, T0);
    expect(updateNotice(opts)).toBeNull();
    expect(spawned).toEqual([dir]);
    // Claimed before spawning: the next session within 24 h does not start another.
    expect(readCache(dir).checkedAt).toBe(T0);
    const again = deps(dir, T0 + 60_000);
    updateNotice(again.opts);
    expect(again.spawned).toEqual([]);
  });

  test("a_stale_cache_still_answers_from_what_it_knows_and_refreshes_for_next_time", () => {
    const dir = installDir({ version: "0.1.0" });
    writeCache(dir, { checkedAt: T0, latest: "v0.2.0" });
    const { spawned, opts } = deps(dir, T0 + CHECK_INTERVAL_MS);
    expect(updateNotice(opts)).toMatch(/v0\.2\.0 is available/);
    expect(spawned).toEqual([dir]);
    expect(readCache(dir)).toEqual({ checkedAt: T0 + CHECK_INTERVAL_MS, latest: "v0.2.0" });
  });

  test("a_session_racing_another_one_s_claim_does_not_start_a_second_refresh", () => {
    // Two sessions starting together both see a stale cache; only the one
    // that takes the claim lock may refresh.
    const dir = installDir();
    writeFileSync(join(dir, UPDATE_CHECK_LOCK), "");
    const { spawned, opts } = deps(dir, Date.now());
    updateNotice(opts);
    expect(spawned).toEqual([]);
  });

  test("an_abandoned_claim_lock_does_not_block_checks_forever", () => {
    const dir = installDir();
    writeFileSync(join(dir, UPDATE_CHECK_LOCK), "");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(dir, UPDATE_CHECK_LOCK), old, old);
    const { spawned, opts } = deps(dir, Date.now());
    updateNotice(opts);
    expect(spawned).toEqual([dir]);
    expect(existsSync(join(dir, UPDATE_CHECK_LOCK))).toBe(false);
  });

  test("disabled_means_no_line_no_refresh_and_no_cache_file", () => {
    const dir = installDir();
    writeCache(dir, { checkedAt: T0, latest: "v9.0.0" });
    const { spawned, opts } = deps(dir, T0 + 2 * DAY);
    expect(updateNotice({ ...opts, env: { MNEMOSYNE_NO_UPDATE_CHECK: "1" } })).toBeNull();
    expect(updateNotice({ ...opts, env: { CI: "1" } })).toBeNull();
    expect(updateNotice({ ...opts, root: store({ updateCheck: false }) })).toBeNull();
    expect(spawned).toEqual([]);
    const dev = installDir({ managed: false });
    expect(updateNotice({ ...opts, installDir: dev })).toBeNull();
    expect(() => readCache(dev)).toThrow();
  });

  test("never_throws_whatever_the_cache_holds", () => {
    const dir = installDir();
    writeFileSync(join(dir, UPDATE_CHECK_FILE), "{not json");
    const { spawned, opts } = deps(dir, T0);
    expect(updateNotice(opts)).toBeNull();
    expect(spawned).toEqual([dir]);
  });

  test("a_failing_spawn_is_swallowed", () => {
    const dir = installDir();
    expect(updateNotice({ ...deps(dir, T0).opts, spawnRefresh: () => { throw new Error("EAGAIN"); } })).toBeNull();
  });

  test("the_cache_lives_in_the_install_dir_never_in_the_store", () => {
    const dir = installDir();
    const root = store();
    updateNotice(deps(dir, T0, root).opts);
    expect(() => readFileSync(join(root, UPDATE_CHECK_FILE))).toThrow();
    expect(readCache(dir).checkedAt).toBe(T0);
  });
});

describe("refreshUpdateCheck (the background half)", () => {
  test("asks_the_releases_api_once_and_caches_the_tag", async () => {
    const dir = installDir();
    const calls: string[] = [];
    const fakeFetch = async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ tag_name: "v0.4.0" }), { status: 200 });
    };
    await refreshUpdateCheck({ installDir: dir, fetch: fakeFetch as typeof fetch, now: () => T0 });
    expect(calls).toEqual([RELEASES_LATEST_URL]);
    expect(readCache(dir)).toEqual({ checkedAt: T0, latest: "v0.4.0" });
  });

  test("an_http_error_is_cached_as_a_check_and_keeps_the_last_known_release", async () => {
    const dir = installDir();
    writeCache(dir, { checkedAt: T0 - 2 * DAY, latest: "v0.2.0" });
    const fakeFetch = async () => new Response("nope", { status: 404 });
    await refreshUpdateCheck({ installDir: dir, fetch: fakeFetch as typeof fetch, now: () => T0 });
    expect(readCache(dir)).toEqual({ checkedAt: T0, latest: "v0.2.0" });
  });

  test("a_network_error_is_silent_and_cached", async () => {
    const dir = installDir();
    const fakeFetch = async () => { throw new TypeError("fetch failed"); };
    await expect(refreshUpdateCheck({ installDir: dir, fetch: fakeFetch as typeof fetch, now: () => T0 })).resolves.toBeUndefined();
    expect(readCache(dir)).toEqual({ checkedAt: T0 });
  });

  test("a_hanging_server_is_cut_off_by_the_timeout", async () => {
    expect(FETCH_TIMEOUT_MS).toBeLessThanOrEqual(1500);
    const dir = installDir();
    let aborted = false;
    const hang = (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); });
    });
    const started = Date.now();
    await refreshUpdateCheck({ installDir: dir, fetch: hang as typeof fetch, now: () => T0, timeoutMs: 20 });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(readCache(dir)).toEqual({ checkedAt: T0 });
  });
});

describe("runUpgrade", () => {
  test("a_dev_checkout_is_told_to_pull_and_rebuild_itself", () => {
    const dir = installDir({ managed: false });
    const errs: string[] = [];
    const ran: string[][] = [];
    const code = runUpgrade([], { installDir: dir, err: (s) => errs.push(s), run: (args) => { ran.push(args); return 0; } });
    expect(code).not.toBe(0);
    expect(ran).toEqual([]);
    expect(errs.join("\n")).toMatch(/development checkout/);
    expect(errs.join("\n")).toMatch(/git pull/);
    expect(errs.join("\n")).toMatch(/npm run build/);
  });

  test("a_managed_install_runs_its_own_installer_update_passing_yes_and_dry_run", () => {
    const dir = installDir();
    const ran: string[][] = [];
    const run = (args: string[]) => { ran.push(args); return 7; };
    expect(runUpgrade(["--yes", "--dry-run"], { installDir: dir, err: () => {}, run })).toBe(7);
    expect(runUpgrade(["-y"], { installDir: dir, err: () => {}, run })).toBe(7);
    expect(ran).toEqual([
      [join(dir, "install.sh"), "upgrade", "--yes", "--dry-run"],
      [join(dir, "install.sh"), "upgrade", "--yes"],
    ]);
  });

  test("an_unknown_flag_is_refused_before_running_anything", () => {
    const dir = installDir();
    const ran: string[][] = [];
    const errs: string[] = [];
    expect(runUpgrade(["--delete-data"], { installDir: dir, err: (s) => errs.push(s), run: (a) => { ran.push(a); return 0; } })).toBe(1);
    expect(ran).toEqual([]);
    expect(errs.join("\n")).toMatch(/usage: mneme upgrade/);
  });
});
