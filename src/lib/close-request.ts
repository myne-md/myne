// SPDX-License-Identifier: AGPL-3.0
// ONE owner for the window's close request (myne-md/myne#945 item 05).
//
// # The bug this exists to close
//
// The owner clicked the title bar's red dot on the quick-unlock (PIN) screen and
// the window did not move at all. The mechanism is in Tauri, not in this app:
// `manager/window.rs` calls `api.prevent_close()` as soon as ANY JS listener
// exists for `tauri://close-requested`, and the JS side is then the ONLY thing
// that can finish the close by calling `destroy()`. So a listener that outlives
// the screen that registered it does not merely receive an event nobody wants:
// it takes the native close button away from every screen that comes after it,
// and only a listener of its own can give it back. Three screens each registered
// their own (`Editor`, `PlainFileScreen`, `CreateVault`), each with a comment
// explaining the asynchronous-registration leak it had already been fixed for,
// and the class kept producing new instances of itself: the quick-unlock screen
// registers none, so it has no way to complete a close that some earlier screen
// started.
//
// # Why one owner, rather than a better guard on three listeners
//
// A per-screen listener makes the app's closability depend on a mount/unmount
// race in every screen that wants to flush something, and the failure mode of
// losing that race is invisible: the app looks alive and ignores the close
// button. The interceptor here is installed ONCE, from `App`, and never
// uninstalled, so it cannot leak and cannot be missing. Screens contribute a
// GUARD, a function that flushes what it owns and answers "close" or "keep the
// window open", and unmounting a screen unregisters its guard, which is a Set
// deletion rather than a listener teardown.
//
// # The deadline warns, it does not destroy
//
// A guard's flush can hang: the vault can already be locked by the time a close
// arrives (the lock task may hold a lock on the very blob the flush writes), and
// an awaited IPC that never answers would strand the close with
// `preventDefault()` already called and `destroy()` never reached: the exact
// symptom this file exists to fix, one layer down.
//
// So each guard runs against a deadline, and the first version of this file
// DESTROYED the window when one missed it. That was wrong (myne-md/myne#945
// review, D8): the guards are not all layout. `Editor`'s flush writes note
// bodies, and `PlainFileScreen`'s protects a tab holding the only copy of text
// that never landed, so a kill switch here traded "the user cannot close the
// window" for "the paragraph the user wrote was never written" and called the
// second one cheap. The layout is rebuildable and the paragraph is not, which is
// the whole difference.
//
// The deadline is a WATCHDOG now: it logs, it says the app is still saving, and
// it keeps waiting. Closability comes from a second close request rather than
// from a timer. Pressing close again while the guards are still running is the
// user saying they have waited long enough, and it destroys the window
// immediately (`inFlight` below). Two presses, no wedge, and no timer deciding on
// its own to drop content.
//
// # What this deliberately does not do
//
// It does not ask the guards to agree. The FIRST guard that answers "keep it
// open" wins and the rest are not consulted, because a refusal comes from a
// pending user decision (an unsaved conflicted tab, a confirmation prompt the
// user declined) and no other screen's flush can overrule it.

import { getCurrentWebviewWindow } from "../platform/webviewWindow";

/**
 * What a screen contributes to the close path.
 *
 * `onCloseRequest` returns `true` to let the close proceed and `false` to keep
 * the window open, typically because it asked the user and they said no. It may
 * be synchronous; a screen with nothing to ask answers `true` directly.
 */
export interface CloseGuard {
  /** Stable name, used for diagnostics and de-duplication on re-register. */
  id: string;
  onCloseRequest: () => Promise<boolean> | boolean;
}

/**
 * How long one guard gets before the watchdog reports that it is still running.
 *
 * A report, not a kill: the guard keeps running and the close keeps waiting (see
 * "The deadline warns" above). Ten seconds is longer than any flush this app
 * performs and shorter than a user will wait before concluding the button is
 * broken.
 */
export const CLOSE_GUARD_DEADLINE_MS = 10_000;

/** The subset of the webview-window handle the close path uses. Structural
 *  rather than imported, because the web seam deliberately has neither member:
 *  a browser tab has no close request to intercept and no window to destroy. */
type CloseCapableWindow = {
  onCloseRequested?: (cb: (event: { preventDefault: () => void }) => void) => Promise<() => void>;
  destroy?: () => Promise<void>;
};

const guards = new Map<string, CloseGuard>();
let installed = false;
/** True from the moment a close request starts asking the guards until the window
 *  is destroyed or a guard refuses. A second request arriving inside that window
 *  is the user's force (see "The deadline warns" above). */
let inFlight = false;

/**
 * Register a guard for the close path. Returns its unregister function, which
 * the registering `useEffect` must call on unmount.
 */
export function registerCloseGuard(guard: CloseGuard): () => void {
  guards.set(guard.id, guard);
  return () => {
    // Only if it is still OURS: a screen that re-registers under the same id
    // (React's strict-mode double mount, a changed dependency) must not be
    // unregistered by the effect that the new registration replaced.
    if (guards.get(guard.id) === guard) guards.delete(guard.id);
  };
}

/** The registered guard ids, in registration order. Test/diagnostic surface. */
export function closeGuardIds(): string[] {
  return [...guards.keys()];
}

/** Run one guard under the watchdog. A throw answers `true`: a guard that cannot
 *  answer cannot veto. A guard that misses the deadline is NOT dropped; the
 *  watchdog says so once and the close keeps waiting for the real answer, because
 *  dropping it here is how a note body that was mid-flush never reached disk. */
async function ask(guard: CloseGuard): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => {
      console.warn(
        `[close-request] guard "${guard.id}" is still running after ${CLOSE_GUARD_DEADLINE_MS}ms; still waiting (press close again to force)`,
      );
    }, CLOSE_GUARD_DEADLINE_MS);
    return await guard.onCloseRequest();
  } catch (e) {
    // Not dev-gated: a guard that throws is a wiring defect in a screen, and the
    // close it silently stopped vetoing leaves no trace in a release build
    // otherwise (myne-md/myne#945 review).
    console.warn(`[close-request] guard "${guard.id}" rejected; closing without it`, e);
    return true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Destroy the window, or say why it cannot be destroyed. The capability check
 *  is reported rather than swallowed: on a host that grants no `destroy`, a
 *  resolved handler would leave a window that never goes away. */
async function finishClose(w: CloseCapableWindow): Promise<void> {
  if (typeof w.destroy !== "function") {
    console.warn(
      "[close-request] this host has no window.destroy(); the close guard finished but the window stays open",
    );
    return;
  }
  try {
    await w.destroy();
  } catch (e) {
    // The OS refused to destroy the window. The user can still close it from the
    // title bar, which re-enters this handler.
    console.warn("[close-request] destroy() rejected:", e);
  }
}

/** Ask every guard, most recently registered first, stopping at the first
 *  refusal. Module-private: the interceptor is its only caller, and the unit test
 *  reaches it through the interceptor rather than around it. */
async function runCloseGuards(): Promise<boolean> {
  const snapshot = [...guards.values()].reverse();
  for (const guard of snapshot) {
    if (!(await ask(guard))) return false;
  }
  return true;
}

/**
 * Install the app's single `tauri://close-requested` handler. Idempotent, called
 * from `App`'s mount effect and never torn down: a listener that lives exactly
 * as long as the process cannot outlive its screen.
 *
 * Outside Tauri (the web client, `pnpm dev` in a browser) the handle has no
 * `onCloseRequested`, and this returns without doing anything: a browser tab's
 * close is the browser's business.
 */
export function installCloseInterceptor(): void {
  if (installed) return;
  installed = true;
  // The handle itself throws when the Tauri runtime is not there at all (jsdom,
  // and a plain `pnpm dev` in a browser), so it is resolved inside the try
  // rather than before it: a boot effect may not throw on a host that has no
  // window to intercept. The globals are deliberately not named here -
  // `scripts/check-platform-seam.mjs` scans for them as a bypass and does not
  // read comments.
  let w: CloseCapableWindow;
  try {
    w = getCurrentWebviewWindow() as unknown as CloseCapableWindow;
  } catch {
    // No Tauri runtime to resolve a window from. That is the web client and a
    // plain `pnpm dev` in a browser, where a tab's close is the browser's
    // business, so this is the expected arm rather than a fault to report.
    installed = false;
    return;
  }
  if (typeof w.onCloseRequested !== "function") {
    // Disarm the idempotence gate on the way out: this host cannot intercept a
    // close YET, and a handle that gains the member later (a capability that
    // arrives with the runtime, a test that swaps the stub) must be able to
    // install. Leaving `installed` true here made one early call permanent and
    // silent, which is the failure this file exists to remove.
    installed = false;
    return;
  }
  try {
    void w
      .onCloseRequested(async (event) => {
        // Taken up front, exactly as the three per-screen handlers did: with a
        // listener present Tauri has already cancelled the native close, so the
        // ONLY path to a closed window is the `destroy()` below.
        event.preventDefault();
        // A SECOND close request while the guards are still running is the escape
        // hatch: the user has asked twice, so the window goes even with a flush
        // still in flight. This is what replaced the timer that used to drop a
        // hung guard on its own (see "The deadline warns" above).
        if (inFlight) {
          console.warn(
            "[close-request] close requested again while a guard is still running; closing now",
          );
          await finishClose(w);
          return;
        }
        inFlight = true;
        try {
          if (!(await runCloseGuards())) return;
          // `destroy` rather than `close` is load-bearing: the ACL grants
          // `core:window:allow-destroy` and deliberately not `allow-close`, so a
          // handler reaching for `close()` leaves the window unclosable.
          await finishClose(w);
        } finally {
          inFlight = false;
        }
      })
      .catch((e: unknown) => {
        // Registration failed. Nothing to restore: without a listener Tauri's
        // native close works, which is the pre-#945 behaviour for every screen
        // that never registered one. Reported unconditionally so a release build
        // whose close interception silently never attached is diagnosable.
        installed = false;
        console.warn("[close-request] listener registration failed:", e);
      });
  } catch (e) {
    // `onCloseRequested` itself threw, which is a real host defect rather than an
    // absent runtime: the handle resolved but refused to register.
    installed = false;
    console.warn("[close-request] close intercept registration threw:", e);
  }
}
