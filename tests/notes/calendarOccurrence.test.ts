// An occurrence belongs to its series (myne-md/myne#1037, task 8).
//
// A recurring event is ONE note projected into many rows, and §3.8.7 has no
// per-occurrence exceptions. So the two claims to test are:
//
// 1. a gesture on an appearance is REFUSED, naming the series and the date, rather
//    than computing a move for a row that has no note; and
// 2. the sanctioned alternative creates a NEW note carrying the series' own
//    duration, and touches nothing about the series.
//
// The second one is asserted against the bytes, because "the series is unchanged"
// is a claim about the file rather than about the intent.

import { describe, expect, it } from "vitest";
import {
  OccurrenceRefused,
  isProjected,
  movableTarget,
  occurrenceDate,
  occurrenceRefusal,
  oneOffSeed,
  oneOffSeedOn,
  seriesNoteId,
} from "../../src/notes/calendar/occurrence";
import { buildEventNoteBytes } from "../../src/notes/createEvent";
import { readEventFromFmBody } from "../../src/dialect/event";
import type { CalendarRow } from "../../src/notes/vaultIndices";

const decoder = new TextDecoder();

function row(over: Partial<CalendarRow> = {}): CalendarRow {
  return {
    noteId: "series-1",
    title: "Standup",
    folder: "Calendar/",
    calendar: "Work",
    start: "2026-11-05 09:00",
    end: "2026-11-05 09:30",
    allDay: false,
    occurrenceOf: "series-1",
    occurrenceDate: "2026-11-05",
    conflicts: false,
    repeat: "every monday",
    repeatUnrecognized: false,
    ...over,
  };
}

/** A one-off: a note that is its own occurrence. */
function oneOff(over: Partial<CalendarRow> = {}): CalendarRow {
  return row({ occurrenceOf: null, occurrenceDate: null, repeat: null, ...over });
}

function fmBody(plaintext: string): string {
  const start = plaintext.indexOf("---\n");
  const end = plaintext.indexOf("\n---", start + 4);
  return plaintext.slice(start + 4, end);
}

describe("recognising an occurrence", () => {
  it("is a projected row, and a projected row is not a note of its own", () => {
    expect(isProjected(row())).toBe(true);
    expect(isProjected(oneOff())).toBe(false);
  });

  it("targets the series for any series-wide write", () => {
    expect(seriesNoteId(row())).toBe("series-1");
    expect(seriesNoteId(oneOff())).toBe("series-1");
  });

  it("names the occurrence's own date, not the series' first", () => {
    expect(occurrenceDate(row())).toBe("2026-11-05");
    expect(occurrenceDate(row({ start: "2026-11-19 09:00", occurrenceDate: "2026-11-19" }))).toBe(
      "2026-11-19",
    );
  });
});

describe("a gesture on an occurrence", () => {
  it("refuses with the series and the date it belongs to", () => {
    expect(occurrenceRefusal(row())).toEqual({
      reason: "belongs-to-series",
      seriesNoteId: "series-1",
      occurrenceDate: "2026-11-05",
      title: "Standup",
    });
  });

  it("refuses BEFORE any planner can compute a move", () => {
    // The guard is what stops a `planDrag` from producing a plausible span for a
    // row that has no note. Removing it makes this test fail, which is how the
    // refusal is proven rather than assumed.
    expect(() => movableTarget(row())).toThrow(OccurrenceRefused);
    try {
      movableTarget(row());
    } catch (err) {
      expect((err as OccurrenceRefused).refusal.occurrenceDate).toBe("2026-11-05");
    }
  });

  it("lets a one-off move, because it has a note of its own", () => {
    expect(movableTarget(oneOff())).toBe("series-1");
    expect(occurrenceRefusal(oneOff())).toBeNull();
  });
});

describe("the sanctioned alternative", () => {
  it("creates a new event note on the occurrence's day", () => {
    const seed = oneOffSeed(row());
    expect(seed).not.toBeNull();
    if (seed === null) throw new Error("unreachable");
    expect(seed.title).toBe("Standup");
    expect(seed.start).toEqual({ date: { year: 2026, month: 11, day: 5 }, time: "09:00" });
    expect(seed.repeat).toBeNull();
  });

  it("carries the series' own duration, so the one-off is not silently different", () => {
    const seed = oneOffSeed(row({ start: "2026-11-05 09:00", end: "2026-11-05 10:30" }));
    if (seed === null) throw new Error("unreachable");
    // 90 minutes in, 90 minutes out.
    const bytes = decoder.decode(buildEventNoteBytes(seed));
    const read = readEventFromFmBody(fmBody(bytes));
    expect(read.state).toBe("ok");
    if (read.state !== "ok") throw new Error("unreachable");
    expect(read.event.start.time).toBe("09:00");
    expect(read.event.end?.time).toBe("10:30");
  });

  it("writes a note with no rule, so it cannot be mistaken for the series", () => {
    const seed = oneOffSeed(row());
    if (seed === null) throw new Error("unreachable");
    const plaintext = decoder.decode(buildEventNoteBytes(seed));
    const read = readEventFromFmBody(fmBody(plaintext));
    if (read.state !== "ok") throw new Error("unreachable");
    expect(read.event.repeatRaw).toBeNull();
    // A one-off has no uid of its own either: it is an ordinary event note.
    expect(read.event.calendar).toBe("Work");
  });

  it("leaves the series untouched, which is what makes it an alternative", () => {
    // The only note this path can write is the NEW one: `oneOffSeed` never carries
    // the series' id, so there is nothing for a writer to target on the series.
    const seed = oneOffSeed(row());
    expect(JSON.stringify(seed)).not.toContain("series-1");
  });

  it("can be dropped on another day, keeping its duration", () => {
    const seed = oneOffSeedOn(
      row({ start: "2026-11-05 09:00", end: "2026-11-05 10:30" }),
      "2026-11-12",
    );
    if (seed === null) throw new Error("unreachable");
    expect(seed.start).toEqual({ date: { year: 2026, month: 11, day: 12 }, time: "09:00" });
    expect(seed.end).toEqual({ date: { year: 2026, month: 11, day: 12 }, time: "10:30" });
  });

  it("keeps an all-day occurrence all-day", () => {
    const seed = oneOffSeed(row({ start: "2026-11-05", end: "2026-11-07", allDay: true }));
    if (seed === null) throw new Error("unreachable");
    expect(seed.start.time).toBeNull();
    expect(seed.end?.time).toBeNull();
  });
});
