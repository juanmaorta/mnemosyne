import { describe, expect, test } from "vitest";
import {
  CODEX_SESSION_START_COMMAND,
  codexHookSnippet,
  codexSessionStartEnvelope,
  cwdFromHookPayload,
  hookSnippet,
  mergeCodexSessionStartHook,
  mergeSessionStartHook,
  SESSION_START_COMMAND,
} from "./hook.js";

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

// --- Codex CLI -------------------------------------------------------------
//
// Codex does not read a hook's raw stdout the way Claude Code does: a
// SessionStart hook must print one JSON object carrying `additionalContext`,
// and anything else is dropped without a word. That silence is why these are
// tested as pure functions — a malformed envelope looks exactly like a session
// with no memory.
describe("codexSessionStartEnvelope", () => {
  test("codex_envelope_carries_the_digest_where_codex_looks_for_it", () => {
    const parsed = JSON.parse(codexSessionStartEnvelope("# Memory\n- [a] one")) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("# Memory\n- [a] one");
  });

  test("codex_envelope_stays_valid_json_when_there_is_no_digest", () => {
    // The never-fail contract: an empty context is still a well-formed envelope.
    const parsed = JSON.parse(codexSessionStartEnvelope("")) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).toBe("");
  });

  test("codex_envelope_is_a_single_line_with_no_trailing_output", () => {
    expect(codexSessionStartEnvelope("a\nb")).toBe(
      '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"a\\nb"}}',
    );
  });
});

describe("cwdFromHookPayload", () => {
  test("cwd_from_hook_payload_reads_the_session_cwd", () => {
    const payload = JSON.stringify({ hook_event_name: "SessionStart", cwd: "/repos/thing", source: "startup" });
    expect(cwdFromHookPayload(payload)).toBe("/repos/thing");
  });

  test("cwd_from_hook_payload_gives_up_quietly_on_garbage", () => {
    // Anything unreadable falls back to the process cwd upstream; it must never
    // throw, because throwing here costs the session its whole digest.
    expect(cwdFromHookPayload("not json {{")).toBeUndefined();
    expect(cwdFromHookPayload("")).toBeUndefined();
    expect(cwdFromHookPayload(JSON.stringify({ cwd: 42 }))).toBeUndefined();
  });
});

describe("codexHookSnippet", () => {
  test("codex_snippet_matches_the_shape_codex_parses", () => {
    const parsed = JSON.parse(codexHookSnippet()) as {
      description: string;
      hooks: { SessionStart: { hooks: { type: string; command: string }[] }[] };
    };
    expect(parsed.description).toMatch(/Mnemosyne/);
    expect(parsed.hooks.SessionStart[0]!.hooks[0]).toMatchObject({
      type: "command",
      command: CODEX_SESSION_START_COMMAND,
    });
  });
});

describe("mergeCodexSessionStartHook", () => {
  test("merge_codex_hook_adds_it_to_an_empty_config", () => {
    const out = mergeCodexSessionStartHook({}, CODEX_SESSION_START_COMMAND) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    expect(out.hooks.SessionStart[0]!.hooks[0]!.command).toBe(CODEX_SESSION_START_COMMAND);
  });

  test("merge_codex_hook_preserves_other_events_and_the_description", () => {
    const existing = {
      description: "cosas mías",
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "otra" }] }] },
    };
    const out = mergeCodexSessionStartHook(existing, CODEX_SESSION_START_COMMAND) as Record<string, any>;
    expect(out.description).toBe("cosas mías");
    expect(out.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(out.hooks.SessionStart).toBeInstanceOf(Array);
  });

  test("merge_codex_hook_does_not_duplicate_an_identical_command", () => {
    const once = mergeCodexSessionStartHook({}, CODEX_SESSION_START_COMMAND);
    const twice = mergeCodexSessionStartHook(once, CODEX_SESSION_START_COMMAND) as {
      hooks: { SessionStart: unknown[] };
    };
    expect(twice.hooks.SessionStart).toHaveLength(1);
  });

  test("merge_codex_hook_tolerates_a_null_group_in_the_existing_file", () => {
    const malformed = { hooks: { SessionStart: [null, { hooks: [{ type: "command", command: "other" }] }] } };
    const out = mergeCodexSessionStartHook(malformed, CODEX_SESSION_START_COMMAND) as {
      hooks: { SessionStart: unknown[] };
    };
    expect(out.hooks.SessionStart).toHaveLength(3);
  });
});
