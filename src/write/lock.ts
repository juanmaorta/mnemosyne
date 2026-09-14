// src/write/lock.ts
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * Local mutual exclusion between `mneme` processes writing the SAME scope.
 *
 * What this guarantees: two CLI invocations on one machine never interleave a
 * read-modify-write of the same scope. What it does NOT: distributed CAS, or any
 * protection against Obsidian, Syncthing or a hand `vim` — they ignore the file.
 * So the lock never replaces `O_EXCL` on create or the revision check on update;
 * it only keeps our own writers from racing each other.
 *
 * The lock file is transient machine-local state: hidden (so the index walker,
 * which only picks up `.md`, and Syncthing-style ignores never see it) and never
 * meant to be synced.
 */

/** Hidden so `listEngramFiles` and sync ignores skip it. */
export const LOCK_FILENAME = ".mneme-write.lock";

/** Default bounded wait. Long enough for a queue of short writes, short enough to notice. */
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 25;

export function scopeLockPath(scopeDir: string): string {
  return join(scopeDir, LOCK_FILENAME);
}

export class LockBusyError extends Error {
  constructor(readonly lockPath: string, readonly holder?: string) {
    super(
      `scope is locked by another mneme write: ${lockPath}` +
        (holder ? ` (held by ${holder})` : ""),
    );
    this.name = "LockBusyError";
  }
}

export interface ScopeLockOptions {
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Blocking sleep. The write path is synchronous end to end (better-sqlite3 style),
 * so there is no event loop to yield to and nothing to await — `Atomics.wait` is
 * the sleep primitive that needs no dependency.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** pid + timestamp of the holder, for a human diagnosing a stuck lock. */
function readHolder(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text.length > 0 ? text.slice(0, 200) : undefined;
  } catch {
    return undefined; // released between the EEXIST and this read — fine
  }
}

/**
 * Rejects a callback whose result is a promise: `fn` must be synchronous.
 * `T` sits naked in the intersection so it still infers from the callback,
 * while the conditional collapses an async callback's parameter type to
 * `() => never` — a compile error at the call site, before the runtime guard.
 */
type Sync<T> = T extends PromiseLike<unknown> ? never : unknown;

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Runs `fn` holding the scope's write lock. The scope directory must already
 * exist: creating it is the caller's decision (it means materializing a scope),
 * and that happens only after the scope and owner gates have passed.
 *
 * A held lock is NEVER broken by age — a slow writer may still be alive. Manual
 * recovery only: check that no `mneme` process is running, then delete the file.
 */
export function withScopeLock<T>(
  scopeDir: string,
  fn: () => T & Sync<T>,
  opts: ScopeLockOptions = {},
): T {
  const path = scopeLockPath(scopeDir);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  let fd: number;
  for (;;) {
    try {
      fd = openSync(path, "wx"); // O_CREAT|O_EXCL: the atomic acquire
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new LockBusyError(path, readHolder(path));
      sleepSync(Math.min(pollMs, remaining));
    }
  }

  // Everything from here on is inside the releasing `finally`: once the file
  // exists it is ours to remove, and a failure while stamping it (ENOSPC on a
  // synced store, say) must not wedge the scope — nothing reclaims a lock by age.
  try {
    try {
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    } finally {
      closeSync(fd);
    }
    const result = fn();
    // A promise would settle long after the `finally` below released the lock,
    // so mutual exclusion would be silently gone. Refuse loudly instead.
    if (isThenable(result)) {
      throw new Error("withScopeLock callback must be synchronous (an async one would release the lock before it settles)");
    }
    return result;
  } finally {
    // Only ever the lock THIS call acquired: on the busy path we threw above and
    // never reach here, so a foreign holder's file is never touched.
    try {
      unlinkSync(path);
    } catch {
      // Someone removed it by hand mid-write; nothing left to release.
    }
  }
}
