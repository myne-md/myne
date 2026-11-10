// Where a timed row sits on the hour axis, in minutes (myne-md/myne#1037).
//
// The axis used to hold each row INSIDE the hour it started in, so a 09:00-10:00
// event occupied one chip in the 09:00 row and no part of the hour after it. A
// block that spans its own minutes needs three answers, and all three live here so
// the grid, a gesture and a test cannot disagree: which minutes a row covers on a
// day (clamped, never trusted), how overlapping rows share the width, and what a
// pointer position means (a pixel is a quarter hour).
//
// Minutes past midnight, never a date-time: the axis is a wall clock
// (`markdown-dialect.md` §3.10.2), so nothing here converts a zone.

/** The minutes of a day an axis draws. */
export const DAY_MINUTES = 24 * 60;

/** The grain a gesture snaps to: small enough that a deliberate 09:15 is reachable. */
export const SNAP_MINUTES = 15;

/** A row's share of one day, in minutes past that day's midnight. */
export type MinuteSpan = {
  readonly startMin: number;
  readonly endMin: number;
};

/** The row fields this module reads; a `CalendarRow` satisfies it. */
export type SpanRow = {
  readonly noteId: string;
  readonly start: string;
  readonly end: string | null;
  readonly allDay: boolean;
};

/** A row placed in a day column: its span, and which slice of the width it takes. */
export type PlacedSpan<T extends SpanRow = SpanRow> = MinuteSpan & {
  /** The row itself, so the caller draws the same object it handed in. */
  readonly row: T;
  /** Stable within one column: the row's own identity plus where it starts. */
  readonly key: string;
  /** 0-based slice within its overlap cluster. */
  readonly column: number;
  /** How many slices that cluster is divided into. */
  readonly columns: number;
};

/**
 * Minutes past midnight for a stored instant (`YYYY-MM-DD HH:MM`), or `null` for
 * one that carries no clock - which is how the dialect says "all day".
 */
export function minuteOfDay(value: string): number | null {
  if (value.length < 16) return null;
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

/** `HH:MM` for minutes past midnight, clamped into the day. */
export function clockOf(minutes: number): string {
  const clamped = Math.max(0, Math.min(DAY_MINUTES, Math.round(minutes)));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The nearest snap point to `minutes`, clamped into the day. */
export function snapMinute(minutes: number, step: number = SNAP_MINUTES): number {
  const snapped = Math.round(minutes / step) * step;
  return Math.max(0, Math.min(DAY_MINUTES, snapped));
}

/**
 * The minutes a row covers on `day`, or `null` when the axis does not draw it.
 *
 * A span crossing midnight is cut at both ends: the axis draws ONE day, so a
 * 23:00-01:00 event fills the last hour of the day it starts on and nothing after.
 */
export function daySpan(row: SpanRow, day: string): MinuteSpan | null {
  if (row.allDay) return null;
  const startMin = minuteOfDay(row.start);
  if (startMin === null) return null;
  const startDay = row.start.slice(0, 10);
  if (startDay > day) return null;

  const endMin = row.end === null ? null : minuteOfDay(row.end);
  const endDay = row.end === null ? null : row.end.slice(0, 10);

  // A row that began on an earlier day is drawn from midnight.
  const from = startDay < day ? 0 : startMin;
  if (endMin === null || endDay === null) {
    // A point event is a zero-length span: the block gets a floor HEIGHT so it
    // stays clickable, and nothing here invents an hour it does not have.
    return { startMin: from, endMin: from };
  }
  if (endDay < day) return null;
  return { startMin: from, endMin: endDay > day ? DAY_MINUTES : Math.max(from, endMin) };
}

/**
 * Place the rows of ONE day column, splitting the width between overlaps.
 *
 * Greedy and in start order: a row's slice changes only when a row BEFORE it
 * changes. A cluster's width is the number of slices it needed, so a row after the
 * cluster ends gets the full column again.
 */
export function layoutDay<T extends SpanRow>(rows: readonly T[], day: string): PlacedSpan<T>[] {
  const entries: { row: T; span: MinuteSpan; column: number }[] = [];
  for (const row of rows) {
    const span = daySpan(row, day);
    if (span !== null) entries.push({ row, span, column: 0 });
  }
  entries.sort((a, b) => a.span.startMin - b.span.startMin || a.span.endMin - b.span.endMin);

  const placed: PlacedSpan<T>[] = [];
  /** The cluster being filled: its rows, the furthest minute it reaches, and when
   *  each slice it has opened becomes free again. */
  let cluster: { rows: typeof entries; end: number; freeAt: number[] } | null = null;

  const flush = (): void => {
    if (cluster === null) return;
    const columns = Math.max(1, cluster.freeAt.length);
    for (const entry of cluster.rows) {
      placed.push({
        row: entry.row,
        key: `${entry.row.noteId}-${entry.span.startMin}`,
        startMin: entry.span.startMin,
        endMin: entry.span.endMin,
        column: entry.column,
        columns,
      });
    }
    cluster = null;
  };

  for (const entry of entries) {
    if (cluster === null || entry.span.startMin >= cluster.end) {
      flush();
      cluster = { rows: [], end: entry.span.endMin, freeAt: [] };
    }
    // A slice is free when the last row that took it has ended by now.
    const free = cluster.freeAt.findIndex((until) => until <= entry.span.startMin);
    if (free === -1) {
      entry.column = cluster.freeAt.length;
      cluster.freeAt.push(entry.span.endMin);
    } else {
      entry.column = free;
      cluster.freeAt[free] = entry.span.endMin;
    }
    cluster.rows.push(entry);
    cluster.end = Math.max(cluster.end, entry.span.endMin);
  }
  flush();
  return placed;
}

/** The same place, as the percentages a positioned block needs. A zero-length row
 *  is given a floor HEIGHT so it stays clickable; its top stays on its minute. */
export function blockGeometry(span: MinuteSpan, minMinutes: number = 0): {
  top: string;
  height: string;
} {
  const height = Math.max(span.endMin - span.startMin, minMinutes);
  return {
    top: `${(span.startMin / DAY_MINUTES) * 100}%`,
    height: `${(height / DAY_MINUTES) * 100}%`,
  };
}
