import { describe, expect, test } from "vitest";
import { retryOnBusy } from "./retry-busy.js";

/** better-sqlite3 stamps a `.code` on the thrown error; a lock loss is `SQLITE_BUSY*`. */
function busy(code = "SQLITE_BUSY"): Error & { code: string } {
  const e = new Error("database is locked") as Error & { code: string };
  e.code = code;
  return e;
}

describe("retryOnBusy", () => {
  test("retries_a_busy_operation_until_it_succeeds", () => {
    let attempts = 0;
    const out = retryOnBusy(() => {
      attempts++;
      if (attempts < 3) throw busy();
      return "indexed";
    }, { sleep: () => {} });

    expect(out).toBe("indexed");
    expect(attempts).toBe(3);
  });

  test("retries_a_busy_snapshot_the_same_way", () => {
    let attempts = 0;
    const out = retryOnBusy(() => {
      attempts++;
      if (attempts < 2) throw busy("SQLITE_BUSY_SNAPSHOT");
      return "ok";
    }, { sleep: () => {} });

    expect(out).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("does_not_retry_a_genuine_error_like_a_unique_collision", () => {
    let attempts = 0;
    const collision = new Error("UNIQUE constraint failed: engrams.scope, engrams.slug") as Error & { code: string };
    collision.code = "SQLITE_CONSTRAINT_UNIQUE";

    expect(() => retryOnBusy(() => { attempts++; throw collision; }, { sleep: () => {} }))
      .toThrow(collision);
    // One attempt, no retries: a real collision is not transient.
    expect(attempts).toBe(1);
  });

  test("gives_up_after_the_retry_budget_and_rethrows_the_busy_error", () => {
    let attempts = 0;
    expect(() => retryOnBusy(() => { attempts++; throw busy("SQLITE_BUSY_TIMEOUT"); },
      { retries: 4, sleep: () => {} })).toThrow(/database is locked/);
    // 1 initial attempt + 4 retries.
    expect(attempts).toBe(5);
  });
});
