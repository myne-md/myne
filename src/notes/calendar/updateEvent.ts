// Editing an event that already exists (myne-md/myne#1037).
//
// The calendar's chips used to open the NOTE, which is a markdown document: an
// event is a note on disk, but the markdown is an implementation detail the user
// asked not to see (owner, 2026-11-08 — "markdown should only be visible when you
// export"). So the chip opens the same form a cell click opens, prefilled, and
// the form writes through here.
//
// **`applyEventMove`'s discipline, not a second one.** A write is value-anchored
// against what the row was RENDERED from and base-hashed against the bytes that
// were read, so a sync pull-apply or a second pane holding the same event turns
// the write into a named refusal instead of an overwrite. The two writers differ
// only in which fields they patch: a drag moves `start`/`end`, this one rewrites
// the whole vocabulary.
//
// **A cleared field is a DELETED line, not an empty one.** `patchFrontmatterField`
// takes `null` to mean "remove", so turning a repeat off leaves the note without a
// `repeat:` key — the same shape a hand-authored one-off has, and the same
// byte-stability rule §3.8.5 asks of every writer in this tree.

import { formatEventInstant } from "@myne/dialect/event";
import { patchFrontmatterField } from "@myne/dialect/surgery";
import { commitEventWrite, openEventWrite, type EventSpan, type EventWriteIo } from "./dragWrite";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The vocabulary the form owns. Every value is in the EMITTED form. */
export type EventEdit = {
  readonly title: string;
  readonly start: string;
  readonly end: string | null;
  readonly calendar?: string | null;
  readonly repeat?: string | null;
  readonly remind?: string | null;
};

/** The emitted form of an edit, from a form's plan (`planEventForm`). */
export function editFromPlan(plan: {
  readonly title: string;
  readonly start: Parameters<typeof formatEventInstant>[0];
  readonly end?: Parameters<typeof formatEventInstant>[0] | null;
  readonly calendar?: string | null;
  readonly repeat?: string | null;
  readonly remind?: string | null;
}): EventEdit {
  return {
    title: plan.title,
    start: formatEventInstant(plan.start),
    end: plan.end === null || plan.end === undefined ? null : formatEventInstant(plan.end),
    calendar: plan.calendar === "" || plan.calendar === undefined ? null : plan.calendar,
    repeat: plan.repeat === "" || plan.repeat === undefined ? null : plan.repeat,
    remind: plan.remind === "" || plan.remind === undefined ? null : plan.remind,
  };
}

/**
 * Write `next` onto the note, provided the note still says `rendered`.
 *
 * Returns without writing when nothing changed, so saving a form the user opened
 * and closed again does not produce a snapshot of identical bytes.
 */
export async function applyEventEdit(args: {
  readonly noteId: string;
  /** The span the row was rendered from: what this write is checked against. */
  readonly rendered: EventSpan;
  readonly next: EventEdit;
  readonly io: EventWriteIo;
}): Promise<void> {
  const { noteId, rendered, next, io } = args;
  // Same three steps a drag owes, from the same two helpers: flush, read, and
  // refuse unless the note still says the `start` this row was drawn from.
  const source = await openEventWrite({ noteId, rendered, io });

  let bytes = patchFrontmatterField(encoder.encode(source), "title", next.title);
  bytes = patchFrontmatterField(bytes, "start", next.start);
  bytes = patchFrontmatterField(bytes, "end", next.end);
  bytes = patchFrontmatterField(bytes, "calendar", next.calendar ?? null);
  bytes = patchFrontmatterField(bytes, "repeat", next.repeat ?? null);
  bytes = patchFrontmatterField(bytes, "remind", next.remind ?? null);
  await commitEventWrite({ noteId, source, body: decoder.decode(bytes), io });
}
