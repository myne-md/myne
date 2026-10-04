// The step every out-of-band frontmatter write owes before it touches disk
// (myne-md/myne#520).
//
// A frontmatter write of this class is read-patch-write against DISK on a note
// that may be OPEN and dirty in a pane. The pane's autosave is a second writer
// of the same bytes, and the settle step that re-reads the note into the pane
// returns early whenever that pane still has pending work, precisely so it
// cannot clobber unsaved typing. So without this, the two writers race, and
// both losers are silent:
//
//   - the pending autosave lands AFTER the field write and puts the pre-write
//     text back, reverting the field;
//   - or it lands between the field write's read and its write, and the field
//     write goes on top of bytes the user has since typed.
//
// The command palette makes that window routine rather than exotic: type,
// Cmd+K, Enter, all inside one autosave debounce.
//
// # Why it lives INSIDE each writer rather than in a caller-side wrapper
//
// Because a wrapper is opt-in, and the first version of this fix proved it: it
// guarded the cover write from the editor screen and left
// `PaneView`'s saved-view "Set cover" calling `setNoteCover` bare, on a note
// that is by definition not the one the user is looking at and so is the MOST
// likely to be open and dirty in another pane. Caller three would have
// inherited the same gap. Here, skipping it is not something a caller can do.
//
// Cheap on the common path: `flushAll` runs the per-pane flushers under
// `Promise.all` and each returns synchronously when its pane is clean, so a
// write with no dirty pane pays one resolved promise.
//
// # The rejection is real, and it was not
//
// `flushAll` used to swallow every per-flusher rejection, and `useAutosave`'s
// `fireSave` swallows one of its own into that pane's `saveStatus`. Two layers
// of swallow meant this function could not fail, so the "abort rather than
// clobber" contract below was a sentence about nothing and the test that
// asserted it injected a rejection production could never produce. Each pane's
// flusher now answers whether it SETTLED (`!lastSaveFailed()` after the flush,
// which is not the same as `!hasPendingWork()`, and the comment at that call
// site in `PaneView.tsx` says why the second one is wrong), and `flushAll`
// rejects when any of them did not. The case that reaches it is
// the one that matters most: a pane whose save is already failing, where
// reading the stale disk bytes and writing a field on top of them is exactly
// the clobber.

// # Which writers call this, and which deliberately do not
//
// Callers today: `setNoteCover.ts`, both converts in `templates.ts`, and the
// trash/restore/delete writers `trashNote.ts` + `deleteNote.ts`
// (myne-md/myne#819). `folderActions.ts` and `renameInbound.ts` call
// `renameFlushHooks().flushOpenPanes()` directly, because they flush once for a
// BATCH rather than per note.
//
// The SEVEN that remain and do NOT flush are the read-patch-write writers whose
// losing direction was accepted as out of scope: `archiveNote` (and its
// unarchive twin), `moveNote`, `folderNote`, `renameNote`, `completeNote` and
// `lib/writing-assistant.ts`. Every one of them is reachable from the sidebar
// context menu or the palette while the same note is open and dirty, so the
// race is not hypothetical there either. They are not simply wired up here,
// because doing so is a BEHAVIOUR change per writer rather than a missing line:
// this function REJECTS on an unsettled pane, and a caller that inherits that
// rejection turns the action into one that can fail while a save is failing
// somewhere else. Each needs its own answer.
//
// `trashNote`/`restoreNote`/`deleteNoteRouted` were the two whose answer was
// never in doubt and are now wired here. Their losing direction is not a
// reverted field but a resurrected note: a pane still holding the pre-trash (or
// pre-delete) buffer autosaves `trashed:`/`deleted:` back off, the note returns
// from the trash, and it stays editable (myne-md/myne#819). Recorded here
// rather than left implicit, so the next reader finds the roster instead of
// concluding the class is closed.

import { renameFlushHooks } from "./renameFlushHook";

/**
 * Persist every dirty pane editor before an out-of-band frontmatter write.
 *
 * Rejects if the flush does. That is deliberate: the flush exists to make the
 * disk match the buffer, and writing anyway is exactly the clobber it prevents,
 * so the caller must not carry on.
 */
export async function flushBeforeFrontmatterWrite(): Promise<void> {
  await renameFlushHooks().flushOpenPanes();
}
