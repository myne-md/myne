// Dragging and resizing an event (myne-md/myne#1037, task 6).
//
// An event's position is two frontmatter fields, so a drag is an ordinary note
// write: `start` moves, `end` moves with it, and nothing else in the blob changes.
// There is no journal, no sidecar state and no second store, because the note IS
// the record.
//
// Two properties make this safe to hang a gesture on:
//
// 1. **Value-anchored.** The gesture carries the `start` the row was RENDERED from
//    and refuses when the note no longer says that. A sync pull-apply between the
//    read and the drop, or the same event open in another pane, would otherwise
//    land the move on bytes nobody looked at.
// 2. **One write, base-hashed.** `end - start` is preserved, and the content hash
//    the backend checks turns a raced write into a refusal rather than an overwrite.
//
// **A refusal REJECTS.** It never resolves quietly: a surface that swallows one
// goes on drawing the row where the user dropped it while the note says otherwise,
// and every later write in that session then fails for a reason nothing displayed.
//
// The reusable half is somebody else's: `sha256Hex`, `isBaseMismatchError`,
// `locateFrontmatter`, `patchFrontmatterField` and the dialect's event reader all
// already exist, and this module only sequences them.

import {
  addDays,
  formatCivilDate,
} from "@myne/dialect/civilDate";
import { formatEventInstant, parseEventInstant, readEventFromFmBody } from "@myne/dialect/event";
import { locateFrontmatter } from "@myne/dialect/lezer/frontmatter";
import { patchFrontmatterField } from "@myne/dialect/surgery";
import { isBaseMismatchError } from "../../types/note-update-error";
import { sha256Hex } from "../baseHash";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Where an event sits, in the emitted form the note carries (`§3.10.2`). */
export type EventSpan = {
  readonly start: string;
  readonly end: string | null;
  readonly allDay: boolean;
};

/**
 * Why a move could not be written. Each is distinct and explainable, and none of
 * them is a generic "could not save": the calendar tells the user which one happened
 * and puts the row back where the note says it is.
 */
export type EventWriteRefusal =
  /** The note no longer carries the `start` the row was drawn from. */
  | "value-changed"
  /** The note has no readable `start` at all (deleted, rewritten, or never an event). */
  | "start-missing"
  /** A sync pull-apply raced the write; nothing was overwritten. */
  | "base-mismatch";

/** A refusal, distinct from an IPC error so the caller can explain it. */
export class EventWriteRefused extends Error {
  constructor(
    readonly reason: EventWriteRefusal,
    readonly noteId: string,
  ) {
    super(`event write refused (${reason}) for note ${noteId}`);
    this.name = "EventWriteRefused";
  }
}

/**
 * The IO a move needs, injected so this module is testable without a vault.
 *
 * `writeNote` takes the base hash it must be given (`TaskWriteIo`'s contract): a
 * three-argument write is the one the backend's expected-base guard defends.
 */
export type EventWriteIo = {
  readNote: (noteId: string) => Promise<string>;
  writeNote: (noteId: string, body: string, baseHashHex: string) => Promise<unknown>;
  /** Flush every pane with unsaved keystrokes. Omitted in tests. */
  flushDirtyPanes?: () => Promise<void>;
};

/** Move one instant by whole days, keeping its wall-clock time. */
function shiftInstant(value: string, days: number): string | null {
  const instant = parseEventInstant(value);
  if (instant === null) return null;
  const shifted = { ...instant, date: addDays(instant.date, days) };
  void formatCivilDate;
  return formatEventInstant(shifted);
}

/**
 * The span a drag of `days` produces: `start` and `end` move together, so a
 * two-hour meeting stays two hours and a three-day trip stays three days.
 */
export function planDrag(span: EventSpan, days: number): EventSpan {
  if (days === 0) return span;
  const start = shiftInstant(span.start, days) ?? span.start;
  const end = span.end === null ? null : (shiftInstant(span.end, days) ?? span.end);
  return { start, end, allDay: span.allDay };
}

/**
 * The span a resize of `days` produces: only `end` moves.
 *
 * A point event gains an end rather than refusing the gesture, so dragging the
 * bottom edge of a 09:00 event is how a user turns it into a 09:00-10:00 one.
 * An end that would precede the start is refused (`null`), because an inverted
 * interval is a shape the dialect does not write and the reader would report as
 * `end-before-start`.
 */
export function planResize(span: EventSpan, days: number): EventSpan | null {
  const start = parseEventInstant(span.start);
  if (start === null) return null;
  const baseEnd = span.end === null ? span.start : span.end;
  const end = shiftInstant(baseEnd, days);
  if (end === null) return null;
  const parsed = parseEventInstant(end);
  if (parsed === null) return null;
  const startMs = civilMs(start);
  const endMs = civilMs(parsed);
  if (endMs < startMs) return null;
  return { start: span.start, end, allDay: span.allDay };
}

/** A comparable stamp for an instant, so two spans can be ordered. */
function civilMs(instant: { date: { year: number; month: number; day: number }; time: string | null }): number {
  const base = Date.UTC(instant.date.year, instant.date.month - 1, instant.date.day);
  if (instant.time === null) return base;
  const [h, m] = instant.time.split(":");
  return base + Number(h) * 3_600_000 + Number(m ?? "0") * 60_000;
}

/**
 * Write `next` onto the note, provided the note still says `rendered`.
 *
 * Returns without writing when the move changes nothing (a drop back where the
 * event started), which keeps a mis-gesture from producing a snapshot.
 */
export async function applyEventMove(args: {
  readonly noteId: string;
  /** The span the row was rendered from: the anchor this write is checked against. */
  readonly rendered: EventSpan;
  readonly next: EventSpan;
  readonly io: EventWriteIo;
}): Promise<void> {
  const { noteId, rendered, next, io } = args;

  // Flush BEFORE reading: a pane holding unsaved keystrokes has a newer body than
  // disk, and writing over the stale copy would be undone by the flush.
  const source = await openEventWrite({ noteId, rendered, io });

  if (next.start === rendered.start && next.end === rendered.end) return;

  let bytes = patchFrontmatterField(encoder.encode(source), "start", next.start);
  if (next.end !== null) bytes = patchFrontmatterField(bytes, "end", next.end);
  await commitEventWrite({ noteId, source, body: decoder.decode(bytes), io });
}

/**
 * Read the note and refuse unless it still says what the row was drawn from.
 *
 * The two writers in this directory (a drag and a form edit) patch different
 * fields but owe the same three steps before they may: flush the panes holding
 * unsaved keystrokes, read, and verify the value-anchor. Kept here rather than
 * copied, because a second copy of "check the anchor" is a second place the check
 * can be dropped.
 */
export async function openEventWrite(args: {
  readonly noteId: string;
  readonly rendered: EventSpan;
  readonly io: EventWriteIo;
}): Promise<string> {
  const { noteId, rendered, io } = args;
  await io.flushDirtyPanes?.();

  const source = await io.readNote(noteId);
  const range = locateFrontmatter(source);
  if (range === null) throw new EventWriteRefused("start-missing", noteId);
  const read = readEventFromFmBody(source.slice(range.bodyStart, range.bodyEnd));
  if (read.state !== "ok") throw new EventWriteRefused("start-missing", noteId);
  if (formatEventInstant(read.event.start) !== rendered.start) {
    throw new EventWriteRefused("value-changed", noteId);
  }
  return source;
}

/**
 * Write `body` over `source`, refusing when disk moved past `source`.
 *
 * `source` is the pre-image the patches were computed from, so its hash is the
 * expected-base guard: a pull-apply between the read and this write turns the
 * write into a named refusal instead of an overwrite.
 */
export async function commitEventWrite(args: {
  readonly noteId: string;
  readonly source: string;
  readonly body: string;
  readonly io: EventWriteIo;
}): Promise<void> {
  const { noteId, source, body, io } = args;
  if (body === source) return;
  try {
    await io.writeNote(noteId, body, await sha256Hex(source));
  } catch (err) {
    if (!isBaseMismatchError(err)) throw err;
    throw new EventWriteRefused("base-mismatch", noteId);
  }
}
