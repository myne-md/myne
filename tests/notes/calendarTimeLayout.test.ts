// Where a timed row sits on the hour axis (myne-md/myne#1037).
//
// The defect this exists for is the one the owner reported from the running app: a
// 09:00-10:00 event drew as one chip INSIDE the 09:00 row, so the grid claimed the
// hour after nine was empty while the note said the event was in it. The block now
// spans its own minutes, and these are the four answers that makes true:
//
// 1. a 09:00-10:00 row covers exactly one hour, and the block's own geometry says
//    where it starts and how tall it is;
// 2. a row that runs past midnight, or began the day before, is CLAMPED to the day
//    column it is drawn in rather than leaking out of it;
// 3. overlapping rows split the width instead of covering each other;
// 4. a pointer's minute snaps to a quarter hour, because a gesture is a pixel and
//    the file carries `09:15`.
//
// The assertions are on numbers, not on the DOM: jsdom computes no layout, so a
// block's `top`/`height` percentages are the only honest evidence of its span.

import { describe, expect, it } from "vitest";
import {
  DAY_MINUTES,
  blockGeometry,
  clockOf,
  daySpan,
  layoutDay,
  minuteOfDay,
  snapMinute,
} from "../../src/notes/calendar/layout";

const DAY = "2026-11-05";

function row(over: Partial<{ noteId: string; start: string; end: string | null; allDay: boolean }> = {}) {
  return {
    noteId: "n1",
    start: `${DAY} 09:00`,
    end: `${DAY} 10:00`,
    allDay: false,
    ...over,
  };
}

describe("the minutes a row covers", () => {
  it("spans start to end, so 09:00-10:00 is one whole hour", () => {
    expect(daySpan(row(), DAY)).toEqual({ startMin: 9 * 60, endMin: 10 * 60 });
    // The block's own geometry, which is what the grid actually positions.
    expect(blockGeometry(daySpan(row(), DAY)!)).toEqual({ top: "37.5%", height: "4.166666666666666%" });
  });

  it("answers null for a row the axis does not draw", () => {
    expect(daySpan(row({ allDay: true }), DAY)).toBeNull();
    expect(daySpan(row({ start: "2026-11-06 09:00", end: "2026-11-06 10:00" }), DAY)).toBeNull();
    // A readable but clock-less start is the dialect's all-day shape, whatever the
    // row's flag says: the value decides, not a field that could disagree with it.
    expect(daySpan(row({ start: DAY, end: null }), DAY)).toBeNull();
  });

  it("clamps a span to the day column it is drawn in", () => {
    // Began yesterday: drawn from midnight, not from a negative offset.
    expect(daySpan(row({ start: "2026-11-04 22:00", end: `${DAY} 02:00` }), DAY)).toEqual({
      startMin: 0,
      endMin: 120,
    });
    // Runs past midnight: filled to the end of the day it starts on.
    expect(daySpan(row({ start: `${DAY} 23:00`, end: "2026-11-06 01:00" }), DAY)).toEqual({
      startMin: 23 * 60,
      endMin: DAY_MINUTES,
    });
  });

  it("keeps a point event a point, so the grid never invents an hour", () => {
    expect(daySpan(row({ end: null }), DAY)).toEqual({ startMin: 540, endMin: 540 });
    // The block still gets a height to be clickable - but from the LAYOUT, and the
    // top stays exactly on its minute.
    expect(blockGeometry(daySpan(row({ end: null }), DAY)!, 20)).toEqual({
      top: "37.5%",
      height: `${(20 / DAY_MINUTES) * 100}%`,
    });
  });
});

describe("how one day's rows share the column", () => {
  it("gives a lone row the whole width", () => {
    const placed = layoutDay([row()], DAY);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ startMin: 540, endMin: 600, column: 0, columns: 1 });
  });

  it("splits the width between two rows at the same hour", () => {
    const placed = layoutDay(
      [row({ noteId: "a" }), row({ noteId: "b", start: `${DAY} 09:30`, end: `${DAY} 10:30` })],
      DAY,
    );
    expect(placed.map((block) => [block.column, block.columns])).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  it("gives the next row the full width again once the cluster ends", () => {
    const placed = layoutDay(
      [
        row({ noteId: "a" }),
        row({ noteId: "b", start: `${DAY} 09:30`, end: `${DAY} 10:30` }),
        row({ noteId: "c", start: `${DAY} 11:00`, end: `${DAY} 12:00` }),
      ],
      DAY,
    );
    expect(placed.map((block) => block.columns)).toEqual([2, 2, 1]);
  });

  it("orders by start, and a row that shares no minute is its own cluster", () => {
    const placed = layoutDay(
      [
        row({ noteId: "late", start: `${DAY} 14:00`, end: `${DAY} 15:00` }),
        row({ noteId: "early" }),
      ],
      DAY,
    );
    expect(placed.map((block) => block.startMin)).toEqual([540, 840]);
    expect(placed.every((block) => block.columns === 1)).toBe(true);
  });

  it("leaves out the rows the axis does not draw", () => {
    const placed = layoutDay([row({ noteId: "all", allDay: true }), row({ noteId: "timed" })], DAY);
    expect(placed.map((block) => block.key)).toEqual(["timed-540"]);
  });
});

describe("what a pointer means", () => {
  it("reads a stored instant as minutes, and nothing for a clock-less one", () => {
    expect(minuteOfDay(`${DAY} 14:30`)).toBe(14 * 60 + 30);
    expect(minuteOfDay(DAY)).toBeNull();
  });

  it("snaps to a quarter hour, clamped into the day", () => {
    expect(snapMinute(9 * 60 + 7)).toBe(9 * 60);
    expect(snapMinute(9 * 60 + 8)).toBe(9 * 60 + 15);
    expect(snapMinute(-20)).toBe(0);
    expect(snapMinute(DAY_MINUTES + 40)).toBe(DAY_MINUTES);
  });

  it("prints clock minutes, clamped", () => {
    expect(clockOf(9 * 60 + 5)).toBe("09:05");
    expect(clockOf(-1)).toBe("00:00");
    expect(clockOf(DAY_MINUTES + 1)).toBe("24:00");
  });
});
