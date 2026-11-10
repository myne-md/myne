// Which calendars the view shows, and which ones exist (owner, 2026-11-10).
//
// A calendar is not a table anywhere: it is the `calendar:` value on an event plus,
// optionally, a colour the user assigned to that NAME in prefs. So "the calendars I
// have" is the union of the two, and "the ones I am looking at" is that union minus
// the names the user switched off. Both questions are answered here so the desktop
// pane and the phone cannot disagree about which rows a view should draw.
//
// **Hidden is stored, not merely remembered.** It rides the same flat prefs map the
// colours do (`calendar_settings`), one entry per setting — `hidden.<name>` — because
// protocol.md §9.5.2 makes the ENTRY the field clock: switching one calendar off on a
// laptop and another off on a phone in the same round has to keep both.
//
// **A name is one calendar, case-folded**, matching the colour resolver's fold: `Work`
// and `work` are the same calendar, which is the identity rule §3.10.1 inherits.

/** The prefs key prefix a calendar's visibility lives under. */
export const CALENDAR_HIDDEN_SETTING_PREFIX = "hidden.";

/** The value a visible calendar may still carry: absence is the default. */
export const CALENDAR_HIDDEN_VALUE = "1";

/** The calendar an event with no `calendar:` field belongs to. */
export const DEFAULT_CALENDAR = "";

/** The fold that makes `Work` and `work` one calendar. */
function fold(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Every calendar name the vault knows: the ones with a colour, plus the ones an
 * event carries. Sorted for a stable menu, with the default calendar first.
 */
export function knownCalendars(
  settings: Readonly<Record<string, string>>,
  rows: readonly { readonly calendar?: string | null }[],
  colourPrefix: string,
): string[] {
  const names = new Map<string, string>();
  for (const key of Object.keys(settings)) {
    if (!key.startsWith(colourPrefix) && !key.startsWith(CALENDAR_HIDDEN_SETTING_PREFIX)) continue;
    const name =
      key.startsWith(colourPrefix)
        ? key.slice(colourPrefix.length)
        : key.slice(CALENDAR_HIDDEN_SETTING_PREFIX.length);
    if (name !== "") names.set(fold(name), name);
  }
  for (const row of rows) {
    if (row.calendar === null || row.calendar === undefined || row.calendar === "") continue;
    if (!names.has(fold(row.calendar))) names.set(fold(row.calendar), row.calendar);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

/** Whether a calendar's events are drawn right now. */
export function isCalendarVisible(
  settings: Readonly<Record<string, string>>,
  name: string | null | undefined,
): boolean {
  if (name === null || name === undefined || name === "") return true;
  const wanted = fold(name);
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(CALENDAR_HIDDEN_SETTING_PREFIX)) continue;
    if (fold(key.slice(CALENDAR_HIDDEN_SETTING_PREFIX.length)) !== wanted) continue;
    return value !== CALENDAR_HIDDEN_VALUE;
  }
  return true;
}

/** The rows a view draws: every visible calendar, and the ones with no calendar. */
export function visibleRows<T extends { readonly calendar?: string | null }>(
  settings: Readonly<Record<string, string>>,
  rows: readonly T[],
): T[] {
  return rows.filter((row) => isCalendarVisible(settings, row.calendar));
}

/** The prefs entry that hides or shows one calendar, or `null` to write "shown". */
export function hiddenSettingFor(name: string, hidden: boolean): { key: string; value: string | null } {
  return {
    key: `${CALENDAR_HIDDEN_SETTING_PREFIX}${name}`,
    value: hidden ? CALENDAR_HIDDEN_VALUE : null,
  };
}
