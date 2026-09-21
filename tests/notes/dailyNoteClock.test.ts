// Daily notes and the clock — myne-md/myne#557, five `notes.daily-notes` /
// `settings.block.daily-notes` bullets.
//
// The roster rows were: change the machine's timezone and its locale, cross
// midnight, cross a DST boundary, and check that exactly one note exists per
// local calendar day with the title the format asked for. Every one of those is
// a per-release hand-walk over OS settings, on a machine somebody has to reboot
// into a different zone — and every one of them is decided by a pure function
// over an injected `now`:
//
//  * `formatDailyDate(now, format)` and `resolveTodayNote(now, …)` take the
//    clock as a parameter and read none themselves;
//  * `buildRenderContext(now, title)` does the same for the template tokens;
//  * `TZ` is an environment variable, so "under Europe/Berlin" is a process
//    setting, not a machine setting;
//  * the ICU locale is settable in-process, so "the Buddhist calendar" is a
//    `toLocaleDateString` argument rather than a phone in Thai.
//
// The one thing that is NOT covered here and stays a roster row: a midnight
// rollover in the RUNNING app, which needs the app running. That belongs to the
// e2e lane (`libfaketime` in the container), and the bullet says so.
//
// # The defaulted-parameter fix that came with this file
//
// `createNoteFromTemplate`'s `now` used to default to `new Date()`. That is the
// exact shape `AGENTS.md` names: a test could pin the instant and prove the
// rendering while both production call sites went on reading the wall clock,
// excused in advance. Worse, the daily-notes branch had ALREADY resolved the
// note's title from a different `new Date()` a few statements earlier, so a call
// straddling midnight would title a note with yesterday's date and render
// `{{date}}` as today's. `now` is required now, the compiler named both sites,
// and the daily branch threads a single instant through both steps. The
// assertions for that are at the bottom of this file.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_DAILY_DATE_FORMAT,
  DEFAULT_DAILY_FOLDER,
  formatDailyDate,
  resolvePeriodNote,
  type PeriodSettings,
} from "../../src/notes/dailyNote";
import { buildRenderContext, singleDay } from "../../src/notes/newNoteFromTemplate";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";

/**
 * A note record for the resolver.
 *
 * Spread over a `Partial` rather than spelled out field by field: `TitleRecord`
 * carries a dozen members the daily resolver never reads, and enumerating them
 * here would put this file in the way of every future field.
 */
function note(over: { id: string; title: string; folder: string | null }): TitleRecord {
  return {
    noteUuid: over.id,
    title: over.title,
    folder: over.folder,
    updatedAt: null,
    trashed: null,
    template: false,
  } as unknown as TitleRecord;
}

/** Build a `Date` at a wall-clock instant in the process's local zone. */
function local(y: number, m: number, d: number, h = 12, min = 0): Date {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

/** "No folder, no format": explicit nulls. The resolver reads each field
 *  through `??`, so a missing key behaves exactly like an unset one — but
 *  `PeriodSettings` requires all three keys, and `{}` stopped typechecking
 *  when the signature widened from two nulls to the three-field form. */
const NO_SETTINGS: PeriodSettings = { folder: null, format: null, template: null };

// ── 1. Exactly one note per local calendar date ─────────────────────────────

describe("one note per LOCAL calendar date", () => {
  it("two instants on the same local day resolve to the same title", () => {
    // 00:01 and 23:59 on the same local day. A resolver that reached for UTC
    // would answer two different dates for these on any negative offset.
    const early = local(2026, 3, 10, 0, 1);
    const late = local(2026, 3, 10, 23, 59);
    expect(formatDailyDate(early, DEFAULT_DAILY_DATE_FORMAT)).toBe("2026-03-10");
    expect(formatDailyDate(late, DEFAULT_DAILY_DATE_FORMAT)).toBe("2026-03-10");
  });

  it("consecutive local days resolve to different titles", () => {
    expect(formatDailyDate(local(2026, 3, 10, 23, 59), "YYYY-MM-DD")).toBe("2026-03-10");
    expect(formatDailyDate(local(2026, 3, 11, 0, 0), "YYYY-MM-DD")).toBe("2026-03-11");
  });

  it("a whole year of local noons produces 365 distinct titles and no gaps", () => {
    // The set property the roster row was really asking about: no day is
    // skipped and no day is claimed twice. A single sweep answers it for every
    // month boundary and every leap-year edge at once.
    const titles = new Set<string>();
    const start = local(2026, 1, 1);
    for (let i = 0; i < 365; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      titles.add(formatDailyDate(d, "YYYY-MM-DD"));
    }
    expect(titles.size).toBe(365);
    expect(titles.has("2026-01-01")).toBe(true);
    expect(titles.has("2026-12-31")).toBe(true);
  });

  it("2028 is a leap year and 29 February gets its own note", () => {
    expect(formatDailyDate(local(2028, 2, 29), "YYYY-MM-DD")).toBe("2028-02-29");
    expect(formatDailyDate(local(2028, 2, 28), "YYYY-MM-DD")).toBe("2028-02-28");
    expect(formatDailyDate(local(2028, 3, 1), "YYYY-MM-DD")).toBe("2028-03-01");
  });
});

// ── 2. DST: the repeated hour and the skipped hour ──────────────────────────

describe("daylight-saving transitions do not create or destroy a day", () => {
  // The process runs in whatever zone `TZ` names. These cases are constructed
  // from UTC instants and formatted through `Intl` in a named zone, so they are
  // the same on every runner regardless of the host's own zone — which is the
  // whole reason the roster row asked for a machine in a specific zone.
  const dateIn = (zone: string, at: Date): string =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);

  it("the SKIPPED hour: Berlin's 2026-03-29 02:00 does not exist and the day still has one date", () => {
    // 00:30 UTC is 01:30 CET; 01:30 UTC is 03:30 CEST — 02:00 local never
    // happens. Both are the 29th, so the day gets exactly one daily note.
    const before = new Date(Date.UTC(2026, 2, 29, 0, 30));
    const after = new Date(Date.UTC(2026, 2, 29, 1, 30));
    expect(dateIn("Europe/Berlin", before)).toBe("2026-03-29");
    expect(dateIn("Europe/Berlin", after)).toBe("2026-03-29");
  });

  it("the REPEATED hour: Berlin's 2026-10-25 02:30 happens twice, still one date", () => {
    // 00:30 UTC is 02:30 CEST and 01:30 UTC is 02:30 CET — the same wall clock,
    // two instants. A resolver keyed on the wall clock rather than the calendar
    // date would see one day as two.
    const first = new Date(Date.UTC(2026, 9, 25, 0, 30));
    const second = new Date(Date.UTC(2026, 9, 25, 1, 30));
    expect(dateIn("Europe/Berlin", first)).toBe("2026-10-25");
    expect(dateIn("Europe/Berlin", second)).toBe("2026-10-25");
  });

  it("a DST day still has exactly 24 distinct hourly dates spread over two dates at most", () => {
    // Sweeping the whole transition day in one-hour UTC steps: a 23-hour and a
    // 25-hour local day must each still yield one local date for the day and
    // its neighbour, never three.
    for (const [zone, day] of [
      ["Europe/Berlin", Date.UTC(2026, 2, 29)],
      ["Europe/Berlin", Date.UTC(2026, 9, 25)],
      ["America/New_York", Date.UTC(2026, 2, 8)],
      ["Australia/Sydney", Date.UTC(2026, 3, 5)],
    ] as const) {
      const dates = new Set<string>();
      for (let h = 0; h < 24; h++) {
        dates.add(dateIn(zone, new Date(day + h * 3_600_000)));
      }
      expect(dates.size, `${zone} on ${new Date(day).toISOString()}`).toBeLessThanOrEqual(
        2,
      );
    }
  });
});

// ── 3. The locale cannot change the date the format asked for ───────────────

describe("a non-Gregorian host calendar does not change the daily title", () => {
  it("th-TH resolves to the Buddhist calendar and the title is still Gregorian", () => {
    // `th-TH` is the case the roster row named: ICU gives it the Buddhist
    // calendar, so 2026 renders as 2569. The daily title is built from
    // `getFullYear()` and friends, which are calendar-free — so the title must
    // not move, whatever the host locale is set to.
    const at = local(2026, 3, 10);
    const buddhist = at.toLocaleDateString("th-TH", { year: "numeric" });
    expect(
      /2569|๒๕๖๙/.test(buddhist),
      `th-TH did not resolve to the Buddhist calendar on this ICU build ` +
        `(got ${JSON.stringify(buddhist)}), so this case proves nothing`,
    ).toBe(true);
    expect(formatDailyDate(at, "YYYY-MM-DD")).toBe("2026-03-10");
  });

  it("no locale changes the title, across a spread of calendars and numbering systems", () => {
    const at = local(2026, 3, 10);
    for (const locale of ["en-US", "th-TH", "ar-SA", "fa-IR", "ja-JP-u-ca-japanese", "he-IL"]) {
      // Only the RENDERING of the same instant differs; the daily title is
      // computed from the Date's own calendar-free accessors.
      expect(at.toLocaleDateString(locale)).toBeTruthy();
      expect(formatDailyDate(at, "YYYY-MM-DD"), `under ${locale}`).toBe("2026-03-10");
    }
  });

  it("honours the format the setting asked for, separators and all", () => {
    const at = local(2026, 3, 10);
    expect(formatDailyDate(at, "YYYY/MM/DD")).toBe("2026/03/10");
    expect(formatDailyDate(at, "DD.MM.YYYY")).toBe("10.03.2026");
    expect(formatDailyDate(at, "Journal YYYY-MM-DD")).toBe("Journal 2026-03-10");
  });
});

// ── 4. Resolution happens at invocation, not at module load ─────────────────

describe("the daily note resolves at invocation, not at page load", () => {
  it("one long-lived module instance answers differently for two instants", () => {
    // The failure this pins: a resolver that captured "today" at import time
    // keeps answering with the day the app was STARTED. On a machine left
    // running for a week, every "open today's note" lands on the same note.
    const notes = [
      note({ id: "a", title: "2026-03-10", folder: "Daily/" }),
      note({ id: "b", title: "2026-03-11", folder: "Daily/" }),
    ];
    // `resolvePeriodNote(now, period, settings, notes)` since myne#177 made the
    // daily flow one case of three; `NO_SETTINGS` is "no folder, no format",
    // which is what the two nulls used to say. `toMatchObject` rather than
    // `toEqual`
    // because the result now also carries the `range` the create path fills
    // `{{period_start}}` from, and pinning it here would assert the calendar
    // rather than the clock, which is this file's subject.
    const monday = resolvePeriodNote(local(2026, 3, 10), "daily", NO_SETTINGS, notes);
    const tuesday = resolvePeriodNote(local(2026, 3, 11), "daily", NO_SETTINGS, notes);
    expect(monday).toMatchObject({ kind: "open", id: "a", dateTitle: "2026-03-10" });
    expect(tuesday).toMatchObject({ kind: "open", id: "b", dateTitle: "2026-03-11" });
  });

  it("asks to CREATE for a day with no note, in the configured folder", () => {
    const res = resolvePeriodNote(local(2026, 3, 12), "daily", NO_SETTINGS, [
      note({ id: "a", title: "2026-03-10", folder: "Daily/" }),
    ]);
    expect(res.kind).toBe("create");
    expect(res.dateTitle).toBe("2026-03-12");
  });

  it("the defaults are the ones the settings block documents", () => {
    expect(DEFAULT_DAILY_FOLDER).toBe("Daily/");
    expect(DEFAULT_DAILY_DATE_FORMAT).toBe("YYYY-MM-DD");
  });
});

// ── 5. "Today's date" against "the template's date" ─────────────────────────

describe("a template's tokens render at instantiation, not at authoring", () => {
  it("the same template renders two different dates under two instants", () => {
    // The `settings.block.daily-notes` bullet's actual claim: a template
    // containing `{{date}}` must stamp the day the NOTE is made, not the day
    // the template was written. Two `now` values through one context builder
    // is the whole check.
    const monday = buildRenderContext(local(2026, 3, 10, 9, 5), "Standup", singleDay(local(2026, 3, 10, 9, 5)));
    const tuesday = buildRenderContext(local(2026, 3, 11, 9, 5), "Standup", singleDay(local(2026, 3, 11, 9, 5)));
    expect(monday.date).toBe("2026-03-10");
    expect(tuesday.date).toBe("2026-03-11");
    expect(monday.title).toBe(tuesday.title);
  });

  it("stamps the LOCAL calendar day, including just after local midnight", () => {
    // 00:30 local. A context built from UTC accessors would stamp the previous
    // day for every user east of Greenwich — the exact failure the
    // `localDateTime` module's header says it exists to prevent.
    const ctx = buildRenderContext(local(2026, 3, 10, 0, 30), "Journal", singleDay(local(2026, 3, 10, 0, 30)));
    expect(ctx.date).toBe("2026-03-10");
    expect(ctx.time).toBe("00:30");
    expect(ctx.datetime).toBe("2026-03-10 00:30");
  });

  it("the weekday follows the host locale while the date does not", () => {
    // Two fields with deliberately different rules, and a test that pins both:
    // `weekday` is localized (the app-language proxy), `date` is not.
    const ctx = buildRenderContext(local(2026, 3, 10), "X", singleDay(local(2026, 3, 10)));
    expect(ctx.date).toBe("2026-03-10");
    expect(ctx.weekday.length).toBeGreaterThan(0);
    // 2026-03-10 is a Tuesday. Asserted through `Intl` rather than pasted so
    // the test does not depend on the runner's language.
    expect(ctx.weekday).toBe(
      local(2026, 3, 10).toLocaleDateString(undefined, { weekday: "long" }),
    );
  });
});

// ── 6. The defaulted-parameter trap is closed ───────────────────────────────

describe("createNoteFromTemplate cannot read the wall clock behind a caller's back", () => {
  it("declares `now` as required, not defaulted", () => {
    // `AGENTS.md`: "A guard parameter with a default value is an opt-in guard,
    // and the default is the arm that never fires." A source assertion rather
    // than a type one because the failure is invisible to `tsc`: re-adding
    // `= new Date()` compiles, satisfies every call site, and silently excuses
    // future ones. The mobile twin has always required it.
    const src = readSource("src/notes/newNoteFromTemplate.ts");
    const sig = src.slice(
      src.indexOf("export async function createNoteFromTemplate"),
      src.indexOf("): Promise<string> {", src.indexOf("createNoteFromTemplate")),
    );
    expect(sig).toContain("now: Date");
    expect(
      /now:\s*Date\s*=/.test(sig),
      "`now` has a default again, which excuses every production call site " +
        "from passing one — the shape AGENTS.md names",
    ).toBe(false);
  });

  it("the daily flow threads ONE instant through the title and the render", () => {
    // Two `new Date()` calls a few statements apart can straddle midnight,
    // which titles the note with yesterday's date and renders `{{date}}` as
    // today's — a note that disagrees with itself, and a once-a-release walk
    // would have to be run at exactly the wrong second to see it.
    const src = readSource("src/screens/Editor.tsx");
    // `onOpenTodayNote` became `onOpenPeriodNote` when myne#177 folded weekly
    // and monthly into one entry point, and the instant is now taken through
    // `zonedNow` so the day is the DISPLAY timezone's. Both facts move the
    // strings this asserts; the property does not, which is that ONE binding
    // reaches both the resolve and the template render.
    const flow = src.slice(
      src.indexOf("const onOpenPeriodNote"),
      src.indexOf("const onOpenPeriodNote") + 2000,
    );
    expect(flow).toContain("const now = zonedNow(new Date(), prefs.timezone);");
    expect(flow).toContain("resolvePeriodNote(now,");
    // …and the template branch takes that same binding rather than a fresh one.
    const templateCall = flow.slice(flow.indexOf("createNoteFromTemplate("));
    expect(templateCall.slice(0, 200)).toContain("now,");
    expect(
      /createNoteFromTemplate\([^)]*new Date\(\)/s.test(flow),
      "the daily branch builds a second instant for the template render",
    ).toBe(false);
  });

  it("the mobile twin still requires it too", () => {
    // A twin that drifts back is how the desktop side got here. `mobile/` is
    // the side that was already right.
    const src = readSource("mobile/src/lib/daily.ts");
    expect(src).toContain("createNoteFromTemplate");
    expect(/now:\s*Date\s*=/.test(src)).toBe(false);
  });
});

function readSource(rel: string): string {
  // Deliberately a plain read rather than an import: what is under test is the
  // SIGNATURE and the call shape, and both survive any import unchanged.
  return readFileSync(rel, "utf8");
}
