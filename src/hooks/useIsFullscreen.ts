// Tracks the Tauri window's fullscreen state. Used to drop the macOS
// traffic-light left inset when fullscreen (the traffic lights are hidden then,
// so the sidebar toggle can sit flush-left). Feature-detects the Tauri window
// API so it degrades to `false` outside a Tauri context (plain web / tests).

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function useIsFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    try {
      const win = getCurrentWindow();
      const refresh = (): void => {
        void win
          .isFullscreen()
          .then((fs) => {
            if (!cancelled) setFullscreen(fs);
          })
          .catch(() => {});
      };
      refresh();
      // Entering/leaving fullscreen fires a resize; re-check on each.
      void win
        .onResized(refresh)
        .then((u) => {
          if (cancelled) u();
          else unlisten = u;
        })
        .catch(() => {});
    } catch {
      /* not in a Tauri window (web / test) — stay `false` */
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return fullscreen;
}
