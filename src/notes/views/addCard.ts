// Adding a card to a board lane: a create plus one field write (myne-md/myne#922
// task 6).
//
// # Two host-owned writes, in this order
//
// 1. **Create.** `note_create`, exactly as "+ New Note" uses it. With a
//    `template` declared on the view the new note's BODY is the template's body;
//    without one it is the vault's default new note. The template's FRONTMATTER
//    is never copied: its properties are the template's own state (its `folder:`,
//    its `status:`, its `template: true` flag), and importing them would silently
//    hand the new card settings the user did not ask for. A new card starts with
//    a title field and nothing else.
// 2. **Place.** The lane value goes through the SAME host-owned field command a
//    drag and a table edit use. There is no second way to write a property, so
//    the authority checks (approval, declared field, reserved marker, value
//    precondition) run once, in the host, for this path too.
//
// # Why the affordance is only offered where the field is declared
//
// A board whose `write_fields` does not include its `group_by` cannot place a
// card. Creating a note and then failing to put it in a lane leaves a stray note
// and a card that never appears, so the button is NOT RENDERED rather than
// rendered disabled: an offer the host is required to refuse is not an
// affordance, it is a trap.
//
// # The card appears only once the write has landed
//
// There is nothing optimistic here, and that is deliberate. The board's rows come
// from the query engine, which re-runs when the index moves; the field write
// re-indexes the note, so the card arrives with the truth behind it. Inventing a
// row first would need a title, a lane and a set of column values the note does
// not have yet.

import { locateFrontmatter } from "@myne/dialect/lezer/frontmatter";
import type { NoteSetFieldError } from "../../types/note-set-field-error";
import { initialNotePlaintext, noteCreate } from "../createNote";
import { noteRead } from "../readNote";
import { setNoteField } from "../setNoteField";
import { asRefusal } from "./boardDrag";

/** Everything one add-card gesture asks for. */
export interface AddCardRequest {
  /** The view performing the write; it supplies both permissions. */
  readonly viewId: string;
  /** The view's `group_by` key: the field the lanes are. */
  readonly laneField: string;
  /** The lane value to place the new card in. `""` is the no-value lane. */
  readonly lane: string;
  /** The note whose body the card copies, when the view declares one. */
  readonly template?: string;
}

export interface AddCardResult {
  /** The note that was created. It exists even when the placement refused. */
  readonly noteId: string;
  /** The pre-write snapshot id of the placement, when the host captured one. */
  readonly snapshotId: string | null;
  /** `null` when the card was placed; the host's reason when it was not. */
  readonly refusal: NoteSetFieldError | null;
}

/**
 * The body of a note: everything after the closing frontmatter fence. A note
 * with no frontmatter is all body, which is why the `null` case returns the
 * source unchanged rather than an empty string.
 */
export function noteBody(text: string): string {
  const range = locateFrontmatter(text);
  return range === null ? text : text.slice(range.blockEnd);
}

/**
 * The plaintext a new card is created with when it copies a template.
 *
 * The head is the same frontmatter a "+ New Note" produces (`title: ""`), and
 * the body is appended verbatim. State A's frontmatter ends with ONE blank line
 * and a template's body already starts with the newline that followed its own
 * closing fence, so the two are joined without doubling it: the created note's
 * body is then byte-identical to the template's, which is the property the task
 * and its test are about.
 */
export function templateCardPlaintext(templateText: string): string {
  const body = noteBody(templateText);
  const head = initialNotePlaintext(null);
  const joined = head.endsWith("\n\n") ? head.slice(0, -1) : head;
  return `${joined}${body}`;
}

/**
 * Create a note and place it in `lane`.
 *
 * Rejects only when no note could be created (a failed template read or a
 * refused `note_create`): that is the case where nothing happened at all. A
 * refused PLACEMENT resolves with `refusal` set and the note id present, because
 * the note really was created and the reader has to be told both facts.
 */
export async function addCardToLane(
  request: AddCardRequest,
): Promise<AddCardResult> {
  const plaintext =
    request.template === undefined
      ? initialNotePlaintext(null)
      : templateCardPlaintext(await noteRead(request.template));

  const noteId = await noteCreate(plaintext, null);

  try {
    const { snapshotId } = await setNoteField({
      noteId,
      viewId: request.viewId,
      field: request.laneField,
      // A note that has just been created carries no lane value, which is what
      // the value-anchored precondition names as `null`.
      expectedValue: null,
      newValue: request.lane,
    });
    return { noteId, snapshotId, refusal: null };
  } catch (err) {
    return { noteId, snapshotId: null, refusal: asRefusal(err) };
  }
}
