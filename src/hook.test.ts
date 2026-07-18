import { describe, expect, test } from "vitest";
import { hookSnippet, mergeSessionStartHook, SESSION_START_COMMAND } from "./hook.js";

describe("hookSnippet", () => {
  test("hookSnippet_is_valid_json_with_session_start_command", () => {
    const parsed = JSON.parse(hookSnippet()) as { hooks: { SessionStart: unknown[] } };
    expect(parsed.hooks.SessionStart).toBeInstanceOf(Array);
    expect(hookSnippet()).toContain(SESSION_START_COMMAND);
  });
});

describe("mergeSessionStartHook", () => {
  test("mergeSessionStartHook_adds_hook_to_empty_settings", () => {
    const out = mergeSessionStartHook({}, "mneme context") as { hooks: { SessionStart: { hooks: { type: string; command: string }[] }[] } };
    expect(out.hooks.SessionStart[0]!.hooks[0]).toEqual({ type: "command", command: "mneme context" });
  });
  test("mergeSessionStartHook_preserves_existing_keys", () => {
    const out = mergeSessionStartHook({ model: "opus", hooks: { Stop: [] } }, "mneme context") as Record<string, any>;
    expect(out.model).toBe("opus");
    expect(out.hooks.Stop).toEqual([]);
    expect(out.hooks.SessionStart).toBeInstanceOf(Array);
  });
  test("mergeSessionStartHook_does_not_duplicate_identical_command", () => {
    const once = mergeSessionStartHook({}, "mneme context");
    const twice = mergeSessionStartHook(once, "mneme context") as { hooks: { SessionStart: unknown[] } };
    expect(twice.hooks.SessionStart).toHaveLength(1);
  });
  test("mergeSessionStartHook_tolerates_null_group_in_existing_settings", () => {
    // Malformed/hand-edited settings.json can contain a null entry in the array.
    const malformed = { hooks: { SessionStart: [null, { hooks: [{ type: "command", command: "other" }] }] } };
    const out = mergeSessionStartHook(malformed, "mneme context") as { hooks: { SessionStart: unknown[] } };
    expect(out.hooks.SessionStart).toHaveLength(3);
  });
});
