// @vitest-environment jsdom
//
// myne#319 — the conflict drain must subscribe ONCE, not once per render.
//
// `onMaterialized` arrives as a fresh closure on every render of the caller, so
// keeping it in `materialize`'s dep list made `materialize` change identity on
// every render and the effect tear down and re-run. Every autosave does that
// (`refreshOne` → new `SidebarState` → new provider value → `EditorChrome`
// re-render), as does every selection change, rename, trash and archive.
//
// Two costs. One `sync_pending_conflicts` IPC per render — which lists the
// vault's `conflicts/` directory on the Rust side, and is not gated on sync
// being configured, so a user with sync off pays it too. And between the
// synchronous `unlisten()` in the cleanup and the resolution of the next
// `await listen(...)`, the subscriber is DEAF: a `sync://changed` the background
// loop emits in that window is dropped for the drain.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

const invokeMock = vi.fn();
const listenMock = vi.fn();
const unlistenMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import { useConflictMaterializer } from "../../src/hooks/useConflictMaterializer";

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  unlistenMock.mockReset();
  // No staged conflicts — the steady state, and the one this churn happens in.
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:sync|sync_pending_conflicts") return [];
    return undefined;
  });
  listenMock.mockImplementation(async () => unlistenMock);
});
afterEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
});

/** Mount the hook and return a re-render that supplies a FRESH callback each
 *  time — the shape every caller render has. */
function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const Probe = (): null => {
    // A new closure per render, exactly as `useCallback(..., [ctx])` yields
    // when `ctx` is a new provider value.
    useConflictMaterializer(() => {});
    return null;
  };
  act(() => root.render(createElement(Probe)));
  return {
    rerender: () => act(() => root.render(createElement(Probe))),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const drains = () =>
  invokeMock.mock.calls.filter((c) => c[0] === "plugin:sync|sync_pending_conflicts").length;

describe("useConflictMaterializer", () => {
  it("drains once on mount", async () => {
    const m = mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(drains()).toBe(1);
    m.unmount();
  });

  it("does not re-drain on a caller re-render", async () => {
    const m = mount();
    await act(async () => {
      await Promise.resolve();
    });
    const afterMount = drains();

    for (let i = 0; i < 5; i++) {
      m.rerender();
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(drains()).toBe(afterMount);
    m.unmount();
  });

  it("does not re-subscribe on a caller re-render — the deaf window", async () => {
    const m = mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(listenMock).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      m.rerender();
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(unlistenMock).not.toHaveBeenCalled();
    m.unmount();
  });

  it("still unsubscribes on unmount", async () => {
    const m = mount();
    await act(async () => {
      await Promise.resolve();
    });
    m.unmount();
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });
});
