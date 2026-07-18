import { readFileSync } from "node:fs";
import { DEFAULT_SCOPE } from "../store.js";

export interface OwnerPolicy {
  owns: string[];
}

/**
 * Machine-local owner policy (`~/memory/.owner`, `.stignore` in Phase 4).
 * Fail-closed: an absent, unreadable, or malformed file → `personal`-only.
 * Owning any other scope is a deliberate, explicit declaration.
 */
export function loadOwnerPolicy(path: string): OwnerPolicy {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (raw !== null && typeof raw === "object" && Array.isArray((raw as { owns?: unknown }).owns)) {
      const owns = (raw as { owns: unknown[] }).owns.filter((s): s is string => typeof s === "string");
      return { owns };
    }
  } catch {
    // fall through to the fail-closed default
  }
  return { owns: [DEFAULT_SCOPE] };
}

export function ownsScope(policy: OwnerPolicy, scope: string): boolean {
  return policy.owns.includes(scope);
}
