// Which colour a calendar draws in (myne-md/myne#1037, task 5).
//
// The user's choice lives in prefs as a **design-token name** (`calendar_settings`
// key `colours.<name>`), never as a colour literal, so a custom theme repaints the
// calendar with the rest of the app. This module turns a name plus the settings map
// into the `var(--...)` a renderer can use, and nothing else.
//
// **A doc exhausted**: an unset or unknown calendar still gets a colour, derived
// from the name rather than left grey. Two calendars that collide are acceptable;
// a calendar that renders identically to its neighbour because the user never
// opened Settings is not, and that is the state every imported calendar starts in.
//
// The palette is the eight `--group-*` tokens the graph's colour rules and the
// item-colour decoration already share (`GROUP_COLOR_PALETTE`), so the calendar has
// no private palette to drift from the design system.

import { GROUP_COLOR_PALETTE, colorGroupVar } from "../graphColorGroups";
import { resolveCalendarColour } from "../../lib/prefs";

/** The token name a calendar draws in, resolving a derived default when unset. */
function calendarColourToken(
  settings: Readonly<Record<string, string>>,
  calendarName: string | null | undefined,
): string {
  if (calendarName === null || calendarName === undefined || calendarName === "") {
    // The default calendar (an event with no `calendar:` field).
    return GROUP_COLOR_PALETTE[0]!.key;
  }
  const stored = resolveCalendarColour(settings, calendarName);
  if (stored !== undefined && isPaletteToken(stored)) return stored;
  return derivedToken(calendarName);
}

/** The `var(--…)` a renderer paints with. */
export function calendarColour(
  settings: Readonly<Record<string, string>>,
  calendarName: string | null | undefined,
): string {
  return colorGroupVar(calendarColourToken(settings, calendarName));
}

function isPaletteToken(name: string): boolean {
  return GROUP_COLOR_PALETTE.some((entry) => entry.key === name);
}

/**
 * A stable token for a name the user never assigned, so two calendars differ
 * without a settings visit.
 *
 * A tiny FNV-style fold over the name (case-folded, so `Work` and `work` are one
 * calendar, matching the segment identity rule §3.10.1 inherits). Deliberately not
 * `crypto.subtle` or a hash dependency: this decides a hue, and a stable sum is
 * enough for that.
 */
function derivedToken(name: string): string {
  const folded = name.normalize("NFC").toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < folded.length; i++) {
    hash ^= folded.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return GROUP_COLOR_PALETTE[hash % GROUP_COLOR_PALETTE.length]!.key;
}
