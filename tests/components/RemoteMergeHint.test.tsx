// @vitest-environment jsdom
//
// ASM-6→B / #422: the "updated from another device" hint fires a calm `info`
// toast from the #419 `sync://remote-merged` signal, exactly once per event,
// and nothing without one. The backend guarantees the event fires ONLY for a
// real CRDT merge (not a local edit, no-op merge, or sync-off) — so the
// frontend's job is just: on the signal, one calm hint; otherwise silence.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

// Capture the handler the component registers for `sync://remote-merged`, so the
// test can fire the event the sync cycle would emit.
let capturedEvent: string | null = null;
let capturedHandler: (() => void) | null = null;
const unlisten = vi.fn();
vi.mock("../../src/platform/event", () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    capturedEvent = name;
    capturedHandler = handler;
    return unlisten;
  }),
}));

// t(key) → key, so the asserted message is the stable key.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { Toaster } from "../../src/components/toast/Toaster";
import { getToasts, resetToasts } from "../../src/components/toast/toastStore";
import { RemoteMergeHint } from "../../src/components/sync/RemoteMergeHint";

beforeEach(() => {
  capturedEvent = null;
  capturedHandler = null;
  unlisten.mockClear();
});

afterEach(() => {
  resetToasts();
  cleanup();
});

// The component subscribes in an effect whose body awaits `listen`; flush the
// microtask so `capturedHandler` is set before the test fires it.
async function mountAndSettle() {
  const utils = render(
    <>
      <RemoteMergeHint />
      <Toaster />
    </>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

describe("RemoteMergeHint (#422)", () => {
  it("subscribes to the sync://remote-merged signal", async () => {
    await mountAndSettle();
    expect(capturedEvent).toBe("sync://remote-merged");
    expect(capturedHandler).not.toBeNull();
  });

  it("fires a calm info toast with its own testid on a remote-merged event", async () => {
    await mountAndSettle();
    act(() => capturedHandler?.());

    const toasts = getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("sync.remoteMergeHint");
    expect(toasts[0].variant).toBe("info"); // never `error`
    expect(toasts[0].action).toBeUndefined(); // no resolve/undo affordance
    expect(toasts[0].testId).toBe("sync.remote-merge-hint");

    // Rendered by the shared Toaster with the hint's own testid.
    expect(screen.getByTestId("sync.remote-merge-hint")).toBeTruthy();
  });

  it("fires nothing until a remote-merged event arrives", async () => {
    await mountAndSettle();
    expect(getToasts()).toHaveLength(0);
  });

  it("fires once per applied remote merge (one toast per event)", async () => {
    await mountAndSettle();
    act(() => capturedHandler?.());
    act(() => capturedHandler?.());
    expect(getToasts()).toHaveLength(2);
  });

  it("unsubscribes on unmount (no leaked listener)", async () => {
    const { unmount } = await mountAndSettle();
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
