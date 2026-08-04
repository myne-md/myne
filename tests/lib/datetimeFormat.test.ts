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

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY,
  displayFromPrefs,
  formatCivilDate,
  formatInstant,
  formatStoredValue,
  formatWallClockTime,
  splitStoredValue,
  todayIn,
  type DateTimeDisplay,
} from "../../src/lib/datetimeFormat";

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
