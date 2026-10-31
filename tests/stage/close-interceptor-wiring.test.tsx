// @vitest-environment jsdom
//
// The close interceptor is INSTALLED by `App` (myne-md/myne#945 item 05).
//
// # Why this is a separate file from `tests/lib/closeRequest.test.ts`
//
// That file owns the mechanism: a guard chain that always resolves to
// destroy-or-refuse, a deadline, a refusal that is final. Every one of those
// cases passes whether or not anything ever calls `installCloseInterceptor()`,
// and "nothing calls it" is exactly the shipped state that produced the bug:
// Tauri cancels the native close as soon as a listener exists, so an interceptor
// that was never installed leaves the workspace screen ignoring the close button
// and NO test of the mechanism can see it. The wiring is the half nobody had, so
// this file mounts `App` and asks whether the seam was told to listen.
//
// # What is stubbed
//
// The WebView-window seam (`src/platform/webviewWindow.ts`), because the subject
// is whether `App` reaches it, not what Tauri does with the registration. `Editor`
// is stubbed for the same reason the update-notice file stubs it: it is another
// screen with its own close guard and would blur which registration was counted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

const caps = vi.hoisted(() => ({ absent: [] as string[] }));
vi.mock("../../src/platform/capabilities", () => ({
  has: (cap: string) => !caps.absent.includes(cap),
  ALL_CAPABILITIES: [],
}));

/** The seam's two members the close path touches. */
const seam = vi.hoisted(() => ({
  onCloseRequested: vi.fn((_cb: (e: { preventDefault: () => void }) => unknown) =>
    Promise.resolve(() => {}),
  ),
  destroy: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/platform/webviewWindow", () => ({
  getCurrentWebviewWindow: () => seam,
}));

vi.mock("../../src/screens/Editor", () => ({
  Editor: () => <div data-testid="stub.editor" />,
}));

import App from "../../src/App";

function wire(): void {
  invokeMock.mockImplementation(async (cmd) => {
    switch (cmd) {
      case "plugin:vault-unlock|vault_list":
        return [];
      case "plugin:vault-unlock|vault_slot_kind":
        return "Locked";
      case "plugin:prefs|prefs_read":
        return {};
      case "plugin:sync|sync_person_status":
        return {
          enrolled: false,
          identity_unlocked: false,
          person_id_hex: null,
          identity_code: null,
        };
      default:
        return undefined;
    }
  });
}

beforeEach(() => {
  caps.absent = [];
  wire();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App installs the close interceptor", () => {
  it("registers ONE close listener, and a second mount does not add another", async () => {
    // Both halves in one case on purpose: `close-request.ts` holds
    // process-lifetime state, so "installed twice" is only observable as a count
    // across two mounts of the same module instance, and re-importing the module
    // between them would be testing a fresh process instead of this one.
    //
    // Why one registration matters beyond tidiness: Tauri pairs each listener
    // with its own `prevent_close()`, so a second registration is a second claim
    // on the native close button that something has to give back. React 19's
    // StrictMode double-mounts effects in development, which is precisely how a
    // non-idempotent install would reach users.
    render(<App />);
    // The effect is passive; one tick is enough for React to run it.
    await Promise.resolve();
    expect(seam.onCloseRequested).toHaveBeenCalledTimes(1);

    cleanup();
    render(<App />);
    await Promise.resolve();
    expect(seam.onCloseRequested).toHaveBeenCalledTimes(1);
  });
});
