// The calendar's grid math (myne-md/myne#1037, task 5).
//
// Pure functions, so these tests are the whole verification of "which day does an
// event fall on". The pane renders what they say; if a cell is wrong the bug is in
// here, and a DOM test would only have told us a cell was wrong without saying
// which rule was.
//
// The cases that matter are the ones a naive grid gets wrong: a month that starts
// on a Sunday (padding of six), a month that starts on a Monday (no padding), a
// February in a leap year, and a multi-day span crossing a month boundary.

import { describe, expect, it } from "vitest";
import { parseCivilDate, formatCivilDate } from "../../src/dialect/civilDate";
import {
  dayCells,
  monthGrid,
  rowDates,
  rowsByDate,
  shiftAnchor,
  weekRow,
  windowForView,
} from "../../src/notes/calendar/grid";
import type { CalendarRow } from "../../src/notes/vaultIndices";

function d(iso: string) {
  const parsed = parseCivilDate(iso);
  if (parsed === null) throw new Error(`bad fixture date ${iso}`);
  return parsed;
}

function row(start: string, end: string | null = null, extra: Partial<CalendarRow> = {}): CalendarRow {
  return {
    noteId: `note-${start}`,
    title: "event",
    folder: null,
    calendar: null,
    start,
    end,
    allDay: !start.includes(" "),
    occurrenceOf: null,
    occurrenceDate: null,
    conflicts: false,
    repeat: null,
    repeatUnrecognized: false,
    remind: null,
    uid: null,
    ...extra,
  };
}

describe("rowDates", () => {
  it("gives a single date for a point event", () => {
    expect(rowDates(row("2026-11-05"))).toEqual(["2026-11-05"]);
    expect(rowDates(row("2026-11-05 09:00"))).toEqual(["2026-11-05"]);
  });

  it("expands a multi-day event into every date it spans", () => {
    expect(rowDates(row("2026-11-05", "2026-11-07"))).toEqual([
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
    ]);
  });

  it("crosses a month boundary without special-casing it", () => {
    expect(rowDates(row("2026-01-30", "2026-02-02"))).toEqual([
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
  });

  it("treats an end before the start as a point rather than an empty span", () => {
    // The host refuses that shape as unreadable, so this only fires on a row a
    // caller assembled by hand; it must not silently draw nothing.
    expect(rowDates(row("2026-11-05", "2026-11-01"))).toEqual(["2026-11-05"]);
  });
});

describe("rowsByDate", () => {
  it("puts a multi-day row in each of its cells", () => {
    const byDate = rowsByDate([row("2026-11-05", "2026-11-06")]);
    expect([...byDate.keys()].sort()).toEqual(["2026-11-05", "2026-11-06"]);
    expect(byDate.get("2026-11-06")).toHaveLength(1);
  });
});

describe("monthGrid", () => {
  it("starts every month on the Monday on or before the 1st", () => {
    // 2026-11-01 is a Sunday, so the grid opens on Monday 2026-10-26.
    const weeks = monthGrid(d("2026-11-15"), []);
    expect(weeks[0]![0]!.date).toBe("2026-10-26");
    expect(weeks[0]![6]!.date).toBe("2026-11-01");
  });

  it("adds no padding when the month starts on a Monday", () => {
    // 2026-06-01 is a Monday.
    const weeks = monthGrid(d("2026-06-10"), []);
    expect(weeks[0]![0]!.date).toBe("2026-06-01");
  });

  it("has seven cells in every row and marks the padding days", () => {
    const weeks = monthGrid(d("2026-02-10"), []);
    for (const week of weeks) expect(week).toHaveLength(7);
    const flat = weeks.flat();
    expect(flat.some((cell) => !cell.inMonth)).toBe(true);
    expect(flat.filter((cell) => cell.inMonth)).toHaveLength(28);
  });

  it("handles a leap February", () => {
    const weeks = monthGrid(d("2028-02-10"), []);
    expect(weeks.flat().filter((cell) => cell.inMonth)).toHaveLength(29);
  });

  it("places a row in every cell it spans", () => {
    const weeks = monthGrid(d("2026-11-15"), [row("2026-11-05", "2026-11-07")]);
    const cells = weeks.flat().filter((cell) => cell.rows.length > 0);
    expect(cells.map((cell) => cell.date)).toEqual([
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
    ]);
  });
});

describe("weekRow and dayCells", () => {
  it("gives the Monday-first week containing the anchor", () => {
    // 2026-11-05 is a Thursday; its Monday is the 2nd.
    expect(weekRow(d("2026-11-05"), []).map((c) => c.date)).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
    ]);
  });

  it("gives one cell for a day, carrying only that day's rows", () => {
    const cells = dayCells(d("2026-11-05"), [row("2026-11-05"), row("2026-11-06")]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.rows).toHaveLength(1);
  });
});

describe("windowForView", () => {
  const anchor = d("2026-11-05");

  it("covers the whole month grid, padding included", () => {
    const window = windowForView("month", anchor, 30);
    expect(window.start).toBe("2026-10-26");
    // 2026-11-30 is a Monday, so the grid's last day is 2026-12-06.
    expect(window.end).toBe("2026-12-06 23:59");
  });

  it("covers exactly the week, the day or the agenda range", () => {
    expect(windowForView("week", anchor, 30)).toEqual({
      start: "2026-11-02",
      end: "2026-11-08 23:59",
    });
    expect(windowForView("day", anchor, 30)).toEqual({
      start: "2026-11-05",
      end: "2026-11-05 23:59",
    });
    expect(windowForView("agenda", anchor, 3)).toEqual({
      start: "2026-11-05",
      end: "2026-11-07 23:59",
    });
  });
});

describe("shiftAnchor", () => {
  it("steps by the view's own unit, and a month step lands on the 1st", () => {
    const anchor = d("2026-11-05");
    expect(formatCivilDate(shiftAnchor("month", anchor, 1))).toBe("2026-12-01");
    expect(formatCivilDate(shiftAnchor("month", anchor, -1))).toBe("2026-10-01");
    expect(formatCivilDate(shiftAnchor("week", anchor, 1))).toBe("2026-11-12");
    expect(formatCivilDate(shiftAnchor("day", anchor, -1))).toBe("2026-11-04");
  });

  it("never lands on a day a short month does not have", () => {
    // From 31 January, forward one month is February, so the anchor is the 1st.
    expect(formatCivilDate(shiftAnchor("month", d("2026-01-31"), 1))).toBe("2026-02-01");
  });
});
