// The window-event transport behind `EditorHost.cover` (myne-md/myne#410).
//
// The banner's hover controls and the frontmatter panel's "Add cover" live in
// this package, in CodeMirror DOM, with no route into the React tree that owns
// the modal or sheet mounts and knows which note is open. So the widget calls
// the host seam, and every host so far implements that seam by dispatching a
// window event its own shell listens for, exactly as `closeActiveTabSignal`
// does for vim `:q`.
//
// # Why the transport lives HERE and not in each client
//
// It did live in each client, spelled identically, in `src/notes/` and
// `mobile/src/lib/`, and both files said so. The justification was that mobile
// aliases `@myne/*` source packages rather than `src/notes/`, and a constant
// this small was not worth a new alias.
//
// That stopped being true. Both trees already alias `@myne/editor`, both
// `editor-host.ts` files import from it, and #520 then had to add `noteId` to
// two detail types in two files for one feature. The shape crosses a
// `CustomEvent`, so TypeScript checks nothing about the hop: a host that
// dispatched the old shape and a shell that read the new one would compile
// cleanly on both sides and simply target the wrong note. One declaration, next
// to the seam members it mirrors, is the only thing that makes the two halves
// checkable at all.

/** The signal behind `EditorHost.cover.openPicker`. */
export const OPEN_COVER_PICKER_EVENT = "myne-open-cover-picker";

/** What the banner tells the shell about the note it belongs to.
 *
 *  `hasCover` is the thing the shell cannot work out for itself: the editor has
 *  just resolved the field, and a shell's note cache carries no cover state. It
 *  decides whether the picker offers its own Remove.
 *
 *  `noteId` is the note the CLICKED banner is drawing, which is not necessarily
 *  the focused one. It used to be absent, on the reasoning that the shell is the
 *  only place that can decide what "focused" means with two panes open. The
 *  shell is, and it decided wrongly (myne-md/myne#520): the banner's controls
 *  `preventDefault` on `mousedown`, so pressing one in an unfocused pane never
 *  focuses that pane and the passive effect that syncs the selected note has not
 *  run either.
 *
 *  `null` means the editor was mounted without an identity (`noteIdFacet`), and
 *  the shell falls back to the focused note, which is the pre-#520 behaviour and
 *  still the right answer for the command palette. A single-pane client (mobile)
 *  cannot hit the split defect and carries the field anyway, because a host that
 *  dropped the argument would leave this contract half implemented. */
export type OpenCoverPickerDetail = {
  readonly hasCover: boolean;
  readonly noteId: string | null;
};

/** The signal behind `EditorHost.cover.remove`.
 *
 *  Its own signal rather than a trip through the picker: clearing a cover is a
 *  one-click intent, and routing it through a modal the user then has to act
 *  inside would make the banner's two controls do the same thing. */
export const REMOVE_COVER_EVENT = "myne-remove-cover";

/** Remove's payload: the same targeting rule as {@link OpenCoverPickerDetail},
 *  and it carries a detail at all only because of #520. A listener must treat a
 *  MISSING detail as `{ noteId: null }` rather than assuming one is present: the
 *  event is dispatched by whichever host build is loaded, and a bare
 *  `new CustomEvent(REMOVE_COVER_EVENT)` still means "the focused note". */
export type RemoveCoverDetail = { readonly noteId: string | null };
