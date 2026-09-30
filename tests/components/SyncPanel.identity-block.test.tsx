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
import { cleanup, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { renderSyncPanel, syncPanelCommandRouter } from "./_syncPanelHarness";

function mount(route: Parameters<typeof syncPanelCommandRouter>[0]): void {
  invokeMock.mockImplementation(syncPanelCommandRouter(route));
  renderSyncPanel();
}

beforeEach(() => {
  invokeMock.mockReset();
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
});
