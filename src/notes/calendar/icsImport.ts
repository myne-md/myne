// Import one `.ics` file into the vault as event notes (myne-md/myne#1037).
//
// The reader is `src/lib/calendarIcs.ts` (a picked file, read by the host under a
// cap) and the codec is `@myne/client-core`'s. This module is the part that writes:
// it calls `createEvent` once per event, so an imported note is the same bytes a
// cell click produces. A second writer here would be a second opinion about the
// note's frontmatter, which is the class of defect the whole feature avoided by
// making an event a note in the first place.
//
// # What it reports, and what it deliberately does not claim
//
// It returns the counts and the codec's own refusal, and it never guesses. A
// refusal is the codec's named reason (`start-unreadable`, `no-events`, ...), not
// "something went wrong", because the user's next move differs per reason.
//
// **Re-importing the same file creates the events again.** The importer carries
// each event's `uid` into the note, so the field that makes a match possible is on
// disk, but the vault has no read that answers "which uids do I already hold" yet:
// `CalendarRow` does not carry `uid`, and inventing a second index for it here
// would be the second store this feature refused. The consequence is stated on the
// issue rather than papered over: a repeat import duplicates, and the fix is the
// `uid` on the range row, not a guess in this file.

import { readIcsFile } from "../../lib/calendarIcs";
import { parseEventInstant } from "@myne/dialect/event";
import { createEvent } from "../createEvent";

/** What one import did. */
export type IcsImportOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "imported";
      readonly filename: string;
      readonly created: number;
      /** Events the codec read but this writer could not place. */
      readonly skipped: number;
      readonly warnings: number;
    };

/**
 * Read a picked `.ics` file and create its events.
 *
 * Events land in the calendar's default folder, which is a default LOCATION rather
 * than a property of an event: `kind` is the identity, and an imported event filed
 * elsewhere is still an event.
 */
export async function importIcsIntoVault(): Promise<IcsImportOutcome> {
  const picked = await readIcsFile();
  if (picked === null) return { kind: "cancelled" };
  const { name, result } = picked;
  if (result.kind !== "ok") return { kind: "refused", reason: result.kind };

  let created = 0;
  let skipped = 0;
  for (const event of result.events) {
    const start = parseEventInstant(event.start);
    if (start === null) {
      // The codec already validated the shape, so this is a disagreement between
      // the two readers rather than bad input. Skip the event and say so in the
      // count instead of aborting an import that would otherwise succeed.
      skipped += 1;
      continue;
    }
    const end = event.end === null ? null : parseEventInstant(event.end);
    await createEvent({
      title: event.title,
      start,
      end,
      calendar: event.calendar,
      repeat: event.repeat,
      remind: event.remind,
      uid: event.uid,
      folder: null,
    });
    created += 1;
  }
  return {
    kind: "imported",
    filename: name,
    created,
    skipped,
    warnings: result.warnings.length,
  };
}
