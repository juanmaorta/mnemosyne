export const SESSION_START_COMMAND = "mneme context";

/**
 * Codex needs the digest wrapped (see `codexSessionStartEnvelope`), so its hook
 * calls the CLI in a different mode. The session's real cwd arrives on the
 * hook's stdin, which is why no `--cwd` is baked into the command here.
 */
export const CODEX_SESSION_START_COMMAND = "mneme context --emit codex-session-start";

/**
 * Seconds Codex waits for the hook. The digest reindexes lazily and may call
 * the embedder, so the default is generous: a hook killed mid-run yields no
 * memory at all, and Codex says nothing about why.
 */
const CODEX_HOOK_TIMEOUT_SECONDS = 20;

interface CommandHook { type: "command"; command: string; timeout?: number }
interface HookGroup { hooks?: CommandHook[] }

export function hookSnippet(): string {
  return JSON.stringify(
    { hooks: { SessionStart: [{ hooks: [{ type: "command", command: SESSION_START_COMMAND }] }] } },
    null,
    2,
  );
}

/** `~/.codex/hooks.json`. Same nesting as Claude Code's settings, plus a description. */
export function codexHookSnippet(): string {
  return JSON.stringify(
    {
      description: "Mnemosyne — ambient memory digest at session start",
      hooks: {
        SessionStart: [{
          hooks: [{ type: "command", command: CODEX_SESSION_START_COMMAND, timeout: CODEX_HOOK_TIMEOUT_SECONDS }],
        }],
      },
    },
    null,
    2,
  );
}

/**
 * What Codex accepts from a SessionStart hook. Claude Code injects a hook's raw
 * stdout; Codex reads this one object and **silently drops** anything else, so
 * a session with a broken envelope is indistinguishable from a session with no
 * memory. Everything that can fail upstream must still end up in here.
 */
export function codexSessionStartEnvelope(additionalContext: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } });
}

/**
 * The cwd Codex reports on the hook's stdin. Undefined for anything unreadable:
 * the caller falls back to the process cwd, because guessing wrong costs one
 * scope while throwing costs the whole digest.
 */
export function cwdFromHookPayload(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { cwd?: unknown };
    return typeof parsed.cwd === "string" && parsed.cwd.length > 0 ? parsed.cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Add one SessionStart command hook, keeping everything else untouched. Shared
 * by both harnesses: `~/.claude/settings.json` and `~/.codex/hooks.json` nest
 * hooks identically, and both are hand-edited files we must not flatten.
 */
function mergeSessionStartEntry(config: Record<string, unknown>, entry: CommandHook): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  const hooks = { ...((next.hooks as Record<string, unknown>) ?? {}) };
  const sessionStart = Array.isArray(hooks.SessionStart) ? [...(hooks.SessionStart as HookGroup[])] : [];
  const already = sessionStart.some((g) => g && g.hooks?.some((h) => h.type === "command" && h.command === entry.command));
  if (!already) sessionStart.push({ hooks: [entry] });
  hooks.SessionStart = sessionStart;
  next.hooks = hooks;
  return next;
}

export function mergeSessionStartHook(settings: Record<string, unknown>, command: string): Record<string, unknown> {
  return mergeSessionStartEntry(settings, { type: "command", command });
}

export function mergeCodexSessionStartHook(config: Record<string, unknown>, command: string): Record<string, unknown> {
  return mergeSessionStartEntry(config, { type: "command", command, timeout: CODEX_HOOK_TIMEOUT_SECONDS });
}
