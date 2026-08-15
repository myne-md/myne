// Cross-provider seam for the note cover's picker (mobile) — myne-md/myne#410.
//
// The desktop twin is `src/notes/openCoverPickerSignal.ts` and the reason is
// identical on both clients: the banner's controls live inside the shared
// editor package, in CodeMirror DOM, with no route into the React tree that
// owns the sheet mounts and knows which note is open. The host emits a window
// event and the editor flow listens.
//
// Deliberately a separate module rather than an import from the desktop tree:
// mobile aliases `@myne/*` source packages, not `src/notes/`, and a constant
// this small is not worth a new alias. The two files must agree on the event
// NAMES, which is why they are spelled identically and both say so.

export const OPEN_COVER_PICKER_EVENT = "myne-open-cover-picker";

/** Whether the note already has a cover. The editor knows (it has just resolved
 *  the field); the shell does not. Decides whether the sheet offers Remove. */
export type OpenCoverPickerDetail = { readonly hasCover: boolean };

/** Remove is its own signal: clearing a cover is a one-click intent, and routing
 *  it through the sheet would make the banner's two controls do the same thing. */
export const REMOVE_COVER_EVENT = "myne-remove-cover";
