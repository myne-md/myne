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
// flusher now answers whether it SETTLED (`!hasPendingWork()` after the flush),
// and `flushAll` rejects when any of them did not. The case that reaches it is
// the one that matters most: a pane whose save is already failing, where
// reading the stale disk bytes and writing a field on top of them is exactly
// the clobber.

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
