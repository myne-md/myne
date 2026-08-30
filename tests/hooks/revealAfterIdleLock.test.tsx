// @vitest-environment jsdom
//
// `useRevealAfterIdleLock`. The fourth re-show site of myne-md/myne#483, and
// the one that reveals the screen carrying the account number.
//
// Idle auto-lock's teardown is hide -> zeroize -> re-apply screen capture ->
// reload, so the re-apply runs while the window is HIDDEN. The Windows capture
// affinity is reported not to survive a hide/show cycle
// (tauri-apps/tauri#14189; Electron shipped the same fix in
// electron/electron#45868), so the show this hook asks for is exactly where the
// protection can be lost.
//
// What is worth a test here is not "does it call show". It is that this side no
// longer holds the sequence at all:
//
// 1. It asks the host for ONE thing. An earlier revision called
//    `getCurrentWindow().show()` and a separate re-assert after it, which is the
//    two-independent-calls shape the other three sites had. And the ordering
//    lived in a comment. If a `window.show` ever reappears here, the invariant is
//    back to being a convention.
// 2. A refusal is swallowed. The web dispatcher answers the whole plugin
//    `Unsupported`; a page has no hidden window and no affinity to lose.
// 3. It fires once per mount, not per render.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const showProtectedMock = vi.fn(async () => {});
const windowSeamMock = vi.fn();

vi.mock("../../src/lib/screen-capture-override", () => ({
  showWindowProtected: () => showProtectedMock(),
}));

// Not imported by the hook any more, and this is what says so: any
// `getCurrentWindow()` reaching for the window seam trips the assertion below.
vi.mock("../../src/platform/window", () => ({
  getCurrentWindow: () => {
    windowSeamMock();
    return { show: async () => {} };
  },
}));

const { useRevealAfterIdleLock } = await import(
  "../../src/hooks/useRevealAfterIdleLock"
);

function Probe() {
  useRevealAfterIdleLock();
  return null;
}

afterEach(() => {
  cleanup();
  showProtectedMock.mockReset();
  showProtectedMock.mockImplementation(async () => {});
  windowSeamMock.mockReset();
});

describe("useRevealAfterIdleLock", () => {
  it("asks the host for the protected re-show, and never drives the window itself", async () => {
    render(<Probe />);
    await waitFor(() => expect(showProtectedMock).toHaveBeenCalledTimes(1));
    expect(
      windowSeamMock,
      "the show must stay host-side, or the protect/show ordering is a comment again",
    ).not.toHaveBeenCalled();
  });

  it("swallows a refusal rather than letting it escape the effect", async () => {
    showProtectedMock.mockRejectedValue(new Error("unsupported"));
    render(<Probe />);
    await waitFor(() => expect(showProtectedMock).toHaveBeenCalled());
    // No unhandled rejection, and nothing else attempted.
    expect(windowSeamMock).not.toHaveBeenCalled();
  });

  it("fires once for the mount, not once per render", async () => {
    const { rerender } = render(<Probe />);
    await waitFor(() => expect(showProtectedMock).toHaveBeenCalledTimes(1));
    rerender(<Probe />);
    rerender(<Probe />);
    expect(showProtectedMock).toHaveBeenCalledTimes(1);
  });
});
