// The phone's calendar (myne-md/myne#1037, grill Q11: "all three clients,
// including a full-screen mobile calendar").
//
// # What it is
//
// Month, week and day over ONE set of shared answers, and the same ones the desktop
// pane draws from: `@myne/calendar-grid` says which day an event falls on and how a
// month lays out, `@myne/calendar-layout` says where a block sits on an hour axis and
// what a finger's position means, `@myne/calendar-drag-write` / `@myne/calendar-update`
// are the writers, and `.myne-calendar__*` in `@myne/client-core` is the skin. A phone
// and a laptop cannot disagree about what is on Thursday or where 10:30 is, because
// they are not two implementations that happen to agree: they are one function called
// twice. What IS per-client is only the shape of the surface (a full-screen overlay
// instead of a pane) and the IO below the writers.
//
// # Gestures are pointer gestures, never HTML5 drag
//
// `draggable` does not fire on touch, so every move here is `pointerdown` ->
// `pointermove` -> `pointerup` on the element or its window, exactly as the desktop
// pane does it: press and drag empty space to draw a range, drag a block's body to
// reschedule it, drag its ends to change one instant. A press that does not move is a
// tap and opens the form, so neither gesture is a mode the user has to know about.
//
// # Why the read is not bounded
//
// `bounded` is the MODEL's clamp on this query, not the user's. This screen is the
// owner looking at their own calendar, so it asks for the whole window, the same way
// the desktop pane does.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { parseCivilDate, weekdayOf } from "@myne/dialect-civil-date";
import { Button, Segmented, Sheet, Spinner, TextField } from "../../components";
import { vaultIndicesCalendarRange } from "../../lib/calendar";
import {
  WEEKDAY_HEADERS,
  dayCells,
  monthGrid,
  shiftAnchor,
  weekRow,
  windowForView,
} from "@myne/calendar-grid";
import {
  DAY_MINUTES,
  MIN_BLOCK_MINUTES,
  blockGeometry,
  clockOf,
  layoutDay,
  rowHour,
} from "@myne/calendar-layout";
import { beginCreateGesture, beginMoveGesture, beginResizeGesture } from "@myne/calendar-gesture";
import { calendarColour } from "@myne/calendar-colour";
import { visibleRows } from "@myne/calendar-visibility";
import { EventWriteRefused, applyEventMove, type EventSpan } from "@myne/calendar-drag-write";
import type { CivilDate } from "@myne/dialect-civil-date";
import type { CalendarRow } from "@myne/vault-indices";
import { monthLabel } from "@myne/calendar-format";
import { tappable } from "../a11y/tappable";
import { EventComposerSheet } from "./EventComposerSheet";
import { skipOccurrence } from "@myne/calendar-skip";
import { overrideOccurrence } from "@myne/calendar-override";
import { noteRead, noteUpdate } from "../../lib/notes";
import { formatLocalDate } from "../../lib/localDateTime";
import { homeClockFor } from "@myne/home-zone";
import { usePrefs } from "../../lib/use-prefs";

type ViewName = "month" | "week" | "day";

/** The three views, in the order the segmented control shows them. */
const VIEWS: readonly ViewName[] = ["month", "week", "day"];

/** The hours an axis draws: a fixed set, so two days' 14:00 sit level. */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** The one IO the shared writers take, bound to the phone's own note commands. */
const EVENT_IO = {
  readNote: noteRead,
  writeNote: (id: string, body: string, base: string) => noteUpdate(id, body, base),
};

/**
 * The second clock (`decisions/storage/0797`), beside a row's own time.
 *
 * A phone is the device that travels, so this is where the feature earns its keep:
 * "09:00 · evde 06:00" is the difference between a meeting that reads as a mistake
 * and one that reads as an early start. Empty string when there is nothing to add,
 * so a reader with no home zone sees exactly what it saw before.
 */
function secondClock(start: string): string {
  const home = homeClockFor(start.replace(" ", "T"));
  if (home === null) return "";
  const day = home.dayOffset === 0 ? "" : home.dayOffset > 0 ? "+1" : "-1";
  return `  ·  ${home.time}${day}`;
}

/** Today, as the civil date the calendar speaks. */
function todayCivil(): CivilDate {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() } as CivilDate;
}

/** The weekday header for a `YYYY-MM-DD`, Monday first like the grid. */
function weekdayHeader(date: string): string {
  const civil = parseCivilDate(date);
  if (civil === null) return "";
  return WEEKDAY_HEADERS[["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(weekdayOf(civil))] ?? "";
}

/** Where a create gesture or a tap opened the composer. */
type ComposeSeed = { date: string; startTime?: string; endTime?: string };

export function CalendarSurface({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<ViewName>("month");
  const [anchor, setAnchor] = useState<CivilDate>(todayCivil);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<readonly CalendarRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [composing, setComposing] = useState<ComposeSeed | null>(null);
  const [editing, setEditing] = useState<CalendarRow | null>(null);
  const [writeFailed, setWriteFailed] = useState(false);
  /** The range a create-drag is drawing, so the ghost can follow the finger. */
  const [creating, setCreating] = useState<{ date: string; from: number; to: number } | null>(null);
  /** The row whose start time is being changed, and the time typed for it. */
  const [retiming, setRetiming] = useState<{ row: CalendarRow; time: string } | null>(null);

  // The same prefs the desktop reads: which calendars are switched off and what
  // colour each one draws in. `usePrefs` is the phone's reader over the one prefs
  // command, so this is a read of the vault's own settings and not a copy of them.
  const { prefs } = usePrefs();
  const calendarSettings = prefs.calendar_settings ?? {};

  const load = useCallback(() => {
    const window = windowForView(view, anchor, 0);
    setFailed(false);
    void vaultIndicesCalendarRange(window.start, window.end, false)
      .then((answer) => setRows(answer.rows))
      .catch(() => {
        setRows([]);
        setFailed(true);
      });
  }, [view, anchor]);
  useEffect(load, [load]);

  /**
   * Cancel one appearance of a series from the phone.
   *
   * The write is the shared one (`@myne/calendar-skip`), so the field's bytes are
   * the same ones the desktop pane writes; only the IO below it is the phone's.
   * A refusal is shown, not swallowed: the row is re-read either way, and a row
   * that came back because the write did not land must not look like one the user
   * never cancelled.
   */
  const skip = useCallback(
    async (row: CalendarRow) => {
      setWriteFailed(false);
      try {
        await skipOccurrence({
          noteId: row.occurrenceOf ?? row.noteId,
          occurrenceDate: row.occurrenceDate ?? row.start.slice(0, 10),
          io: EVENT_IO,
        });
      } catch (err) {
        if (err instanceof EventWriteRefused) setWriteFailed(true);
        else throw err;
      }
      await load();
    },
    [load],
  );

  /**
   * Retime one appearance, through the writer the desktop pane uses.
   *
   * The day and the duration stay (`decisions/storage/0796`), so the sheet asks for
   * a clock only; a date field here would be a move, and a move on an occurrence has
   * no legal write on either client.
   */
  const retime = useCallback(async () => {
    if (retiming === null) return;
    setWriteFailed(false);
    try {
      await overrideOccurrence({
        noteId: retiming.row.occurrenceOf ?? retiming.row.noteId,
        occurrenceDate: retiming.row.occurrenceDate ?? retiming.row.start.slice(0, 10),
        time: retiming.time,
        io: EVENT_IO,
      });
      setRetiming(null);
    } catch (err) {
      if (err instanceof EventWriteRefused) setWriteFailed(true);
      else throw err;
    }
    await load();
  }, [load, retiming]);

  /**
   * ONE writer for every gesture that changes `start`/`end`, so a refused move
   * cannot be shown as landed by the gesture that did not check.
   */
  const commitSpan = useCallback(
    async (row: CalendarRow, rendered: EventSpan, next: EventSpan) => {
      if (next.start === rendered.start && next.end === rendered.end) return;
      setWriteFailed(false);
      try {
        await applyEventMove({ noteId: row.noteId, rendered, next, io: EVENT_IO });
      } catch (err) {
        if (err instanceof EventWriteRefused) setWriteFailed(true);
        else throw err;
      }
      await load();
    },
    [load],
  );

  /**
   * Press and drag on empty hour space: draw the range, then open the form in it.
   * A press that does not move is a TAP, and it opens the form at that hour: on a
   * phone that is the whole "create here" gesture, and it needs no second mode.
   */
  const beginCreate = (event: React.PointerEvent<HTMLDivElement>, date: string) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    if ((event.target as HTMLElement).dataset.hour === undefined) return;
    // A drag draws a range and opens the form in it; a TAP opens the form at that
    // hour, because a phone has no second gesture for "create here".
    beginCreateGesture(event, {
      date,
      onRange: (from, to) => setCreating({ date, from, to }),
      onDrawn: (from, to) => {
        setCreating(null);
        setComposing({ date, startTime: clockOf(from), endTime: clockOf(to) });
      },
      onTap: (minute) => {
        setCreating(null);
        setComposing({ date, startTime: clockOf(minute) });
      },
    });
  };

  /**
   * Drag a block's body: the whole span moves by the pointer, so the DAY and the
   * TIME both follow it and the duration survives. The point that was grabbed stays
   * under the finger, so grabbing near the bottom does not slide the start.
   */
  const beginMove = (
    event: React.PointerEvent<HTMLDivElement>,
    row: CalendarRow,
    date: string,
    drawnStartMin: number,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (row.occurrenceOf !== null) return; // an appearance has no legal move on either client
    const rendered: EventSpan = { start: row.start, end: row.end, allDay: row.allDay };
    beginMoveGesture(event, {
      rendered,
      drawnStartMin,
      date,
      onPreview: (next) => {
        // The row follows the finger before the write: one gesture, one write.
        setRows((current) =>
          (current ?? []).map((candidate) =>
            candidate.noteId === row.noteId ? { ...candidate, start: next.start, end: next.end } : candidate,
          ),
        );
      },
      onCommit: (next) => {
        setRows((current) =>
          (current ?? []).map((candidate) =>
            candidate.noteId === row.noteId ? { ...candidate, start: next.start, end: next.end } : candidate,
          ),
        );
        void commitSpan(row, rendered, next);
      },
      // A TAP on a block opens its form: the same door `+` opens, prefilled.
      onTap: () => setEditing(row),
    });
  };

  /** Drag an end to move that instant. One write on release, never per move. */
  const beginResize = (
    event: React.PointerEvent<HTMLSpanElement>,
    row: CalendarRow,
    date: string,
    edge: "start" | "end",
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (row.occurrenceOf !== null) return;
    const rendered: EventSpan = { start: row.start, end: row.end, allDay: row.allDay };
    beginResizeGesture(event, {
      rendered,
      date,
      edge,
      onPreview: (next) =>
        setRows((current) =>
          (current ?? []).map((candidate) =>
            candidate.noteId === row.noteId ? { ...candidate, start: next.start, end: next.end } : candidate,
          ),
        ),
      onCommit: (next) => void commitSpan(row, rendered, next),
    });
  };

  // A calendar switched off on any client is off here too: the filter runs on the rows
  // as the host returned them, so it applies to the month grid, the axis and the list.
  const shown = rows === null ? null : visibleRows(calendarSettings, rows);
  const cells = shown === null ? [] : view === "week" ? weekRow(anchor, shown) : dayCells(anchor, shown);
  const dayRows =
    selected === null ? [] : (shown ?? []).filter((row) => row.start.slice(0, 10) === selected);

  /** The chip both the axis and the all-day band draw: one row, one look. */
  const chip = (row: CalendarRow, showTime: boolean) => (
    <div
      key={`${row.noteId}:${row.start}`}
      className="myne-calendar__chip"
      data-testid={`calendar.chip.${row.noteId}`}
      data-conflicts={row.conflicts ? "true" : undefined}
      // One variable for the spine and the wash, exactly as the desktop chip does.
      style={{ "--calendar-colour": calendarColour(calendarSettings, row.calendar) } as CSSProperties}
    >
      {showTime && (
        <span className="myne-calendar__time">
          {row.allDay ? t("calendar.allDay") : row.start.slice(11, 16)}
        </span>
      )}
      {showTime && secondClock(row.start) !== "" && (
        <span className="myne-calendar__home" data-testid="calendar.row.home-clock">
          {secondClock(row.start).replace(/^\s*·\s*/, "")}
        </span>
      )}
      <span className="myne-calendar__title">{row.title || t("calendar.untitled")}</span>
    </div>
  );

  /** One block on the axis: geometry from the shared layout, gestures on top. */
  const timedBlock = (date: string, block: { row: CalendarRow; startMin: number; endMin: number; key: string; column: number; columns: number }) => {
    const geometry = blockGeometry(block, MIN_BLOCK_MINUTES);
    return (
      <div
        key={block.key}
        className="myne-calendar__block"
        data-testid="calendar.block"
        data-start-minute={block.startMin}
        data-end-minute={block.endMin}
        style={{
          top: geometry.top,
          height: geometry.height,
          insetInlineStart: `calc(${block.column} * (100% / ${block.columns}))`,
          width: `calc(100% / ${block.columns})`,
        }}
        onPointerDown={(event) => beginMove(event, block.row, date, block.startMin)}
      >
        {chip(block.row, true)}
        <span
          aria-hidden="true"
          className="myne-calendar__grip"
          data-edge="start"
          onPointerDown={(event) => beginResize(event, block.row, date, "start")}
        />
        <span
          aria-hidden="true"
          className="myne-calendar__grip"
          data-edge="end"
          onPointerDown={(event) => beginResize(event, block.row, date, "end")}
        />
      </div>
    );
  };

  const renderAxis = () => {
    const gridStyle = {
      gridTemplateColumns: `var(--space-7) repeat(${Math.max(cells.length, 1)}, minmax(0, 1fr))`,
    };
    const band = cells.some((cell) => cell.rows.some((row) => rowHour(row) === null));
    return (
      <div className="myne-calendar__timegrid" style={{ flex: "1 1 auto", minHeight: 0 }}>
        <div className="myne-calendar__days" style={gridStyle}>
          <span aria-hidden="true" />
          {cells.map((cell) => (
            <div key={cell.date} className="myne-calendar__dayhead" data-testid={`calendar.dayhead.${cell.date}`}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>{weekdayHeader(cell.date)}</span>{" "}
              <span style={{ fontSize: "var(--text-sm)" }}>{cell.date.slice(8, 10).replace(/^0/, "")}</span>
            </div>
          ))}
        </div>
        {band && (
          <div className="myne-calendar__allday" style={gridStyle} data-testid="calendar.allday">
            <span className="myne-calendar__hourlabel">{t("calendar.allDay")}</span>
            {cells.map((cell) => (
              <div key={cell.date} className="myne-calendar__alldaycell">
                {cell.rows.filter((row) => rowHour(row) === null).map((row) => chip(row, false))}
              </div>
            ))}
          </div>
        )}
        <div className="myne-calendar__hours" style={gridStyle} data-testid="calendar.hours">
          <div className="myne-calendar__labels" aria-hidden="true">
            {HOURS.map((hour) => (
              <span key={hour} className="myne-calendar__hourlabel">
                {`${String(hour).padStart(2, "0")}:00`}
              </span>
            ))}
          </div>
          {cells.map((cell) => (
            <div key={cell.date} data-date={cell.date} className="myne-calendar__column" data-testid={`calendar.cell.${cell.date}`}>
              {HOURS.map((hour) => (
                <div key={hour} data-hour={hour} className="myne-calendar__slot" onPointerDown={(event) => beginCreate(event, cell.date)} />
              ))}
              {/* Its own layer, because a slot is an hour tall and an event is not. */}
              <div className="myne-calendar__layer">
                {layoutDay(cell.rows, cell.date).map((block) => timedBlock(cell.date, block))}
                {creating !== null && creating.date === cell.date && (
                  <div
                    className="myne-calendar__ghost"
                    data-testid="calendar.createSpan"
                    data-start-minute={creating.from}
                    data-end-minute={creating.to}
                    style={{
                      top: `${(creating.from / DAY_MINUTES) * 100}%`,
                      height: `${((creating.to - creating.from) / DAY_MINUTES) * 100}%`,
                    }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: "var(--space-0)",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-1)",
        zIndex: "var(--z-dropdown)" as unknown as number,
      }}
      data-testid="calendar.surface"
    >
      {/* Header: month, paging, the way out, and the view switch below it. */}
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-7) var(--space-4) var(--space-2)",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <Button
          variant="ghost"
          full={false}
          {...tappable}
          aria-label={t("calendar.prev")}
          data-testid="calendar.prev"
          onClick={() => setAnchor((current: CivilDate) => shiftAnchor(view, current, -1))}
        >
          ‹
        </Button>
        <span style={{ flex: "1 1 auto", fontSize: "var(--text-md)", fontWeight: "var(--weight-semibold, 600)" as unknown as number }} data-testid="calendar.heading">
          {monthLabel(anchor, i18n.language)}
        </span>
        <Button
          variant="ghost"
          full={false}
          {...tappable}
          aria-label={t("calendar.next")}
          data-testid="calendar.next"
          onClick={() => setAnchor((current: CivilDate) => shiftAnchor(view, current, 1))}
        >
          ›
        </Button>
        <Button variant="ghost" full={false} {...tappable} data-testid="calendar.today" onClick={() => setAnchor(todayCivil())}>
          {t("common.today")}
        </Button>
        <Button
          variant="ghost"
          full={false}
          {...tappable}
          aria-label={t("calendar.composer.title")}
          data-testid="calendar.add"
          onClick={() => setComposing({ date: selected ?? formatLocalDate(new Date()) })}
        >
          +
        </Button>
        <Button variant="ghost" full={false} {...tappable} aria-label={t("calendar.close")} data-testid="calendar.close" onClick={onClose}>
          ✕
        </Button>
      </div>

      {/* Month / Week / Day: the desktop's three views, with the desktop's semantics
          (week moves by seven days, day by one) because `shiftAnchor` owns them. */}
      <div style={{ flex: "none", padding: "var(--space-2) var(--space-4)" }}>
        <Segmented
          ariaLabel={t("calendar.view")}
          options={[t("calendar.view.month"), t("calendar.view.week"), t("calendar.view.day")]}
          active={VIEWS.indexOf(view)}
          onChange={(index) => setView(VIEWS[index] ?? "month")}
          testIdPrefix="calendar.view"
          optionValues={[...VIEWS]}
        />
      </div>

      {rows === null ? (
        <div style={{ flex: "1 1 auto", display: "grid", placeItems: "center" }} data-testid="calendar.loading">
          <Spinner />
        </div>
      ) : view === "month" ? (
        <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "var(--space-0) var(--space-2) var(--space-3)" }} data-testid="calendar.grid">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", padding: "var(--space-2)" }}>
            {WEEKDAY_HEADERS.map((label) => (
              <span key={label} style={{ textAlign: "center", fontSize: "var(--text-xs)", fontWeight: "var(--weight-semibold, 600)" as unknown as number, letterSpacing: "var(--tracking-caps)", color: "var(--fg-3)", textTransform: "uppercase" }}>
                {label}
              </span>
            ))}
          </div>
          {monthGrid(anchor, shown ?? []).map((week, wi) => (
            <div key={wi} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
              {week.map((cell) => {
                const dayNumber = cell.date.slice(8, 10).replace(/^0/, "");
                const chosen = selected === cell.date;
                return (
                  <button
                    {...tappable}
                    key={cell.date}
                    onClick={() => setSelected(cell.date)}
                    data-testid={`calendar.cell.${cell.date}`}
                    aria-pressed={chosen}
                    style={{
                      minHeight: "var(--target-min)",
                      border: "none",
                      background: chosen ? "var(--accent-soft, var(--bg-3))" : "transparent",
                      color: cell.inMonth ? "var(--fg-1)" : "var(--fg-3)",
                      borderRadius: "var(--radius-2)",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      padding: "var(--space-1) var(--space-0)",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ fontSize: "var(--text-sm)" }}>{dayNumber}</span>
                    {cell.rows.length > 0 && (
                      <span
                        data-testid={`calendar.dot.${cell.date}`}
                        style={{ width: "var(--space-1)", height: "var(--space-1)", borderRadius: "var(--radius-pill)", background: "var(--accent)" }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        renderAxis()
      )}

      {/* The day you picked, below the month it belongs to. The axis views ARE the
          day, so this list is the month view's half. */}
      {view === "month" && selected !== null && (
        <div style={{ flex: "none", maxHeight: "40%", overflowY: "auto", padding: "var(--space-0) var(--space-4)" }} data-testid="calendar.day-list">
          {dayRows.length === 0 ? (
            <p style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }} data-testid="calendar.day-empty">
              {t("calendar.noEvents")}
            </p>
          ) : (
            dayRows.map((row) => (
              <div
                key={`${row.noteId}:${row.start}`}
                data-testid={`calendar.event.${row.noteId}`}
                style={{ padding: "var(--space-2) var(--space-0)", borderBottom: "1px solid var(--line-1)" }}
              >
                <div style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-medium, 500)" as unknown as number }}>{row.title || t("calendar.untitled")}</div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                  {row.allDay ? t("calendar.allDay") : row.start.slice(11)}
                  {row.allDay ? "" : secondClock(row.start)}
                  {row.calendar === null ? "" : `  ·  ${row.calendar}`}
                  {row.conflicts ? `  ·  ${t("calendar.conflict")}` : ""}
                </div>
                <Button variant="ghost" full={false} {...tappable} data-testid={`calendar.edit.${row.noteId}`} onClick={() => setEditing(row)}>
                  {t("common.edit")}
                </Button>
                {row.occurrenceOf !== null && (
                  // Only an appearance offers this: a one-off event has nothing
                  // to cancel, and deleting it is the delete it already has.
                  <Button variant="ghost" full={false} {...tappable} data-testid={`calendar.skip.${row.noteId}`} onClick={() => void skip(row)}>
                    {t("calendar.occurrence.skip")}
                  </Button>
                )}
                {row.occurrenceOf !== null && (
                  <Button
                    variant="ghost"
                    full={false}
                    {...tappable}
                    data-testid={`calendar.retime.${row.noteId}`}
                    onClick={() => setRetiming({ row, time: row.allDay ? "" : row.start.slice(11, 16) })}
                  >
                    {t("calendar.occurrence.retime")}
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {composing !== null && (
        <EventComposerSheet
          date={composing.date}
          startTime={composing.startTime}
          endTime={composing.endTime}
          onClose={() => setComposing(null)}
          onCreated={() => {
            const day = composing.date;
            setComposing(null);
            setSelected(day);
            load();
          }}
        />
      )}

      {editing !== null && (
        <EventComposerSheet
          date={editing.start.slice(0, 10)}
          edit={editing}
          onClose={() => setEditing(null)}
          onCreated={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {writeFailed && (
        <p role="alert" style={{ flex: "none", padding: "var(--space-0) var(--space-4)", fontSize: "var(--text-sm)", color: "var(--danger)" }} data-testid="calendar.skipFailed">
          {t("calendar.skipFailed")}
        </p>
      )}

      {retiming !== null && (
        <Sheet onClose={() => setRetiming(null)} padded>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }} data-testid="calendar.retime-sheet">
            <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
              {t("calendar.occurrence.retimeHint", { date: retiming.row.occurrenceDate ?? retiming.row.start.slice(0, 10) })}
            </p>
            <TextField
              label={t("calendar.occurrence.retime")}
              value={retiming.time}
              onChange={(value) => setRetiming({ row: retiming.row, time: value })}
              testId="calendar.retime.time-field"
            />
            <Button disabled={retiming.time === ""} onClick={() => void retime()} data-testid="calendar.retime.save">
              {t("calendar.occurrence.retimeSave")}
            </Button>
          </div>
        </Sheet>
      )}

      {failed && (
        <p role="alert" style={{ flex: "none", padding: "var(--space-0) var(--space-4) var(--space-4)", fontSize: "var(--text-sm)", color: "var(--danger)" }} data-testid="calendar.error">
          {t("calendar.loadFailed")}
        </p>
      )}
    </div>
  );
}
