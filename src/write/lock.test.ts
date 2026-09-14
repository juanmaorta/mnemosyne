// src/write/lock.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

/**
 * A seam for the one failure that cannot be provoked from outside: the write
 * that stamps pid+timestamp into an already-created lock file (ENOSPC/EDQUOT/EIO
 * on a synced store). Everything else delegates to the real fs.
 */
const fsHook = vi.hoisted(() => ({ failWrite: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (...args: unknown[]): number => {
      if (fsHook.failWrite) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      return (actual.writeSync as (...a: unknown[]) => number)(...args);
    },
  };
});
import { LockBusyError, scopeLockPath, withScopeLock } from "./lock.js";
import { listEngramFiles } from "../index/walk.js";

function store(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "mneme-lock-"));
  const dir = join(root, "personal");
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

describe("withScopeLock", () => {
  test("lock_is_held_during_the_callback_and_released_after", () => {
    const { dir } = store();
    const path = scopeLockPath(dir);

    const seen = withScopeLock(dir, () => existsSync(path));

    expect(seen).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("lock_file_records_pid_for_manual_diagnosis", () => {
    const { dir } = store();
    const contents = withScopeLock(dir, () => readFileSync(scopeLockPath(dir), "utf8"));
    expect(contents).toContain(String(process.pid));
    expect(contents).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/); // ISO timestamp
  });

  test("lock_is_released_after_the_wrapped_fn_throws", () => {
    const { dir } = store();
    const path = scopeLockPath(dir);

    expect(() => withScopeLock(dir, () => { throw new Error("boom"); })).toThrow("boom");

    expect(existsSync(path)).toBe(false);
    // And the next writer can take it.
    expect(withScopeLock(dir, () => "ok")).toBe("ok");
  });

  test("busy_lock_times_out_with_the_lock_path_and_the_holder", () => {
    const { dir } = store();
    const path = scopeLockPath(dir);
    writeFileSync(path, "99999 2026-09-11T10:00:00.000Z\n"); // another writer holds it

    let err: unknown;
    try {
      withScopeLock(dir, () => "never", { timeoutMs: 30, pollMs: 5 });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(LockBusyError);
    expect((err as LockBusyError).lockPath).toBe(path);
    expect((err as LockBusyError).holder).toContain("99999");
  });

  test("a_lock_it_did_not_acquire_is_never_deleted", () => {
    const { dir } = store();
    const path = scopeLockPath(dir);
    writeFileSync(path, "99999 2026-09-11T10:00:00.000Z\n");

    expect(() => withScopeLock(dir, () => "never", { timeoutMs: 10, pollMs: 5 })).toThrow(LockBusyError);

    // Never recovered by age: a slow writer may still be alive.
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("99999");
  });

  test("lock_is_released_when_stamping_the_holder_fails", () => {
    const { dir } = store();
    // ENOSPC/EDQUOT/EIO while writing pid+timestamp: the file is already on disk,
    // and nothing reclaims a lock by age, so it must not survive the failure.
    fsHook.failWrite = true;
    try {
      expect(() => withScopeLock(dir, () => "never")).toThrow(/no space left/);
    } finally {
      fsHook.failWrite = false;
    }

    expect(existsSync(scopeLockPath(dir))).toBe(false);
    expect(withScopeLock(dir, () => "ok")).toBe("ok");
  });

  test("async_callback_is_refused_and_the_lock_released", () => {
    const { dir } = store();

    expect(() =>
      // @ts-expect-error an async callback would release the lock before it settles
      withScopeLock(dir, async () => "nope"),
    ).toThrow(/synchronous/);

    expect(existsSync(scopeLockPath(dir))).toBe(false);
  });

  test("lock_file_is_never_picked_up_by_the_index_walker", () => {
    const { root, dir } = store();
    writeFileSync(join(dir, "una-nota.md"), "---\nname: una-nota\n---\ncuerpo\n");

    const files = withScopeLock(dir, () => listEngramFiles(root));

    expect(files.map((f) => f.path)).toEqual([join(dir, "una-nota.md")]);
  });
});
