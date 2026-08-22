// Cross-provider seam for the note cover's picker (myne-md/myne#410).
//
// The banner's hover controls live inside the shared editor package, in
// CodeMirror DOM, with no route into the React tree that owns the modal mounts
// or the pane that knows which note is focused. Rather than thread a callback
// through every layer, the host emits this window event and the editor shell
// listens, exactly like `closeActiveTabSignal` does for vim `:q`.
//
// It used to be a bare signal meaning "pick a cover for whatever is focused",
// on the reasoning that the shell is the only place that can decide what that
// is when two panes are open. The shell is, and it decided wrongly
// (myne-md/myne#520): the banner's controls `preventDefault` on `mousedown`, so
// pressing one in an unfocused pane never focuses that pane, and the passive
// effect that syncs the selected note has not run either. Both signals now name
// their target and the shell obeys it.

export const OPEN_COVER_PICKER_EVENT = "myne-open-cover-picker";

/** What the banner tells the shell about the note it belongs to.
 *
 *  `hasCover` is the thing the shell cannot work out for itself: the editor has
 *  just resolved the field, and the shell's note cache carries no cover state.
 *  It decides whether the picker offers its own Remove.
 *
 *  `noteId` is the note the CLICKED banner is drawing, which is not necessarily
 *  the focused one. `null` means the editor was mounted without an identity
 *  (`noteIdFacet`), and the shell falls back to the focused note, which is the
 *  pre-#520 behaviour and still the right answer for the command palette. */
export type OpenCoverPickerDetail = {
  readonly hasCover: boolean;
  readonly noteId: string | null;
};

/** Remove is a separate signal rather than a trip through the picker: clearing
 *  a cover is a one-click intent, and routing it through a modal the user then
 *  has to act inside would make the banner's two controls do the same thing. */
export const REMOVE_COVER_EVENT = "myne-remove-cover";

/** Remove's payload: the same targeting rule as {@link OpenCoverPickerDetail},
 *  and it carries a detail at all only because of #520. A listener must treat a
 *  MISSING detail as `{ noteId: null }` rather than assuming one is present:
 *  the event is dispatched by whichever host build is loaded, and a bare
 *  `new CustomEvent(REMOVE_COVER_EVENT)` still means "the focused note". */
export type RemoveCoverDetail = { readonly noteId: string | null };
