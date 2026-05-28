// `renameNote` — frontmatter-`title:` rename action.
//
// Title is a frontmatter-only concern: rename always writes the FM
// `title:` field via `patchTitleField`, which handles all states
// (replace existing `title:`, insert into an existing FM block, or inject
// a fresh FM block when none exists). There is no first-`# H1` fallback —
// the body heading is never used as a title source or write target.
// Supersedes the 2026-05-15 "mirror-existing source-of-truth (β)" tree.
//
// After title surgery, `patchUpdatedField` always refreshes `updated:`
// because rename is a modification.
//
// Caller responsibilities (Q14 / Q21 in the implementation tasks):
// - Trim whitespace from the new title before invocation.
// - Reject empty / whitespace-only titles before invocation (no-op rename).
// - Strip embedded newlines before invocation (surgery defensively
//   strips them too, but the UI is the canonical sanitizer).

import { patchTitleField, patchUpdatedField } from "../dialect";
import { noteUpdate } from "./updateNote";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Rename a note by writing the new title to the frontmatter `title:`
 * field. Composes `patchUpdatedField` after the title surgery (rename is
 * a modification → `updated:` must advance).
 *
 * Rejects with whatever `noteUpdate` propagates (typically a
 * `NoteUpdateError` shape on IPC failure).
 */
export async function renameNote(
  noteId: string,
  currentBytes: string,
  newTitle: string,
): Promise<void> {
  const input = encoder.encode(currentBytes);
  const renamed = patchTitleField(input, newTitle);
  const stamped = patchUpdatedField(renamed, new Date().toISOString());
  await noteUpdate(noteId, decoder.decode(stamped));
}
