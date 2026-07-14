// The hardened Excalidraw canvas shell (drawing-notes SF1/SF2, MYND-498/499).
//
// SF1 delivered the empty hardened shell; SF2 wires it to a note: it loads the
// scene JSON from the note body (`initialSceneJson`) and re-serializes on change
// (`onSceneChange`) so the host (PaneView) can splice it back via `writeSceneJson`
// and let the existing autosave debounce persist it. Egress is stripped by
// HARDENED_EXCALIDRAW_PROPS (SYNC-5) + the self-hosted asset path.
//
// This module is the lazy chunk — importing it pulls in Excalidraw (+ roughjs),
// so it is only ever reached via the `React.lazy` boundary in
// `./DrawingCanvasLazy`. PaneView keys the mount by note id, so switching to a
// different drawing remounts with the new scene (initialData is read once at
// mount); a same-note out-of-band reload (sync-pull) still wants a live check.
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useRef, type ComponentProps, type CSSProperties } from "react";
import { HARDENED_EXCALIDRAW_PROPS } from "./excalidrawConfig";

type InitialData = ComponentProps<typeof Excalidraw>["initialData"];

const WRAP_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  minHeight: 0,
};

export type DrawingCanvasProps = {
  /** Scene JSON (the ```excalidraw fence contents) loaded as the canvas's
   *  initial data. Undefined / malformed → an empty canvas (never throws). */
  initialSceneJson?: string;
  /** Called with the re-serialized scene JSON whenever the canvas changes; the
   *  host splices it into the note body and autosave (debounced) persists it. */
  onSceneChange?: (sceneJson: string) => void;
};

function parseInitialData(json: string | undefined): InitialData {
  if (json === undefined) return undefined;
  try {
    const scene = JSON.parse(json) as Record<string, unknown>;
    // Single boundary cast: the parsed scene carries Excalidraw's own precise
    // element/appState/file types that we can't reconstruct structurally here.
    return {
      elements: scene.elements ?? [],
      appState: scene.appState ?? {},
      files: scene.files ?? {},
    } as unknown as InitialData;
  } catch {
    // A malformed scene must never crash the render — fall back to empty.
    return undefined;
  }
}

export default function DrawingCanvas({
  initialSceneJson,
  onSceneChange,
}: DrawingCanvasProps) {
  // Excalidraw fires onChange once on mount with the initial scene — skip that
  // no-op fire so merely OPENING a drawing doesn't dirty the buffer + autosave a
  // normalized-but-unedited scene. (Deeper viewport-vs-content gating is a
  // live-tuning follow-up, per the review.)
  const primed = useRef(false);
  return (
    <div style={WRAP_STYLE} data-testid="drawing.canvas">
      <Excalidraw
        {...HARDENED_EXCALIDRAW_PROPS}
        initialData={parseInitialData(initialSceneJson)}
        onChange={
          onSceneChange
            ? (elements, appState, files) => {
                if (!primed.current) {
                  primed.current = true;
                  return;
                }
                onSceneChange(serializeAsJSON(elements, appState, files, "local"));
              }
            : undefined
        }
      />
    </div>
  );
}
