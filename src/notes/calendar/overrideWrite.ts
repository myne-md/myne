// Retiming one appearance of a series (myne-md/myne#1037, decisions/storage/0796).
//
// "Not 09:00 this Tuesday, 14:00" is one more field on the series note:
// `override: 2026-11-10 14:00`. The day stays, the duration stays, only the wall
// clock moves, and the host applies it when it projects the series into rows
// (`core/src/plugins/vault_indices/calendar.rs`).
//
// The bound is what keeps this from becoming the second record `0792` refuses: an
// entry names a date the rule ALREADY generates and one time. It cannot move an
// occurrence to another day, cannot change its length, and cannot add one, so it has
// nothing to say that could disagree with the series. Those gestures stay refused
// (`occurrence.ts`), and their answer stays a one-off note.
//
// Same IO contract as the drag and skip writers, and the same reason: base-hashed,
// so a raced write is a refusal rather than an overwrite.

import { formatCivilDate, parseCivilDate } from "@myne/dialect/civilDate";
import { parseEventInstant, readEventFromFmBody, setOverride } from "@myne/dialect/event";
import { locateFrontmatter } from "@myne/dialect/lezer/frontmatter";
import { patchFrontmatterField } from "@myne/dialect/surgery";
import { isBaseMismatchError } from "../../types/note-update-error";
import { sha256Hex } from "../baseHash";
import { EventWriteRefused, type EventWriteIo } from "./dragWrite";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Give one appearance of a series a different start time.
 *
 * `time` is `HH:MM` in 24-hour wall clock, the only shape the vocabulary emits. A
 * value that does not parse is refused here rather than written: the host's reader
 * would drop it silently, so the user would see a save that changed nothing.
 */
export async function overrideOccurrence(args: {
  readonly noteId: string;
  /** `YYYY-MM-DD`: the appearance being retimed. */
  readonly occurrenceDate: string;
  /** `HH:MM`: the wall-clock time it should start at instead. */
  readonly time: string;
  readonly io: EventWriteIo;
}): Promise<void> {
  const { noteId, occurrenceDate, time, io } = args;

  const date = parseCivilDate(occurrenceDate);
  const instant = parseEventInstant(`${occurrenceDate} ${time.trim()}`);
  if (date === null || instant === null || instant.time === null) {
    throw new EventWriteRefused("start-missing", noteId);
  }

  await io.flushDirtyPanes?.();

  const source = await io.readNote(noteId);
  const range = locateFrontmatter(source);
  if (range === null) throw new EventWriteRefused("start-missing", noteId);
  const read = readEventFromFmBody(source.slice(range.bodyStart, range.bodyEnd));
  if (read.state !== "ok") throw new EventWriteRefused("start-missing", noteId);

  const next = setOverride(
    read.event.overrides.length === 0
      ? null
      : read.event.overrides
          .map((entry) => `${formatCivilDate(entry.date)} ${entry.time ?? ""}`.trim())
          .join(", "),
    instant,
  );

  const body = decoder.decode(patchFrontmatterField(encoder.encode(source), "override", next));
  try {
    await io.writeNote(noteId, body, await sha256Hex(source));
  } catch (err) {
    if (!isBaseMismatchError(err)) throw err;
    throw new EventWriteRefused("base-mismatch", noteId);
  }
}
