// Calendar event creation (myne-md/myne#1037) - a thin desktop orchestrator over
// the existing `note_create` IPC, exactly like `createDrawing`.
//
// An event is a NOTE (`markdown-dialect.md` §3.10): `kind: event` plus a
// frontmatter vocabulary. So there is no event command, no event table and no
// event blob - the note envelope already carries all of it, encrypted, synced,
// backed up and searchable. The backend mints the UUIDv7 identity, which is what
// keeps an event rename-safe and inert to dragging.
//
// **The bytes are built here, not by a second writer.** Every field goes through
// the same surgery the editor uses (`patchTitleField`, `patchFrontmatterField`), so
// a note created by a cell click is byte-identical to one the user typed by hand,
// and the emitted form is the one `@myne/dialect` reads (`formatEventInstant`, a
// single space between date and time).

import { formatEventInstant, type EventInstant } from "@myne/dialect/event";
import { normalizeFolderPath } from "../dialect/folderPath";
import { patchFrontmatterField, patchTitleField } from "../dialect/surgery";
import { noteCreate } from "./createNote";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The folder a new event lands in when the user has not said otherwise.
 *
 * A default LOCATION only: `kind` is an event's identity, never its folder, so an
 * event dragged to `Work/` or filed by an importer stays an event. Creating in it
 * registers the folder as deliberate through `noteCreate`, the daily-notes
 * discipline, so an empty `Calendar/` still shows in the sidebar.
 */
export const DEFAULT_CALENDAR_FOLDER = "Calendar/";

/** What a caller supplies when creating an event. */
export type NewEventInput = {
  readonly title: string;
  readonly start: EventInstant;
  readonly end?: EventInstant | null;
  readonly calendar?: string | null;
  readonly repeat?: string | null;
  /** A relative lead: `30m`, `2h`, `1d`. */
  readonly remind?: string | null;
  readonly folder?: string | null;
};

/**
 * The plaintext a brand-new event is created with. Exported so a test can assert
 * the bytes without an IPC round trip: the shape IS the contract here.
 */
export function buildEventNoteBytes(input: NewEventInput): Uint8Array {
  let bytes = patchTitleField(encoder.encode(""), input.title);
  bytes = patchFrontmatterField(bytes, "kind", "event");
  bytes = patchFrontmatterField(bytes, "start", formatEventInstant(input.start));
  if (input.end !== undefined && input.end !== null) {
    bytes = patchFrontmatterField(bytes, "end", formatEventInstant(input.end));
  }
  if (input.calendar !== undefined && input.calendar !== null && input.calendar !== "") {
    bytes = patchFrontmatterField(bytes, "calendar", input.calendar);
  }
  if (input.repeat !== undefined && input.repeat !== null && input.repeat !== "") {
    bytes = patchFrontmatterField(bytes, "repeat", input.repeat);
  }
  if (input.remind !== undefined && input.remind !== null && input.remind !== "") {
    bytes = patchFrontmatterField(bytes, "remind", input.remind);
  }
  return bytes;
}

/**
 * Create an event note and return its `NoteId`.
 *
 * `folder` defaults to {@link DEFAULT_CALENDAR_FOLDER}; pass `null` for the vault
 * root, which is what an importer or a drag already did.
 */
export async function createEvent(input: NewEventInput): Promise<string> {
  const folder = normalizeFolderPath(
    input.folder === undefined ? DEFAULT_CALENDAR_FOLDER : input.folder,
  );
  let bytes = buildEventNoteBytes(input);
  // `folder:` through the same seam, never by string concatenation: the create
  // path and the move path must produce the same bytes for the same note.
  if (folder !== null) bytes = patchFrontmatterField(bytes, "folder", folder);
  return await noteCreate(decoder.decode(bytes), folder);
}
