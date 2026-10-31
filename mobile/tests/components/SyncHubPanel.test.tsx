// @vitest-environment jsdom
//
// The mobile sync hub's status row, and the rule myne-md/myne#938 task 13 states:
// "Offline" is reserved for a transport failure, and every other failure class
// says what it actually is.
//
// It exists because the phone's row read "Offline" for everything but a TLS
// failure, so a locked identity, a frozen account, a full disk and a device the
// owner had just removed all gave the same false instruction: look at the
// network, which was working. The classes are not a mobile invention; they are
// the desktop indicator's arms (`src/components/sync/SyncStatusIndicator.tsx`)
// over the same `FailureClass::status_detail` strings out of the same core, and
// this file holds the two clients to the same table rather than to a shared
// component, since a phone renders the row itself.
//
// `useTranslation` returns the KEY, so an assertion names the catalog entry the
// user would see rather than a copy string that can be reworded underneath it.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-i18next")>();
  return { ...real, useTranslation: () => ({ t: (key: string) => key }) };
});

// The hub reads the endpoint and the account usage on mount and asks
// `useMemberVault` which plane the vault speaks for. All three are IPC, so the
// boundary is mocked and every command answers its empty shape.
const invokeMock = vi.fn((cmd: string) => {
  if (cmd === "plugin:sync|sync_get_endpoint") return Promise.resolve({ endpoint_url: null });
  if (cmd === "plugin:sync|sync_member_vault_status") {
    return Promise.resolve({ is_member_vault: false, has_credential: false, method: null });
  }
  return Promise.resolve(undefined);
});

vi.mock("../../src/platform/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/core")>();
  return { ...real, invoke: (...args: unknown[]) => invokeMock(args[0] as string) };
});

import { SyncHubPanel } from "../../src/components/SyncSettingsPanels";
import type { SyncStatus } from "../../src/lib/use-sync-status";

/** Render the hub with one status and return the status row's text. */
function labelFor(status: SyncStatus): string {
  render(
    <SyncHubPanel
      status={status}
      onSyncNow={() => {}}
      syncing={false}
      onOpenEndpoint={() => {}}
      onOpenEnroll={() => {}}
      onOpenDevices={() => {}}
      onOpenMembers={() => {}}
    />,
  );
  const row = screen.getByTestId("sync.settings.status");
  const text = row.textContent ?? "";
  cleanup();
  return text;
}

afterEach(() => {
  cleanup();
  invokeMock.mockClear();
});

describe("the mobile status row reserves 'Offline' for a transport failure", () => {
  it("says the identity is locked rather than that the device is offline", () => {
    const text = labelFor({ state: "error", detail: "identity_locked" });
    expect(text).toContain("sync.status.errorIdentityLocked");
    expect(text).not.toContain("settings.sync.summary.offline");
  });

  it("keeps 'Offline' for the class that names it, `sync_failed`", () => {
    // `FailureClass::Transport` and `Other` both report this detail, so it is the
    // one class where "Offline" is a true statement about the network.
    expect(labelFor({ state: "error", detail: "sync_failed" })).toContain(
      "settings.sync.summary.offline",
    );
  });

  it("names a full disk, a frozen account, a removed device and a throttle", () => {
    expect(labelFor({ state: "error", detail: "storage_full" })).toContain(
      "sync.status.errorStorageFull",
    );
    expect(labelFor({ state: "error", detail: "frozen" })).toContain("sync.status.errorFrozen");
    expect(labelFor({ state: "error", detail: "device_revoked" })).toContain(
      "sync.status.errorDeviceRevoked",
    );
    expect(labelFor({ state: "error", detail: "rate_limited" })).toContain(
      "sync.status.errorRateLimited",
    );
  });

  it("keeps the TLS copy for a certificate failure", () => {
    const text = labelFor({ state: "error", detail: "tls_failure" });
    expect(text).toContain("sync.status.errorTls");
    expect(text).not.toContain("settings.sync.summary.offline");
  });

  it("gives a detail this build does not know the generic copy, never 'Offline'", () => {
    // A newer core, or a renamed class. Guessing "offline" from an unknown string
    // is the same failure the rest of this file exists to remove, one version on.
    // `endsWith`, not `toContain`: every class-scoped key below starts with
    // `sync.status.error`, so a substring assertion would pass for `errorQuota`
    // and prove nothing about the fallback.
    const text = labelFor({ state: "error", detail: "a_class_from_a_newer_core" });
    expect(text.endsWith("sync.status.error")).toBe(true);
    expect(text).not.toContain("settings.sync.summary.offline");
  });
});
