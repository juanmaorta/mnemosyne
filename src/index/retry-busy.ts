// A bounded retry for SQLite lock loss.
//
// `busy_timeout` (set in db.ts) already makes a writer WAIT for the lock up
// front, so BEGIN IMMEDIATE blocks instead of failing instantly. But that
// window is finite: under a storm of concurrent `mneme` processes on one store
// — several harnesses, or the whole test suite racing — a machine starved of
// CPU can let even a 5 s timeout expire, and better-sqlite3 then THROWS
// `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT`/`SQLITE_BUSY_TIMEOUT`. In reindex that
// throw was swallowed into `errors++`, so a transient lock loss looked exactly
// like real corruption. This retries only that transient case, a few more
// times with backoff, and leaves every other error — a genuine UNIQUE
// collision, say — to propagate on the first attempt, because it is not
// transient and retrying it only hides it.

/** Pause the calling thread without spinning. better-sqlite3 is synchronous, so
 *  the retry loop must be too; `Atomics.wait` on a throwaway buffer sleeps the
 *  thread the way `src/write/lock.ts` already does for the scope lock. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusy(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

export interface RetryOnBusyOptions {
  /** Extra attempts after the first. Default 5 (so up to 6 tries in all). */
  retries?: number;
  /** Injected for tests; defaults to exponential backoff with jitter. */
  sleep?: (attempt: number) => void;
}

/**
 * Run `fn`, retrying it only while it throws a `SQLITE_BUSY*` error, up to
 * `retries` extra times. Any other error — and the busy error once the budget
 * is spent — is rethrown unchanged.
 */
export function retryOnBusy<T>(fn: () => T, opts?: RetryOnBusyOptions): T {
  const retries = opts?.retries ?? 5;
  const sleep = opts?.sleep ?? ((attempt: number) =>
    // 10, 20, 40, 80… ms capped at 250, plus up to one step of jitter so a herd
    // of waiters does not re-collide in lockstep.
    sleepSync(Math.min(10 * 2 ** attempt, 250) + Math.floor(Math.random() * 10 * 2 ** attempt)));

  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!isBusy(e) || attempt >= retries) throw e;
      sleep(attempt);
    }
  }
}
