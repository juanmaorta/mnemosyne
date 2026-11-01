import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

/** A SessionStart command hook is Mnemosyne's if it runs `mneme context`. */
function isMnemosyneHook(h: CommandHook): boolean {
  return h.type === "command" && typeof h.command === "string" && h.command.startsWith(SESSION_START_COMMAND);
}

/** Single-quote a value for the shell, escaping embedded single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * One whitespace-separated word of a command, kept with its source offsets so a
 * single option can be spliced out without reflowing the rest.
 */
interface ShellToken {
  /** Offset of the token's first char in the command. */
  start: number;
  /** Offset just past the token's last char. */
  end: number;
  /**
   * The token's LEADING run of UNQUOTED characters. An option flag (`--root`,
   * `--emit`, `--root=…`) is written bare at a token's start, so this is how we
   * tell a real flag from a path value that merely CONTAINS `--root`/`--emit`
   * (there the leading char is a quote and this is empty).
   */
  bareLead: string;
}

/**
 * Split a command into shell words, honoring `'…'`, `"…"` (with `\` escapes) and
 * bare `\` escapes — the quoting `shellQuote` emits and the forms a user may
 * hand-write. Returns null on an unterminated quote: a command we cannot reason
 * about, so the caller leaves it untouched rather than corrupt it. Shell control
 * operators are not interpreted here (`isSimpleMnemosyneCommand` rejects those
 * first); this only needs to find token and option boundaries correctly.
 */
function tokenizeCommand(command: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  const n = command.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(command[i]!)) i++;
    if (i >= n) break;
    const start = i;
    let bareLead = "";
    let stillBare = true;
    while (i < n && !/\s/.test(command[i]!)) {
      const c = command[i]!;
      if (c === "'") {
        stillBare = false;
        i++;
        while (i < n && command[i] !== "'") i++;
        if (i >= n) return null; // unterminated '
        i++;
      } else if (c === '"') {
        stillBare = false;
        i++;
        while (i < n && command[i] !== '"') {
          if (command[i] === "\\" && i + 1 < n) i++; // skip the escaped char
          i++;
        }
        if (i >= n) return null; // unterminated "
        i++;
      } else if (c === "\\") {
        stillBare = false;
        i = Math.min(i + 2, n); // the escaped char
      } else {
        if (stillBare) bareLead += c;
        i++;
      }
    }
    tokens.push({ start, end: i, bareLead });
  }
  return tokens;
}

/** Remove `command[start,end)` and re-append `tail`, with clean single spaces. */
function spliceAndAppend(command: string, start: number, end: number, tail: string): string {
  const before = command.slice(0, start).replace(/\s+$/, "");
  const after = command.slice(end).replace(/^\s+/, "");
  const head = after ? `${before} ${after}` : before;
  return `${head} ${tail}`;
}

/**
 * Set `--root <root>` on a `mneme context` command, REPLACING any existing
 * `--root` option and PRESERVING every other argument (e.g. `--scope`,
 * `--budget`) verbatim. "Existing option" means a real flag at a token start
 * (`--root value` across two tokens, or a self-contained `--root=value`) — NOT
 * the string `--root` buried inside another argument's quoted value, which must
 * be left alone. When the command cannot be tokenized (unterminated quote), the
 * root is just appended; such commands never reach here (see
 * `isSimpleMnemosyneCommand`).
 */
function withRoot(command: string, root: string): string {
  const tail = `--root ${shellQuote(root)}`;
  const tokens = tokenizeCommand(command);
  if (tokens === null) return `${command} ${tail}`;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.bareLead === "--root") {
      const value = tokens[k + 1]; // `--root value`: drop both tokens
      return spliceAndAppend(command, t.start, value ? value.end : t.end, tail);
    }
    if (t.bareLead.startsWith("--root=")) return spliceAndAppend(command, t.start, t.end, tail); // `--root=value`
  }
  return `${command} ${tail}`;
}

/**
 * Codex drops a hook's plain stdout, so its command must ask for the envelope.
 * Detect `--emit` as an actual option (a flag at a token start), not as a
 * substring of some path value like `/tmp/--emit-memory`.
 */
function withEmit(command: string): string {
  const tokens = tokenizeCommand(command);
  const present = tokens !== null && tokens.some((t) => t.bareLead === "--emit" || t.bareLead.startsWith("--emit="));
  return present ? command : `${command} --emit codex-session-start`;
}

/**
 * A plain `mneme context …` invocation we can safely rewrite by appending flags.
 * A command with shell control operators (pipes, `&&`/`||`/`;`, redirects,
 * substitutions, comments) is a user-crafted pipeline where appending `--root`
 * would land on the wrong command, and one we cannot tokenize (unterminated
 * quote) is unparseable — both are left untouched rather than corrupted.
 */
function isSimpleMnemosyneCommand(command: string): boolean {
  if (!isMnemosyneHook({ type: "command", command })) return false;
  // Check for operators OUTSIDE quoted arguments, so a quoted path with a shell
  // metacharacter (e.g. `--root '/tmp/Research & Notes'`, which the installer
  // itself emits) is still recognized as simple and stays migratable.
  const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\\./g, "");
  if (/[|&;<>\n`#]|\$\(/.test(unquoted)) return false;
  return tokenizeCommand(command) !== null;
}

/**
 * Install Mnemosyne's SessionStart hook, RECONCILING any it already owns by
 * migrating IN PLACE: every existing `mneme context…` command is rewritten to the
 * new command (so a bare `install-hook` entry picks up `init`'s `--root`, and a
 * re-init with another root updates it) while keeping each hook's own group —
 * its `matcher`, its `timeout`, its position. That preserves separate matcher
 * groups (e.g. startup AND resume) instead of collapsing them, and avoids the
 * two-stores accumulation the exact-string dedup allowed. Only when the store
 * owns no SessionStart hook at all is a fresh group added. Unrelated hooks and
 * malformed null groups are left untouched.
 */
/**
 * Install/reconcile Mnemosyne's SessionStart hook IN PLACE. Each existing
 * `mneme context…` command is kept where it is — its matcher group, its
 * `timeout`, its position — and, when a `root` is given (`init`), gets its
 * `--root` set to that store while every other argument is preserved. Without a
 * `root` (`install-hook`) existing commands are left exactly as they are, so
 * running it after `init` never redirects sessions off the initialized store.
 * Only when the store owns no SessionStart hook at all is a fresh one added.
 * Unrelated hooks and malformed null groups are untouched.
 */
function reconcileSessionStartHook(
  config: Record<string, unknown>,
  opts: { codex: boolean; root?: string },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  const hooks = { ...((next.hooks as Record<string, unknown>) ?? {}) };
  const groups = Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as (HookGroup | null)[]) : [];
  const base = opts.codex ? CODEX_SESSION_START_COMMAND : SESSION_START_COMMAND;
  let found = false;
  const result = groups.map((g) => {
    if (g == null) return g;
    const seen = new Set<string>();
    const rebuilt: CommandHook[] = [];
    for (const h of g.hooks ?? []) {
      if (!isMnemosyneHook(h)) { rebuilt.push(h); continue; }
      found = true;
      // A user-crafted compound command (pipe, &&, redirect…) is left exactly as
      // is: appending flags would attach them to the wrong command. It still
      // counts as found, so no duplicate is added alongside it.
      if (!isSimpleMnemosyneCommand(h.command)) { rebuilt.push(h); continue; }
      // Rewrite in place, preserving other args: for Codex ensure the `--emit`
      // envelope (its plain stdout is dropped); when a root is set (`init`)
      // ensure `--root`. A plain `install-hook` (no codex, no root) is a no-op,
      // so it never redirects a session off an already-configured store.
      let command = h.command;
      if (opts.codex) command = withEmit(command);
      if (opts.root !== undefined) command = withRoot(command, opts.root);
      if (seen.has(command)) continue; // drop a within-group duplicate
      seen.add(command);
      rebuilt.push(opts.codex ? { ...h, command, timeout: h.timeout ?? CODEX_HOOK_TIMEOUT_SECONDS } : { ...h, command });
    }
    return { ...g, hooks: rebuilt };
  });
  if (!found) {
    const command = opts.root !== undefined ? withRoot(base, opts.root) : base;
    const entry: CommandHook = opts.codex
      ? { type: "command", command, timeout: CODEX_HOOK_TIMEOUT_SECONDS }
      : { type: "command", command };
    result.push({ hooks: [entry] });
  }
  hooks.SessionStart = result;
  next.hooks = hooks;
  return next;
}

/**
 * Idempotently install the SessionStart hook into a settings/hooks file, keeping
 * every other key intact and reconciling any prior Mnemosyne hook. Shared by
 * `install-hook` ({ codex }) and `init` ({ root }). Returns `"parse-error"` when
 * the existing file is present but not valid JSON (the caller must not clobber a
 * hand-edited file it cannot understand); a missing file is fine.
 */
export function installSessionStartHook(
  settingsPath: string,
  opts: { codex?: boolean; root?: string } = {},
): "installed" | "unchanged" | "parse-error" {
  let current: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = readFileSync(settingsPath, "utf8");
    current = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return "parse-error";
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  const reconciled = reconcileSessionStartHook(current, {
    codex: opts.codex ?? false,
    ...(opts.root !== undefined ? { root: opts.root } : {}),
  });
  const next = `${JSON.stringify(reconciled, null, 2)}\n`;
  if (raw === next) return "unchanged";
  writeFileSync(settingsPath, next);
  return "installed";
}

/**
 * Remove every Mnemosyne SessionStart hook (any `mneme context…` command) from a
 * settings/hooks file, for the installer's uninstall (MNE-97). The inverse of
 * `installSessionStartHook`: unrelated hooks, keys and matcher groups stay; a
 * group left empty BY THIS removal is dropped, and so is a `SessionStart` key
 * left empty, and a `hooks` object left with no keys at all. `dryRun` reports without writing. A missing file is nothing to
 * do; an unparseable one is refused, never rewritten.
 */
export function uninstallSessionStartHook(
  settingsPath: string,
  opts: { dryRun?: boolean } = {},
): { status: "removed" | "absent" | "parse-error"; removed: string[] } {
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return { status: (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "parse-error", removed: [] };
  }
  const hooks = current.hooks as Record<string, unknown> | undefined;
  const groups = hooks && Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as (HookGroup | null)[]) : [];
  const removed: string[] = [];
  const kept = groups.flatMap((g) => {
    if (g == null || !Array.isArray(g.hooks)) return [g];
    const rest = g.hooks.filter((h) => {
      if (!isMnemosyneHook(h)) return true;
      removed.push(h.command);
      return false;
    });
    if (rest.length === g.hooks.length) return [g];
    return rest.length === 0 ? [] : [{ ...g, hooks: rest }];
  });
  if (removed.length === 0) return { status: "absent", removed };
  if (!opts.dryRun) {
    const nextHooks: Record<string, unknown> = { ...hooks };
    if (kept.length === 0) delete nextHooks.SessionStart;
    else nextHooks.SessionStart = kept;
    const next: Record<string, unknown> = { ...current, hooks: nextHooks };
    if (Object.keys(nextHooks).length === 0) delete next.hooks;
    writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return { status: "removed", removed };
}
