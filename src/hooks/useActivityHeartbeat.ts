// `useActivityHeartbeat` — window-level user-activity heartbeat for the
// backend auto-lock-on-idle timer (MYND-121).
//
// While mounted (i.e. while the vault is Unlocked and the Editor is on
// screen), it reports real DOM input activity to the backend so the
// window-level idle clock (`VaultRuntimeState::last_activity`) stays fresh.
// The backend timer uses machine-level OS idle when available and this
// window-level signal only as the Wayland / unsupported-platform fallback.
//
// Tracked activity events: `mousemove`, `keydown`, `focus`, and
// `visibilitychange` → visible. Going-away signals (`blur`,
// `visibilitychange` → hidden) deliberately fire NO heartbeat — the backend's
// window-level idle then grows from the last real activity (fail-closed). The
// heartbeat is driven by EXPLICIT DOM events, not by inferring idle from the
// WebView throttling its `setTimeout`s (which is implementation-defined across
// WKWebView / WebView2 / WebKitGTK).
//
// Leading-throttled to at most one IPC per `HEARTBEAT_THROTTLE_MS`: the first
// activity after a quiet period reports immediately (resetting the backend
// idle promptly), and a continuous burst coalesces to one IPC every interval.
// The heartbeat is best-effort — transport failures are swallowed; the backend
// idle timer is the authoritative, fail-closed clock.

import { useEffect, useRef } from "react";
import { reportUserActivity } from "../lib/vault-unlock";

/** Min interval between heartbeat IPCs. Coalesces activity bursts. */
const HEARTBEAT_THROTTLE_MS = 5_000;

export function useActivityHeartbeat(): void {
  const lastSentRef = useRef(0);

  useEffect(() => {
    const beat = () => {
      const now = Date.now();
      if (now - lastSentRef.current < HEARTBEAT_THROTTLE_MS) return;
      lastSentRef.current = now;
      void reportUserActivity().catch(() => {
        // Best-effort: the backend idle timer is the authoritative
        // fail-closed clock; a missed heartbeat just lets idle grow.
      });
    };

    const onVisibility = () => {
      // Only "became visible" counts as activity; hidden = going away
      // (silence → backend idle grows).
      if (document.visibilityState === "visible") beat();
    };

    window.addEventListener("mousemove", beat, { passive: true });
    window.addEventListener("keydown", beat, { passive: true });
    window.addEventListener("focus", beat);
    document.addEventListener("visibilitychange", onVisibility);

    // Fire once on mount so an unlock immediately registers as activity
    // (the freshest possible baseline for the new session's idle window).
    beat();

    return () => {
      window.removeEventListener("mousemove", beat);
      window.removeEventListener("keydown", beat);
      window.removeEventListener("focus", beat);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
