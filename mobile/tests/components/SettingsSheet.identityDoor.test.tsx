// @vitest-environment jsdom
//
// The phone's Settings → Sync repair row (myne-md/myne#1029).
//
// # The failure this pins
//
// An owner's iPhone had never uploaded anything: the sync row read "Unlock your
// identity to sync" and the panel rendered no control under it. Two facts were
// missing and this file covers the second half of the first one: `SyncHubPanel`
// dropped the shared view's `action`, and the sheet had no door to pass it on to.
// `SyncHubPanel.test.tsx` proves the ROW; this proves the sheet threads it, which
// is the hop a component test of the panel cannot see: the row would render and
// be inert, which is the shape `EditorFlow.lineNumbers.test.tsx` was written for.
//
// `useTranslation` echoes keys, so every assertion names the catalog entry the
// user would see rather than a copy string that can be reworded underneath it.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const syncStatus = vi.hoisted(() => ({
  value: { state: "uploads_blocked", detail: "identity_locked" } as unknown,
}));

vi.mock("../../src/hooks/useMemberVault", () => ({ useMemberVault: () => "owner" }));
vi.mock("../../src/lib/use-sync-status", () => ({
  useSyncStatus: () => ({
    status: syncStatus.value,
    reconciling: false,
    dismissReconcile: () => {},
    integrityAlert: false,
    syncNow: async () => {},
    busy: false,
  }),
}));
vi.mock("../../src/lib/use-prefs", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/use-prefs")>();
  return {
    ...real,
    usePrefs: () => ({ prefs: real.DEFAULT_PREFS, loading: false, error: false, reload: () => {} }),
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import { SettingsSheet } from "../../src/app/flows/SettingsSheet";

afterEach(cleanup);

function renderSyncPanel(onUnlockIdentity: (() => void) | undefined) {
  render(
    <SettingsSheet
      vaultId={"vault-id-hex"}
      onClose={() => {}}
      onLock={() => {}}
      onDeleteVaultSuccess={() => {}}
      initialPanel="sync"
      onUnlockIdentity={onUnlockIdentity}
    />,
  );
}

describe("Settings → Sync offers the identity repair the sentence names", () => {
  it("renders the row from the shared view's action and opens the door", async () => {
    const onUnlockIdentity = vi.fn();
    renderSyncPanel(onUnlockIdentity);

    expect((await screen.findByTestId("sync.settings.status")).textContent).toContain(
      "sync.status.errorIdentityLocked",
    );
    const row = screen.getByTestId("sync.settings.unlock-identity");
    expect(row.textContent).toContain("sync.status.unlockIdentityCta");
    fireEvent.click(row);
    expect(onUnlockIdentity).toHaveBeenCalledTimes(1);
  });

  it("renders no row for a caller with no door to open", async () => {
    // The row must never be a control that does nothing: a surface with no shell
    // behind it keeps the sentence and drops the row, which is what the panel's
    // own optional prop is for.
    renderSyncPanel(undefined);
    await screen.findByTestId("sync.settings.status");
    expect(screen.queryByTestId("sync.settings.unlock-identity")).toBeNull();
  });
});
