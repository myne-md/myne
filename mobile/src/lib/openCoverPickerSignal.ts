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
// NAMES and on the DETAIL SHAPE, which is why they are spelled identically and
// both say so.

export const OPEN_COVER_PICKER_EVENT = "myne-open-cover-picker";

/** What the banner tells the flow about the note it belongs to.
 *
 *  `hasCover` is what the editor knows and the flow does not: it has just
 *  resolved the field. Decides whether the sheet offers Remove.
 *
 *  `noteId` names the note the clicked banner is drawing (myne-md/myne#520).
 *  Mobile shows one note at a time, so it cannot hit the split defect that
 *  motivated the field; it carries it because the seam is shared and a host
 *  that dropped the argument would leave the editor package's contract half
 *  implemented. `null` means the editor was mounted without an identity, and
 *  the flow falls back to the open note. */
export type OpenCoverPickerDetail = {
  readonly hasCover: boolean;
  readonly noteId: string | null;
};

/** Remove is its own signal: clearing a cover is a one-click intent, and routing
 *  it through the sheet would make the banner's two controls do the same thing. */
export const REMOVE_COVER_EVENT = "myne-remove-cover";

/** Remove's payload: same targeting rule as {@link OpenCoverPickerDetail}. A
 *  listener must treat a MISSING detail as `{ noteId: null }` rather than
 *  assuming one is present. */
export type RemoveCoverDetail = { readonly noteId: string | null };
