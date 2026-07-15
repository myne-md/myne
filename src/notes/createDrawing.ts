// Drawing-note creation — a TS orchestrator over the existing note IPC
// (drawing-notes SF2, MYND-499).
//
// Per SYNC-1/SYNC-8 a drawing is just a `.myn` note carrying `kind: drawing` +
// an Excalidraw scene serialized into a ```excalidraw fenced body, so creation
// is a TS orchestrator over `note_create` — **no new backend command, no new
// capability-ACL entry**, exactly like `createTemplate`. The backend mints the
// UUIDv7 identity (never UI-supplied), so the drawing is rename-safe.
//
// Unlike root markdown notes (which send empty plaintext and let autosave inject
// FM per "İlk save inject etmez"), a drawing MUST carry `kind: drawing` from
// creation so the very first open routes to the canvas surface, not CodeMirror.

import {
  patchKindField,
  patchTitleField,
  patchFolderField,
  DRAWING_KIND_VALUE,
} from "../dialect";
import { normalizeFolderPath } from "../dialect/folderPath";
import { noteCreate } from "./createNote";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The initial empty Excalidraw scene serialized into the ```excalidraw fenced
 * body a drawing note carries (SYNC-8). Minimal + deserializable by Excalidraw's
 * `restore()`; the live canvas overwrites it on first autosave. Pure — exported
 * for round-trip testing.
 */
export function buildInitialDrawingBody(): string {
  const scene = {
    type: "excalidraw",
    version: 2,
    source: "myne",
    elements: [],
    appState: {},
    files: {},
  };
  return "```excalidraw\n" + JSON.stringify(scene) + "\n```\n";
}

/**
 * Build the full drawing-note plaintext bytes — `kind: drawing` (+ optional
 * `title:`) frontmatter over the initial fenced scene. Pure; `createDrawing`
 * decodes + sends it. Mirrors `createTemplate`'s title-then-flag patch order.
 */
export function buildDrawingNoteBytes(
  name?: string,
  folder?: string | null,
): Uint8Array {
  let bytes: Uint8Array = encoder.encode(buildInitialDrawingBody());
  if (name !== undefined && name.length > 0) {
    bytes = patchTitleField(bytes, name);
  }
  bytes = patchKindField(bytes, DRAWING_KIND_VALUE);
  // Foldered create (a2 timing, mirrors `createNote`): write `folder:` FM at
  // create so the drawing lands under its folder before the first edit. A root
  // drawing (folder omitted / null / empty) carries no `folder:` field.
  const normFolder = normalizeFolderPath(folder ?? null);
  if (normFolder !== null) {
    bytes = patchFolderField(bytes, normFolder);
  }
  return bytes;
}

/**
 * Mint a brand-new drawing note through the existing `note_create` IPC. Optional
 * `name` writes `title:`; omitted → the new-drawing entry point drops into inline
 * rename (empty-title UX, grill Q3). Returns the new `NoteId`. Rejects with
 * whatever `note_create` propagates.
 */
export async function createDrawing(
  name?: string,
  folder?: string | null,
): Promise<string> {
  return await noteCreate(decoder.decode(buildDrawingNoteBytes(name, folder)));
}
