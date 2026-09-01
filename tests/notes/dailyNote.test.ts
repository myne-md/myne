// Unit tests for src/notes/dailyNote.ts (MYND-191) — the idempotent "open
// today" resolver. Pure function; all clock input is the injected `now`.

import { describe, it, expect } from "vitest";
import { buildRenderContext, singleDay } from "../../src/notes/newNoteFromTemplate";
import {
  formatDailyDate,
  isoWeek,
  zonedNow,
  periodRange,
  periodSettings,
  resolvePeriodNote,
  DEFAULT_DAILY_FOLDER,
  DEFAULT_DAILY_DATE_FORMAT,
} from "../../src/notes/dailyNote";
import type { PeriodSettings } from "../../src/notes/dailyNote";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";

function rec(
  uuid: string,
  title: string | null,
  folder: string | null,
  over: Partial<TitleRecord> = {},
): TitleRecord {
  return {
    noteUuid: uuid,
    title,
    folder,
    updatedAt: null,
    trashed: null,
    template: false,
    ...over,
  };
}

// Fixed local instant: 2026-06-07 (a Sunday) at 01:00.
const NOW = new Date(2026, 5, 7, 1, 0, 0);

describe("formatDailyDate", () => {
  it("formats the default YYYY-MM-DD in local time", () => {
    expect(formatDailyDate(NOW, DEFAULT_DAILY_DATE_FORMAT)).toBe("2026-06-07");
  });
  it("supports a custom separator format", () => {
    expect(formatDailyDate(NOW, "YYYY/MM/DD")).toBe("2026/06/07");
  });
  it("keeps the local calendar day for an early-morning instant", () => {
    expect(formatDailyDate(new Date(2026, 5, 7, 0, 30), "YYYY-MM-DD")).toBe(
      "2026-06-07",
    );
  });
});

// Period token grammar (myne#177). The same case table runs in
// mobile/tests/daily.test.ts and in the Rust port's `daily_match::tests`.
// Three implementations that agree only by review are three implementations
// that will drift, so the cases are deliberately the same cases.

describe("isoWeek", () => {
  it("numbers a mid-year Monday per ISO 8601", () => {
    // 2026-08-24 is a Monday; its Thursday is 2026-08-27, 34 weeks after the
    // first Thursday of 2026 (2026-01-01), so it is week 35.
    expect(isoWeek(new Date(2026, 7, 24))).toEqual({ weekYear: 2026, week: 35 });
  });

  it("keeps a week whole across the year boundary, in both directions", () => {
    // The week of 2026-12-28 runs into January. ISO puts all of it in 2026-W53,
    // so the note opened on the 28th and the note opened on the 1st have to be
    // the same note. A calendar year here yields 2026-W53 and 2027-W53: one
    // week, two notes.
    expect(isoWeek(new Date(2026, 11, 28))).toEqual({ weekYear: 2026, week: 53 });
    expect(isoWeek(new Date(2027, 0, 1))).toEqual({ weekYear: 2026, week: 53 });
  });

  it("puts the first days of a year in the previous week-year when ISO says so", () => {
    // 2021-01-01 is a Friday, so it belongs to 2020-W53.
    expect(isoWeek(new Date(2021, 0, 1))).toEqual({ weekYear: 2020, week: 53 });
  });

  it("starts week 1 on the Monday of the week holding the first Thursday", () => {
    expect(isoWeek(new Date(2024, 0, 1))).toEqual({ weekYear: 2024, week: 1 });
  });
});

describe("zonedNow", () => {
  // 2026-06-07T22:30:00-04:00: 22:30 in New York, already the 8th in Berlin.
  const EVENING_IN_NEW_YORK = new Date(Date.UTC(2026, 5, 8, 2, 30));

  it("returns the instant untouched when no override is set", () => {
    const now = new Date(2026, 5, 7, 1, 0, 0);
    expect(zonedNow(now, null)).toBe(now);
    expect(zonedNow(now, "")).toBe(now);
  });

  it("moves the calendar date across a zone that has already turned over", () => {
    const berlin = zonedNow(EVENING_IN_NEW_YORK, "Europe/Berlin");
    expect(formatDailyDate(berlin, "YYYY-MM-DD")).toBe("2026-06-08");
    const newYork = zonedNow(EVENING_IN_NEW_YORK, "America/New_York");
    expect(formatDailyDate(newYork, "YYYY-MM-DD")).toBe("2026-06-07");
  });

  it("moves the WEEK, not just the day, when the boundary is a Sunday night", () => {
    // 2026-08-23 is a Sunday. 22:30 in New York is already Monday in Berlin, so
    // the two zones disagree about which ISO week this is, a whole week apart,
    // which is why the override could not be left unhonoured for weekly notes.
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
    // Both call sites now derive from one instant; this is that contract.
    for (const zone of ["Europe/Berlin", "America/New_York"]) {
      const now = zonedNow(EVENING_IN_NEW_YORK, zone);
      const title = formatDailyDate(now, "YYYY-MM-DD");
      expect(buildRenderContext(now, title, singleDay(now)).date).toBe(title);
    }
  });

  it("falls back to the device clock on an unusable zone identifier", () => {
    // `timezone` is a free string with no codec-level validation, so an unknown
    // value is a documented state (protocol.md §9.5) and must not break the
    // flow. The rule for every free-string pref is unknown maps to the default.
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

describe("periodRange", () => {
  it("gives daily a one-day range anchored on that day", () => {
    const r = periodRange(new Date(2026, 7, 26, 9, 0), "daily");
    expect(formatDailyDate(r.anchor, "YYYY-MM-DD")).toBe("2026-08-26");
    expect(formatDailyDate(r.start, "YYYY-MM-DD")).toBe("2026-08-26");
    expect(formatDailyDate(r.end, "YYYY-MM-DD")).toBe("2026-08-26");
  });

  it("anchors a week on its Monday and ends it on the Sunday", () => {
    // 2026-08-26 is a Wednesday.
    const r = periodRange(new Date(2026, 7, 26, 9, 0), "weekly");
    expect(formatDailyDate(r.start, "YYYY-MM-DD")).toBe("2026-08-24");
    expect(formatDailyDate(r.end, "YYYY-MM-DD")).toBe("2026-08-30");
    expect(r.anchor).toEqual(r.start);
  });

  it("anchors a week the same way when the day IS the Sunday", () => {
    // Sunday is index 0 in getDay(), the case an off-by-one gets wrong: it
    // belongs to the week that STARTED six days earlier, not the next one.
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

  it("keeps a weekly range whole across a month boundary", () => {
    // 2026-09-02 is a Wednesday; its week starts in August.
    const r = periodRange(new Date(2026, 8, 2), "weekly");
    expect(formatDailyDate(r.start, "YYYY-MM-DD")).toBe("2026-08-31");
    expect(formatDailyDate(r.end, "YYYY-MM-DD")).toBe("2026-09-06");
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
      // A period this build has no UI for must be ignored, not crash.
      "quarterly.folder": "Quarterly/",
      // A daily entry in the map is IGNORED: daily lives in the flat fields,
      // and honouring this would give one setting two homes.
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
    const notes = [rec("w", "2026-W35", "Weekly/")];
    for (const day of [24, 26, 30]) {
      const r = resolvePeriodNote(new Date(2026, 7, day, 9, 0), "weekly", unset, notes);
      expect(r).toMatchObject({ kind: "open", id: "w", dateTitle: "2026-W35" });
    }
    // …and the NEXT week is a different note.
    expect(resolvePeriodNote(new Date(2026, 7, 31), "weekly", unset, notes).kind).toBe("create");
  });

  it("opens the same monthly note from any day of that month", () => {
    const notes = [rec("m", "2026-08", "Monthly/")];
    for (const day of [1, 15, 31]) {
      const r = resolvePeriodNote(new Date(2026, 7, day), "monthly", unset, notes);
      expect(r).toMatchObject({ kind: "open", id: "m", dateTitle: "2026-08" });
    }
  });

  it("carries the range so the create path can fill the period tokens", () => {
    const r = resolvePeriodNote(WEDNESDAY, "weekly", unset, []);
    expect(formatDailyDate(r.range.start, "YYYY-MM-DD")).toBe("2026-08-24");
    expect(formatDailyDate(r.range.end, "YYYY-MM-DD")).toBe("2026-08-30");
  });

  it("keeps the daily behaviour byte-identical through the shared path", () => {
    const notes = [rec("a", "2026-08-26", "Daily/")];
    expect(resolvePeriodNote(WEDNESDAY, "daily", unset, notes)).toMatchObject({
      kind: "open",
      id: "a",
      dateTitle: "2026-08-26",
    });
  });

  it("still excludes trashed and template notes for every period", () => {
    const trashed = [rec("w", "2026-W35", "Weekly/", { trashed: "2026-08-26T00:00:00Z" })];
    expect(resolvePeriodNote(WEDNESDAY, "weekly", unset, trashed).kind).toBe("create");
    const template = [rec("w", "2026-W35", "Weekly/", { template: true })];
    expect(resolvePeriodNote(WEDNESDAY, "weekly", unset, template).kind).toBe("create");
  });

  it("resolves two periods pointed at one folder and format to ONE note", () => {
    // The match rule is folder + title and nothing else, so this is not a bug
    // to special-case here. Settings warns when it is configured.
    const collide: PeriodSettings = { folder: "Same/", format: "YYYY-MM", template: null };
    const notes = [rec("x", "2026-08", "Same/")];
    for (const period of ["weekly", "monthly"] as const) {
      expect(resolvePeriodNote(WEDNESDAY, period, collide, notes)).toMatchObject({
        kind: "open",
        id: "x",
      });
    }
  });
});

// The daily period through the SAME resolver the app calls. There is no
// daily-only entry point any more: a shim that existed for these tests was
// exactly the thing that could drift from what ships.
describe("resolvePeriodNote for the daily period", () => {
  it("revisit same day → opens the existing note (no create)", () => {
    const notes = [rec("a", "2026-06-07", "Daily/")];
    const r = resolvePeriodNote(NOW, "daily", { folder: null, format: null, template: null }, notes);
    expect(r).toMatchObject({ kind: "open", id: "a", dateTitle: "2026-06-07" });
  });

  it("first-ever daily note → create signal with the date-title + folder", () => {
    const r = resolvePeriodNote(NOW, "daily", { folder: null, format: null, template: null }, []);
    expect(r).toMatchObject({ kind: "create",
      dateTitle: "2026-06-07",
      folder: "Daily/",
    });
  });

  it("renamed title no longer matches → create", () => {
    const notes = [rec("a", "Sunday notes", "Daily/")];
    expect(resolvePeriodNote(NOW, "daily", { folder: null, format: null, template: null }, notes).kind).toBe("create");
  });

  it("moved out of the daily folder no longer matches → create", () => {
    const notes = [rec("a", "2026-06-07", "Archive/")];
    expect(resolvePeriodNote(NOW, "daily", { folder: null, format: null, template: null }, notes).kind).toBe("create");
  });

  it("case-fold + NFC: folder + title variants resolve to the same note", () => {
    // daily/ vs Daily/, and a date title compared case-insensitively.
    const notes = [rec("a", "2026-06-07", "daily/")];
    const r = resolvePeriodNote(NOW, "daily", { folder: "Daily/", format: null, template: null }, notes);
    expect(r).toMatchObject({ kind: "open", id: "a", dateTitle: "2026-06-07" });
  });

  it("a trashed today-note is excluded → create", () => {
    const notes = [
      rec("a", "2026-06-07", "Daily/", { trashed: "2026-06-07T00:00:00Z" }),
    ];
    expect(resolvePeriodNote(NOW, "daily", { folder: null, format: null, template: null }, notes).kind).toBe("create");
  });

  it("a template-flagged today-note is excluded → create", () => {
    const notes = [rec("a", "2026-06-07", "Daily/", { template: true })];
    expect(resolvePeriodNote(NOW, "daily", { folder: null, format: null, template: null }, notes).kind).toBe("create");
  });

  it("honors a custom folder + format", () => {
    const notes = [rec("a", "2026/06/07", "Journal/")];
    const r = resolvePeriodNote(NOW, "daily", { folder: "Journal/", format: "YYYY/MM/DD", template: null }, notes);
    expect(r).toMatchObject({ kind: "open", id: "a", dateTitle: "2026/06/07" });
  });

  it("matches only within the daily folder, not a same-named root note", () => {
    const notes = [rec("a", "2026-06-07", null)]; // root note, same title
    expect(resolvePeriodNote(NOW, "daily", { folder: null, format: null, template: null }, notes).kind).toBe("create");
  });

  it("uses the documented defaults when prefs are null", () => {
    // Sanity on the exported defaults.
    expect(DEFAULT_DAILY_FOLDER).toBe("Daily/");
    expect(DEFAULT_DAILY_DATE_FORMAT).toBe("YYYY-MM-DD");
  });
});
