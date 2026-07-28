// @vitest-environment jsdom
//
// Failures that never reach React (phase3-web-client task 114).
//
// `RootErrorBoundary` catches render exceptions — one of three ways this client
// breaks. A rejected seam call, a Worker error or a throw in an event handler
// reaches nothing but the console, and on the web client that is the whole
// observable surface for those: a page that stopped working, with no code and no
// devtools panel its user can read back to a maintainer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GLOBAL_FAILURE_CODES,
  installGlobalFailureHandlers,
  lastGlobalFailure,
  onGlobalFailure,
  reportGlobalFailure,
  resetGlobalFailureForTest,
} from "../../src/lib/global-failure";

beforeEach(() => resetGlobalFailureForTest());
afterEach(() => resetGlobalFailureForTest());

describe("global failure channel", () => {
  it("records a bounded code and notifies subscribers", () => {
    const seen: string[] = [];
    onGlobalFailure((c) => seen.push(c));
    reportGlobalFailure("worker-fatal");
    expect(seen).toEqual(["worker-fatal"]);
    expect(lastGlobalFailure()).toBe("worker-fatal");
  });

  it("carries codes from a closed set, never a message", () => {
    // The property, stated at the type level and pinned here: everything that
    // travels is one of a handful of labels. `window.onerror` hands over
    // arbitrary text from arbitrary code — on this client it can quote a path, a
    // note title or a credential in scope.
    for (const code of GLOBAL_FAILURE_CODES) {
      expect(code).toMatch(/^[a-z-]+$/);
    }
    expect(GLOBAL_FAILURE_CODES.length).toBeLessThan(10);
  });

  it("a throwing subscriber does not stop the others or re-enter", () => {
    // A listener that threw would otherwise trigger `window.onerror`, which
    // would report another failure, which would call the listener again.
    const good = vi.fn();
    onGlobalFailure(() => {
      throw new Error("bad listener");
    });
    onGlobalFailure(good);
    expect(() => reportGlobalFailure("uncaught-error")).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("catches an uncaught error and an unhandled rejection from the window", () => {
    const target = window;
    installGlobalFailureHandlers(target);
    target.dispatchEvent(new Event("error"));
    expect(lastGlobalFailure()).toBe("uncaught-error");
    resetGlobalFailureForTest();
    target.dispatchEvent(new Event("unhandledrejection"));
    expect(lastGlobalFailure()).toBe("unhandled-rejection");
  });

  it("installs exactly once, so a hot reload cannot double-register", () => {
    const target = window;
    const spy = vi.spyOn(target, "addEventListener");
    installGlobalFailureHandlers(target);
    const after = spy.mock.calls.length;
    installGlobalFailureHandlers(target);
    expect(spy.mock.calls.length).toBe(after);
    spy.mockRestore();
  });

  it("does not render, navigate or swallow — it only records", () => {
    // The decision to SHOW a failure belongs to the screen, which knows what the
    // user is in the middle of. A global handler that force-navigated on the
    // first stray rejection would throw away work over a failure the app had
    // already recovered from.
    const before = window.location.href;
    reportGlobalFailure("unhandled-rejection");
    expect(window.location.href).toBe(before);
    expect(document.body.textContent).toBe("");
  });
});
