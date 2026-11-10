// `<CalendarPane>` - the calendar's centre-pane surface (myne-md/myne#1037).
//
// Four views over ONE range read (`vaultIndicesCalendarRange`): month, week, day
// and agenda. Every row comes from the host query, which is the same query the
// mobile screen, the reminder pass and the fifth agent tool call, so "what is on
// Thursday" has one answer in this product. What this file owns is presentation,
// the zoom, paging and the write gestures.
//
// **The grid math is not here.** `calendar/grid.ts` owns what day an event falls on
// and how a month lays out; this file draws what those functions say, which is why
// a cell and an agenda line cannot disagree about a multi-day span.
//
// **A cell click captures, a row click opens its form.** Capture is one gesture (a
// `+`, an inline title, Enter) that writes the same bytes the full form would; the
// month grid gives it a day, the hour axis gives it an hour.
//
// **Locked shows a shell with no data.** The query is slot-gated host-side, so a
// locked vault gets a refusal rather than content; the pane says so instead of
// rendering an empty grid that reads as "nothing scheduled".

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { formatWallClockTime } from "../../lib/datetimeFormat";
import { usePrefs } from "../../hooks/usePrefs";
import { createEvent } from "../createEvent";
import { importIcsIntoVault } from "../calendar/icsImport";
import { TimeField } from "../calendar/fields";
import { applyEventEdit, editFromPlan } from "../calendar/updateEvent";
import { reindexNote } from "../vaultIndices";
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
  planEdgeResize,
  planMoveTo,
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
import {
  DAY_MINUTES,
  SNAP_MINUTES,
  clockOf,
  layoutDay,
  minuteOfDay,
  snapMinute,
  type PlacedSpan,
} from "../calendar/layout";
import {
  CalendarEventForm,
  emptyEventForm,
  formFromRow,
  planEventForm,
  type EventFormValues,
} from "./CalendarEventForm";
import { calendarColour } from "../calendar/colour";
import {
  isProjected,
  occurrenceDate,
  oneOffSeed,
  seriesNoteId,
  type OccurrenceRefusal,
} from "../calendar/occurrence";
import { dayLabel, monthLabel, shortDayLabel } from "../calendar/format";
import { useLiveVaultTasks, type VaultTask } from "../taskIndex";
import { skipOccurrence } from "../calendar/skipWrite";
import { overrideOccurrence } from "../calendar/overrideWrite";
import { homeClockFor, readHomeZone, subscribeHomeZone } from "../../lib/homeZone";

/** A row the pane draws: an event's occurrence, or a due-bearing task. */
type DisplayRow = CalendarRow & { readonly task?: VaultTask };

/** How many days the agenda covers. A month of "what is coming" is what a person
 *  opens a calendar to answer. */
const AGENDA_DAYS = 30;

/** A captured event's default hour: the all-day reminder anchor's own. */
const CAPTURE_HOUR = "09:00";

/** How many chips a month cell shows before it counts the rest. */
const CELL_CHIPS = 3;

/** The shortest a timed block may DRAW itself, so a point event is still hittable. */
const MIN_BLOCK_MINUTES = 18;

/** The hours a day column draws: a fixed axis, so two days' 14:00 sit level. */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** Where a day column starts when the day holds nothing: a working morning. */
const FIRST_VISIBLE_HOUR = 8;

/** The hour of a row's start, or `null` when it carries no clock at all. */
function rowHour(row: CalendarRow): number | null {
  if (row.start.length <= 10) return null;
  const hour = Number(row.start.slice(11, 13));
  return Number.isFinite(hour) ? hour : null;
}

/** The day column under a pointer's x, so a drag can change the DAY as well as the
 *  hour. `null` outside the grid, which the gesture reads as "stay on this day". */
function columnUnder(clientX: number, from: HTMLElement | null): { column: HTMLElement; date: string } | null {
  const grid = from?.closest<HTMLElement>(".myne-calendar__hours") ?? null;
  if (grid === null) return null;
  for (const column of grid.querySelectorAll<HTMLElement>(".myne-calendar__column")) {
    const rect = column.getBoundingClientRect();
    if (rect.width > 0 && clientX >= rect.left && clientX <= rect.right) {
      return { column, date: column.getAttribute("data-date") ?? "" };
    }
  }
  return null;
}

/** Minutes past midnight for a pointer over `column`, snapped; `null` when the
 *  column has no measured height. */
function minuteAt(clientY: number, column: HTMLElement | null): number | null {
  if (column === null) return null;
  const rect = column.getBoundingClientRect();
  if (!Number.isFinite(rect.height) || rect.height <= 0) return null;
  return snapMinute(((clientY - rect.top) / rect.height) * DAY_MINUTES);
}

function hourValue(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

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
  const display = useDateTimeDisplay();
  const today = useLocalToday(zone);
  const { prefs } = usePrefs();
  const settings = prefs.calendar_settings ?? {};

  const [anchor, setAnchor] = useState<CivilDate>(
    () => initialAnchor ?? parseCivilDate(today) ?? todayCivilDate(),
  );
  const [range, setRange] = useState<CalendarRange | null>(null);
  const [error, setError] = useState<"locked" | "failed" | null>(null);
  const [capturing, setCapturing] = useState<string | null>(null);
  /** The hour a click landed on; `null` means a day was clicked, not an hour. */
  const [captureHour, setCaptureHour] = useState<string | null>(null);
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
  const io = useMemo(
    () => ({
      readNote: noteRead,
      writeNote: (id: string, body: string, base: string) => noteUpdate(id, body, base),
      flushDirtyPanes: ws.flushAll,
    }),
    [ws],
  );
  /** A projected occurrence has no note: name the series instead. */
  const refuseOccurrence = useCallback(
    (row: CalendarRow) =>
      setOccurrence({
        refusal: {
          reason: "belongs-to-series" as const,
          seriesNoteId: seriesNoteId(row),
          occurrenceDate: occurrenceDate(row),
          title: row.title,
        },
        row,
      }),
    [],
  );
  const [failure, setFailure] = useState<EventWriteRefusal | null>(null);
  /**
   * The full form's seed values, or `null` when it is closed.
   *
   * Deliberately separate from `capturing`: a click on a cell is the fast path (a
   * title and nothing else), and the form is the deliberate one. Both write through
   * `createEvent`, so the two paths produce the same record.
   */
  const [composing, setComposing] = useState<EventFormValues | null>(null);
  /** The range a create-drag is drawing, or `null`. */
  const [creating, setCreating] = useState<{ date: string; from: number; to: number } | null>(null);
  /** Set while a create-drag ran, so its release does not also open the inline
   *  capture field. */
  const draggedRef = useRef(false);
  /** The event whose form is open for EDITING, or `null`. A chip opens this rather
   *  than the markdown note, which the owner wants visible only on export. */
  const [editing, setEditing] = useState<DisplayRow | null>(null);
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

  /**
   * A due-bearing task drawn as a row.
   *
   * A task is a note with a date and an event is a note with a date, so a calendar
   * that shows only one of them answers half of "what is on this week". The task
   * carries `task` so the chip can be told apart and, more importantly, so no drag
   * path can treat it as an event: patching `start` on a task's line would rewrite a
   * line-task into something no reader agrees about.
   *
   * Completed tasks are left out. A calendar is a forward view, and a finished item
   * keeps its own surface, which is the notes list and the done marker in the file.
   */
  const taskRows: DisplayRow[] = useLiveVaultTasks()
    .filter((task) => task.due !== undefined && !task.completed)
    .map((task) => {
      const start = (task.due ?? "").replace("T", " ");
      return {
        noteId: task.noteId,
        title: task.noteTitle ?? task.rawLine.replace(/^[-*+] \[[ xX]\] /, "").slice(0, 120),
        folder: task.noteFolder,
        calendar: null,
        start,
        end: null,
        // A due date with no time is an all-day item, exactly as a `start` with no
        // time is an all-day event (§3.10.2 uses one rule for both).
        allDay: !start.includes(" "),
        occurrenceOf: null,
        occurrenceDate: null,
        conflicts: false,
        repeat: task.repeat ?? null,
        repeatUnrecognized: false,
        task,
      } as DisplayRow;
    })
    .filter((row) => row.start !== "");

  const rows: DisplayRow[] = [
    ...(range?.rows ?? []).map((row) => {
      const span = optimistic[row.noteId];
      if (span === undefined) return row as DisplayRow;
      return { ...row, start: span.start, end: span.end, allDay: span.allDay } as DisplayRow;
    }),
    ...taskRows,
  ];
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
          io,
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
          io,
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

  /** ONE writer for every gesture that changes `start`/`end`, so a refused move
   *  cannot be shown as landed by the gesture that did not check. */
  const commitSpan = useCallback(
    async (row: CalendarRow, rendered: EventSpan, next: EventSpan, changed: boolean) => {
      const clear = () =>
        setOptimistic((current) => {
          const rest = { ...current };
          delete rest[row.noteId];
          return rest;
        });
      if (!changed) {
        clear();
        return;
      }
      setFailure(null);
      setOptimistic((current) => ({ ...current, [row.noteId]: next }));
      try {
        await applyEventMove({ noteId: row.noteId, rendered, next, io });
        // Re-index before reloading, or the fresh read returns the OLD `start`.
        await reindexNote(row.noteId);
        clear();
        setReload((n) => n + 1);
      } catch (err) {
        clear();
        setFailure(err instanceof EventWriteRefused ? err.reason : null);
        setReload((n) => n + 1);
        if (!(err instanceof EventWriteRefused)) throw err;
      }
    },
    [io],
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
        refuseOccurrence(gesture.row);
        return;
      }
      const from = parseCivilDate(gesture.rendered.start.slice(0, 10));
      const to = parseCivilDate(date);
      if (from === null || to === null) return;
      const delta = daysBetween(from, to);
      if (delta === 0) return;

      const next = gesture.mode === "move" ? planDrag(gesture.rendered, delta) : planResize(gesture.rendered, delta);
      if (next === null) return; // an end before the start is not a shape to write
      await commitSpan(gesture.row, gesture.rendered, next, true);
    },
    [drag, commitSpan],
  );

  /** Press and drag on empty hour space: draw the range, then open the form in it.
   *  A press that does not move stays the inline field, so neither is a mode. */
  const beginCreate = (event: React.PointerEvent<HTMLDivElement>, date: string) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    const column = event.currentTarget.closest<HTMLElement>(".myne-calendar__column");
    // The element's own window: this component holds the calendar RANGE as
    // `window`, which is what `window.addEventListener` here resolved to.
    const host = event.currentTarget.ownerDocument.defaultView;
    if (host === null) return;
    const anchor = minuteAt(event.clientY, column);
    if (anchor === null) return;
    draggedRef.current = false;
    let from = anchor;
    let to = anchor + SNAP_MINUTES;

    const move = (next: PointerEvent) => {
      const minute = minuteAt(next.clientY, column);
      if (minute === null) return;
      draggedRef.current = true;
      from = Math.min(anchor, minute);
      to = Math.max(Math.max(anchor, minute), from + SNAP_MINUTES);
      setCreating({ date, from, to });
    };

    const up = () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerup", up);
      setCreating(null);
      if (!draggedRef.current) return;
      // `23:59`, because a clock has 1440 minutes and 1440 is not one.
      const startMin = Math.min(from, DAY_MINUTES - SNAP_MINUTES);
      const endMin = Math.min(Math.max(to, startMin + SNAP_MINUTES), DAY_MINUTES - 1);
      setComposing({
        ...emptyEventForm(date),
        startTime: clockOf(startMin),
        endDate: date,
        endTime: clockOf(endMin),
      });
    };

    host.addEventListener("pointermove", move);
    host.addEventListener("pointerup", up);
  };

  /** Drag an event's body: the whole span moves by the pointer, so the day and the
   *  time both follow it. The point inside the block that was grabbed stays under
   *  the pointer, so grabbing near its bottom does not slide the start. */
  const beginMove = (
    event: React.PointerEvent<HTMLElement>,
    row: DisplayRow,
    date: string,
    drawnStartMin: number,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (row.task !== undefined) return;
    if (isProjected(row)) {
      refuseOccurrence(row);
      return;
    }
    const origin = event.currentTarget.closest<HTMLElement>(".myne-calendar__column");
    const host = event.currentTarget.ownerDocument.defaultView;
    if (host === null || origin === null) return;
    const grabAt = minuteAt(event.clientY, origin);
    if (grabAt === null) return;
    const grabOffset = grabAt - drawnStartMin;

    const rendered: EventSpan = { start: row.start, end: row.end, allDay: row.allDay };
    let preview: EventSpan | null = null;

    const move = (next: PointerEvent) => {
      const under = columnUnder(next.clientX, origin) ?? { column: origin, date };
      const minute = minuteAt(next.clientY, under.column);
      if (minute === null) return;
      const targetStart = snapMinute(minute - grabOffset);
      const dayDelta = daysBetween(parseCivilDate(date)!, parseCivilDate(under.date) ?? parseCivilDate(date)!);
      const planned = planMoveTo(rendered, dayDelta * DAY_MINUTES + (targetStart - drawnStartMin));
      if (planned === null) return;
      draggedRef.current = true;
      preview = planned;
      setOptimistic((current) => ({ ...current, [row.noteId]: planned }));
    };

    const up = () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerup", up);
      const next = preview;
      if (next === null) return;
      void commitSpan(row, rendered, next, next.start !== rendered.start || next.end !== rendered.end);
    };

    host.addEventListener("pointermove", move);
    host.addEventListener("pointerup", up);
  };

  /** Drag an edge to move that instant. ONE write on release, never per move. */
  const beginResize = (
    event: React.PointerEvent<HTMLElement>,
    row: DisplayRow,
    date: string,
    edge: "start" | "end",
  ) => {
    if (event.button !== 0) return;
    event.preventDefault(); // the pointer's default here is a text selection
    event.stopPropagation();
    if (row.task !== undefined) return;
    if (isProjected(row)) {
      refuseOccurrence(row);
      return;
    }
    const column = event.currentTarget.closest<HTMLElement>(".myne-calendar__column");
    const host = event.currentTarget.ownerDocument.defaultView;
    if (host === null) return;
    const rendered: EventSpan = { start: row.start, end: row.end, allDay: row.allDay };
    let preview: EventSpan | null = null;

    const move = (next: PointerEvent) => {
      const minute = minuteAt(next.clientY, column);
      if (minute === null) return;
      const planned = planEdgeResize(rendered, edge, `${date} ${clockOf(minute)}`);
      if (planned === null) return;
      preview = planned;
      setOptimistic((current) => ({ ...current, [row.noteId]: planned }));
    };

    const up = () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerup", up);
      const next = preview;
      if (next === null) return;
      void commitSpan(
        row,
        rendered,
        next,
        next.start !== rendered.start || next.end !== rendered.end,
      );
    };

    host.addEventListener("pointermove", move);
    host.addEventListener("pointerup", up);
  };

  const commitCapture = useCallback(
    async (date: string) => {
      const title = draft.trim();
      if (title === "") {
        setCapturing(null);
        setCaptureHour(null);
        return;
      }
      const start = parseEventInstant(`${date} ${captureHour ?? CAPTURE_HOUR}`);
      if (start === null) {
        setError("failed");
        return;
      }
      try {
        await createEvent({ title, start });
        setDraft("");
        setCapturing(null);
        setCaptureHour(null);
      } catch {
        setError("failed");
      }
    },
    [draft, captureHour],
  );

  /** One gesture, two grains: a day from the grid, an hour from the axis. */
  const openCapture = (date: string, hour: number | null = null) => {
    setCapturing(date);
    setCaptureHour(hour === null ? null : hourValue(hour));
    setDraft("");
  };

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
          setCaptureHour(null);
          setDraft("");
        }
      }}
      onBlur={() => void commitCapture(date)}
    />
  );

  // The preference lives in `localStorage` and Settings writes it from another screen,
  // so the calendar SUBSCRIBES: reading it once during render left an open calendar on
  // one clock until something unrelated forced a re-render, which is what made the
  // second clock look like a feature that does nothing.
  const homeZone = useSyncExternalStore(subscribeHomeZone, readHomeZone);
  const homeFor = (row: DisplayRow) =>
    row.allDay ? null : homeClockFor(row.start.replace(" ", "T"), homeZone);

  const chip = (row: DisplayRow, showTime: boolean, showGrip = showTime, dragToMove = true) => (
    <Button
      key={`${row.noteId}-${row.start}`}
      variant="ghost"
      data-testid="calendar.row"
      data-conflicts={row.conflicts ? "true" : undefined}
      data-occurrence={isProjected(row) ? "true" : undefined}
      title={
        row.task !== undefined
          ? t("calendar.taskRow", { date: row.start.slice(0, 10) })
          : isProjected(row)
            ? t("calendar.occurrenceOf", { date: occurrenceDate(row) })
            : undefined
      }
      data-task={row.task !== undefined ? "true" : undefined}
      // A task is not draggable: its date is a `due:` field on a line (or on the
      // note's frontmatter), not an event `start`, and the move writer would patch a
      // field no reader of that line agrees about.
      draggable={dragToMove && row.task === undefined}
      onDragStart={(event) => {
        if (!dragToMove || row.task !== undefined) {
          event.preventDefault();
          return;
        }
        event.stopPropagation();
        setDrag({
          row,
          mode: "move",
          rendered: { start: row.start, end: row.end, allDay: row.allDay },
        });
      }}
      // An event opens its form; a task opens the note it is a line inside.
      onClick={() => {
        if (row.task !== undefined) {
          ws.openNewTabInFocused(row.noteId);
          return;
        }
        if (isProjected(row)) {
          // An appearance has no note of its own: the panel names the series.
          refuseOccurrence(row);
          return;
        }
        setEditing(row);
      }}
      onContextMenu={
        isProjected(row)
          ? (event) => {
              // The panel that explains what an occurrence is, reachable without
              // dragging one: right-clicking a projected row offers the three
              // answers (edit the series, add a one-off, cancel this one) instead
              // of a menu with a fourth thing that would have no legal write.
              event.preventDefault();
              refuseOccurrence(row);
            }
          : undefined
      }
      className="myne-calendar__chip"
      // The row's colour is the user's own token choice, so it comes per row.
      style={{ borderInlineStartColor: calendarColour(settings, row.calendar) }}
    >
      {showTime && (
        <span className="myne-calendar__time">
          {row.allDay ? t("calendar.allDay") : formatWallClockTime(row.start.slice(11), display)}
        </span>
      )}
      {/* The second clock (decisions/storage/0797): the note's time is a wall clock
          and stays one, so this is an addition to the READING and nothing stored.
          Its OWN line rather than a suffix on the clock: a block in a week column is
          narrow enough to cut "09:00 · 17:00" mid-string, and a reading nobody can
          finish is a reading that is not there. `homeClockFor` answers null when the
          preference is unset or is the device's own zone, so the common case costs
          the row nothing. */}
      {showTime &&
        (() => {
          const home = homeFor(row);
          if (home === null) return null;
          const day = home.dayOffset === 0 ? "" : home.dayOffset > 0 ? "+1" : "-1";
          return (
            <span className="myne-calendar__home" data-testid="calendar.row.home-clock">
              {`${home.time}${day}`}
            </span>
          );
        })()}
      <span className="myne-calendar__title">{row.title ?? t("calendar.untitled")}</span>
      {row.task !== undefined && <Icon name="check" size={10} />}
      {row.occurrenceOf !== null && <Icon name="rotate-ccw" size={10} />}
      {/* The grip only where a time axis exists to lengthen an event along: a month
          cell has none, and `⋯` on every row of a 42-cell grid is noise. */}
      {showGrip && (
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
      )}
    </Button>
  );

  /** `YYYY-MM-DDTHH:MM`, the device's own clock, in the shape a row's start uses. */
  function currentMinute(): string {
    const at = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }

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
          onClick={() => openCapture(date)}
        />
      </div>
    );
  };

  const monthCell = (cell: ReturnType<typeof monthGrid>[number][number]) => (
    <div
      key={cell.date}
      data-testid="calendar.cell"
      data-date={cell.date}
      data-outside={cell.inMonth ? undefined : "true"}
      data-today={cell.date === today ? "true" : undefined}
      className="myne-calendar__cell"
      onDragOver={(event) => {
        if (drag !== null) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        void dropOn(cell.date);
      }}
      // Empty space in a day captures. A month cell has one line of room, so what
      // it opens is the inline title, where a week column opens the full form.
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        openCapture(cell.date);
      }}
    >
      <div className="myne-calendar__cellhead">
        <span className="myne-calendar__daynum">{cell.date.slice(8)}</span>
        <span style={{ flex: "1 1 auto" }} />
        <span className="myne-calendar__add">
          <IconButton
            icon="plus"
            label={t("calendar.capture.on", { date: cell.date })}
            iconSize={11}
            onClick={() => openCapture(cell.date)}
          />
        </span>
      </div>
      {capturing === cell.date && captureField(cell.date)}
      <div className="myne-calendar__events">
        {cell.rows.slice(0, CELL_CHIPS).map((row) => chip(row, true, false))}
      </div>
      {cell.rows.length > CELL_CHIPS && (
        <span className="myne-calendar__more">
          {t("calendar.more", { count: cell.rows.length - CELL_CHIPS })}
        </span>
      )}
    </div>
  );

  const renderMonth = () => {
    const weeks = monthGrid(anchor, rows);
    return (
      <div className="myne-calendar__month" data-testid="calendar.month">
        <div className="myne-calendar__weekdays">
          {WEEKDAY_HEADERS.map((day) => (
            <span key={day} className="myne-calendar__weekday">
              {t(`calendar.weekday.${day}`)}
            </span>
          ))}
        </div>
        <div
          className="myne-calendar__weeks"
          style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}
        >
          {weeks.map((week) => (
            <div key={week[0]!.date} className="myne-calendar__week">
              {week.map(monthCell)}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const hoursRef = useRef<HTMLDivElement | null>(null);

  /**
   * Land the axis where the day usually starts: the first thing on it, else the
   * current hour, else a working morning. Never midnight, and the slot's own
   * `offsetTop` is the target so the row height stays in the stylesheet.
   */
  useEffect(() => {
    const el = hoursRef.current;
    if (el === null) return;
    const first = rows
      .map(rowHour)
      .filter((hour): hour is number => hour !== null)
      .sort((a, b) => a - b)[0];
    const showsToday = today >= window.start && today <= window.end;
    const hour = first ?? (showsToday ? Number(now.slice(11, 13)) : FIRST_VISIBLE_HOUR);
    const slot = el.querySelector<HTMLElement>(`[data-hour="${hour}"]`);
    if (slot !== null) el.scrollTop = slot.offsetTop;
    // Only when the surface changes: re-running on every render would fight the
    // reader's own scrolling while the pane ticks its clock.
  }, [view, anchor, window.start]);

  /**
   * A day column with an hour axis, for both views that want one.
   *
   * A list of rows could not answer "at what hour", and gave a person nowhere to
   * put a 14:00 meeting except the form. Each hour is a target of its own.
   */
  /** A timed row as a BLOCK over its own minutes; `layoutDay` owns the geometry and
   *  the overlap split. The grips are a pointer shortcut the form also offers. */
  const timedBlock = (date: string, block: PlacedSpan<DisplayRow>) => {
    const share = 100 / block.columns;
    const minutes = Math.max(block.endMin - block.startMin, MIN_BLOCK_MINUTES);
    const title = block.row.title ?? t("calendar.untitled");
    return (
      <div
        key={block.key}
        className="myne-calendar__block"
        data-testid="calendar.block"
        // The body is the MOVE target; the grips inside it are the edges. A press
        // that does not move still opens the form, which is what the chip's own
        // click does - the drag suppresses it.
        onPointerDown={(event) => beginMove(event, block.row, date, block.startMin)}
        // The span as NUMBERS, so a scenario (and a test in jsdom, which computes
        // no layout) can assert what the block covers instead of reading pixels.
        data-start-minute={block.startMin}
        data-end-minute={block.endMin}
        style={{
          top: `${(block.startMin / DAY_MINUTES) * 100}%`,
          height: `${(minutes / DAY_MINUTES) * 100}%`,
          insetInlineStart: `${block.column * share}%`,
          width: `calc(${share}% - 2px)`,
        }}
      >
        <span
          aria-hidden="true"
          className="myne-calendar__grip"
          data-edge="start"
          title={t("calendar.resize", { title })}
          onPointerDown={(event) => beginResize(event, block.row, date, "start")}
        />
        {chip(block.row, true, false, false)}
        <span
          aria-hidden="true"
          className="myne-calendar__grip"
          data-edge="end"
          title={t("calendar.resize", { title })}
          onPointerDown={(event) => beginResize(event, block.row, date, "end")}
        />
      </div>
    );
  };

  const renderTimeGrid = (cells: ReturnType<typeof weekRow>) => {
    const gridStyle = { gridTemplateColumns: `var(--space-7) repeat(${cells.length}, minmax(0, 1fr))` };
    const band = cells.some((cell) => cell.rows.some((row) => rowHour(row) === null));
    const nowMinute = minuteOfDay(now.slice(0, 16).replace("T", " "));
    return (
      <div className="myne-calendar__timegrid">
        <div className="myne-calendar__days" style={gridStyle}>
          <span aria-hidden="true" />
          {cells.map((cell) => (
            <div key={cell.date} className="myne-calendar__dayhead">
              {dayHeader(cell.date)}
            </div>
          ))}
        </div>
        {band && (
          <div className="myne-calendar__allday" style={gridStyle}>
            <span className="myne-calendar__hourlabel">{t("calendar.allDay")}</span>
            {cells.map((cell) => (
              <div key={cell.date} className="myne-calendar__alldaycell">
                {cell.rows.filter((row) => rowHour(row) === null).map((row) => chip(row, false))}
              </div>
            ))}
          </div>
        )}
        <div className="myne-calendar__hours" style={gridStyle} ref={hoursRef} data-testid="calendar.hours">
          <div className="myne-calendar__labels" aria-hidden="true">
            {HOURS.map((hour) => (
              <span key={hour} className="myne-calendar__hourlabel">
                {formatWallClockTime(hourValue(hour), display)}
              </span>
            ))}
          </div>
          {cells.map((cell) => (
            <div
              key={cell.date}
              data-testid="calendar.cell"
              data-date={cell.date}
              className="myne-calendar__column"
              // A block moves by the POINTER here: the hour axis can express 10:30.
            >
              {HOURS.map((hour) => {
                const open = capturing === cell.date && captureHour === hourValue(hour);
                return (
                  <div
                    key={hour}
                    data-hour={hour}
                    className="myne-calendar__slot"
                    onPointerDown={(event) => beginCreate(event, cell.date)}
                    // A TARGET, not a control: `currentTarget` keeps the field's own.
                    onClick={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (draggedRef.current) {
                        draggedRef.current = false;
                        return;
                      }
                      openCapture(cell.date, hour);
                    }}
                  >
                    {open && <div className="myne-calendar__slotform">{captureField(cell.date)}</div>}
                  </div>
                );
              })}
              {/* Its own layer, because a slot is an hour tall and an event is not. */}
              <div className="myne-calendar__layer">
                {cell.date === today && nowMinute !== null && (
                  <div
                    aria-hidden="true"
                    data-testid="calendar.now"
                    className="myne-calendar__now"
                    style={{ top: `${(nowMinute / DAY_MINUTES) * 100}%` }}
                  >
                    <span className="myne-calendar__nowdot" />
                    <span className="myne-calendar__nowrule" />
                    <span className="myne-calendar__nowtime">
                      {formatWallClockTime(now.slice(11, 16), display)}
                    </span>
                  </div>
                )}
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
        return renderTimeGrid(weekRow(anchor, rows));
      case "day":
        return renderTimeGrid(dayCells(anchor, rows));
      case "agenda":
        return renderAgenda();
      default: {
        const exhaustive: never = view;
        return exhaustive;
      }
    }
  };

  /**
   * Where "now" is. ONE interval for the whole pane, not a timer per row: the
   * marker is a single line, and recomputing a hundred cells a minute is a fan
   * nobody can hear the reason for.
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
        openCapture(today);
        event.preventDefault();
        return;
      default:
        return;
    }
  };

  return (
    <div
      // No gutters are granted (`PaneView`'s calendar branch): this surface's
      // inset is its own and symmetric, in `components.css` beside the grid's.
      className="myne-calendar"
      data-testid="calendar.pane"
      data-pane={paneId}
      tabIndex={0}
      onKeyDown={onKeyDown}
      role="application"
      aria-label={t("calendar.view.label")}
    >
      <div className="myne-calendar__bar">
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
          label={t("common.today")}
          iconSize={14}
          onClick={() => setAnchor(parseCivilDate(today) ?? todayCivilDate())}
        />
        <span style={{ flex: "1 1 auto" }} />
        <IconButton
          icon="calendar-plus"
          label={t("calendar.form.title")}
          iconSize={14}
          onClick={() => setComposing(emptyEventForm(formatCivilDate(anchor)))}
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
          <TimeField
            label={t("calendar.occurrence.retime")}
            value={retime === "" ? null : retime}
            onChange={(next) => setRetime(next ?? "")}
            testId="calendar.occurrence.retime-field"
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
          initial={composing}
          onClose={() => {
            setComposing(null);
            setReload((n) => n + 1);
          }}
        />
      )}

      {editing !== null && (
        <CalendarEventForm
          mode="edit"
          initial={formFromRow(editing)}
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            const plan = planEventForm(values);
            if (!plan.ok) return;
            setFailure(null);
            try {
              await applyEventEdit({
                noteId: editing.noteId,
                rendered: { start: editing.start, end: editing.end, allDay: editing.allDay },
                next: editFromPlan(plan.input),
                io,
              });
              // `note_update` does not touch the index this pane reads.
              await reindexNote(editing.noteId);
            } catch (err) {
              setFailure(err instanceof EventWriteRefused ? err.reason : null);
              // A real I/O failure is not a refusal: rethrown so it reaches the
              // pane's error surface instead of closing on the old values.
              if (!(err instanceof EventWriteRefused)) throw err;
            } finally {
              setEditing(null);
              setReload((n) => n + 1);
            }
          }}
        />
      )}

      {error === "locked" ? (
        <p style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }} data-testid="calendar.lockedShell">
          {t("calendar.locked")}
        </p>
      ) : (
        <div className="myne-calendar__body">
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
