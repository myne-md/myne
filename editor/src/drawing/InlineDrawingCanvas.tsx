// The live, edit-in-place canvas mounted inside an inline `![[drawing]]` embed
// (MYND-634). It is the SAME hardened `DrawingCanvasLazy` the whole-note drawing
// surface uses (egress-stripped, embeddables rejected, curated chrome — the
// `embed-hardening` guard locks that config), so the inline surface adds no new
// Excalidraw posture. The difference is only WHERE the scene comes from and goes:
// a DIFFERENT note than the host buffer, reached through the injected
// `DrawingEmbedIo` (`readScene` / `saveScene`), never the pane's own autosave.
//
// Read once on mount (keyed by note id by the widget, so a note swap remounts);
// writes are debounced so a burst of strokes is one save, mirroring the whole-
// note canvas's host-driven debounce.

import { useEffect, useRef, useState } from "react";
import { DrawingCanvasLazy } from "./DrawingCanvasLazy";
import type { DrawingEmbedIo } from "./embed-io";

/** Debounce window for persisting inline canvas edits — matches the note
 *  autosave idle window so the two feel identical. */
const SAVE_DEBOUNCE_MS = 1000;

export function InlineDrawingCanvas({
  io,
  noteId,
}: {
  io: DrawingEmbedIo;
  noteId: string;
}) {
  // `undefined` = still loading; `null` = loaded, empty/new scene; string = scene.
  const [scene, setScene] = useState<string | null | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void io
      .readScene(noteId)
      .then((s) => {
        if (!cancelled) setScene(s);
      })
      .catch(() => {
        if (!cancelled) setScene(null);
      });
    return () => {
      cancelled = true;
    };
  }, [io, noteId]);

  // Flush any pending save on unmount (collapse / note switch) so the last edit
  // is never lost to the debounce. `saveScene` is only absent on an open-full-
  // screen host, which never mounts this inline canvas — so the `?.` is a type
  // guard, not a live branch here.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (pendingRef.current !== null) {
        void io.saveScene?.(noteId, pendingRef.current).catch(() => {});
        pendingRef.current = null;
      }
    };
  }, [io, noteId]);

  const onSceneChange = (json: string) => {
    pendingRef.current = json;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const next = pendingRef.current;
      pendingRef.current = null;
      if (next !== null) void io.saveScene?.(noteId, next).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  };

  if (scene === undefined) {
    // Loading — a neutral placeholder, not an empty canvas (which would look like
    // a real, blank drawing the user might start editing before the real one loads).
    return (
      <div
        data-testid="editor.drawing-embed.canvas-loading"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "var(--fg-3)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-sm)",
        }}
      />
    );
  }

  // A height:100% wrapper so the canvas fills the fixed-height embed host — the
  // same shape PaneView gives the whole-note canvas (DrawingCanvas reads its size
  // from its parent).
  return (
    <div style={{ height: "100%", minHeight: 0 }}>
      <DrawingCanvasLazy
        initialSceneJson={scene ?? undefined}
        onSceneChange={onSceneChange}
        // Open centered on the drawing, not at its saved scroll offset (#213).
        fitContentOnMount
      />
    </div>
  );
}
