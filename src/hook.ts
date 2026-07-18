export const SESSION_START_COMMAND = "mneme context";

interface CommandHook { type: "command"; command: string }
interface HookGroup { hooks?: CommandHook[] }

export function hookSnippet(): string {
  return JSON.stringify(
    { hooks: { SessionStart: [{ hooks: [{ type: "command", command: SESSION_START_COMMAND }] }] } },
    null,
    2,
  );
}

export function mergeSessionStartHook(settings: Record<string, unknown>, command: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...settings };
  const hooks = { ...((next.hooks as Record<string, unknown>) ?? {}) };
  const sessionStart = Array.isArray(hooks.SessionStart) ? [...(hooks.SessionStart as HookGroup[])] : [];
  const already = sessionStart.some((g) => g && g.hooks?.some((h) => h.type === "command" && h.command === command));
  if (!already) sessionStart.push({ hooks: [{ type: "command", command }] });
  hooks.SessionStart = sessionStart;
  next.hooks = hooks;
  return next;
}
