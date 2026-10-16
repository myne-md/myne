// @vitest-environment jsdom
//
// The Sync panel on a MEMBER vault (myne-md/myne).
//
// # What this file is for
//
// A member vault's account plane is the member's own PERSON account, not the
// vault's (`core/src/plugins/sync/devices.rs::account_plane_from_host`), and two
// affordances on this panel stop being honest there rather than merely useful:
//
//   - the OWNER's device-join QR carries an account number a member does not have
//     and leads to a `{account# + password}` join a member cannot complete, so the
//     member's own QR takes its place;
//   - the usage projection is then the member's person account, which holds none of
//     the shared vault's blobs — so the storage figure would read "0 B of 5 GB"
//     above a vault full of notes, while the device count is genuinely theirs and
//     matches the roster.
//
// Both are `memberVault` reads, and both are asserted here in BOTH directions:
// "the member gets the member QR" is satisfied by a panel that offers it to
// everyone, which is exactly the regression the owner-side case rules out.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import {
  renderSyncPanel,
  syncPanelCommandRouter,
  type SyncPanelRoute,
} from "./_syncPanelHarness";

/** A projection the panel renders in full: a real ceiling, so the storage row and
 *  its meter are both on screen and their absence means something. */
const USAGE = {
  stored_bytes: 1_024,
  device_count: 2,
  frozen: false,
  quota_bytes: 5_000,
  max_devices: 10,
};

async function mountWith(route: SyncPanelRoute) {
  invokeMock.mockImplementation(syncPanelCommandRouter(route));
  renderSyncPanel();
  // The member probe is an effect, so a panel asserting on its result has to let
  // it settle before reading.
  await waitFor(() =>
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "plugin:sync|sync_member_vault_status"),
    ).toBe(true),
  );
}

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the Sync panel, member vault vs owner vault", () => {
  it("offers the member's own-device QR on a member vault, and never the owner's", async () => {
    await mountWith({ memberVault: true });

    expect(await screen.findByTestId("sync.member-join-qr.open")).toBeTruthy();
    // The owner's QR is the other half of the pair, and its absence here is the
    // point: it needs a pasted account number a member does not have.
    expect(screen.queryByTestId("sync.device-join-qr.open")).toBeNull();
  });

  it("does not offer the member's QR on an owner vault", async () => {
    await mountWith({ memberVault: false });

    // The owner's own icon is gated on the roster (`enrolledHere`), which the
    // shared router always refuses, so this case asserts the MEMBER door's
    // absence rather than the owner door's presence.
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some((c) => c[0] === "plugin:sync|sync_member_vault_status"),
      ).toBe(true),
    );
    expect(screen.queryByTestId("sync.member-join-qr.open")).toBeNull();
  });

  it("counts the member's own devices without claiming their vault's storage", async () => {
    await mountWith({ memberVault: true, usage: USAGE });

    expect(await screen.findByTestId("sync.usage-devices")).toBeTruthy();
    // The figure counts the member's PERSON account's namespace, which holds none
    // of the shared vault's blobs.
    expect(screen.queryByTestId("sync.usage-storage")).toBeNull();
    expect(screen.queryByTestId("sync.usage-meter")).toBeNull();
  });

  it("keeps both usage rows on an owner vault, so the member shape is not the default", async () => {
    await mountWith({ memberVault: false, usage: USAGE });

    expect(await screen.findByTestId("sync.usage-storage")).toBeTruthy();
    expect(screen.getByTestId("sync.usage-devices")).toBeTruthy();
    expect(screen.getByTestId("sync.usage-meter")).toBeTruthy();
  });
});
