// @vitest-environment jsdom
//
// Which settle action force-relocks (myne-md/myne#461).
//
// `SyncPanel` passes `onMigrated` down as its force-relock: the Settings shell
// wires it to `onForceRelock({ kind: "Exists" })`, which sets the stage to
// `unlock`. The panel used to call it for BOTH settle actions, and only one of
// the two is a re-key:
//
//   - `vault_migrate_abort` restores the pre-migration root and the backend
//     drops the slot with it (`lock_from_host`), so relocking is correct.
//   - `vault_migrate_confirm` crypto-erases the staged `legacy/` snapshot and
//     leaves the running slot exactly as it was. Relocking on top of that showed
//     a lock screen the backend never locked, the correct master password came
//     back `VaultAlreadyUnlocked` on every attempt, and the only way out was
//     restarting the app.
//
// `settleMigrationBlock.test.tsx` pins the CHANNEL (that the block says which
// action landed). This pins the POLICY, which is one line in the panel and is
// what the deletion test asks about: remove `if (which === "aborted")` and the
// channel test still passes.
//
// Both directions are asserted. A panel that never relocked would satisfy the
// confirm case on its own, and would break the abort path in the opposite
// direction: the vault really is re-keyed there, so leaving the user in the
// editor points a live session at a root that no longer opens it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { clickAndFlush } from "./_clickAndFlush";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { renderSyncPanel, syncPanelCommandRouter } from "./_syncPanelHarness";

/** Mount the panel with a staged `legacy/` snapshot, so the settle block shows. */
function mountWithStagedSnapshot(onMigrated: () => void) {
  invokeMock.mockImplementation(
    syncPanelCommandRouter({
      migration: { pending: true, can_abort: true, offerable: false },
    }),
  );
  return renderSyncPanel({ onMigrated });
}

/** Every command name the panel's subtree has invoked. `invoke` is called with
 *  the name alone for these two, so match on the name rather than on an
 *  argument shape that does not exist. */
function commandsCalled(): string[] {
  return invokeMock.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => invokeMock.mockReset());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("settling a migration from the Sync panel", () => {
  it("does NOT relock on confirm, because confirm is not a re-key", async () => {
    const onMigrated = vi.fn();
    mountWithStagedSnapshot(onMigrated);
    const confirm = await waitFor(() => screen.getByTestId("migrate.settle-confirm"));

    await clickAndFlush(confirm);

    expect(commandsCalled()).toContain("plugin:vault-migrate|vault_migrate_confirm");
    // The whole bug in one assertion. The slot is still `Slot::Unlocked`, so a
    // relock here is a lock screen the backend never locked.
    expect(onMigrated).not.toHaveBeenCalled();
  });

  it("DOES relock on abort, because abort restores the pre-migration root", async () => {
    const onMigrated = vi.fn();
    mountWithStagedSnapshot(onMigrated);
    const abort = await waitFor(() => screen.getByTestId("migrate.settle-abort"));

    await clickAndFlush(abort);

    expect(commandsCalled()).toContain("plugin:vault-migrate|vault_migrate_abort");
    expect(onMigrated).toHaveBeenCalledTimes(1);
  });
});
