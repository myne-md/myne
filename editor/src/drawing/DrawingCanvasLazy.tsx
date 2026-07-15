// Lazy boundary for the Excalidraw canvas (drawing-notes SF1, MYND-498).
//
// Keeps the Excalidraw + roughjs chunk OUT of the cold bundle — a session that
// never opens a drawing pays zero bytes (the GraphView `React.lazy` precedent,
// src/notes/components/GraphView.tsx). Downstream surfaces render
// `<DrawingCanvasLazy/>`, never the raw `./DrawingCanvas` default export, so the
// dynamic `import()` is the only entry into the Excalidraw chunk.
import { lazy, Suspense, type CSSProperties } from "react";
import type { DrawingCanvasProps } from "./DrawingCanvas";

const DrawingCanvas = lazy(() => import("./DrawingCanvas"));

const FALLBACK_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  height: "100%",
  minHeight: 0,
};

export function DrawingCanvasLazy(props: DrawingCanvasProps) {
  return (
    <Suspense
      fallback={
        <div style={FALLBACK_STYLE} data-testid="drawing.canvas-loading" aria-busy="true" />
      }
    >
      <DrawingCanvas {...props} />
    </Suspense>
  );
}
