// Pure drawing-note body construction (drawing-notes SF2, MYND-499) — shared by
// both clients' create flows (desktop `createDrawing`, mobile `EditorFlow`).
//
// Per SYNC-1/SYNC-8 a drawing is just a `.myn` note carrying `kind: drawing` +
// an Excalidraw scene serialized into a ```excalidraw fenced body. These builders
// are pure frontmatter surgery (@myne/dialect); the client-specific orchestrators
// decode the bytes and send them through their own `note_create` IPC wrapper.

import {
  patchKindField,
  patchTitleField,
  patchFolderField,
  DRAWING_KIND_VALUE,
} from "@myne/dialect";
import { normalizeFolderPath } from "@myne/dialect/folderPath";

const encoder = new TextEncoder();

/**
 * The initial empty Excalidraw scene serialized into the ```excalidraw fenced
 * body a drawing note carries (SYNC-8). Minimal + deserializable by Excalidraw's
 * `restore()`; the live canvas overwrites it on first save. Pure.
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
 * `title:` / `folder:`) frontmatter over the initial fenced scene. Pure; the
 * caller decodes + sends it. Mirrors `createTemplate`'s title-then-flag order.
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
