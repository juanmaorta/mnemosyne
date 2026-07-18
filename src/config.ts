import { homedir } from "node:os";
import { join } from "node:path";

export function resolveRoot(flag?: string): string {
  return flag ?? process.env.MNEMOSYNE_ROOT ?? join(homedir(), "memory");
}
