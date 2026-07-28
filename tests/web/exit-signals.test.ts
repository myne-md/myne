// @vitest-environment jsdom
//
// The web graceful-exit seam (phase3-web-client task 93).
//
// The desktop close-intercept prevents the window close, awaits the flush chain
// and only then destroys — and its own catch block turns that into a no-op in a
// browser, so every tab close dropped the newest edit. This is the browser's
// equivalent, and the two properties that make it correct rather than merely
// present are both asserted here:
//
//  * `hidden` flushes CONTENT but must not be treated as a quit — a tab switch
//    happens dozens of times an hour, and `vault.workspace`'s mtime is a
//    lock/quit signal by `protocol.md` §9.7.4.
//  * `beforeunload` warns and never flushes: it cannot await, so a flush started
//    there is a flush killed halfway through.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onExitIntent, setUnsavedGuard } from "../../web/src/platform/exit-signals";

function hide() {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}
function show() {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  // Release every reason — the module state is page-wide, so one test's held
  // guard would otherwise arm the next one's `beforeunload`.
  setUnsavedGuard("flushing", false);
  setUnsavedGuard("credential-push-pending", false);
  show();
});

describe("exit intents", () => {
  it("reports a page-hide as a CLOSE", () => {
    const seen: string[] = [];
    const off = onExitIntent((k) => {
      seen.push(k);
    });
    dispatchEvent(new Event("pagehide"));
    expect(seen).toEqual(["closing"]);
    off();
  });

  it("reports a tab switch as HIDING, not closing", () => {
    // The distinction the workspace blob depends on: a `hidden` transition is
    // not a quit, and writing `vault.workspace` on one would make its mtime a
    // log of when the user was reading.
    const seen: string[] = [];
    const off = onExitIntent((k) => {
      seen.push(k);
    });
    hide();
    expect(seen).toEqual(["hiding"]);
    off();
  });

  it("says nothing when the tab comes BACK", () => {
    const handler = vi.fn();
    const off = onExitIntent(handler);
    hide();
    handler.mockClear();
    show();
    expect(handler).not.toHaveBeenCalled();
    off();
  });

  it("detaches both listeners on unsubscribe", () => {
    const handler = vi.fn();
    onExitIntent(handler)();
    dispatchEvent(new Event("pagehide"));
    hide();
    expect(handler).not.toHaveBeenCalled();
  });

  it("awaits an async handler's start — the flush begins at the last moment", async () => {
    let started = false;
    const off = onExitIntent(async () => {
      started = true;
      await Promise.resolve();
    });
    dispatchEvent(new Event("pagehide"));
    expect(started).toBe(true);
    off();
  });
});

describe("the unsaved guard", () => {
  function fireBeforeUnload(): boolean {
    const e = new Event("beforeunload", { cancelable: true });
    dispatchEvent(e);
    return e.defaultPrevented;
  }

  it("does not warn when nothing is outstanding", () => {
    setUnsavedGuard("flushing", true); // install the listener…
    setUnsavedGuard("flushing", false); // …then release the reason
    expect(fireBeforeUnload()).toBe(false);
  });

  it("warns while a flush is outstanding", () => {
    setUnsavedGuard("flushing", true);
    expect(fireBeforeUnload()).toBe(true);
    setUnsavedGuard("flushing", false);
  });

  it("stops warning once the flush settles", () => {
    setUnsavedGuard("flushing", true);
    setUnsavedGuard("flushing", false);
    expect(fireBeforeUnload()).toBe(false);
  });

  // The reason the guard is keyed rather than a boolean (task 88). The two
  // holders have wildly different lifetimes: a flush clears in milliseconds,
  // while a credential push waiting on a server can be pending for the whole
  // session. Under a bare boolean the flush's release disarms the credential
  // guard, and the user closes the tab with no prompt on the one condition
  // where losing this browser's copy loses the change outright.
  it("keeps warning when one reason releases and another is still held", () => {
    setUnsavedGuard("credential-push-pending", true);
    setUnsavedGuard("flushing", true);
    setUnsavedGuard("flushing", false); // the short-lived holder finishes
    expect(fireBeforeUnload()).toBe(true);
    setUnsavedGuard("credential-push-pending", false);
    expect(fireBeforeUnload()).toBe(false);
  });

  // `setUnsavedGuard` is called from a React effect, which can legitimately
  // re-run with the same value. A counter would drift; a set does not.
  it("is idempotent in both directions", () => {
    setUnsavedGuard("credential-push-pending", true);
    setUnsavedGuard("credential-push-pending", true);
    setUnsavedGuard("credential-push-pending", false);
    expect(fireBeforeUnload()).toBe(false);
    setUnsavedGuard("credential-push-pending", false); // release with none held
    expect(fireBeforeUnload()).toBe(false);
  });
});
