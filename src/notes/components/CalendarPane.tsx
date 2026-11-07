// `<CalendarPane>` - the calendar's centre-pane surface (myne-md/myne#1037).
//
// Four views over ONE range read (`vaultIndicesCalendarRange`): month, week, day
// and agenda. Every row comes from the host query, which is the same query the
// mobile screen, the reminder pass and the fifth agent tool call, so "what is on
// Thursday" has one answer in this product. What this file owns is presentation,
// the zoom, paging and the write gestures.
//
// **The grid math is not here.** `calendar/grid.ts` owns what day an event falls on
// and how a month lays out; this file draws what those functions say. That split is
// why the four views agree: a cell and an agenda line cannot disagree about a
// multi-day span, because both read `rowsByDate`.
//
// **A cell click captures, a row click opens.** Capture is one gesture (a `+` on the
// day, an inline title, Enter), and the note is the event, so the fastest path
// writes the same bytes the full form would. Opening a row opens the note in a tab,
// because an event IS a note and its keys, links and body are the note's.
//
// **Locked shows a shell with no data.** The query is slot-gated host-side, so a
// locked vault gets a refusal rather than content; the pane says so instead of
// rendering an empty grid that reads as "nothing scheduled".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { IconButton } from "../../components/primitives/IconButton";
import { Input } from "../../components/primitives/Input";
import { Segmented } from "../../components/primitives/Segmented";
import {
  vaultIndicesCalendarRange,
  type CalendarRange,
  type CalendarRow,
} from "../vaultIndices";
import { useIndexNonce } from "../indexNonce";
import { useLocalToday } from "../useLocalToday";
import { useDateTimeDisplay } from "../../lib/useDateTimeDisplay";
import { usePrefs } from "../../hooks/usePrefs";
import { createEvent } from "../createEvent";
import { importIcsIntoVault } from "../calendar/icsImport";
import {
  canImportIcs,
  exportIcsFile,
  ICS_EXPORT_WINDOW,
} from "../../lib/calendarIcs";
import { toast } from "../../components/toast/toastStore";
import { noteRead } from "../readNote";
import { noteUpdate } from "../updateNote";
import {
  EventWriteRefused,
  applyEventMove,
  planDrag,
  planResize,
  type EventSpan,
  type EventWriteRefusal,
} from "../calendar/dragWrite";
import { useWorkspace } from "../workspaceContext";
import {
  addDays,
  daysBetween,
  formatCivilDate,
  parseCivilDate,
  todayCivilDate,
  weekdayOf,
  type CivilDate,
} from "@myne/dialect/civilDate";
import { parseEventInstant } from "@myne/dialect/event";
import {
  calendarViewOf,
  type CalendarView,
  type PaneId,
  type WorkspaceItem,
} from "../workspaceState";
import { WEEKDAY_HEADERS, dayCells, monthGrid, shiftAnchor, weekRow, windowForView } from "../calendar/grid";
import { CalendarEventForm, emptyEventForm } from "./CalendarEventForm";
import { calendarColour } from "../calendar/colour";
import {
  isProjected,
  occurrenceDate,
  oneOffSeed,
  seriesNoteId,
  type OccurrenceRefusal,
} from "../calendar/occurrence";
import { dayLabel, monthLabel, shortDayLabel } from "../calendar/format";
import { Fragment } from "react";
import { skipOccurrence } from "../calendar/skipWrite";
import { overrideOccurrence } from "../calendar/overrideWrite";
import { homeClockFor } from "../../lib/homeZone";

/** How many days the agenda covers. A month of "what is coming" is what a person
 *  opens a calendar to answer. */
const AGENDA_DAYS = 30;

/** The default time a captured event gets: 09:00, the hour the all-day reminder
 *  anchor defaults to, so capture and reminder agree about mornings. */
const CAPTURE_HOUR = "09:00";

/** How many chips a month cell shows before it counts the rest. */
const CELL_CHIPS = 3;

export function CalendarPane({
  paneId,
  item,
  initialAnchor,
}: {
  paneId: PaneId;
  item: Extract<WorkspaceItem, { kind: "calendar" }>;
  /** The day the pane opens on. Defaults to today; a specimen and a future
   *  deep link both need to name it. */
  initialAnchor?: CivilDate;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const ws = useWorkspace();
  const nonce = useIndexNonce();
  const { timeZone: zone } = useDateTimeDisplay();
  const today = useLocalToday(zone);
  const { prefs } = usePrefs();
  const settings = prefs.calendar_settings ?? {};

  const [anchor, setAnchor] = useState<CivilDate>(
    () => initialAnchor ?? parseCivilDate(today) ?? todayCivilDate(),
  );
  const [range, setRange] = useState<CalendarRange | null>(null);
  const [error, setError] = useState<"locked" | "failed" | null>(null);
  const [capturing, setCapturing] = useState<string | null>(null);
  // The gesture in flight: which row, and whether the user is moving or resizing it.
  const [drag, setDrag] = useState<{
    row: CalendarRow;
    mode: "move" | "resize";
    rendered: EventSpan;
  } | null>(null);
  /** Set when a gesture landed on an occurrence, which has no note to move. */
  const [occurrence, setOccurrence] = useState<{ refusal: OccurrenceRefusal; row: CalendarRow } | null>(
    null,
  );
  // Optimistic spans keyed by note id, so the row lands where it was dropped and
  // is put back by the reload when the write is refused.
  const [optimistic, setOptimistic] = useState<Record<string, EventSpan>>({});
  const [failure, setFailure] = useState<EventWriteRefusal | null>(null);
  /**
   * The full form's date, or `null` when it is closed.
   *
   * Deliberately separate from `capturing`: a click on a cell is the fast path (a
   * title and nothing else), and the form is the deliberate one. Both write through
   * `createEvent`, so the two paths produce the same record.
   */
  const [composing, setComposing] = useState<string | null>(null);
  /** The time the user typed for a retimed occurrence, held per row. */
  const [retime, setRetime] = useState<string>("");
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const view = calendarViewOf(item);
  const window = useMemo(() => windowForView(view, anchor, AGENDA_DAYS), [view, anchor]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void vaultIndicesCalendarRange(window.start, window.end, false)
      .then((answer) => {
        if (cancelled) return;
        // Shape-coerced at the boundary: a caller that mocks the seam (the story
        // catalogue does) can resolve nothing, and a pane that threw on that
        // would be a specimen nobody could render.
        setRange({
          rows: Array.isArray(answer?.rows) ? answer.rows : [],
          unreadable: Array.isArray(answer?.unreadable) ? answer.unreadable : [],
        });
      })
      .catch(() => {
        if (cancelled) return;
        // The host refuses the query when no vault is unlocked, which is the
        // ordinary locked state rather than a failure.
        setRange(null);
        setError("locked");
      });
    return () => {
      cancelled = true;
    };
  }, [window.start, window.end, nonce, reload]);

  useEffect(() => {
    if (capturing !== null) inputRef.current?.focus();
  }, [capturing]);

  const rows = (range?.rows ?? []).map((row) => {
    const span = optimistic[row.noteId];
    if (span === undefined) return row;
    return { ...row, start: span.start, end: span.end, allDay: span.allDay };
  });
  const unreadable = range?.unreadable ?? [];

  /**
   * Drop a dragged row onto `date`.
   *
   * The write is a frontmatter edit on the note (`dragWrite.ts`), anchored to the
   * span the row was DRAWN from. A refusal is not swallowed: the optimistic span
   * is dropped and the host is re-read, so the row returns to where the note says
   * it is and the reason is on screen. A surface that kept the row where the user
   * dropped it would be claiming a write that never landed.
   */
  /**
   * Cancel one appearance of a series.
   *
   * The field is on the series note (`decisions/storage/0795`), so this is an
   * ordinary note write and the pane re-reads afterwards: a row that vanished
   * because the user cancelled it and a row that vanished because the host lost
   * the write must not look the same.
   */
  const skipRow = useCallback(
    async (row: CalendarRow) => {
      setFailure(null);
      try {
        await skipOccurrence({
          noteId: seriesNoteId(row),
          occurrenceDate: occurrenceDate(row),
          io: {
            readNote: noteRead,
            writeNote: (id, body, base) => noteUpdate(id, body, base),
            flushDirtyPanes: ws.flushAll,
          },
        });
        setOccurrence(null);
      } catch (err) {
        setFailure(err instanceof EventWriteRefused ? err.reason : null);
      }
      setReload((n) => n + 1);
    },
    [ws],
  );

  /**
   * Give one appearance a different start time.
   *
   * The day and the duration stay (`decisions/storage/0796`), so what the user
   * types is a clock and not a date: a field that also took a date would be a move,
   * and a move on an occurrence has no legal write.
   */
  const retimeRow = useCallback(
    async (row: CalendarRow) => {
      setFailure(null);
      try {
        await overrideOccurrence({
          noteId: seriesNoteId(row),
          occurrenceDate: occurrenceDate(row),
          time: retime,
          io: {
            readNote: noteRead,
            writeNote: (id, body, base) => noteUpdate(id, body, base),
            flushDirtyPanes: ws.flushAll,
          },
        });
        setOccurrence(null);
        setRetime("");
      } catch (err) {
        setFailure(err instanceof EventWriteRefused ? err.reason : null);
      }
      setReload((n) => n + 1);
    },
    [retime, ws],
  );

  const dropOn = useCallback(
    async (date: string) => {
      const gesture = drag;
      setDrag(null);
      if (gesture === null) return;

      // An occurrence is an appearance of a series, not a note, so there is no
      // write a drag on it could perform (§3.8.7 has no per-occurrence
      // exceptions). Refuse it with the two honest alternatives rather than a
      // toast, and refuse BEFORE any planner runs.
      if (isProjected(gesture.row)) {
        setOccurrence({
          refusal: {
            reason: "belongs-to-series",
            seriesNoteId: seriesNoteId(gesture.row),
            occurrenceDate: occurrenceDate(gesture.row),
            title: gesture.row.title,
          },
          row: gesture.row,
        });
        return;
      }
      const from = parseCivilDate(gesture.rendered.start.slice(0, 10));
      const to = parseCivilDate(date);
      if (from === null || to === null) return;
      const delta = daysBetween(from, to);
      if (delta === 0) return;

      const next = gesture.mode === "move" ? planDrag(gesture.rendered, delta) : planResize(gesture.rendered, delta);
      if (next === null) return; // an end before the start is not a shape to write

      setFailure(null);
      setOptimistic((current) => ({ ...current, [gesture.row.noteId]: next }));
      try {
        await applyEventMove({
          noteId: gesture.row.noteId,
          rendered: gesture.rendered,
          next,
          io: {
            readNote: noteRead,
            writeNote: (id, body, base) => noteUpdate(id, body, base),
            flushDirtyPanes: ws.flushAll,
          },
        });
        setReload((n) => n + 1);
      } catch (err) {
        setOptimistic((current) => {
          const rest = { ...current };
          delete rest[gesture.row.noteId];
          return rest;
        });
        setFailure(err instanceof EventWriteRefused ? err.reason : null);
        setReload((n) => n + 1);
        if (!(err instanceof EventWriteRefused)) throw err;
      }
    },
    [drag, ws],
  );

  const commitCapture = useCallback(
    async (date: string) => {
      const title = draft.trim();
      if (title === "") {
        setCapturing(null);
        return;
      }
      const start = parseEventInstant(`${date} ${CAPTURE_HOUR}`);
      if (start === null) {
        setError("failed");
        return;
      }
      try {
        await createEvent({ title, start });
        setDraft("");
        setCapturing(null);
      } catch {
        setError("failed");
      }
    },
    [draft],
  );

  const heading = useMemo(() => {
    switch (view) {
      case "month":
        return monthLabel(anchor, locale);
      case "week": {
        const cells = weekRow(anchor, []);
        const first = parseCivilDate(cells[0]!.date);
        const last = parseCivilDate(cells[6]!.date);
        if (first === null || last === null) return "";
        return `${shortDayLabel(first, locale)} - ${shortDayLabel(last, locale)}`;
      }
      case "day":
        return dayLabel(anchor, locale);
      case "agenda":
        return t("calendar.agendaRange", { days: AGENDA_DAYS });
      default: {
        const exhaustive: never = view;
        return exhaustive;
      }
    }
  }, [view, anchor, t, locale]);

  const captureField = (date: string) => (
    <Input
      ref={inputRef}
      aria-label={t("calendar.capture.title")}
      placeholder={t("calendar.capture.placeholder")}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commitCapture(date);
        }
        if (event.key === "Escape") {
          setCapturing(null);
          setDraft("");
        }
      }}
      onBlur={() => void commitCapture(date)}
    />
  );

  const chip = (row: CalendarRow, showTime: boolean) => (
    <Button
      key={`${row.noteId}-${row.start}`}
      variant="ghost"
      data-testid="calendar.row"
      data-conflicts={row.conflicts ? "true" : undefined}
      data-occurrence={isProjected(row) ? "true" : undefined}
      title={isProjected(row) ? t("calendar.occurrenceOf", { date: occurrenceDate(row) }) : undefined}
      draggable
      onDragStart={(event) => {
        event.stopPropagation();
        setDrag({
          row,
          mode: "move",
          rendered: { start: row.start, end: row.end, allDay: row.allDay },
        });
      }}
      onClick={() => ws.openNewTabInFocused(row.noteId)}
      onContextMenu={
        isProjected(row)
          ? (event) => {
              // The panel that explains what an occurrence is, reachable without
              // dragging one: right-clicking a projected row offers the three
              // answers (edit the series, add a one-off, cancel this one) instead
              // of a menu with a fourth thing that would have no legal write.
              event.preventDefault();
              setOccurrence({
                refusal: {
                  reason: "belongs-to-series",
                  seriesNoteId: seriesNoteId(row),
                  occurrenceDate: occurrenceDate(row),
                  title: row.title,
                },
                row,
              });
            }
          : undefined
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-1)",
        width: "100%",
        minWidth: 0,
        padding: "var(--space-1)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-1)",
        background: row.conflicts ? "var(--warning-soft)" : "var(--bg-1)",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "var(--space-2)",
          height: "var(--space-2)",
          flex: "0 0 auto",
          borderRadius: "var(--radius-pill)",
          background: calendarColour(settings, row.calendar),
        }}
      />
      {showTime && (
        <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)", flex: "0 0 auto" }}>
          {row.allDay ? t("calendar.allDay") : row.start.slice(11)}
          {(() => {
            // The second clock (decisions/storage/0797): the note's time is a wall
            // clock and stays one, so this is an addition to the READING rather
            // than anything stored. `homeClockFor` answers null when the preference
            // is unset or is the device's own zone, which is the common case and
            // must cost the row nothing.
            const home = homeClockFor(row.start.replace(" ", "T"));
            if (home === null) return null;
            const day = home.dayOffset === 0 ? "" : home.dayOffset > 0 ? "+1" : "-1";
            return (
              <span data-testid="calendar.row.home-clock" style={{ marginLeft: "var(--space-1)" }}>
                {`· ${home.time}${day}`}
              </span>
            );
          })()}
        </span>
      )}
      <span
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--fg-1)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.title ?? t("calendar.untitled")}
      </span>
      {row.occurrenceOf !== null && <Icon name="rotate-ccw" size={10} />}
      <span
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("calendar.resize", { title: row.title ?? t("calendar.untitled") })}
        draggable
        onDragStart={(event) => {
          event.stopPropagation();
          setDrag({
            row,
            mode: "resize",
            rendered: { start: row.start, end: row.end, allDay: row.allDay },
          });
        }}
        onClick={(event) => event.stopPropagation()}
        style={{ flex: "0 0 auto", width: "var(--space-2)", cursor: "ns-resize", color: "var(--fg-3)" }}
      >
        <Icon name="more-horizontal" size={10} />
      </span>
    </Button>
  );

  /** `YYYY-MM-DDTHH:MM`, the device's own clock, in the shape a row's start uses. */
  function currentMinute(): string {
    const at = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }

  /** Whether the marker belongs above this row: the first row that starts later. */
  const nowMarker = (rowTime: string) => rowTime > now.slice(11);

  /**
   * The "now" line.
   *
   * A calendar without one makes the reader do the arithmetic the app already knows:
   * every day looks the same, including today. It carries `aria-hidden` because it is
   * a position, not information a screen reader can use, and the day header already
   * says which day this is.
   */
  const nowLine = () => (
    <div
      aria-hidden="true"
      data-testid="calendar.now"
      style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", padding: "var(--space-0) 0" }}
    >
      <span style={{ width: "var(--space-1)", height: "var(--space-1)", borderRadius: "var(--radius-pill)", background: "var(--accent)" }} />
      <span style={{ flex: "1 1 auto", borderTop: "1px solid var(--accent)" }} />
      <span style={{ fontSize: "var(--text-xs)", color: "var(--accent)" }}>{now.slice(11, 16)}</span>
    </div>
  );

  const dayHeader = (date: string) => {
    const parsed = parseCivilDate(date);
    const weekday =
      parsed === null ? "" : t(`calendar.weekday.${weekdayOf(parsed)}`);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>{weekday}</span>
        <span
          style={{
            fontSize: "var(--text-xs)",
            color: date === today ? "var(--accent)" : "var(--fg-2)",
            fontWeight: date === today ? ("var(--weight-medium, 500)" as unknown as number) : undefined,
          }}
          data-testid={date === today ? "calendar.today-header" : undefined}
        >
          {date.slice(8)}
        </span>
        <span style={{ flex: "1 1 auto" }} />
        <IconButton
          icon="plus"
          label={t("calendar.capture.on", { date })}
          iconSize={12}
          onClick={() => {
            setCapturing(date);
            setDraft("");
          }}
        />
      </div>
    );
  };

  const renderMonth = () => (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", gap: "var(--space-1)", minHeight: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: "var(--space-1)" }}>
        {WEEKDAY_HEADERS.map((day) => (
          <span key={day} style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)", textAlign: "center" }}>
            {t(`calendar.weekday.${day}`)}
          </span>
        ))}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateRows: `repeat(${monthGrid(anchor, rows).length}, minmax(0, 1fr))`,
          gap: "var(--space-1)",
          minHeight: 0,
        }}
      >
        {monthGrid(anchor, rows).map((week) => (
          <div key={week[0]!.date} style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: "var(--space-1)", minHeight: 0 }}>
            {week.map((cell) => (
              <div
                key={cell.date}
                data-testid="calendar.cell"
                data-date={cell.date}
                onDragOver={(event) => {
                  if (drag !== null) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  void dropOn(cell.date);
                }}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-0)",
                  minHeight: 0,
                  padding: "var(--space-1)",
                  borderRadius: "var(--radius-1)",
                  border: "1px solid var(--line-1)",
                  background: cell.inMonth ? "var(--bg-1)" : "var(--bg-2)",
                  opacity: cell.inMonth ? 1 : 0.6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center" }}>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>{cell.date.slice(8)}</span>
                  <span style={{ flex: "1 1 auto" }} />
                  <IconButton
                    icon="plus"
                    label={t("calendar.capture.on", { date: cell.date })}
                    iconSize={11}
                    onClick={() => {
                      setCapturing(cell.date);
                      setDraft("");
                    }}
                  />
                </div>
                {capturing === cell.date && captureField(cell.date)}
                {cell.rows.slice(0, CELL_CHIPS).map((row) => chip(row, false))}
                {cell.rows.length > CELL_CHIPS && (
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                    {t("calendar.more", { count: cell.rows.length - CELL_CHIPS })}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );

  const renderColumns = (cells: ReturnType<typeof weekRow>) => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))`,
        gap: "var(--space-1)",
        minHeight: 0,
        overflowY: "auto",
      }}
    >
      {cells.map((cell) => (
        <div
          key={cell.date}
          data-testid="calendar.cell"
          data-date={cell.date}
          onDragOver={(event) => {
            if (drag !== null) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            void dropOn(cell.date);
          }}
          onClick={(event) => {
            // Empty space in a day is where a person reaches for a pen, so a click
            // on the cell itself opens the composer for that day. `currentTarget`
            // rather than `target`: a click on a chip, the header's `+` or the
            // capture field must keep meaning what it already meant, and a handler
            // that fired on every bubbled click would open a form under the user's
            // finger every time they opened an event.
            if (event.target !== event.currentTarget) return;
            setComposing(cell.date);
          }}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-0)",
            minHeight: 0,
            padding: "var(--space-1)",
            borderRadius: "var(--radius-1)",
            border: "1px solid var(--line-1)",
            background: "var(--bg-1)",
          }}
        >
          {dayHeader(cell.date)}
          {capturing === cell.date && captureField(cell.date)}
          {cell.rows.map((row) => (
            <Fragment key={`${row.noteId}-${row.start}`}>
              {cell.date === today && nowMarker(row.start.slice(11)) ? nowLine() : null}
              {chip(row, true)}
            </Fragment>
          ))}
          {cell.date === today && cell.rows.every((row) => row.start.slice(11) <= now.slice(11)) && nowLine()}
        </div>
      ))}
    </div>
  );

  const renderAgenda = () => {
    // The agenda shows each row once, on the day it STARTS: a three-day trip is one
    // line here and three cells in the month grid, because the agenda answers "what
    // begins on this day" rather than "what fills it".
    const byDate = new Map<string, CalendarRow[]>();
    for (const row of rows) {
      const date = row.start.slice(0, 10);
      const bucket = byDate.get(date);
      if (bucket === undefined) byDate.set(date, [row]);
      else bucket.push(row);
    }
    const days: { date: string; rows: CalendarRow[] }[] = [];
    for (let i = 0; i < AGENDA_DAYS; i++) {
      const date = formatCivilDate(addDays(anchor, i));
      days.push({ date, rows: byDate.get(date) ?? [] });
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", overflowY: "auto", minHeight: 0 }}>
        {days.map((day) => (
          <div
            key={day.date}
            data-testid="calendar.dayRow"
            data-date={day.date}
            onDragOver={(event) => {
              if (drag !== null) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              void dropOn(day.date);
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-1)",
                padding: "var(--space-1) 0",
                borderBottom: "1px solid var(--line-1)",
              }}
            >
              {dayHeader(day.date)}
            </div>
            {capturing === day.date && <div style={{ padding: "var(--space-1) 0" }}>{captureField(day.date)}</div>}
            {day.rows.map((row) => (
              <div key={`${row.noteId}-${row.start}`} style={{ padding: "var(--space-0) 0" }}>
                {chip(row, true)}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  };

  const body = () => {
    switch (view) {
      case "month":
        return renderMonth();
      case "week":
        return renderColumns(weekRow(anchor, rows));
      case "day":
        return renderColumns(dayCells(anchor, rows));
      case "agenda":
        return renderAgenda();
      default: {
        const exhaustive: never = view;
        return exhaustive;
      }
    }
  };

  /**
   * Where "now" is, re-read on a tick so the marker moves while the pane is open.
   *
   * One interval for the whole pane rather than a timer per row: the marker is a
   * single line, and a calendar that recomputed a hundred cells a minute would be
   * the reason a laptop's fan turns on while nobody is looking at it.
   */
  const [now, setNow] = useState<string>(() => currentMinute());
  useEffect(() => {
    const id = setInterval(() => setNow(currentMinute()), 60_000);
    return () => clearInterval(id);
  }, []);

  /**
   * Keyboard navigation, on the pane rather than on the window.
   *
   * A calendar is a grid, so the arrows move through it the way every other calendar
   * does: left and right by a day, up and down by a week. `t` jumps to today and `n`
   * starts a note on the anchor day, which are the two things a keyboard user does
   * most and the two that had no key at all.
   *
   * The handler is on the pane because the editor is where the caret usually lives:
   * a window-level listener would eat an arrow key out of a paragraph the user is
   * typing in, which is the failure mode that makes a shortcut worse than none.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    // The DAY is the unit the arrows move in, whatever the view shows: a week view
    // that moved by a week on every keypress would have no way to reach tuesday, and
    // a month view that did would be the only calendar in the world that does.
    const shift = (days: number) => {
      const next = addDays(anchor, days);
      setAnchor(next);
      event.preventDefault();
    };
    switch (event.key) {
      case "ArrowLeft":
        return shift(-1);
      case "ArrowRight":
        return shift(1);
      case "ArrowUp":
        return shift(-7);
      case "ArrowDown":
        return shift(7);
      case "t":
      case "T":
        setAnchor(parseCivilDate(today) ?? todayCivilDate());
        event.preventDefault();
        return;
      case "n":
      case "N":
        setCapturing(today);
        event.preventDefault();
        return;
      default:
        return;
    }
  };

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: "var(--space-2)", padding: "var(--space-3) 0" }}
      data-testid="calendar.pane"
      data-pane={paneId}
      tabIndex={0}
      onKeyDown={onKeyDown}
      role="application"
      aria-label={t("calendar.view.label")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <Segmented
          ariaLabel={t("calendar.view.label")}
          value={view}
          options={[
            { value: "month", label: t("calendar.view.month") },
            { value: "week", label: t("calendar.view.week") },
            { value: "day", label: t("calendar.view.day") },
            { value: "agenda", label: t("calendar.view.agenda") },
          ]}
          onChange={(next) => ws.setCalendarViewState(paneId, next as CalendarView)}
          testId="calendar.view"
        />
        <IconButton
          icon="chevron-left"
          label={t("calendar.prev")}
          iconSize={14}
          onClick={() => setAnchor((current) => shiftAnchor(view, current, -1))}
        />
        <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-2)", minWidth: 0 }}>{heading}</span>
        <IconButton
          icon="chevron-right"
          label={t("calendar.next")}
          iconSize={14}
          onClick={() => setAnchor((current) => shiftAnchor(view, current, 1))}
        />
        <IconButton
          icon="calendar-days"
          label={t("calendar.today")}
          iconSize={14}
          onClick={() => setAnchor(parseCivilDate(today) ?? todayCivilDate())}
        />
        <span style={{ flex: "1 1 auto" }} />
        <IconButton
          icon="calendar-plus"
          label={t("calendar.form.title")}
          iconSize={14}
          onClick={() => setComposing(formatCivilDate(anchor))}
        />
        {/* `.ics` exchange. In the pane header rather than the palette because it
            is a control for the view you are already in, and it is the only path
            in or out of another calendar (myne-md/myne#1037). */}
        {/* Import is desktop-only: it needs a path-taking open dialog, and the
            browser client has none. Export is not, because a download needs no
            dialog, so the two affordances do not share a gate. */}
        {canImportIcs() && (
        <IconButton
          icon="file-plus"
          label={t("calendar.import")}
          iconSize={14}
          onClick={() => {
            void importIcsIntoVault().then((outcome) => {
              if (outcome.kind === "cancelled") return;
              if (outcome.kind === "refused") {
                toast({
                  message: t(`calendar.importRefused.${outcome.reason}`),
                  variant: "error",
                  testId: "calendar.ics-toast",
                });
                return;
              }
              toast({
                message:
                  outcome.skipped > 0
                    ? t("calendar.importedSkipped", {
                        filename: outcome.filename,
                        count: outcome.created,
                        skipped: outcome.skipped,
                      })
                    : t("calendar.imported", {
                        filename: outcome.filename,
                        count: outcome.created,
                      }),
                variant: "success",
                testId: "calendar.ics-toast",
              });
            });
          }}
        />
        )}
        <IconButton
          icon="download"
          label={t("calendar.export")}
          iconSize={14}
          onClick={() => {
            void vaultIndicesCalendarRange(
              ICS_EXPORT_WINDOW.start,
              ICS_EXPORT_WINDOW.end,
              false,
            ).then((wide) => exportIcsFile(wide.rows, formatCivilDate(anchor)));
          }}
        />
        {failure !== null && (
          <span role="alert" style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }} data-testid="calendar.writeRefused">
            {t(`calendar.refused.${failure}`)}
          </span>
        )}
        {error === "failed" && (
          <span role="alert" style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}>
            {t("calendar.loadFailed")}
          </span>
        )}
      </div>

      {occurrence !== null && (
        <div
          role="alert"
          data-testid="calendar.occurrenceRefused"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            flexWrap: "wrap",
            padding: "var(--space-2)",
            borderRadius: "var(--radius-1)",
            border: "1px solid var(--line-1)",
            background: "var(--bg-1)",
          }}
        >
          <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-2)" }}>
            {t("calendar.occurrence.thisIsOne", { date: occurrence.refusal.occurrenceDate })}
          </span>
          <Button
            variant="ghost"
            onClick={() => ws.openNewTabInFocused(occurrence.refusal.seriesNoteId)}
          >
            {t("calendar.occurrence.editSeries")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              // A NEW note, not an exception on the series: the series is left
              // byte-identical, which is the whole point of the alternative.
              const seed = oneOffSeed(occurrence.row);
              if (seed === null) return;
              void createEvent(seed).then(() => {
                setOccurrence(null);
                setReload((n) => n + 1);
              });
            }}
          >
            {t("calendar.occurrence.addOneOff")}
          </Button>
          <Input
            type="time"
            aria-label={t("calendar.occurrence.retime")}
            value={retime}
            onChange={(event) => setRetime(event.target.value)}
            data-testid="calendar.occurrence.retime-field"
          />
          <Button
            variant="ghost"
            disabled={retime === ""}
            onClick={() => void retimeRow(occurrence.row)}
            data-testid="calendar.occurrence.retime"
          >
            {t("calendar.occurrence.retime")}
          </Button>
          <Button variant="ghost" onClick={() => void skipRow(occurrence.row)} data-testid="calendar.occurrence.skip">
            {t("calendar.occurrence.skip")}
          </Button>
          <IconButton icon="x" label={t("common.dismiss")} iconSize={12} onClick={() => setOccurrence(null)} />
        </div>
      )}

      {composing !== null && (
        <CalendarEventForm
          initial={emptyEventForm(composing)}
          onClose={() => {
            setComposing(null);
            setReload((n) => n + 1);
          }}
        />
      )}

      {error === "locked" ? (
        <p style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }} data-testid="calendar.lockedShell">
          {t("calendar.locked")}
        </p>
      ) : (
        <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
          {body()}
          {unreadable.length > 0 && (
            <div data-testid="calendar.unreadable" style={{ paddingTop: "var(--space-2)" }}>
              <p style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                {t("calendar.unreadable.heading", { count: unreadable.length })}
              </p>
              {unreadable.map((entry) => (
                <p key={entry.noteId} style={{ fontSize: "var(--text-xs)", color: "var(--fg-2)" }}>
                  {entry.title ?? entry.noteId} - {t(`calendar.unreadable.${entry.reason}`)}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
