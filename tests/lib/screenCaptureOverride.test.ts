// Binding tests for `src/lib/screen-capture-override.ts` (myne-md/myne#482,
// #483). Mocks the Tauri `invoke` shim and pins the exact command names and
// arg-key shape, which is the one drift a typecheck cannot see: the strings are
// literals on both sides of IPC and nothing compares them.
//
// The bindings are deliberately NOT in `src/lib/prefs.ts` and so are not part of
// that file's nonce contract: nothing here writes `vault.prefs`, and the prefs
// nonce exists to tell sibling `usePrefs` instances that a SYNCED field moved.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  getScreenCaptureOverride,
  setScreenCaptureOverride,
  showWindowProtected,
} from "../../src/lib/screen-capture-override";

const VIEW = { disabled: false, via_flag: false, effective: false };

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(VIEW);
});

describe("screen-capture override bindings", () => {
  it("reads through the plugin's get command, with no arguments", async () => {
    await getScreenCaptureOverride();
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:screen-capture|screen_capture_override_get",
    );
  });

  it("writes through the set command under the `disabled` arg key", async () => {
    await setScreenCaptureOverride(true);
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:screen-capture|screen_capture_override_set",
      { disabled: true },
    );
  });

  it("asks the host for the whole re-show, choosing no value", async () => {
    // The absence of a payload is the property worth pinning. Every value in
    // the sequence is state the backend already holds, which is what makes it
    // safe to expose pre-unlock: page context cannot use it to turn protection
    // OFF, and cannot aim it at a window of its choosing either.
    await showWindowProtected();
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:screen-capture|screen_capture_show_protected",
    );
    expect(invokeMock.mock.calls[0]).toHaveLength(1);
  });

  it("returns the backend's view rather than the argument it was given", async () => {
    // The case this exists for: passing `false` on a flag-launched run records
    // the intent and leaves the window unprotected. A caller that trusted its
    // own argument would report "protection is back on" over a black window.
    invokeMock.mockResolvedValue({
      disabled: false,
      via_flag: true,
      effective: true,
    });
    const view = await setScreenCaptureOverride(false);
    expect(view.disabled).toBe(false);
    expect(view.effective).toBe(true);
  });
});
