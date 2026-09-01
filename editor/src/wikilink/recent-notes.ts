// The notes the reader has touched most recently, newest first, as the `[[`
// picker's tiebreak (myne-md/myne#601).
//
// A vault of any size has many notes whose titles fuzzy-match two or three
// letters equally well, and the one being linked to is almost always one that
// was just open: the note being written about, the note it was copied from, the
// one the last link went to. Score alone cannot know that, so it offers them in
// an order that has nothing to do with the writer's session, and with an EMPTY
// query it has nothing to go on at all: the picker opens on `[[` before a
// single character is typed, which is exactly the moment the answer is most
// predictable.
//
// # A source, not a snapshot, and that is the whole shape of this file
//
// The neighbouring facets here (`note-set`, `vault-headings`,
// `vault-block-anchors`) hold VALUES behind a `Compartment`, because their
// contents change for reasons the editor cannot see and the host has to push
// each new one in. This one holds a FUNCTION the host installs once at mount.
//
// The difference is that the recency order has a single module-level owner on
// the host side, and the only reader is the picker, which reads it at the
// moment it opens. Pushing snapshots meant a `Compartment.reconfigure`, a full
// re-resolve of the editor's whole extension tree, on every note activation,
// per mounted pane, to deliver a fifty-element array that nothing looks at until
// somebody types `[[`. Worse, it made the value per pane: only the pane whose
// own active note changed pushed a new snapshot, so every OTHER open pane ranked
// its picker off the order from the last time that pane switched notes. A source
// has one value by construction.

import { Facet, type EditorState, type Extension } from "@codemirror/state";

/** Answers "which notes were touched most recently, newest first" at the moment
 *  it is called. The host owns the order; the editor only asks. */
export type RecentNotesSource = () => readonly string[];

const NONE: RecentNotesSource = () => [];

/** Combine takes the most-recently provided source, so a host that installs one
 *  wins over the empty default composed into `myneExtensions()`. */
const recentNotesFacet = Facet.define<RecentNotesSource, RecentNotesSource>({
  combine: (inputs) => (inputs.length > 0 ? inputs[inputs.length - 1]! : NONE),
});

/** Compose into `myneExtensions()`. With no source the picker ranks on score
 *  alone, exactly as it did before this existed, which is also what a host that
 *  tracks no recency gets. */
export function recentNotesExtension(source: RecentNotesSource = NONE): Extension {
  return recentNotesFacet.of(source);
}

/** Read the current recency order from a plugin (`view.state`). Calls the host's
 *  source, so the answer is current as of this call rather than as of the last
 *  time anything was pushed in. */
export function readRecentNotes(state: EditorState): readonly string[] {
  return state.facet(recentNotesFacet)();
}
