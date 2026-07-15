// Public surface of the shared drawing module (`@myne/editor/drawing`), consumed
// by the desktop PaneView and the mobile EditorFlow. Excalidraw stays behind the
// `DrawingCanvasLazy` React.lazy boundary, so importing this barrel pulls ZERO
// excalidraw into the cold bundle — the heavy chunk loads on first drawing open.
//
// renderScene / attRefs / excalidrawConfig / excalidraw-asset-path are NOT
// re-exported here: renderScene statically imports @excalidraw, so those stay
// direct subpath imports (`@myne/editor/drawing/<name>`) for the few export /
// thumbnail / boot-side-effect callers that opt in.
export { DrawingCanvasLazy } from "./DrawingCanvasLazy";
export type { DrawingCanvasProps } from "./DrawingCanvas";
export {
  extractSceneJson,
  writeSceneJson,
  withPersistedTheme,
} from "./sceneContent";
export { isDrawingBody } from "./isDrawing";
export { buildInitialDrawingBody, buildDrawingNoteBytes } from "./drawingNote";
