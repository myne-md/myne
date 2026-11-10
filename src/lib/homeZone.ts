// The second clock: what an event's time reads as in the user's HOME zone.
//
// An event's stored time is a local wall clock (§3.10.2). That is deliberate, and
// this module is what keeps it deliberate: nothing about a zone reaches the note.
// The home zone is a DEVICE-LOCAL preference (localStorage, like the accent colour
// in `accentColor.ts` and the display language), so a file that exports as
// plaintext still says "09:00" and nothing about where anybody lives.
//
// Two consequences worth stating, because both are load-bearing:
//
// 1. **The note never changes.** `… 09:00` stays byte-identical whichever zone the
//    reader is in. What changes is what the surface ADDS beside it, which is a
//    rendering concern and not a storage one.
// 2. **No zone database ships.** `Intl.DateTimeFormat` with a `timeZone` already
//    resolves IANA identifiers, in the same WebView that renders the calendar, so
//    the conversion is one call rather than a table to keep current. DST is
//    therefore right by construction: the formatter applies the offset that was in
//    force at that instant, not the one in force today.
//
// What this deliberately does NOT do is keep an event at a fixed ABSOLUTE time (a
// flight that departs at the same moment wherever you read it from). That needs a
// zone on the note, which §3.10.2 refuses and `decisions/storage/0797` keeps
// refused; the second clock answers "what time is that for the people at home",
// which is the question a travelling reader actually asks.

const HOME_ZONE_KEY = "myne.homeZone";

/** The `HH:MM` (24h) plus the day offset an instant reads as in another zone. */
export type SecondClock = {
  /** `HH:MM` in the home zone. */
  readonly time: string;
  /** `-1`, `0` or `1`: whether that clock is on the day before, the same day, or after. */
  readonly dayOffset: number;
};

/** Whether `zone` is an IANA identifier this runtime can resolve. */
export function isKnownZone(zone: string): boolean {
  if (zone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The stored home zone, or `null` when unset or unusable. */
export function readHomeZone(): string | null {
  try {
    const value = localStorage.getItem(HOME_ZONE_KEY);
    if (value === null || !isKnownZone(value)) return null;
    return value;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

/**
 * Listen for a change to the preference.
 *
 * A surface that reads the zone ONCE during render shows one clock until something
 * unrelated re-renders it, and the setting is written on another screen entirely, so
 * the write is what has to reach the calendar. This is the whole reason the module
 * carries a subscriber list rather than a plain getter.
 */
export function subscribeHomeZone(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Store the home zone, or clear it when the value is empty or unknown.
 *
 * Unknown is a CLEAR rather than a refusal: this is a preference with no writer to
 * report to, and a stored zone the runtime cannot resolve would silently produce no
 * second clock at all, which reads as a bug rather than as a setting.
 */
export function writeHomeZone(zone: string): void {
  try {
    const trimmed = zone.trim();
    const next = trimmed === "" || !isKnownZone(trimmed) ? null : trimmed;
    if (next === null) localStorage.removeItem(HOME_ZONE_KEY);
    else localStorage.setItem(HOME_ZONE_KEY, next);
    // Announced even when the value is unchanged: a listener's job is to re-read, and
    // a second write of the same zone costs one re-render and no divergence.
    for (const listener of listeners) listener();
  } catch {
    // A WebView with no storage still shows one clock; nothing here is load-bearing.
  }
}

/** The zone this device is in, as `Intl` reports it. */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

const PARTS = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;

/**
 * How far ahead of UTC `zone` is at `epochMs`, in milliseconds, DST included.
 *
 * Derived by reading the same instant back as wall-clock parts in that zone and
 * comparing them with what UTC says it is: the difference IS the offset. Doing it
 * this way rather than from a table is what makes a summer date and a winter date
 * answer differently without a single rule here.
 */
function zoneOffsetMs(zone: string, epochMs: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(epochMs);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "NaN");
  const asUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour"), pick("minute"), pick("second"));
  return asUtc - epochMs;
}

/**
 * The instant a wall clock names in `zone`.
 *
 * Two passes, because the offset depends on the instant and the instant depends on
 * the offset: the first guess can land on the wrong side of a DST change, and the
 * second corrects it. One pass is the classic bug that makes every event an hour off
 * for the half of the year nobody tested.
 */
function epochOfWallClock(
  stamp: { year: number; month: number; day: number; hours: number; minutes: number },
  zone: string,
): number {
  const guess = Date.UTC(stamp.year, stamp.month - 1, stamp.day, stamp.hours, stamp.minutes);
  const first = guess - zoneOffsetMs(zone, guess);
  const secondOffset = zoneOffsetMs(zone, first);
  return guess - secondOffset;
}

/**
 * What a stored time reads as in the home zone, or `null` when there is nothing to
 * add: no preference, a preference equal to the device's own zone, or a value the
 * shape check refuses.
 *
 * `fromZone` is the zone the stored value is a wall clock IN, which is the device's
 * own zone in production and explicit here so a test does not depend on what the
 * machine's clock is set to. An all-day event has no clock to convert and answers
 * `null`, which is what keeps a date-only event from gaining a time in another zone.
 */
export function homeClockFor(
  instant: string,
  zone: string | null = readHomeZone(),
  fromZone: string = deviceZone(),
): SecondClock | null {
  if (zone === null || fromZone === "" || zone === fromZone) return null;
  const match = PARTS.exec(instant.trim());
  if (match === null || match[4] === undefined || match[5] === undefined) return null;

  const [, year, month, day, hours, minutes] = match;
  const stamp = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hours: Number(hours),
    minutes: Number(minutes),
  };
  if (Number.isNaN(epochOfWallClock(stamp, fromZone))) return null;

  try {
    const at = epochOfWallClock(stamp, fromZone);
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).formatToParts(at);
    const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const homeYear = Number(pick("year"));
    const homeMonth = Number(pick("month"));
    const homeDay = Number(pick("day"));
    if (Number.isNaN(homeYear) || Number.isNaN(homeMonth) || Number.isNaN(homeDay)) return null;
    const sameDay = homeYear === stamp.year && homeMonth === stamp.month && homeDay === stamp.day;
    const dayOffset = sameDay
      ? 0
      : Date.UTC(homeYear, homeMonth - 1, homeDay) > Date.UTC(stamp.year, stamp.month - 1, stamp.day)
        ? 1
        : -1;
    return { time: `${pick("hour")}:${pick("minute")}`, dayOffset };
  } catch {
    return null;
  }
}
