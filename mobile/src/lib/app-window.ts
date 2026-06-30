// Tauri window helpers — narrow surface for app-level lifecycle.
//
// `closeApp()` is the canonical "Uygulamayı kapat" CTA handler used by
// fail-closed error UIs (corrupted vault.meta, IO error, etc.). Calls
// `destroy()` rather than `close()`:
//   - `core:window:allow-destroy` is already declared in
//     `src-tauri/capabilities/default.json` (allow-close is NOT — adding
//     it widens the WebView attack surface against TB6 for an affordance
//     we don't need).
//   - `destroy()` is non-cancellable: no close-requested event fires,
//     so a forgotten / stale `onCloseRequested` listener cannot
//     `preventDefault()` and silently swallow the user's exit intent.
//     Fail-closed semantics is "only-exit"; cancellation = failure.
//   - There is no in-progress work to flush at fail-closed call sites:
//     corrupted vault.meta + IO-error states have no decrypted blobs
//     in memory; invalid-state path runs `vault_lock` upstream of
//     `closeApp` (Editor mount guard + FailClosedError onCtaClick).
//
// Web-mode (no Tauri runtime) fallback: console.warn + noop. Pure
// browser dev (e.g. `pnpm dev` outside `pnpm tauri dev`) cannot close
// the host window — the user closes the browser tab manually. Phase 1
// is desktop-only so this is a developer-experience nicety only.

import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * `true` when running inside `pnpm tauri dev` / production bundle (the
 * Tauri runtime injects `window.__TAURI_INTERNALS__`); `false` under
 * pure-browser dev (e.g. `pnpm dev` without `tauri dev`). Module-load
 * constant — cheaper than per-call check.
 */
export const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Destroy the host app window.
 *
 * Used by fail-closed error CTAs (`<FailClosedError reason="corrupted-vault" />`,
 * `<FailClosedError reason="io-error" />`) when the user cannot recover
 * in-session and must restart manually. Per `app-state-machine` PRD Q8(a):
 * destructive recovery is NOT offered, so the only legitimate exit is
 * to close the app and restore a backup vault.meta out-of-band.
 *
 * Errors during destroy are swallowed — if the OS refuses to terminate
 * the window (extremely rare), the user can still close via the title
 * bar's native close button. Dev-mode surfaces the rejection to console
 * so the path isn't silently ignored.
 */
export async function closeApp(): Promise<void> {
  if (!HAS_TAURI) {
    // Web dev mode — no host window to close. Surface to the dev
    // console so the call isn't silently ignored without trace.
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn("[app-window] closeApp() called outside Tauri context — no-op in web dev");
    }
    return;
  }
  try {
    await getCurrentWindow().destroy();
  } catch (e) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn("[app-window] closeApp() destroy() rejected:", e);
    }
  }
}
