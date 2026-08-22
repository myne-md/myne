// Which note this editor view is holding (myne-md/myne#520).
//
// The editor package is note-agnostic almost everywhere, and that is the right
// default: a document is a document. Two widgets genuinely need the identity,
// though, and its absence was a bug rather than a purity win.
//
// The cover banner draws Change / Remove, and the promoted title row draws Add
// cover; all three ask the host to act. The host used to resolve the target
// itself, on the documented reasoning that "the host is also the only thing that
// knows which note the focused pane holds". That reasoning has a hole in a
// split: every one of those controls calls `preventDefault` on `mousedown`, so
// pressing one in an UNFOCUSED pane never focuses it, and the shell's idea of
// the selected note is still the other pane's. The other pane's note lost its
// cover, silently, while the one the user clicked kept its own.
//
// So the control says which note it belongs to, and the host acts on that.
// `null` means "the host did not say", which every consumer treats as "fall back
// to the focused note". That is the old behaviour, preserved for a host that has
// not been updated and for the command palette, which genuinely does mean "the
// focused one".
//
// A facet rather than a prop threaded through the widget tree because CM6
// widgets receive an `EditorView` and nothing else, and a Compartment around it
// because the desktop shell keeps ONE long-lived view per pane and swaps
// documents through it. Same five-part shape as `wikilink/note-set.ts`: facet,
// compartment, seed, read, reconfigure, all in one module.
//
// `readNoteId` is how the widgets read it, and it must be called at ACTIVATION
// time rather than at `toDOM` time: a widget's DOM outlives a note swap whenever
// its `eq()` compares equal, so a value captured in the closure could name the
// previous note.

import {
  Compartment,
  type EditorState,
  Facet,
  type Extension,
  type StateEffect,
} from "@codemirror/state";

/**
 * The note id this view holds, or `null` when the host has not said.
 *
 * Last value wins, matching every other scalar facet here: the compartment
 * carries exactly one, and a host that supplies none gets the default.
 */
export const noteIdFacet = Facet.define<string | null, string | null>({
  combine: (values) => (values.length > 0 ? values[values.length - 1]! : null),
});

const noteIdCompartment = new Compartment();

/** Compose into `myneExtensions()`, or into a bare `EditorState` a caller
 *  builds itself. A state that installs the raw facet instead silently ignores
 *  every later `reconfigureNoteId`, which is the one way this can be wired so
 *  that it type-checks and does nothing. */
export function noteIdExtension(noteId: string | null = null): Extension {
  return noteIdCompartment.of(noteIdFacet.of(noteId));
}

/** Read the note this view holds, from a widget's `view.state`. */
export function readNoteId(state: EditorState): string | null {
  return state.facet(noteIdFacet);
}

/** The effect the host dispatches when the pane swaps to another note. */
export function reconfigureNoteId(noteId: string | null): StateEffect<unknown> {
  return noteIdCompartment.reconfigure(noteIdFacet.of(noteId));
}
