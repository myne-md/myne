// Writing an event on the phone (myne-md/myne#1037).
//
// An event is a NOTE, so this writes bytes and then calls `note_create` — the
// same two steps `mobile/src/lib/setNoteCover.ts` takes for a cover, and the same
// frontmatter surgery the desktop `createEvent` uses. There is no event command,
// no event table and no event blob to write: `kind: event` plus a handful of
// fields IS the record.
//
// **Why this is not `src/notes/createEvent.ts`.** That module calls the desktop
// `noteCreate` wrapper. The phone has its own (`mobile/src/lib/notes.ts`), and the
// seam rule says a client writes through its own. What IS shared is everything
// above the seam: the surgery, the instant formatter, the field vocabulary, so a
// note created on a phone is byte-identical to one created on a laptop.

import { eventNoteBytes, type EventInstant } from "../dialect/event";
import { patchFrontmatterField } from "@myne/dialect/surgery";
import { normalizeFolderPath } from "../dialect/folderPath";
import { noteCreate } from "./notes";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What the composer supplies. */
export type NewMobileEvent = {
  readonly title: string;
  readonly start: EventInstant;
  readonly end?: EventInstant | null;
  readonly repeat?: string | null;
  readonly remind?: string | null;
  readonly calendar?: string | null;
  readonly folder?: string | null;
};

/**
 * The plaintext a new event is created with.
 *
 * Internal on purpose: the bytes are asserted through [`createEventNote`] with
 * `note_create` mocked, which is the pair of steps a caller actually performs. An
 * exported builder with one test importer is an export nothing ships.
 */
function buildEventNote(input: NewMobileEvent): string {
  // The dialect's builder, not a copy of it: a second emitter is how the phone came to
  // write no `uid` and to order `repeat` before `calendar` while the desktop did the
  // reverse, which made the "byte-identical" claim in this file's header false.
  return decoder.decode(
    eventNoteBytes({
      title: input.title,
      start: input.start,
      end: input.end,
      repeat: input.repeat,
      remind: input.remind,
      calendar: input.calendar,
    }),
  );
}

/** Create the note and return its id. */
export async function createEventNote(input: NewMobileEvent): Promise<string> {
  // The vault root, like the desktop (owner, 2026-11-08): a default of
  // `Calendar/` created a folder nobody asked for, and kept it alive through
  // the deliberate-folder registry after the last event in it was deleted.
  const folder = normalizeFolderPath(
    input.folder === undefined ? null : input.folder,
  );
  let body = buildEventNote(input);
  if (folder !== null) {
    body = decoder.decode(
      patchFrontmatterField(encoder.encode(body), "folder", folder),
    );
  }
  return await noteCreate(body, folder);
}

/**
 * `HH:MM` in 24-hour wall clock, or `null` when the text is not one.
 *
 * The same shape the dialect writes and the reminder anchor validates
 * (`set_calendar_setting` refuses anything else), so a value that reaches disk
 * here is a value every reader can parse.
 */
export function parseClock(text: string): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}
