import { ulid } from "ulid";
import type { Clock } from "../clock.js";

/**
 * Correlation id for one logical operation (a query and every candidate,
 * injection and reinforcement it causes). ULID rather than a random uuid so
 * ids sort chronologically and carry their own timestamp — a trace can be
 * reconstructed from the log without a separate index.
 */
export function newCorrId(clock: Clock): string {
  return ulid(clock.now());
}
