// Web seam — the moments before a tab stops being able to write
// (phase3-web-client task 93).
//
// See `src/platform/exit-signals.ts` for why the two kinds are distinct and why
// `beforeunload` is a warning rather than the flush point. This file is the part
// that has to be right about browser lifecycle, and the two facts it is built on
// are:
//
// * **A hidden tab can be discarded without another event.** So `hidden` must
//   flush content, not merely mark it dirty. It must NOT write the workspace
//   blob — a tab switch is not a quit (`protocol.md` §9.7.4).
// * **`pagehide` is the last reliable moment**, and it is not guaranteed to be
//   followed by anything. `unload` is unreliable-to-absent in modern browsers
//   and is what the Page Lifecycle guidance replaces with these two.
//
// The handler is invoked and awaited on a best-effort basis: the browser may
// kill the page mid-flush and nothing here can prevent that. What this seam
// guarantees is that the flush STARTS at the last moment it can, rather than
// never starting — which is what the desktop close-intercept's absence left the
// web client with.

import type { ExitKind, UnsavedReason } from "../../../src/platform/exit-signals";

export type { ExitKind, UnsavedReason };

/**
 * The reasons currently held. A SET rather than a counter or a boolean:
 *
 * * a boolean is last-writer-wins, and the two holders have wildly different
 *   lifetimes — a flush clears in milliseconds and would disarm a
 *   credential-push guard that has been held for the whole session;
 * * a counter would drift on a double-arm, and `setUnsavedGuard` is called from
 *   an effect that React can legitimately re-run.
 *
 * A set is idempotent in both directions, which is what an effect-driven caller
 * needs.
 */
const held = new Set<UnsavedReason>();

/**
 * One `beforeunload` listener for the page, installed lazily.
 *
 * Registered once rather than per subscriber: a `beforeunload` handler's mere
 * presence disables the browser's back/forward cache in some engines, so this
 * one exists only while something has actually asked for the guard.
 */
let beforeUnloadInstalled = false;
function ensureBeforeUnload(): void {
  if (beforeUnloadInstalled) return;
  beforeUnloadInstalled = true;
  addEventListener("beforeunload", (e) => {
    if (held.size === 0) return;
    // The modern shape: `preventDefault()` plus a legacy `returnValue`. The
    // STRING is ignored by every current browser — they show their own copy —
    // so nothing user-facing is being written here.
    e.preventDefault();
    e.returnValue = "";
  });
}

export function onExitIntent(handler: (kind: ExitKind) => Promise<void> | void): () => void {
  const onPageHide = () => {
    void handler("closing");
  };
  const onVisibility = () => {
    // `hidden` only. The `visible` transition is a return, not an exit, and
    // flushing on it would double every write.
    if (document.visibilityState === "hidden") void handler("hiding");
  };
  addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

export function setUnsavedGuard(reason: UnsavedReason, active: boolean): void {
  if (active) {
    held.add(reason);
    ensureBeforeUnload();
  } else {
    held.delete(reason);
  }
}
