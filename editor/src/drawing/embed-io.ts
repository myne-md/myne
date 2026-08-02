// Inline drawing-embed IO seam (MYND-634 / drawing-inline-embed).
//
// The `editor/` package renders the inline `![[drawing]]` embed (thumbnail ↔
// live canvas), but it CANNOT reach note read/create/save IPC — that lives in
// the `src/` tree. So the host (desktop `PaneView`) injects the note-CRUD
// callbacks the embed needs through a Facet, the same remount-free channel the
// resolver note-set uses (`wikilink/note-set.ts`) — carrying functions instead
// of data. A host that does not set it (mobile today, an incapable platform)
// leaves the embed inert rather than adding a mandatory cross-host seam member.
//
// This keeps ALL note-CRUD on the src side (`noteRead` / `saveNote` /
// `createDrawing`, discipline-enforced there) while the editor package stays IO-
// free — mirroring how attachments cross the seam, but without a new
// `EditorHost` interface member (and thus no mobile-parity obligation).

import {
  Compartment,
  Facet,
  type EditorState,
  type Extension,
  type StateEffect,
} from "@codemirror/state";

/** The note-CRUD callbacks the inline drawing embed calls. Supplied by the host
 *  (desktop `PaneView`), which closes each over the current note's context.
 *
 *  Two host shapes: a host with `saveScene` (desktop) edits the drawing INLINE
 *  (thumbnail ↔ live canvas); a host with `openNote` (mobile) instead opens the
 *  drawing full-screen on tap and never mounts the cramped inline canvas. Only
 *  `readScene` (thumbnail) + `createSibling` (`/drawing`) are always required. */
export interface DrawingEmbedIo {
  /** Read a drawing note's scene JSON (the ```excalidraw fence body) by note id.
   *  Resolves `null` when the note is missing or carries no scene. */
  readScene: (noteId: string) => Promise<string | null>;
  /** Create a new sibling drawing note in the HOST note's folder and resolve to
   *  its title — the token the `/drawing` slash command embeds as `![[title]]`. */
  createSibling: () => Promise<string>;
  /** Persist an edited scene back into the drawing note (frontmatter + trailing
   *  attachment-ref block preserved; `updated:` stamped). Present → the embed is
   *  editable INLINE (desktop). Absent → the embed is view-only inline (mobile
   *  edits full-screen via `openNote`). */
  saveScene?: (noteId: string, sceneJson: string) => Promise<void>;
  /** Rename a drawing note from the inline header. Present → the header title is
   *  an editable field; the host MUST route through a rename that rewrites every
   *  `![[oldTitle]]` embed to `![[newTitle]]` (else the reference is orphaned).
   *  Absent → the header title is static (a host with no ref-rewriting rename,
   *  e.g. mobile, omits it rather than break the embed). */
  renameDrawing?: (noteId: string, newTitle: string) => Promise<void>;
  /** Open the drawing note full-screen (its own tab/screen). Present → tapping
   *  the embed opens it there instead of the inline canvas, and the embed stays a
   *  thumbnail (the right shape for a phone — the inline 420px canvas is cramped
   *  and stacks chrome). Desktop omits it (inline edit). */
  openNote?: (noteId: string) => void;
}

/** The live drawing-embed IO, or `null` on a host that does not provide it. The
 *  compartment provides exactly one, so combine takes the most recent. */
export const drawingEmbedIoFacet = Facet.define<
  DrawingEmbedIo | null,
  DrawingEmbedIo | null
>({
  combine: (inputs) => (inputs.length > 0 ? inputs[inputs.length - 1]! : null),
});

const drawingEmbedIoCompartment = new Compartment();

/** Compose into `myneExtensions()` — seeds the facet with `null` until the host
 *  reconfigures it post-mount. */
export function drawingEmbedIoExtension(): Extension {
  return drawingEmbedIoCompartment.of(drawingEmbedIoFacet.of(null));
}

/** Read the current IO seam from a widget/plugin (`view.state`). */
export function readDrawingEmbedIo(state: EditorState): DrawingEmbedIo | null {
  return state.facet(drawingEmbedIoFacet);
}

/** The effect the host dispatches when the IO seam changes (note switch → a new
 *  closure capturing the new note's folder for `createSibling`). */
export function reconfigureDrawingEmbedIo(
  io: DrawingEmbedIo | null,
): StateEffect<unknown> {
  return drawingEmbedIoCompartment.reconfigure(drawingEmbedIoFacet.of(io));
}
