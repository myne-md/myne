// @vitest-environment jsdom
//
// Component tests for `src/components/sync/SyncStatusIndicator.tsx` (MYND-424
// task 10). The indicator consumes the real `useSyncStatus` hook, which talks
// to the `sync` Tauri plugin via `invoke` (`plugin:sync|sync_status` poll +
// `plugin:sync|sync_now` trigger). We mock `invoke` at the Tauri boundary
// (same shape as the notes unit tests) and route by command name, so the
// component + hook are exercised end-to-end: each `SyncRuntimeStatus` variant
// renders its correct dot-state + label, and clicking "Sync now" invokes
// `plugin:sync|sync_now`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// The hook listens for `sync://enrollment-changed`; stub it to a no-op unlistener.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { SyncStatusIndicator } from "../../src/components/sync/SyncStatusIndicator";
import type { SyncStatus } from "../../src/hooks/useSyncStatus";

/** Resolve `sync_status` with `status`; default other commands (e.g. sync_now). */
function statusFixture(status: SyncStatus, syncNowResult?: SyncStatus) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "plugin:sync|sync_status") return Promise.resolve(status);
    if (cmd === "plugin:sync|sync_now") {
      return Promise.resolve(syncNowResult ?? status);
    }
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

describe("SyncStatusIndicator — status variants", () => {
  it("disabled renders 'Sync off' and hides the Sync now affordance", async () => {
    statusFixture({ state: "disabled" });
    render(<SyncStatusIndicator />);
    await waitFor(() =>
      expect(
        screen.getByTestId("sync.status-indicator").getAttribute("data-sync-state"),
      ).toBe("disabled"),
    );
    expect(screen.getByTestId("sync.status-label").textContent).toBe("Sync off");
    // No endpoint configured → nothing to trigger; the button is omitted.
    expect(screen.queryByTestId("sync.sync-now")).toBeNull();
  });

  it("not_enrolled renders 'Not enrolled' and HIDES the Sync now affordance", async () => {
    statusFixture({ state: "not_enrolled" });
    render(<SyncStatusIndicator />);
    await waitFor(() =>
      expect(
        screen.getByTestId("sync.status-indicator").getAttribute("data-sync-state"),
      ).toBe("not_enrolled"),
    );
    expect(screen.getByTestId("sync.status-label").textContent).toBe("Not enrolled");
    // A not-enrolled device cannot sync → the button is omitted (else clicking it
    // would map NotReady→Idle and flash a false "Synced").
    expect(screen.queryByTestId("sync.sync-now")).toBeNull();
  });

  it("pending renders 'Awaiting approval' and HIDES the Sync now affordance", async () => {
    statusFixture({ state: "pending" });
    render(<SyncStatusIndicator />);
    await waitFor(() =>
      expect(
        screen.getByTestId("sync.status-indicator").getAttribute("data-sync-state"),
      ).toBe("pending"),
    );
    expect(screen.getByTestId("sync.status-label").textContent).toBe("Awaiting approval");
    // A pending device cannot manually sync until approved → no button.
    expect(screen.queryByTestId("sync.sync-now")).toBeNull();
  });

  it("idle renders 'Synced' and exposes the Sync now affordance", async () => {
    statusFixture({ state: "idle" });
    render(<SyncStatusIndicator />);
    await waitFor(() =>
      expect(
        screen.getByTestId("sync.status-indicator").getAttribute("data-sync-state"),
      ).toBe("idle"),
    );
    expect(screen.getByTestId("sync.status-label").textContent).toBe("Synced");
    expect(screen.getByTestId("sync.sync-now")).toBeTruthy();
  });

  it("syncing renders the 'Syncing…' label", async () => {
    statusFixture({ state: "syncing" });
    render(<SyncStatusIndicator />);
    await waitFor(() =>
      expect(
        screen.getByTestId("sync.status-indicator").getAttribute("data-sync-state"),
      ).toBe("syncing"),
    );
    expect(screen.getByTestId("sync.status-label").textContent).toBe("Syncing…");
  });

  it("error renders the 'Sync error' label", async () => {
    statusFixture({ state: "error", detail: "boom" });
    render(<SyncStatusIndicator />);
    await waitFor(() =>
      expect(
        screen.getByTestId("sync.status-indicator").getAttribute("data-sync-state"),
      ).toBe("error"),
    );
    expect(screen.getByTestId("sync.status-label").textContent).toBe("Sync error");
  });

  it("conflicts renders the pluralized review count (>1)", async () => {
    statusFixture({ state: "conflicts", count: 3 });
    render(<SyncStatusIndicator />);
    await waitFor(() =>
      expect(
        screen.getByTestId("sync.status-indicator").getAttribute("data-sync-state"),
      ).toBe("conflicts"),
    );
    expect(screen.getByTestId("sync.status-label").textContent).toBe(
      "3 conflicts to review",
    );
  });

  it("conflicts renders the singular review label (count === 1)", async () => {
    statusFixture({ state: "conflicts", count: 1 });
    render(<SyncStatusIndicator />);
    await waitFor(() =>
      expect(screen.getByTestId("sync.status-label").textContent).toBe(
        "1 conflict to review",
      ),
    );
  });
});

describe("SyncStatusIndicator — which states offer 'Sync now'", () => {
  // The mapping moved into `src/lib/sync-status-view.ts` (myne-md/myne#1027) and its first
  // version answered `false` for five error classes the desktop had always offered the button
  // for. Nothing noticed, because the only visibility assertions were for `idle` and the two
  // identity states. The rule this table holds: the row is hidden where a cycle cannot reach the
  // network or where another act is the repair, and shown wherever a retry is what a user wants
  // after fixing the cause.
  const offers = async (status: SyncStatus): Promise<boolean> => {
    statusFixture(status);
    render(<SyncStatusIndicator />);
    await waitFor(() =>
      expect(screen.getByTestId("sync.status-indicator").getAttribute("data-sync-state")).not.toBe(
        "loading",
      ),
    );
    return screen.queryByTestId("sync.sync-now") !== null;
  };

  it.each([
    ["quota_exceeded", true, "freed server quota, then retry"],
    ["storage_full", true, "freed local disk, then retry"],
    ["tls_failure", true, "repaired the certificate or the network, then retry"],
    ["frozen", true, "the account was unfrozen, then retry"],
    ["device_revoked", true, "the owner re-added the device, then retry"],
    ["sync_failed", true, "a transport blip, retry is the whole fix"],
    ["identity_locked", false, "the phrase entry is the honest control"],
    ["device_key_missing", false, "the repair action is the honest control"],
  ] as const)("error %s → Sync now visible: %s", async (detail, expected) => {
    expect(await offers({ state: "error", detail })).toBe(expected);
    cleanup();
  });

  it("hides the row while uploads are blocked, which is the state the branch exists for", async () => {
    expect(await offers({ state: "uploads_blocked", detail: "device_key_missing" })).toBe(false);
    cleanup();
  });
});

describe("SyncStatusIndicator — sync now affordance", () => {
  it("clicking 'Sync now' invokes plugin:sync|sync_now", async () => {
    statusFixture({ state: "idle" }, { state: "syncing" });
    render(<SyncStatusIndicator />);
    await waitFor(() => expect(screen.getByTestId("sync.sync-now")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync.sync-now"));
    });

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some((c) => c[0] === "plugin:sync|sync_now"),
      ).toBe(true),
    );
  });

  it("reflects the status returned by sync_now after the click resolves", async () => {
    statusFixture({ state: "idle" }, { state: "error", detail: "net" });
    render(<SyncStatusIndicator />);
    await waitFor(() => expect(screen.getByTestId("sync.sync-now")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync.sync-now"));
    });

    await waitFor(() =>
      expect(
        screen.getByTestId("sync.status-indicator").getAttribute("data-sync-state"),
      ).toBe("error"),
    );
    expect(screen.getByTestId("sync.status-label").textContent).toBe("Sync error");
  });
});

// --- Refusal classes (MYND-570) -------------------------------------------
//
// The Rust failure gate coarsens a cycle error to a FailureClass and emits its
// `status_detail()` tag; the indicator maps each tag to its own copy. The point
// of the feature is that these must NOT collapse into the generic "Sync error"
// — each is separately actionable, and all three still PULL (only upload stops).
describe("refusal classes render distinct copy", () => {
  const cases: Array<[string, string]> = [
    ["quota_exceeded", "Storage full: uploads paused"],
    ["payload_too_large", "A file is too large to upload"],
    ["frozen", "Account frozen: uploads paused"],
    // myne#581. In this table rather than in one of its own because the claim
    // is the same claim: it must not collapse into "Sync error". It differs
    // from its neighbours in being certain to occur — a certificate expires on
    // a schedule, so a pinned one is replaced on a schedule — and in being the
    // only one that leaves sync entirely dead rather than pull-only.
    ["tls_failure", "Couldn’t verify the sync server’s HTTPS connection"],
  ];

  for (const [detail, expected] of cases) {
    it(`maps "${detail}" to its own label`, async () => {
      statusFixture({ state: "error", detail } as SyncStatus);
      render(<SyncStatusIndicator />);
      await waitFor(() => {
        expect(screen.getByText(expected)).toBeTruthy();
      });
      // The generic fallback must not be what the user sees.
      expect(screen.queryByText("Sync error")).toBeNull();
    });
  }

  // A shared (`NTV6`) vault whose person identity is not held
  // in this session refuses to sync. Deliberately NOT in the table above: those
  // all still PULL, and this one does nothing at all until the user unlocks the
  // identity. The claim is the same, though — it must not collapse into "Sync
  // error", because the fix is a specific action, not the network.
  it('maps "identity_locked" to its own label', async () => {
    statusFixture({ state: "error", detail: "identity_locked" } as SyncStatus);
    render(<SyncStatusIndicator />);
    await waitFor(() => {
      expect(screen.getByText("Unlock your identity to sync")).toBeTruthy();
    });
    expect(screen.queryByText("Sync error")).toBeNull();
  });

  // The key this device published is gone (myne-md/myne#983). Its own label AND its own call to
  // action: the repair is still the identity phrase entry, but "unlock your identity" was shown
  // for this state for a week and named the wrong thing.
  it('maps "device_key_missing" to its own label, apart from identity_locked', async () => {
    statusFixture({ state: "error", detail: "device_key_missing" } as SyncStatus);
    render(<SyncStatusIndicator onUnlockIdentity={() => {}} />);
    await waitFor(() => {
      expect(
        screen.getByText(
          "The signing key this device published is not here, so sync cannot run",
        ),
      ).toBeTruthy();
    });
    expect(screen.queryByText("Unlock your identity to sync")).toBeNull();
    expect(screen.getByText("Repair this device")).toBeTruthy();
    expect(screen.queryByText("Sync error")).toBeNull();
  });

  it("still falls back to the generic label for an unknown detail", async () => {
    statusFixture({ state: "error", detail: "sync_failed" } as SyncStatus);
    render(<SyncStatusIndicator />);
    await waitFor(() => {
      expect(screen.getByText("Sync error")).toBeTruthy();
    });
  });
});

// The whole point of the `identity_locked` state is that it is actionable: the
// fix is to unlock the person identity, so the indicator offers that action and
// stands "Sync now" down (a cycle refuses before any network call, so it cannot
// help until the identity is unlocked).
describe("identity_locked unlock affordance", () => {
  it("offers the unlock action and calls it, and hides Sync now", async () => {
    const onUnlockIdentity = vi.fn();
    statusFixture({ state: "error", detail: "identity_locked" } as SyncStatus);
    render(<SyncStatusIndicator onUnlockIdentity={onUnlockIdentity} />);
    await waitFor(() =>
      expect(screen.getByTestId("sync.unlock-identity")).toBeTruthy(),
    );
    expect(screen.queryByTestId("sync.sync-now")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync.unlock-identity"));
    });
    expect(onUnlockIdentity).toHaveBeenCalledTimes(1);
  });

  it("offers no unlock action when the host passed no handler", async () => {
    statusFixture({ state: "error", detail: "identity_locked" } as SyncStatus);
    render(<SyncStatusIndicator />);
    await waitFor(() =>
      expect(screen.getByText("Unlock your identity to sync")).toBeTruthy(),
    );
    expect(screen.queryByTestId("sync.unlock-identity")).toBeNull();
  });
});

// The repair for a lost device key IS the identity entry (`decisions/protocol/0774`), so the
// affordance has to be the same one, and the test has to be its own: a single `identity_locked`
// case passes whether or not `device_key_missing` reaches this branch.
describe("device_key_missing repair affordance", () => {
  it("offers the identity entry and calls it, and hides Sync now", async () => {
    const onUnlockIdentity = vi.fn();
    statusFixture({ state: "error", detail: "device_key_missing" } as SyncStatus);
    render(<SyncStatusIndicator onUnlockIdentity={onUnlockIdentity} />);
    await waitFor(() =>
      expect(screen.getByTestId("sync.unlock-identity")).toBeTruthy(),
    );
    expect(screen.queryByTestId("sync.sync-now")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync.unlock-identity"));
    });
    expect(onUnlockIdentity).toHaveBeenCalledTimes(1);
  });

  it("offers no action when the host passed no handler", async () => {
    statusFixture({ state: "error", detail: "device_key_missing" } as SyncStatus);
    render(<SyncStatusIndicator />);
    await waitFor(() =>
      expect(
        screen.getByText(
          "The signing key this device published is not here, so sync cannot run",
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByTestId("sync.unlock-identity")).toBeNull();
  });
});
