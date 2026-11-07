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

import { formatEventInstant, type EventInstant } from "../dialect/event";
import { patchFrontmatterField, patchTitleField } from "../dialect/surgery";
import { normalizeFolderPath } from "../dialect/folderPath";
import { noteCreate } from "./notes";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Where a new event lands when the user has not said otherwise. A default
 *  LOCATION only: `kind` is an event's identity, never its folder. */
export const DEFAULT_CALENDAR_FOLDER = "Calendar/";

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
  let bytes = patchTitleField(encoder.encode(""), input.title);
  bytes = patchFrontmatterField(bytes, "kind", "event");
  bytes = patchFrontmatterField(bytes, "start", formatEventInstant(input.start));
  if (input.end !== undefined && input.end !== null) {
    bytes = patchFrontmatterField(bytes, "end", formatEventInstant(input.end));
  }
  if (input.repeat !== undefined && input.repeat !== null && input.repeat !== "") {
    bytes = patchFrontmatterField(bytes, "repeat", input.repeat);
  }
  if (input.remind !== undefined && input.remind !== null && input.remind !== "") {
    bytes = patchFrontmatterField(bytes, "remind", input.remind);
  }
  if (input.calendar !== undefined && input.calendar !== null && input.calendar !== "") {
    bytes = patchFrontmatterField(bytes, "calendar", input.calendar);
  }
  return decoder.decode(bytes);
}

/** Create the note and return its id. */
export async function createEventNote(input: NewMobileEvent): Promise<string> {
  const folder = normalizeFolderPath(
    input.folder === undefined ? DEFAULT_CALENDAR_FOLDER : input.folder,
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
