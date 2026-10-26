// @vitest-environment jsdom
//
// A member vault keeps the way out when its credential is gone.
//
// The remove link and the member confirm copy both existed, but the link was
// rendered inside the owner half of `Unlock.tsx`'s member/owner branch, so a
// member never saw it: the only in-app removal path was Settings, which needs
// the vault to be unlocked first. This pins the entry point, and the member
// copy behind it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: async () => {} }),
}));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/tmp/app-data",
  join: async (...parts: string[]) => parts.join("/"),
}));

import i18n from "../../src/i18n";
import { Unlock } from "../../src/screens/Unlock";
import type { VaultId } from "../../src/lib/stage";

const A = "00000000-0000-7000-8000-00000000000a";

function renderMemberUnlock() {
  invokeMock.mockImplementation((cmd) => {
    switch (cmd) {
      case "plugin:sync|sync_member_vault_status":
        return Promise.resolve(true);
      case "plugin:sync|sync_member_unlock_status":
        // No device-local fast credential: the card offers the phrase.
        return Promise.resolve(null);
      case "plugin:quick-unlock|quick_unlock_status":
        return Promise.resolve({ configured: false, method: null, available: false });
      case "plugin:vault-unlock|vault_list":
        return Promise.resolve([{ id: A, status: "Exists", label: null }]);
      default:
        return Promise.resolve(undefined);
    }
  });
  return render(
    <Unlock
      initialStatus={{ kind: "Exists" }}
      vaultId={A as VaultId}
      onUnlocked={() => {}}
      onStartRecovery={() => {}}
      onResumeRecovery={() => {}}
      onDeleteVaultSuccess={() => {}}
      onRestoreBackup={() => {}}
      onBack={() => {}}
    />,
  );
}

beforeEach(() => invokeMock.mockReset());
afterEach(() => cleanup());

describe("a member vault keeps the way out", () => {
  it("renders the remove link with the member label", async () => {
    renderMemberUnlock();
    await screen.findByTestId("unlock.member-form");

    const link = await screen.findByTestId("unlock.delete-link");
    expect(link.textContent?.trim()).toBe(i18n.t("unlock.memberRemoveLink"));
    expect(link.textContent?.trim()).not.toBe(i18n.t("unlock.deleteLink"));
  });

  it("opens the member disclosure, not the owner's destructive copy", async () => {
    renderMemberUnlock();
    await screen.findByTestId("unlock.member-form");

    fireEvent.click(await screen.findByTestId("unlock.delete-link"));

    expect(
      await screen.findByTestId("delete-vault.member-removal-disclosure"),
    ).toBeTruthy();
    expect(screen.queryByText(i18n.t("settings.deleteVault.copyPrimary"))).toBeNull();
  });
});
