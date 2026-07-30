// Web seam — `window` (phase3-web-client task 25).
//
// Tauri's `getCurrentWindow()` is an OS window handle. A page has no such
// thing — it has a *tab*, which it does not own and cannot destroy. Each member
// below is therefore either a real browser equivalent or an explicit refusal,
// never a plausible-looking stub.

import { unsupported } from "../../../src/platform/unsupported";
import { listen } from "./event";

export function getCurrentWindow(): {
  destroy: () => Promise<void>;
  isFullscreen: () => Promise<boolean>;
  show: () => Promise<void>;
  listen: (name: string, handler: (e: unknown) => void) => Promise<() => void>;
} {
  return {
    /**
     * **Refused.** `window.close()` only works for a window the script itself
     * opened; for a normal tab the browser ignores it silently.
     *
     * Silent-ignore is the worst available behaviour here, because the desktop
     * caller is the fail-closed error screen's "close the app" affordance
     * (`src/lib/app-window.ts`): a button that appears to work and does nothing
     * is worse than an absent one. The typed refusal is what lets task 27 omit
     * the affordance instead.
     */
    destroy: async () => unsupported("window.destroy"),

    /**
     * A real equivalent: the Fullscreen API reports whether *this document* is
     * fullscreen. Not identical to an OS window being fullscreen — a maximised
     * browser showing a non-fullscreen page answers `false` — but it is the
     * question the caller is actually asking (is chrome hidden from the user).
     */
    isFullscreen: async () => document.fullscreenElement !== null,

    /**
     * **Refused.** The desktop counterpart reveals a window that idle auto-lock
     * hid with `orderOut:` (MYND-121/MYND-628, `src/hooks/useRevealAfterIdleLock.ts`).
     * A page has no hidden window to reveal: web auto-lock zeroizes and re-renders
     * the locked surface in the same tab, which was never taken away.
     *
     * The refusal is typed rather than a no-op `async () => {}` on purpose. A
     * silent success would claim the reveal happened, and the one caller treats
     * a throw as "not inside Tauri, nothing actionable" — which is exactly the
     * right outcome here — so the refusal reads correctly at the call site while
     * a stub would make a future second caller believe it worked.
     */
    show: async () => unsupported("window.show"),

    /**
     * Window-scoped events route through the same Worker event bus as
     * everything else. Tauri distinguishes app-global from window-scoped
     * listeners; a page has exactly one window, so the distinction collapses
     * and there is nothing to lose by collapsing it.
     */
    listen: async (name: string, handler: (e: unknown) => void) =>
      await listen(name, handler as never),
  };
}
