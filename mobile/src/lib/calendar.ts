// The calendar's range read, on the phone (myne-md/myne#1037).
//
// One wrapper, because the host command is the ONE answer to "what happens
// between these two instants" and three surfaces ask it: the desktop pane, this
// screen, and the agent's `calendar_range` tool. The TYPE is the shared one
// (`@myne/vault-indices`, imported type-only so nothing from the desktop tree
// reaches this bundle); only the invoke is per-client, which is the seam rule.

import { invoke } from "../platform/core";
import type { CalendarRange } from "@myne/vault-indices";

/**
 * The rows between two wall-clock instants.
 *
 * `bounded` is the caller's choice and not a performance hint: the user's own
 * screens ask unbounded, and the agent asks bounded, which is where the 366-day
 * refusal lives. A phone screen is the user's own surface, so it asks unbounded.
 */
export function vaultIndicesCalendarRange(
  windowStart: string,
  windowEnd: string,
  bounded: boolean,
): Promise<CalendarRange> {
  return invoke<CalendarRange>("plugin:vault-indices|vault_indices_calendar_range", {
    windowStart,
    windowEnd,
    bounded,
  });
}
