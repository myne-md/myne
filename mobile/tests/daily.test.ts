import { describe, it, expect } from "vitest";
import { formatLocalDate } from "../src/lib/localDateTime";
import {
  formatDailyDate,
  isoWeek,
  zonedNow,
  periodRange,
  periodSettings,
  resolvePeriodNote,
} from "../src/lib/daily";
import type { PeriodSettings } from "../src/lib/daily";

describe("formatDailyDate", () => {
  it("replaces YYYY/MM/DD tokens (local clock, zero-padded)", () => {
    const d = new Date(2026, 6, 4); // local: 4 July 2026 (month index 6 = July)
    expect(formatDailyDate(d, "YYYY-MM-DD")).toBe("2026-07-04");
    expect(formatDailyDate(d, "YYYY/MM/DD")).toBe("2026/07/04");
    expect(formatDailyDate(d, "Daily YYYY")).toBe("Daily 2026");
  });
});

// Period token grammar (myne#177). This is the same case table as
// tests/notes/dailyNote.test.ts in the shared tree and `daily_match::tests` in
// the Rust port. Mobile keeps its own copy of the formatter, so the cases are
// deliberately the same cases: three implementations that agree only by review
// are three implementations that will drift.

describe("isoWeek", () => {
  it("numbers a mid-year Monday per ISO 8601", () => {
    expect(isoWeek(new Date(2026, 7, 24))).toEqual({ weekYear: 2026, week: 35 });
  });

  it("keeps a week whole across the year boundary, in both directions", () => {
    expect(isoWeek(new Date(2026, 11, 28))).toEqual({ weekYear: 2026, week: 53 });
    expect(isoWeek(new Date(2027, 0, 1))).toEqual({ weekYear: 2026, week: 53 });
  });

  it("puts the first days of a year in the previous week-year when ISO says so", () => {
    expect(isoWeek(new Date(2021, 0, 1))).toEqual({ weekYear: 2020, week: 53 });
  });

  it("starts week 1 on the Monday of the week holding the first Thursday", () => {
    expect(isoWeek(new Date(2024, 0, 1))).toEqual({ weekYear: 2024, week: 1 });
  });
});

describe("zonedNow", () => {
  const EVENING_IN_NEW_YORK = new Date(Date.UTC(2026, 5, 8, 2, 30));

  it("returns the instant untouched when no override is set", () => {
    const now = new Date(2026, 5, 7, 1, 0, 0);
    expect(zonedNow(now, null)).toBe(now);
    expect(zonedNow(now, "")).toBe(now);
  });

  it("moves the calendar date across a zone that has already turned over", () => {
    expect(formatDailyDate(zonedNow(EVENING_IN_NEW_YORK, "Europe/Berlin"), "YYYY-MM-DD")).toBe(
      "2026-06-08",
    );
    expect(
      formatDailyDate(zonedNow(EVENING_IN_NEW_YORK, "America/New_York"), "YYYY-MM-DD"),
    ).toBe("2026-06-07");
  });

  it("moves the WEEK, not just the day, when the boundary is a Sunday night", () => {
    const sundayNight = new Date(Date.UTC(2026, 7, 24, 2, 30));
    expect(formatDailyDate(zonedNow(sundayNight, "America/New_York"), "gggg-[W]ww")).toBe(
      "2026-W34",
    );
    expect(formatDailyDate(zonedNow(sundayNight, "Europe/Berlin"), "gggg-[W]ww")).toBe(
      "2026-W35",
    );
  });

  it("carries the zone's time of day, not an arbitrary hour", () => {
    // The same instant renders `{{time}}` and `{{datetime}}` in a template, so
    // an hour invented here would stamp a note made at 22:30 in New York with
    // some other clock reading entirely.
    const berlin = zonedNow(EVENING_IN_NEW_YORK, "Europe/Berlin");
    expect([berlin.getHours(), berlin.getMinutes()]).toEqual([4, 30]);
    const newYork = zonedNow(EVENING_IN_NEW_YORK, "America/New_York");
    expect([newYork.getHours(), newYork.getMinutes()]).toEqual([22, 30]);
  });

  it("gives the template's render context the same day the title gets", () => {
    // The defect this pins: the anchor was zone-corrected and the render
    // context was not, so a note opened at 22:30 in New York with a Berlin
    // override was TITLED 2026-06-08 and rendered `{{date}}` as 2026-06-07.
    // `formatLocalDate` is what the render context's `date` field is built
    // from, so agreeing with the title here is that contract.
    for (const zone of ["Europe/Berlin", "America/New_York"]) {
      const now = zonedNow(EVENING_IN_NEW_YORK, zone);
      expect(formatLocalDate(now)).toBe(formatDailyDate(now, "YYYY-MM-DD"));
    }
  });

  it("falls back to the device clock on an unusable zone identifier", () => {
    const now = new Date(2026, 5, 7, 1, 0, 0);
    expect(formatDailyDate(zonedNow(now, "Mars/Olympus_Mons"), "YYYY-MM-DD")).toBe(
      "2026-06-07",
    );
  });
});

describe("formatDailyDate, period tokens", () => {
  const MONDAY_W35 = new Date(2026, 7, 24);

  it("expands gggg and ww with the ISO week-year, not the calendar year", () => {
    expect(formatDailyDate(MONDAY_W35, "gggg-[W]ww")).toBe("2026-W35");
    expect(formatDailyDate(new Date(2027, 0, 1), "gggg-[W]ww")).toBe("2026-W53");
    expect(formatDailyDate(new Date(2026, 11, 28), "gggg-[W]ww")).toBe("2026-W53");
  });

  it("zero-pads the week number", () => {
    expect(formatDailyDate(new Date(2026, 0, 29), "gggg-[W]ww")).toBe("2026-W05");
  });

  it("treats a bracketed run as literal text, tokens included", () => {
    expect(formatDailyDate(MONDAY_W35, "[Week ]ww")).toBe("Week 35");
    expect(formatDailyDate(MONDAY_W35, "[YYYY]")).toBe("YYYY");
    expect(formatDailyDate(MONDAY_W35, "[gggg-ww]")).toBe("gggg-ww");
  });

  it("passes an unterminated bracket through as a literal", () => {
    expect(formatDailyDate(MONDAY_W35, "gggg-[W")).toBe("2026-[W");
  });

  it("passes an empty bracket pair through as nothing", () => {
    expect(formatDailyDate(MONDAY_W35, "gggg[]ww")).toBe("202635");
  });

  it("leaves the existing YYYY/MM/DD grammar untouched", () => {
    expect(formatDailyDate(MONDAY_W35, "YYYY-MM-DD")).toBe("2026-08-24");
    expect(formatDailyDate(MONDAY_W35, "YYYY/MM/DD")).toBe("2026/08/24");
    expect(formatDailyDate(MONDAY_W35, "Daily YYYY")).toBe("Daily 2026");
    expect(formatDailyDate(MONDAY_W35, "DDD")).toBe("24D");
    expect(formatDailyDate(MONDAY_W35, "MMM")).toBe("08M");
  });

  it("does not re-substitute inside already-expanded output", () => {
    expect(formatDailyDate(MONDAY_W35, "YYYY")).toBe("2026");
  });

  it("re-reads a stored format that used the new tokens as literals", () => {
    // The one-time compatibility break myne#177 accepts, pinned so it is a
    // recorded behaviour rather than a surprise. `[`, `ww` and `gggg` were
    // ordinary characters under the pre-myne#177 grammar and are grammar now,
    // so a `daily_date_format` already on disk containing one of them renders a
    // different title. `protocol.md` 9.5.2 and decision 0539 say why there is
    // no migration: existing notes keep their titles, the next open makes one
    // under the new title, nothing is lost.
    const d = new Date(2026, 7, 24);
    // Was `2026-08-24 [journal]` before myne#177.
    expect(formatDailyDate(d, "YYYY-MM-DD [journal]")).toBe("2026-08-24 journal");
    // Were the literals `gggg` and `ww`.
    expect(formatDailyDate(d, "gggg")).toBe("2026");
    expect(formatDailyDate(d, "ww")).toBe("35");
  });

});

describe("resolvePeriodNote for the daily period", () => {
  const now = new Date(2026, 6, 4);

  it("returns create with the default folder + date title when nothing matches", () => {
    expect(resolvePeriodNote(now, "daily", { folder: null, format: null, template: null }, [])).toMatchObject({ kind: "create",
      dateTitle: "2026-07-04",
      folder: "Daily/",
    });
  });

  it("opens an existing today-note in the daily folder", () => {
    const notes = [{ id: "x", title: "2026-07-04", folder: "Daily/" }];
    expect(resolvePeriodNote(now, "daily", { folder: null, format: null, template: null }, notes)).toMatchObject({ kind: "open", id: "x", dateTitle: "2026-07-04" });
  });

  it("matches case-insensitively on folder + title", () => {
    const notes = [{ id: "y", title: "2026-07-04", folder: "daily/" }];
    expect(resolvePeriodNote(now, "daily", { folder: null, format: null, template: null }, notes).kind).toBe("open");
  });

  it("does not match a same-titled note in a different folder", () => {
    const notes = [{ id: "z", title: "2026-07-04", folder: "Other/" }];
    expect(resolvePeriodNote(now, "daily", { folder: null, format: null, template: null }, notes).kind).toBe("create");
  });

  it("honors a custom date format + folder", () => {
    const r = resolvePeriodNote(now, "daily", { folder: "Journal/", format: "YYYY/MM/DD", template: null }, []);
    expect(r).toMatchObject({ kind: "create", dateTitle: "2026/07/04", folder: "Journal/" });
  });
});

// The period model (myne#177). The same case table as
// tests/notes/dailyNote.test.ts in the shared tree: mobile keeps its own copy of
// the resolver, so a value that differs between the two clients means one vault
// gets two notes for one week.

describe("periodRange", () => {
  it("anchors a week on its Monday and ends it on the Sunday", () => {
    // 2026-08-26 is a Wednesday.
    const r = periodRange(new Date(2026, 7, 26, 9, 0), "weekly");
    expect(formatDailyDate(r.start, "YYYY-MM-DD")).toBe("2026-08-24");
    expect(formatDailyDate(r.end, "YYYY-MM-DD")).toBe("2026-08-30");
  });

  it("anchors a week the same way when the day IS the Sunday", () => {
    const r = periodRange(new Date(2026, 7, 30, 23, 0), "weekly");
    expect(formatDailyDate(r.start, "YYYY-MM-DD")).toBe("2026-08-24");
    expect(formatDailyDate(r.end, "YYYY-MM-DD")).toBe("2026-08-30");
  });

  it("anchors a month on the 1st and ends it on the real last day", () => {
    const r = periodRange(new Date(2026, 7, 26), "monthly");
    expect(formatDailyDate(r.start, "YYYY-MM-DD")).toBe("2026-08-01");
    expect(formatDailyDate(r.end, "YYYY-MM-DD")).toBe("2026-08-31");
  });

  it("gets February right, leap year included", () => {
    expect(formatDailyDate(periodRange(new Date(2026, 1, 10), "monthly").end, "YYYY-MM-DD")).toBe(
      "2026-02-28",
    );
    expect(formatDailyDate(periodRange(new Date(2028, 1, 10), "monthly").end, "YYYY-MM-DD")).toBe(
      "2028-02-29",
    );
  });
});

describe("periodSettings", () => {
  const PREFS = {
    daily_folder: "Journal/",
    daily_date_format: "YYYY/MM/DD",
    daily_template: "tmpl-daily",
    periodic_notes: {
      "weekly.folder": "Weekly/",
      "weekly.template": "tmpl-weekly",
      "monthly.format": "YYYY-MM",
      "quarterly.folder": "Quarterly/",
      "daily.folder": "Wrong/",
    },
  };

  it("reads daily from the three legacy flat fields", () => {
    expect(periodSettings(PREFS, "daily")).toEqual({
      folder: "Journal/",
      format: "YYYY/MM/DD",
      template: "tmpl-daily",
    });
  });

  it("reads the other periods from the map, unset settings as null", () => {
    expect(periodSettings(PREFS, "weekly")).toEqual({
      folder: "Weekly/",
      format: null,
      template: "tmpl-weekly",
    });
    expect(periodSettings(PREFS, "monthly")).toEqual({
      folder: null,
      format: "YYYY-MM",
      template: null,
    });
  });
});

describe("resolvePeriodNote", () => {
  const WEDNESDAY = new Date(2026, 7, 26, 9, 0);
  const unset: PeriodSettings = { folder: null, format: null, template: null };

  it("creates this week's note with the default folder and format", () => {
    const r = resolvePeriodNote(WEDNESDAY, "weekly", unset, []);
    expect(r.kind).toBe("create");
    expect(r.dateTitle).toBe("2026-W35");
    expect(r.kind === "create" && r.folder).toBe("Weekly/");
  });

  it("opens the same note from any day of that week (idempotent)", () => {
    const notes = [{ id: "w", title: "2026-W35", folder: "Weekly/" }];
    for (const day of [24, 26, 30]) {
      const r = resolvePeriodNote(new Date(2026, 7, day, 9, 0), "weekly", unset, notes);
      expect(r).toMatchObject({ kind: "open", id: "w", dateTitle: "2026-W35" });
    }
    expect(resolvePeriodNote(new Date(2026, 7, 31), "weekly", unset, notes).kind).toBe("create");
  });

  it("opens the same monthly note from any day of that month", () => {
    const notes = [{ id: "m", title: "2026-08", folder: "Monthly/" }];
    for (const day of [1, 15, 31]) {
      expect(resolvePeriodNote(new Date(2026, 7, day), "monthly", unset, notes)).toMatchObject({
        kind: "open",
        id: "m",
        dateTitle: "2026-08",
      });
    }
  });

  it("carries the range so the create path can fill the period tokens", () => {
    const r = resolvePeriodNote(WEDNESDAY, "weekly", unset, []);
    expect(formatDailyDate(r.range.start, "YYYY-MM-DD")).toBe("2026-08-24");
    expect(formatDailyDate(r.range.end, "YYYY-MM-DD")).toBe("2026-08-30");
  });

  it("agrees with the desktop resolver on the titles it produces", () => {
    // The values pinned here are the ones tests/notes/dailyNote.test.ts pins for
    // the same inputs. If the two clients ever disagree, one vault gets two
    // notes for one period and nothing else in either tree would say so.
    expect(resolvePeriodNote(WEDNESDAY, "daily", unset, []).dateTitle).toBe("2026-08-26");
    expect(resolvePeriodNote(WEDNESDAY, "weekly", unset, []).dateTitle).toBe("2026-W35");
    expect(resolvePeriodNote(WEDNESDAY, "monthly", unset, []).dateTitle).toBe("2026-08");
  });
});
