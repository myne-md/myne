// Platform seam — the moments before this client stops being able to write
// (phase3-web-client task 93).
//
// # What the desktop already has, and what web lost
//
// `Editor.tsx` registers a Tauri close-intercept: it prevents the default
// close, awaits the flush chain (note content → workspace descriptor → vault
// indices → graph layout) and only then destroys the window. Its catch block
// says "not running inside Tauri → close-intercept is a no-op", which is true
// and, on the web client, means **every tab close silently drops the newest
// edit** — on the one client where an unsynced edit is all that stands between
// the user and real loss.
//
// # Two kinds of exit, because they are not the same event
//
// A browser has no single "quitting" callback, and the two it does have differ
// in a way that matters here:
//
// * `pagehide` — the page is going away. This is the analogue of a window
//   close: flush everything.
// * `visibilitychange` → `hidden` — the user switched tabs or apps. The page is
//   still alive and may come back in a second. Flushing NOTE CONTENT here is
//   right (a tab can be discarded from this state without another event), but
//   writing `vault.workspace` is NOT: `protocol.md` §9.7.4 keeps that blob's
//   mtime a lock/quit signal, and a tab switch happens dozens of times an hour.
//
// So the handler receives which kind it is and decides. Collapsing them would
// either lose content or turn the workspace blob's mtime into an
// editor-activity log — the exact leak the graceful-exit-only rule forecloses.
//
// # `beforeunload` is a WARNING, never the flush point
//
// It cannot await. A handler that starts an async flush there is a handler that
// gets killed halfway through, which is worse than not starting: a torn write
// with no warning. Its only job here is to set `returnValue` while a flush is
// outstanding, so the browser shows its own "leave site?" prompt and the user
// decides.
//
// # Desktop is a deliberate no-op
//
// Not because a window has no exit, but because it already has one that works,
// with E2E coverage this task must not disturb. The desktop path stays exactly
// where it is; this seam is what gives the browser the same guarantee, and the
// two are wired independently rather than one being rebuilt on the other's
// account.

/** Which exit is happening. See the header: they are not interchangeable. */
export type ExitKind =
  /** The page/window is going away. Flush everything. */
  | "closing"
  /** The page is hidden but alive. Flush CONTENT only — never `vault.workspace`. */
  | "hiding";

/**
 * Subscribe to this platform's pre-exit moments. Returns an unsubscribe.
 *
 * `handler` may be async; a host that can wait, waits. `null` on desktop, and
 * that IS the desktop implementation — see the header.
 */
export function onExitIntent(handler: (kind: ExitKind) => Promise<void> | void): () => void {
  void handler;
  return () => {};
}

/**
 * Why the exit guard is held. Each holder arms and disarms independently.
 *
 * **The key is what makes more than one holder possible at all.** A bare
 * boolean is last-writer-wins, so the moment there are two reasons the shorter
 * one silently disarms the longer: the flush below finishes in milliseconds and
 * clears the flag in its `finally`, while a credential push waiting on a server
 * can be pending for the whole session. The user would then close the tab with
 * no prompt, on the one condition where the prompt matters most.
 */
export type UnsavedReason =
  /** A flush is in flight right now (milliseconds). */
  | "flushing"
  /**
   * A password change this device made has not been acknowledged by the server
   * (task 88). Can outlive many flushes. Losing this browser's copy while it is
   * held loses the change: every other device still expects the old password,
   * and on web there is no recovery phrase to fall back to.
   */
  | "credential-push-pending";

/**
 * Tell the platform whether unsaved work is outstanding, per `reason`.
 *
 * The prompt is armed while **any** reason is held. On web this arms the
 * `beforeunload` prompt, which is the only honest thing a page can do about
 * work it may not get to finish. No-op on desktop, where the close-intercept
 * can simply wait.
 */
export function setUnsavedGuard(reason: UnsavedReason, active: boolean): void {
  void reason;
  void active;
}
