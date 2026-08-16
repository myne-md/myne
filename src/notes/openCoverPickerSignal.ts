// Cross-provider seam for the note cover's picker (myne-md/myne#410).
//
// The banner's hover controls live inside the shared editor package, in
// CodeMirror DOM, with no route into the React tree that owns the modal mounts
// or the pane that knows which note is focused. Rather than thread a callback
// through every layer, the host emits this window event and the editor shell
// listens, exactly like `closeActiveTabSignal` does for vim `:q`.
//
// Deliberately a bare signal with no payload: "pick a cover for whatever is
// focused". The shell decides what that is, which is also the only place that
// can decide it correctly when two panes are open.

export const OPEN_COVER_PICKER_EVENT = "myne-open-cover-picker";

/** The one thing the shell cannot work out for itself: whether the note already
 *  has a cover. The editor has just resolved it; the shell's note cache carries
 *  no cover state. It decides whether the picker offers its own Remove. */
export type OpenCoverPickerDetail = { readonly hasCover: boolean };

/** Remove is a separate signal rather than a trip through the picker: clearing
 *  a cover is a one-click intent, and routing it through a modal the user then
 *  has to act inside would make the banner's two controls do the same thing. */
export const REMOVE_COVER_EVENT = "myne-remove-cover";
