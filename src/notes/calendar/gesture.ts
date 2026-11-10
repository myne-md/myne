// The two hour-axis gestures, once (myne-md/myne#1037).
//
// A block is moved and an edge is dragged by exactly the same arithmetic on a phone
// and on a laptop: where the pointer is inside the block, which day column its x is
// over, and what minutes that resolves to. Writing that twice is how the two clients
// start disagreeing about where a drag landed, and `check-duplication` reported the
// copy the first time it was written twice. So the GESTURE lives here and a surface
// supplies what only it knows: the row, the span it was drawn from, and what to do
// with the result.
//
// It is DOM-bound on purpose, and that is the one reason it is not in `layout.ts`
// with the rest of the mapping: this half owns event listeners on a window it does
// not own, so it also owes their removal, which it does in the `pointerup` that ends
// the gesture.
//
// What the CALLER decides, because it is policy and not geometry:
//
// - whether this row may move at all (a projected occurrence has no legal write, a
//   task row is not an event);
// - what a tap means (desktop opens its inline form, the phone opens its sheet);
// - what a preview means (both paint the row optimistically; neither writes until
//   release).

import { parseCivilDate } from "@myne/dialect/civilDate";
import { DAY_MINUTES, SNAP_MINUTES, columnUnder, minuteAt, snapMinute } from "./layout";
import { planEdgeResize, planMoveTo, type EventSpan } from "./dragWrite";

/** The pressed element and the pointer that pressed it, as the caller saw them. */
export type GesturePress = {
  readonly currentTarget: HTMLElement;
  readonly clientX: number;
  readonly clientY: number;
};

/** What a surface supplies for a move. */
export type MoveGestureHandlers = {
  /** The span the row was DRAWN from: the anchor a write is checked against. */
  readonly rendered: EventSpan;
  /** The minute past midnight the block's own start was drawn at. */
  readonly drawnStartMin: number;
  /** The day of the column that was pressed. */
  readonly date: string;
  /** A span the pointer has reached, before any write. */
  readonly onPreview: (next: EventSpan) => void;
  /** The span the pointer was released on, once. */
  readonly onCommit: (next: EventSpan) => void;
  /** A press that never moved. Absent means "do nothing", which is what a surface
   *  that has no second meaning for a tap wants. */
  readonly onTap?: () => void;
};

/** What a surface supplies for an edge drag. */
export type ResizeGestureHandlers = {
  readonly rendered: EventSpan;
  readonly date: string;
  readonly edge: "start" | "end";
  readonly onPreview: (next: EventSpan) => void;
  readonly onCommit: (next: EventSpan) => void;
};

/** The day column a gesture started in, or `null` outside the axis. */
function originColumn(press: GesturePress): HTMLElement | null {
  return press.currentTarget.closest<HTMLElement>(".myne-calendar__column");
}

/** The window the listeners go on: the element's own, never a global one. */
function hostWindow(press: GesturePress): Window | null {
  return press.currentTarget.ownerDocument.defaultView;
}

/**
 * Drag a block's body: the whole span moves by the pointer, so the day and the time
 * both follow it and the duration survives.
 *
 * The point INSIDE the block that was grabbed stays under the pointer, so grabbing an
 * event near its bottom does not slide its start to the pointer's minute.
 */
export function beginMoveGesture(press: GesturePress, handlers: MoveGestureHandlers): void {
  const origin = originColumn(press);
  const host = hostWindow(press);
  if (origin === null || host === null) return;
  const grabAt = minuteAt(press.clientY, origin);
  if (grabAt === null) return;
  const grabOffset = grabAt - handlers.drawnStartMin;
  const { rendered, date } = handlers;
  let preview: EventSpan | null = null;

  const onPointerMove = (next: PointerEvent) => {
    const under = columnUnder(next.clientX, origin) ?? { column: origin, date };
    const minute = minuteAt(next.clientY, under.column);
    if (minute === null) return;
    const targetStart = snapMinute(minute - grabOffset);
    const from = parseCivilDate(date);
    const to = parseCivilDate(under.date) ?? from;
    if (from === null || to === null) return;
    const dayDelta = Math.round(
      (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / 86_400_000,
    );
    const planned = planMoveTo(
      rendered,
      dayDelta * DAY_MINUTES + (targetStart - handlers.drawnStartMin),
    );
    if (planned === null) return;
    preview = planned;
    handlers.onPreview(planned);
  };

  const onPointerUp = () => {
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerup", onPointerUp);
    if (preview === null) {
      handlers.onTap?.();
      return;
    }
    handlers.onCommit(preview);
  };

  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerUp);
}

/** What a surface supplies for a create-drag. */
export type CreateGestureHandlers = {
  /** The day column that was pressed. */
  readonly date: string;
  /** The range a drag has drawn so far, snapped, `from < to` always. */
  readonly onRange: (from: number, to: number) => void;
  /** The drag ended: clear the preview and act on the range. */
  readonly onDrawn: (from: number, to: number) => void;
  /** A press that never moved: a TAP at that minute, which is a different act. */
  readonly onTap: (minute: number) => void;
};

/**
 * Press and drag on empty hour space: draw a range, then hand it over.
 *
 * `onDrawn` gets the range CLAMPED to the day, and a drag never produces an empty one
 * (a zero-length event is not a shape either client writes). A press that does not
 * move resolves to `onTap` with the minute it landed on, because a phone has no
 * second gesture for "create here".
 */
export function beginCreateGesture(press: GesturePress, handlers: CreateGestureHandlers): void {
  const origin = originColumn(press);
  const host = hostWindow(press);
  if (origin === null || host === null) return;
  const anchor = minuteAt(press.clientY, origin);
  if (anchor === null) return;
  let from = anchor;
  let to = anchor + SNAP_MINUTES;
  let dragged = false;

  const onPointerMove = (next: PointerEvent) => {
    const minute = minuteAt(next.clientY, origin);
    if (minute === null) return;
    dragged = true;
    from = Math.min(anchor, minute);
    to = Math.max(Math.max(anchor, minute), from + SNAP_MINUTES);
    handlers.onRange(from, to);
  };

  const onPointerUp = () => {
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerup", onPointerUp);
    if (!dragged) {
      handlers.onTap(anchor);
      return;
    }
    // `23:59`, because a clock has 1440 minutes and 1440 is not one.
    const startMin = Math.min(from, DAY_MINUTES - SNAP_MINUTES);
    const endMin = Math.min(Math.max(to, startMin + SNAP_MINUTES), DAY_MINUTES - 1);
    handlers.onDrawn(startMin, endMin);
  };

  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerUp);
}

/** Drag one end of a block: that instant moves, the other one stays. */
export function beginResizeGesture(press: GesturePress, handlers: ResizeGestureHandlers): void {
  const column = originColumn(press);
  const host = hostWindow(press);
  if (column === null || host === null) return;
  const { rendered, date, edge } = handlers;
  let preview: EventSpan | null = null;

  const onPointerMove = (next: PointerEvent) => {
    const minute = minuteAt(next.clientY, column);
    if (minute === null) return;
    const hh = String(Math.floor(minute / 60)).padStart(2, "0");
    const mm = String(minute % 60).padStart(2, "0");
    const planned = planEdgeResize(rendered, edge, `${date} ${hh}:${mm}`);
    if (planned === null) return;
    preview = planned;
    handlers.onPreview(planned);
  };

  const onPointerUp = () => {
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerup", onPointerUp);
    if (preview !== null) handlers.onCommit(preview);
  };

  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerUp);
}
