// @vitest-environment jsdom
//
// The Sync panel's Identity block, per device identity state.
//
// It used to render ONLY when no identity existed, so a device that held an
// identity (the common case, an owner created one at vault creation) had no
// identity surface here at all, and a locked one had no way to see which
// identity it held. The block now renders in every state: it offers the Add CTA
// when there is none, and otherwise shows the held identity's public code and,
// while the private identity is locked for the session, the unlock action.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
const writeTextMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: writeTextMock,
}));

import { getToasts, resetToasts } from "../../src/components/toast/toastStore";
import { renderSyncPanel, syncPanelCommandRouter } from "./_syncPanelHarness";

function mount(route: Parameters<typeof syncPanelCommandRouter>[0]): void {
  invokeMock.mockImplementation(syncPanelCommandRouter(route));
  renderSyncPanel();
}

beforeEach(() => {
  invokeMock.mockReset();
  writeTextMock.mockReset().mockResolvedValue(undefined);
  resetToasts();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the Identity block, per device identity state", () => {
  it("offers the Add CTA when this device holds no identity", async () => {
    mount({ syncState: "idle" });
    await waitFor(() => expect(screen.getByTestId("sync.panel.add-identity")).toBeTruthy());
    expect(screen.queryByTestId("sync.panel.identity-locked")).toBeNull();
    expect(screen.queryByTestId("sync.panel.identity-unlocked")).toBeNull();
  });

  it("shows the held identity's code and the unlock action while it is locked", async () => {
    mount({
      syncState: "idle",
      person: {
        enrolled: true,
        identity_unlocked: false,
        identity_code: "MYNE-PERSON-1:deadbeef",
        sealed_keypair_present: true,
      },
    });
    await waitFor(() => expect(screen.getByTestId("sync.panel.identity-locked")).toBeTruthy());
    const code = screen.getByTestId("sync.panel.identity-code") as HTMLInputElement;
    expect(code.value).toBe("MYNE-PERSON-1:deadbeef");
    // The copy chip sits beside the code, and the unlock action is inline on the
    // same row (myne-md/myne#818).
    expect(screen.getByTestId("sync.panel.copy-identity")).toBeTruthy();
    expect(screen.getByTestId("sync.panel.unlock-identity")).toBeTruthy();
    // The Add CTA is not shown; the identity already exists.
    expect(screen.queryByTestId("sync.panel.add-identity")).toBeNull();
  });

  it("shows the identity as unlocked, with no add or unlock action", async () => {
    mount({
      syncState: "idle",
      person: {
        enrolled: true,
        identity_unlocked: true,
        identity_code: "MYNE-PERSON-1:deadbeef",
        sealed_keypair_present: true,
      },
    });
    await waitFor(() => expect(screen.getByTestId("sync.panel.identity-unlocked")).toBeTruthy());
    expect(screen.queryByTestId("sync.panel.add-identity")).toBeNull();
    expect(screen.queryByTestId("sync.panel.unlock-identity")).toBeNull();
  });

  it("treats a sealed-but-unenrolled identity as 'recover', not 'add'", async () => {
    // `sealed_keypair_present` with `enrolled: false` is myne-md/myne#780's
    // shape: a live identity this device holds but whose token never landed.
    mount({
      syncState: "idle",
      person: { enrolled: false, sealed_keypair_present: true, identity_code: "c" },
    });
    await waitFor(() => expect(screen.getByTestId("sync.panel.identity-locked")).toBeTruthy());
    expect(screen.queryByTestId("sync.panel.add-identity")).toBeNull();
  });

  it("copies the identity code with outcome feedback (myne-md/myne#823)", async () => {
    // The chip's BEHAVIOUR, not just its presence: a test that only asserts the
    // testid exists passes with an empty `copyIdentityCode` body. This is the
    // third identity-code-copy surface (the other two are in
    // identityCodeCopy.test.tsx, which the locked harness here cannot drive).
    mount({
      syncState: "idle",
      person: {
        enrolled: true,
        identity_unlocked: false,
        identity_code: "MYNE-PERSON-1:deadbeef",
        sealed_keypair_present: true,
      },
    });
    await waitFor(() => expect(screen.getByTestId("sync.panel.copy-identity")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync.panel.copy-identity"));
    });
    await waitFor(() =>
      expect(writeTextMock).toHaveBeenCalledWith("MYNE-PERSON-1:deadbeef"),
    );
    expect(getToasts().at(-1)?.variant).toBe("info");
    expect(getToasts().at(-1)?.message).toBe("Identity code copied");
  });

  it("reports a clipboard failure on the identity chip (myne-md/myne#823)", async () => {
    writeTextMock.mockRejectedValueOnce(new Error("clipboard unavailable"));
    mount({
      syncState: "idle",
      person: {
        enrolled: true,
        identity_unlocked: false,
        identity_code: "MYNE-PERSON-1:deadbeef",
        sealed_keypair_present: true,
      },
    });
    await waitFor(() => expect(screen.getByTestId("sync.panel.copy-identity")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync.panel.copy-identity"));
    });
    await waitFor(() => expect(getToasts().at(-1)?.variant).toBe("error"));
    expect(getToasts().at(-1)?.message).toBe("Couldn't copy the identity code");
  });
});
