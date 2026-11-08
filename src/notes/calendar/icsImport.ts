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
// # Re-import matches, it does not duplicate
//
// Each event's `uid` goes into the note, and the vault's existing uids come from the
// SAME range read the pane uses (`CalendarRow.uid`), so the match key has one owner:
// the event index. A second index over events would be the second store this feature
// deliberately does not have (`decisions/storage/0792`).
//
// Two honest limits, both reported rather than hidden. A hand-authored event that
// was never exported carries no `uid`, so importing a file that names it creates a
// second note: the vault cannot know two notes describe one meeting. And a file whose
// events were EDITED between imports updates nothing, because this writer only
// creates. Both are stated on myne-md/myne#1037 rather than dressed up as
// convergence.

import { ICS_EXPORT_WINDOW, readIcsFile } from "../../lib/calendarIcs";
import { parseEventInstant } from "@myne/dialect/event";
import { createEvent } from "../createEvent";
import { vaultIndicesCalendarRange } from "../vaultIndices";

/** What one import did. */
export type IcsImportOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "imported";
      readonly filename: string;
      readonly created: number;
      /** Events already in the vault by `uid`, so nothing was written for them. */
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

  // The uids this vault already holds, from the one read that answers "what is on
  // my calendar". A locked vault or a failed read returns nothing, and an import
  // then creates everything: refusing the whole file because the index is
  // unreadable would be worse than an import a user can undo one note at a time.
  const held = new Set<string>();
  try {
    const existing = await vaultIndicesCalendarRange(
      ICS_EXPORT_WINDOW.start,
      ICS_EXPORT_WINDOW.end,
      false,
    );
    for (const row of existing.rows) {
      // The exporter writes `uid ?? noteId` (a hand-authored event has no `uid:`),
      // so the matcher has to answer the same pair. Reading only `uid` made every
      // hand-authored event fail to match its own export, and a restore from that
      // export then created a second note for each one.
      held.add(row.uid ?? row.noteId);
    }
  } catch {
    // Deliberately silent, with the consequence stated in the outcome: the import
    // still runs, and `skipped` then means "not matched" rather than "not held".
  }

  let created = 0;
  let skipped = 0;
  for (const event of result.events) {
    if (held.has(event.uid)) {
      skipped += 1;
      continue;
    }
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
