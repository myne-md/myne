// Cancelling one appearance of a series (myne-md/myne#1037, decisions/storage/0795).
//
// A recurring event is ONE note, and a cancelled occurrence is one more field on
// that note: `skip: 2026-11-05, 2026-11-12`. The projection reads the list and
// leaves those dates out of the answer (`core/src/plugins/vault_indices/calendar.rs`),
// so there is nothing to migrate, nothing to keep in step, and nothing that can
// survive the note it belongs to.
//
// What this does NOT do, and `occurrence.ts` still refuses: move one occurrence's
// TIME. A cancellation is the absence of an appearance; a moved appearance would be
// a second record of the same event, which `decisions/storage/0792` refuses. The
// sanctioned answer to "not this Thursday at 11:00" stays a one-off note.
//
// One property differs from the drag writer, and it is the honest version of the
// same idea. A drag compares the note's `start` to the value the row was drawn from,
// because that value is STORED. An occurrence's date is DERIVED from the rule, so
// there is no stored value to compare against; what guards this write is the base
// hash, which turns a raced write into a refusal. A concurrent retime does not make
// the result wrong either: the field is append-only, so a date that the new rule no
// longer generates simply never matches an occurrence.

import { formatCivilDate, parseCivilDate } from "@myne/dialect/civilDate";
import { appendSkipDate, readEventFromFmBody } from "@myne/dialect/event";
import { locateFrontmatter } from "@myne/dialect/lezer/frontmatter";
import { patchFrontmatterField } from "@myne/dialect/surgery";
import { isBaseMismatchError } from "../../types/note-update-error";
import { sha256Hex } from "../baseHash";
import { EventWriteRefused, type EventWriteIo } from "./dragWrite";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Cancel one appearance of a series, by date.
 *
 * A date already in the list is not an error: the answer is the same file the caller
 * already has, and the caller's reload shows the row gone either way.
 */
export async function skipOccurrence(args: {
  readonly noteId: string;
  /** `YYYY-MM-DD`: the appearance the user cancelled. */
  readonly occurrenceDate: string;
  readonly io: EventWriteIo;
}): Promise<void> {
  const { noteId, occurrenceDate, io } = args;

  const date = parseCivilDate(occurrenceDate);
  if (date === null) throw new EventWriteRefused("start-missing", noteId);

  await io.flushDirtyPanes?.();

  const source = await io.readNote(noteId);
  const range = locateFrontmatter(source);
  if (range === null) throw new EventWriteRefused("start-missing", noteId);
  const read = readEventFromFmBody(source.slice(range.bodyStart, range.bodyEnd));
  if (read.state !== "ok") throw new EventWriteRefused("start-missing", noteId);

  const next = appendSkipDate(
    read.event.skip.length === 0 ? null : read.event.skip.map(formatCivilDate).join(", "),
    date,
  );
  if (next === null) return; // already cancelled: the file already says so

  const body = decoder.decode(patchFrontmatterField(encoder.encode(source), "skip", next));
  try {
    await io.writeNote(noteId, body, await sha256Hex(source));
  } catch (err) {
    if (!isBaseMismatchError(err)) throw err;
    throw new EventWriteRefused("base-mismatch", noteId);
  }
}
