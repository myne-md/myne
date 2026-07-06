// WL-5 (wikilink-backlink epic): the single channel that delivers the live
// resident `ResolverNote[]` into CodeMirror view-plugins (the chip's broken-link
// resolution + hover R1, and the `[[` autocomplete picker in feature #3).
//
// `CMEditor` is mounted once, so a plain prop can't reach a ViewPlugin after
// mount. Instead the note-set lives in a `Facet`, provided through a
// `Compartment` so the host can `reconfigure` it (re-mount-free) whenever the
// note-set changes — driven by `useResolverNotes()`, which re-derives on the
// SYNC-5 index nonce (WL-6). Every wikilink view-plugin reads the facet; nobody
// invents a second note-set-injection mechanism.

import {
  Compartment,
  Facet,
  type EditorState,
  type Extension,
  type StateEffect,
} from "@codemirror/state";
import type { ResolverNote } from "@myne/editor/host/notes/resolveWikilink";

/** The live resolver note-set, as seen by wikilink view-plugins. Combine takes
 *  the most-recently-provided value (the compartment provides exactly one). */
export const noteSetFacet = Facet.define<
  readonly ResolverNote[],
  readonly ResolverNote[]
>({
  combine: (inputs) => (inputs.length > 0 ? inputs[inputs.length - 1]! : []),
});

const noteSetCompartment = new Compartment();

/** Compose into `myneExtensions()` — seeds the facet with an empty note-set
 *  until the host reconfigures it post-mount. */
export function noteSetExtension(): Extension {
  return noteSetCompartment.of(noteSetFacet.of([]));
}

/** Read the current note-set from a plugin/tooltip (`view.state`). */
export function readNoteSet(state: EditorState): readonly ResolverNote[] {
  return state.facet(noteSetFacet);
}

/** The effect the host dispatches when the note-set changes. */
export function reconfigureNoteSet(
  notes: readonly ResolverNote[],
): StateEffect<unknown> {
  return noteSetCompartment.reconfigure(noteSetFacet.of(notes));
}
