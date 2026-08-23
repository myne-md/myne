// @vitest-environment jsdom
//
// The settle block's outcome channel (myne-md/myne#461).
//
// This component had no test at all, and `migrate.settle-confirm` was clicked
// nowhere in the repo, which is exactly how the defect shipped: the block
// reported abort and confirm through ONE bare callback, and the panel above it
// treated the pair as interchangeable by wiring that callback to a force-relock.
//
// Only ABORT is a re-key. `vault_migrate_abort` restores the pre-migration root
// and the backend drops the slot with it, so a relock is right. `vault_migrate_confirm`
// crypto-erases the staged `legacy/` snapshot and leaves the running slot exactly
// as it was, so the relock put React on a lock screen the backend never locked:
// the correct master password then returned `VaultAlreadyUnlocked` on every
// attempt and the only way out was restarting the app.
//
// What is pinned here is the CHANNEL, not the panel's policy. The panel's own
// branch is one line (`if (which === "aborted")`), and it is unreachable to a
// test that cannot tell the two actions apart, which is the state this file ends.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/** Click and flush the async handler's microtasks inside act, so a rejection is
 *  caught by the component rather than surfacing as an unhandled rejection. */
async function clickAndFlush(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 0));
  });
}

const abortMigration = vi.fn(async () => {});
const confirmMigration = vi.fn(async () => {});
const migrationSettleStatus = vi.fn(async () => ({ pending: true, can_abort: true }));

vi.mock("../../src/lib/vault-migrate", () => ({
  abortMigration: () => abortMigration(),
  confirmMigration: () => confirmMigration(),
  migrationSettleStatus: () => migrationSettleStatus(),
}));

import { SettleMigrationBlock } from "../../src/components/settings/SettleMigrationBlock";

afterEach(() => {
  cleanup();
  abortMigration.mockClear();
  confirmMigration.mockClear();
  migrationSettleStatus.mockClear();
  migrationSettleStatus.mockResolvedValue({ pending: true, can_abort: true });
});

/** Mount and wait for the pending probe to resolve, which is what renders it. */
async function mount(onSettled: (which: "aborted" | "confirmed") => void) {
  await act(async () => {
    render(<SettleMigrationBlock onSettled={onSettled} />);
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("SettleMigrationBlock tells its parent WHICH action landed", () => {
  it("reports `confirmed` for the confirm action", async () => {
    const onSettled = vi.fn();
    await mount(onSettled);
    await clickAndFlush(screen.getByTestId("migrate.settle-confirm"));
    expect(confirmMigration).toHaveBeenCalledTimes(1);
    expect(abortMigration).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith("confirmed");
  });

  it("reports `aborted` for the abort action", async () => {
    // The other direction, and it is not decoration: a channel that answered
    // the same value for both would satisfy the test above on its own.
    const onSettled = vi.fn();
    await mount(onSettled);
    await clickAndFlush(screen.getByTestId("migrate.settle-abort"));
    expect(abortMigration).toHaveBeenCalledTimes(1);
    expect(confirmMigration).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith("aborted");
  });

  it("says nothing when the settle command rejects", async () => {
    // A failed settle changed nothing on disk, so the panel must not act on it.
    // Before the outcome argument this was already true; it is asserted here
    // because the new signature is the one a future edit will touch.
    confirmMigration.mockRejectedValueOnce({ kind: "AlreadySynced" });
    const onSettled = vi.fn();
    await mount(onSettled);
    await clickAndFlush(screen.getByTestId("migrate.settle-confirm"));
    expect(onSettled).not.toHaveBeenCalled();
    expect(screen.getByTestId("migrate.settle-error")).toBeTruthy();
  });

  it("renders nothing when no snapshot is staged", async () => {
    migrationSettleStatus.mockResolvedValue({ pending: false, can_abort: false });
    const onSettled = vi.fn();
    await mount(onSettled);
    expect(screen.queryByTestId("migrate.settle")).toBeNull();
  });

  it("offers no abort once the vault has synced past the roll-back point", async () => {
    // `can_abort` false means the peers hold the v0.2 generation, so restoring
    // here would fork this device away from them. The backend refuses, and an
    // offer the backend refuses is worse than no offer.
    migrationSettleStatus.mockResolvedValue({ pending: true, can_abort: false });
    const onSettled = vi.fn();
    await mount(onSettled);
    expect(screen.getByTestId("migrate.settle-confirm")).toBeTruthy();
    expect(screen.queryByTestId("migrate.settle-abort")).toBeNull();
  });
});
