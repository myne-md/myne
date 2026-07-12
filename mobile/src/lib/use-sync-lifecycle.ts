// `useSyncLifecycle` — report WebView visibility to the shared sync scheduler
// (SYNC-37/38): `hidden` → `sync_lifecycle_suspend` hard-idles the foreground
// loop while the app is backgrounded; `visible` → `sync_lifecycle_resume`
// clears the flag and arms the one-shot immediate poll, so returning to the
// app pulls fresh state without waiting out the poll interval. On iOS
// WKWebView `visibilitychange → hidden` fires before JS suspension, so the
// suspend invoke lands before the freeze.
//
// Fire-and-forget: a failed invoke (gallery preview, plain-browser dev) is
// ignored — the loop then just keeps its steady-state polling behaviour. The
// native grace-window flush (iOS `beginBackgroundTask`) stays the deferred
// MYND-460 F4 cluster; this hook is the no-native-code visibility subset.

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export function useSyncLifecycle(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const report = () => {
      void invoke(
        document.visibilityState === "hidden"
          ? "plugin:sync|sync_lifecycle_suspend"
          : "plugin:sync|sync_lifecycle_resume",
      ).catch(() => {});
    };
    document.addEventListener("visibilitychange", report);
    // Align the scheduler with the CURRENT state on mount — a WebView reload
    // that happens while backgrounded must not leave the loop un-suspended.
    report();
    return () => document.removeEventListener("visibilitychange", report);
  }, [enabled]);
}
