// Shared render-dispatch guard (drawing-notes SF2, MYND-499; SYNC-2): does a note
// body carry the value-strict `kind: drawing` frontmatter marker? Both clients —
// desktop `PaneView`, mobile `EditorFlow` — route a drawing body to the Excalidraw
// canvas instead of CodeMirror. Uses the canonical dialect frontmatter locator so
// the dispatch can never diverge from loadNoteBatch / the readers.
import { readKindFromFmBody } from "@myne/dialect";
import { locateFrontmatter } from "@myne/dialect/lezer/frontmatter";

/** True iff `body`'s frontmatter carries the exact `kind: drawing` marker. */
export function isDrawingBody(body: string): boolean {
  const fm = locateFrontmatter(body);
  return (
    fm !== null &&
    readKindFromFmBody(body.slice(fm.bodyStart, fm.bodyEnd)) === "drawing"
  );
}
