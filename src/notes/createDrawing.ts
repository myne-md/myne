// Drawing-note creation — a thin desktop orchestrator over the note IPC
// (drawing-notes SF2, MYND-499).
//
// The pure body-builders (`buildInitialDrawingBody` / `buildDrawingNoteBytes`)
// now live in the shared `@myne/editor/drawing` module so both clients' create
// flows reuse them; this file keeps only the desktop `note_create` wiring and
// re-exports the builders so existing importers + tests keep resolving them here.
//
// Per SYNC-1/SYNC-8 a drawing is just a `.myn` note carrying `kind: drawing` +
// an Excalidraw scene in a ```excalidraw fenced body — no new backend command,
// no new capability-ACL entry, exactly like `createTemplate`. The backend mints
// the UUIDv7 identity (never UI-supplied), so the drawing is rename-safe.

import { buildDrawingNoteBytes } from "@myne/editor/drawing";
import { noteCreate } from "./createNote";

export { buildInitialDrawingBody, buildDrawingNoteBytes } from "@myne/editor/drawing";

const decoder = new TextDecoder();

/**
 * Mint a brand-new drawing note through the existing `note_create` IPC. Optional
 * `name` writes `title:`; omitted → the new-drawing entry point drops into inline
 * rename (empty-title UX, grill Q3). `folder` writes `folder:` FM at create.
 * Returns the new `NoteId`. Rejects with whatever `note_create` propagates.
 */
export async function createDrawing(
  name?: string,
  folder?: string | null,
): Promise<string> {
  return await noteCreate(decoder.decode(buildDrawingNoteBytes(name, folder)));
}
