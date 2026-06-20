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
