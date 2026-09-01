// myne#279 — the one formatter that replaces four ad-hoc paths.
//
// The sharpest of those four was a hardcoded `en-GB` formatter in `UTC` for
// saved-view date cells, so a user with the app in Turkish, German or US English
// still got British date formatting. It was not a fallback — it was a literal.
//
// The other property under test is the one the specs are opinionated about: a
// note's stored date and time are ZONE-FREE wall-clock, so the timezone setting
// must not convert them. It applies to what counts as "today" and to genuine
// instants, and to nothing else.

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY,
  displayFromPrefs,
  formatCivilDate,
  formatInstant,
  formatStoredValue,
  formatWallClockTime,
  parseDisplayDate,
  resetDateTimeDisplayForLock,
  setDateTimeDisplay,
  splitStoredValue,
  subscribeDateTimeDisplay,
  dateTimeDisplay,
  todayIn,
  type DateTimeDisplay,
} from "../../src/lib/datetimeFormat";
import { isRealDate } from "@myne/dialect/dates";

/** The catalogs under `locales/`. Written out rather than read off disk: this
 *  spec runs in the browser-shaped Vitest environment, and a roster that drifts
 *  short would quietly shrink the round trip below. */
const SHIPPED_LOCALES = [
  "ar", "bn", "cs", "da", "de", "el", "en", "es", "fa", "fi", "fr", "hi", "hu",
  "id", "it", "ja", "ko", "nb", "nl", "pa", "pl", "pt", "ro", "ru", "sv", "sw",
  "th", "tr", "uk", "ur", "vi", "zh",
] as const;

function display(over: Partial<DateTimeDisplay> = {}): DateTimeDisplay {
  return { ...DEFAULT_DISPLAY, ...over };
}

describe("displayFromPrefs", () => {
  it("reads the three prefs", () => {
    const d = displayFromPrefs(
      { date_format: "dmy", time_format: "12h", timezone: "Europe/Istanbul" },
      "tr",
    );
    expect(d).toEqual({
      dateFormat: "dmy",
      timeFormat: "12h",
      timeZone: "Europe/Istanbul",
      locale: "tr",
    });
  });

  it("degrades an unknown format to system rather than failing", () => {
    // The wire carries free strings, so a value a newer build wrote must read as
    // "unset" here, never as "broken vault".
    const d = displayFromPrefs({ date_format: "yyyy/mm/dd", time_format: "36h" });
    expect(d.dateFormat).toBe("system");
    expect(d.timeFormat).toBe("system");
  });

  it("degrades an unsupported zone to the host zone", () => {
    // `Intl` throws a RangeError on an unknown `timeZone`; a date cell is not
    // worth an exception.
    expect(displayFromPrefs({ timezone: "Mars/Olympus_Mons" }).timeZone).toBeNull();
    expect(displayFromPrefs({ timezone: "" }).timeZone).toBeNull();
  });

  it("treats absent prefs as all-default", () => {
    expect(displayFromPrefs(null)).toEqual(DEFAULT_DISPLAY);
    expect(displayFromPrefs(undefined)).toEqual(DEFAULT_DISPLAY);
  });
});

describe("formatCivilDate", () => {
  it("honours every explicit preset", () => {
    expect(formatCivilDate("2026-08-01", display({ dateFormat: "iso" }))).toBe("2026-08-01");
    expect(formatCivilDate("2026-08-01", display({ dateFormat: "dmy" }))).toBe("01/08/2026");
    expect(formatCivilDate("2026-08-01", display({ dateFormat: "mdy" }))).toBe("08/01/2026");
    expect(formatCivilDate("2026-08-01", display({ dateFormat: "dmmmy" }))).toContain("2026");
  });

  it("follows the app's language on `system`, not a hardcoded en-GB", () => {
    const de = formatCivilDate("2026-08-01", display({ locale: "de" }));
    const gb = formatCivilDate("2026-08-01", display({ locale: "en-GB" }));
    expect(de).not.toBe(gb);
  });

  it("never shifts the day, whatever zone is set", () => {
    // The off-by-one that hit every user west of UTC: a civil date names a
    // calendar day, not an instant.
    for (const timeZone of [null, "Pacific/Kiritimati", "Pacific/Niue", "Asia/Tokyo"]) {
      expect(formatCivilDate("2026-08-01", display({ dateFormat: "iso", timeZone }))).toBe(
        "2026-08-01",
      );
      expect(formatCivilDate("2026-08-01", display({ dateFormat: "dmy", timeZone }))).toBe(
        "01/08/2026",
      );
    }
  });

  it("returns an unparseable value verbatim", () => {
    expect(formatCivilDate("next tuesday", display())).toBe("next tuesday");
    expect(formatCivilDate("", display())).toBe("");
  });
});

describe("formatWallClockTime", () => {
  it("honours the explicit presets", () => {
    expect(formatWallClockTime("09:00", display({ timeFormat: "24h" }))).toBe("09:00");
    expect(formatWallClockTime("09:00", display({ timeFormat: "12h" }))).toBe("9:00 AM");
    expect(formatWallClockTime("21:05", display({ timeFormat: "24h" }))).toBe("21:05");
    expect(formatWallClockTime("21:05", display({ timeFormat: "12h" }))).toBe("9:05 PM");
    expect(formatWallClockTime("00:30", display({ timeFormat: "12h" }))).toBe("12:30 AM");
    expect(formatWallClockTime("12:30", display({ timeFormat: "12h" }))).toBe("12:30 PM");
  });

  it("never shifts the clock, whatever zone is set", () => {
    // "09:00" means 09:00 wherever the user is — that is what a personal
    // reminder means, and converting it would invent an instant nobody wrote.
    for (const timeZone of [null, "Pacific/Kiritimati", "America/Los_Angeles"]) {
      expect(formatWallClockTime("09:00", display({ timeFormat: "24h", timeZone }))).toBe("09:00");
    }
  });

  it("returns an unparseable value verbatim", () => {
    expect(formatWallClockTime("morning", display())).toBe("morning");
    expect(formatWallClockTime("99:99", display({ timeFormat: "24h" }))).toBe("99:99");
  });
});

describe("splitStoredValue / formatStoredValue", () => {
  it("splits the shapes a task row actually holds", () => {
    expect(splitStoredValue("2026-08-01")).toEqual({ date: "2026-08-01", time: null });
    expect(splitStoredValue("2026-08-01T09:00")).toEqual({ date: "2026-08-01", time: "09:00" });
    expect(splitStoredValue("2026-08-01 09:00")).toEqual({ date: "2026-08-01", time: "09:00" });
    expect(splitStoredValue("nonsense")).toEqual({ date: null, time: null });
  });

  it("keeps the time instead of silently dropping it", () => {
    // Task rows used to slice [0,10] and drop the time entirely.
    expect(
      formatStoredValue("2026-08-01T09:00", display({ dateFormat: "iso", timeFormat: "24h" })),
    ).toBe("2026-08-01 09:00");
  });

  it("prints a bare date with no phantom time", () => {
    expect(formatStoredValue("2026-08-01", display({ dateFormat: "iso" }))).toBe("2026-08-01");
  });
});

describe("formatInstant — the one place the zone converts", () => {
  it("prints an instant in the chosen zone", () => {
    // 2026-08-01T23:30:00Z is already 2 August in Tokyo (+09:00).
    const t = Date.parse("2026-08-01T23:30:00Z");
    expect(formatInstant(t, display({ dateFormat: "iso", timeZone: "Asia/Tokyo" }))).toBe(
      "2026-08-02",
    );
    expect(formatInstant(t, display({ dateFormat: "iso", timeZone: "UTC" }))).toBe("2026-08-01");
  });

  it("can carry a time, in the chosen format and zone", () => {
    const t = Date.parse("2026-08-01T23:30:00Z");
    expect(
      formatInstant(t, display({ dateFormat: "iso", timeFormat: "24h", timeZone: "UTC" }), {
        withTime: true,
      }),
    ).toBe("2026-08-01 23:30");
  });

  it("returns empty for an invalid instant rather than 'Invalid Date'", () => {
    expect(formatInstant(new Date(Number.NaN), display())).toBe("");
  });
});

describe("todayIn", () => {
  it("answers in the chosen zone", () => {
    const now = new Date(Date.parse("2026-08-01T23:30:00Z"));
    expect(todayIn(display({ timeZone: "UTC" }), now)).toBe("2026-08-01");
    expect(todayIn(display({ timeZone: "Asia/Tokyo" }), now)).toBe("2026-08-02");
    expect(todayIn(display({ timeZone: "America/Los_Angeles" }), now)).toBe("2026-08-01");
  });

  it("emits the normative civil-date shape", () => {
    expect(todayIn(display({ timeZone: "UTC" }))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("resetDateTimeDisplayForLock", () => {
  // The store is module scope in a shared package, so it outlives every unmount,
  // and neither a lock nor a vault switch reloads the page. Before this call
  // existed, one unlock left the reader's formats and TIME ZONE resident through
  // a lock and into the next vault's session (myne-md/myne#609, found by
  // review). The zone is what makes it worth a teardown rather than a remount:
  // it is a coarse-location datum kept per vault everywhere else.
  afterEach(() => {
    resetDateTimeDisplayForLock();
  });

  it("returns the store to its defaults", () => {
    setDateTimeDisplay({
      dateFormat: "dmy",
      timeFormat: "12h",
      timeZone: "Europe/Berlin",
      locale: "de",
    });
    expect(dateTimeDisplay().timeZone).toBe("Europe/Berlin");
    resetDateTimeDisplayForLock();
    expect(dateTimeDisplay()).toEqual(DEFAULT_DISPLAY);
  });

  it("notifies subscribers, so a rendered surface repaints on the lock", () => {
    // Not notifying would leave the previous vault's dates on screen until the
    // next incidental render, which is exactly the staleness this whole feature
    // exists to remove.
    setDateTimeDisplay({ ...DEFAULT_DISPLAY, dateFormat: "dmy" });
    let beats = 0;
    const off = subscribeDateTimeDisplay(() => {
      beats += 1;
    });
    resetDateTimeDisplayForLock();
    off();
    expect(beats).toBe(1);
  });

  it("KEEPS its subscribers, unlike the test reset", () => {
    // Dropping them here would silently unsubscribe every mounted view plugin
    // for the rest of the process, which is a worse failure than the one this
    // call fixes.
    let beats = 0;
    const off = subscribeDateTimeDisplay(() => {
      beats += 1;
    });
    resetDateTimeDisplayForLock();
    setDateTimeDisplay({ ...DEFAULT_DISPLAY, dateFormat: "mdy" });
    off();
    expect(beats).toBe(2);
  });
});

describe("parseDisplayDate", () => {
  it("reads a date back under the user's own format", () => {
    expect(parseDisplayDate("01/08/2026", display({ dateFormat: "dmy" }))).toBe("2026-08-01");
    expect(parseDisplayDate("08/01/2026", display({ dateFormat: "mdy" }))).toBe("2026-08-01");
  });

  it("resolves the ambiguous pair under the selected format ONLY", () => {
    // The whole reason this reads one format rather than all of them: the same
    // string is a real date under both presets and a DIFFERENT one under each.
    // Trying both would mean searching two strings, which the in-note find has
    // no way to express.
    expect(parseDisplayDate("01/08/2026", display({ dateFormat: "dmy" }))).toBe("2026-08-01");
    expect(parseDisplayDate("01/08/2026", display({ dateFormat: "mdy" }))).toBe("2026-01-08");
  });

  it("accepts an unpadded day or month", () => {
    expect(parseDisplayDate("1/8/2026", display({ dateFormat: "dmy" }))).toBe("2026-08-01");
  });

  it("refuses a day that is not on the calendar rather than rolling it over", () => {
    expect(parseDisplayDate("31/02/2026", display({ dateFormat: "dmy" }))).toBeNull();
    expect(parseDisplayDate("32/01/2026", display({ dateFormat: "dmy" }))).toBeNull();
    // Month-first, so the MONTH is the first field: 13 is the invalid one here.
    // Written the other way round first (`01/13/2026`), which is month 01 day 13
    // and perfectly real, so the test was asserting against a valid date.
    expect(parseDisplayDate("13/01/2026", display({ dateFormat: "mdy" }))).toBeNull();
    expect(parseDisplayDate("02/30/2026", display({ dateFormat: "mdy" }))).toBeNull();
  });

  it("returns null for `iso`, the one format with nothing to translate", () => {
    // Not a gap: the typed text already IS the stored form, so a second search
    // would repeat the first over the same string.
    expect(parseDisplayDate("2026-08-01", display({ dateFormat: "iso" }))).toBeNull();
  });

  it("reads back the two `Intl` presets, `system` included", () => {
    // `system` is the DEFAULT. An earlier version excluded it along with the
    // month-name preset, which shipped this feature switched off for everyone
    // who never opened the setting: they read `Aug 1, 2026`, typed that, and got
    // "No matches" with no fallback and no notice.
    expect(parseDisplayDate("Aug 1, 2026", display({ dateFormat: "system" }))).toBe("2026-08-01");
    // Written as `1 Aug 2026` first, which is not what `dmmmy` prints in
    // English: `Intl` picks the FIELD ORDER from the locale, and only the month
    // spelling is asked for. The test was asserting against a string the app
    // never shows, so it takes the printer's word for it instead.
    const dmmmy = display({ dateFormat: "dmmmy" });
    expect(parseDisplayDate(formatCivilDate("2026-08-01", dmmmy), dmmmy)).toBe("2026-08-01");
  });

  it("reads the month name in the app's own language, not the host's", () => {
    // The `system` presets resolve against the language chosen IN Myne, which is
    // the objection that made "just follow the OS locale" the wrong answer to
    // myne#279. So the reverse reading has to follow it too.
    expect(parseDisplayDate("1 Ağu 2026", display({ dateFormat: "dmmmy", locale: "tr" }))).toBe(
      "2026-08-01",
    );
    expect(parseDisplayDate("01.08.2026", display({ dateFormat: "system", locale: "de" }))).toBe(
      "2026-08-01",
    );
  });

  it("reads a locale whose printed year is not the Gregorian one", () => {
    // The reason `yearTokens` probes the formatter instead of pulling a
    // four-digit run out of the query: `th` prints the Buddhist year and `fa`
    // the Persian one, so a query carrying 2569 or 1405 is talking about
    // Gregorian 2026. Two of the 32 shipped catalogs do this, and the second
    // probe six months in is what makes the Persian case work at all, since a
    // Persian year boundary falls inside the Gregorian one.
    const th = display({ dateFormat: "system", locale: "th" });
    expect(parseDisplayDate(formatCivilDate("2026-08-01", th), th)).toBe("2026-08-01");
    const fa = display({ dateFormat: "system", locale: "fa" });
    expect(parseDisplayDate(formatCivilDate("2026-08-01", fa), fa)).toBe("2026-08-01");
  });

  it("refuses an `Intl`-printed string that is off by a day", () => {
    // The comparison is against the printer's own output, so a near miss is a
    // miss. This is the property that keeps the second search honest: it can
    // only ever hand back an ISO date some chip could really be showing.
    expect(parseDisplayDate("Aug 32, 2026", display({ dateFormat: "system" }))).toBeNull();
    expect(parseDisplayDate("Feb 30, 2026", display({ dateFormat: "system" }))).toBeNull();
    expect(parseDisplayDate("Aug 2026", display({ dateFormat: "system" }))).toBeNull();
  });

  it("does not read a year alone, or a year outside the searchable range", () => {
    expect(parseDisplayDate("2026", display({ dateFormat: "system" }))).toBeNull();
    // 1900 to 2100 is an absolute window, so this stays a fact rather than
    // something that changes on New Year's Eve.
    expect(parseDisplayDate("Aug 1, 2101", display({ dateFormat: "system" }))).toBeNull();
    expect(parseDisplayDate("Aug 1, 1899", display({ dateFormat: "system" }))).toBeNull();
  });

  it("returns null for anything that is not a date at all", () => {
    for (const text of ["", "rent", "01/08", "2026", "01/08/26", "01-08-2026"]) {
      expect(parseDisplayDate(text, display({ dateFormat: "dmy" })), text).toBeNull();
    }
  });

  it("agrees with the dialect's own calendar check, including where that is odd", () => {
    // The property that matters is agreement with the ONLY writer that can have
    // produced a stored form, `parseTaskInstant`, which validates through the
    // same `isRealDate`. A second predicate here would let this produce an ISO
    // string no chip can be carrying, and the search would come back empty for
    // a reason nobody could see.
    //
    // `isRealDate` builds through `Date.UTC`, which remaps a two-digit year to
    // 1900+y, so a year under 100 is rejected. Pinned so the agreement is a
    // tested fact rather than an assumption, and so that fixing the remap in
    // `dialect/src/dates.ts` fails here and is looked at on purpose.
    expect(isRealDate(26, 8, 1)).toBe(false);
    expect(parseDisplayDate("01/08/0026", display({ dateFormat: "dmy" }))).toBeNull();
  });

  it("round-trips against the formatter it inverts, in every locale we ship", () => {
    // The round trip is the whole contract for the two `Intl` presets, since
    // their reader IS the printer. Run over all 32 catalogs rather than a
    // sample, because the failures this catches are per-locale by nature: a
    // calendar with a different year, a numeral system, a field order, an era
    // suffix. `en` alone would have passed while `th` and `fa` were broken.
    for (const dateFormat of ["dmy", "mdy", "dmmmy", "system"] as const) {
      for (const locale of SHIPPED_LOCALES) {
        const d = display({ dateFormat, locale });
        const printed = formatCivilDate("2026-08-01", d);
        expect(parseDisplayDate(printed, d), `${dateFormat} ${locale}`).toBe("2026-08-01");
      }
    }
  });
});
