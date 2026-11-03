// @vitest-environment jsdom
//
// The member-vault removal copy in the phone's Settings sheet (audit K2-i,
// mobile half; the sheet's twin of `UnlockFlow.memberVaultRemoval.test.tsx`).
//
// # The failure this pins
//
// A SHARED (member) vault used to be shown the owner's destructive copy in the
// danger zone: the drill-down title "Delete vault", the account-row label "Delete
// vault", the red warning "This permanently deletes this vault and all of its
// notes from this device. This cannot be undone.", and a submit reading "Delete
// this vault". For a member every one of those is false in the dangerous
// direction: the vault is not theirs to destroy and the removal is reversible
// (they can add it again from their own recovery phrase). The member arm must
// carry the member heading, its eyebrow and the shared disclosure, and the owner's
// copy must be ABSENT.
//
// # What is asserted, and why each half is needed
//
//  1. The disclosure is pinned by FULL-literal equality against
//     `MEMBER_VAULT_REMOVAL_DISCLOSURE` (imported through the client shim, so the
//     re-export is what is under test, not a second copy written here).
//  2. The owner's warning is absent; the entry label and the submit label are the
//     member sentences; the panel title is the member heading.
//  3. The owner arm still shows its own copy, so the member branch cannot have
//     leaked across.
//  4. Every member key is resolved non-empty in `locales/en/common.json`, because
//     `useTranslation` echoes keys here and an echoed key passes while the shipped
//     phone renders nothing (the mobile AGENTS.md gotcha).
//
// The sheet's only real data dependencies on the path under test are the account
// plane (`useMemberVault`) and the prefs/sync hooks the whole sheet reads, so those
// are stubbed and everything else runs as written. `HAS_TAURI` is left real (false
// under jsdom), which is what keeps the sheet's host-touching effects inert.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plane = vi.hoisted(() => ({ value: "owner" as "owner" | "member" | "unknown" }));

vi.mock("../../src/hooks/useMemberVault", () => ({
  useMemberVault: () => plane.value,
}));
vi.mock("../../src/lib/use-sync-status", () => ({
  useSyncStatus: () => ({
    status: null,
    reconciling: false,
    dismissReconcile: () => {},
    integrityAlert: false,
    syncNow: async () => {},
    busy: false,
  }),
}));
// The prefs hook is stubbed to its own default view, so the sheet renders without
// a host while the DEFAULT_PREFS the shipped client falls back to is kept REAL.
vi.mock("../../src/lib/use-prefs", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/use-prefs")>();
  return {
    ...real,
    usePrefs: () => ({ prefs: real.DEFAULT_PREFS, loading: false, error: false, reload: () => {} }),
  };
});
// `useTranslation` echoes keys; `i18n.language` is read by the language row.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import { SettingsSheet } from "../../src/app/flows/SettingsSheet";
import {
  MEMBER_VAULT_REMOVAL_DISCLOSURE,
} from "../../src/lib/load-bearing-copy";
import enCatalog from "@myne/locales-en";

const EN_CATALOG = enCatalog as Record<string, unknown>;

function localeValue(key: string): unknown {
  let node: unknown = EN_CATALOG;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Every member key this surface reaches, so the catalog claim is one list. */
const MEMBER_REMOVAL_KEYS = [
  "settings.deleteVault.memberHeading",
  "settings.deleteVault.memberEyebrow",
  "settings.deleteVault.memberSubmit",
  "settings.deleteVault.keychainNote",
];

afterEach(() => cleanup());

beforeEach(() => {
  plane.value = "owner";
});

function renderSheet(initialPanel: "account" | "delete-vault") {
  render(
    <SettingsSheet
      vaultId={"vault-id-hex"}
      onClose={() => {}}
      onLock={() => {}}
      onDeleteVaultSuccess={() => {}}
      initialPanel={initialPanel}
    />,
  );
}

describe("SettingsSheet member-vault removal copy (audit K2-i)", () => {
  it("labels the danger-zone entry with the member sentence", () => {
    plane.value = "member";
    renderSheet("account");
    expect(screen.getByTestId("settings.account.delete-vault").textContent).toBe(
      "settings.deleteVault.memberSubmit",
    );
  });

  it("renders the shared disclosure verbatim and drops the owner's warning", () => {
    plane.value = "member";
    renderSheet("delete-vault");

    expect(screen.getByTestId("settings.member-removal-disclosure").textContent).toBe(
      MEMBER_VAULT_REMOVAL_DISCLOSURE,
    );
    expect(screen.getByTestId("settings.member-remove-eyebrow").textContent).toBe(
      "settings.deleteVault.memberEyebrow",
    );
    expect(screen.getByTestId("settings.panel-title").textContent).toBe(
      "settings.deleteVault.memberHeading",
    );
    // The owner's permanent-deletion warning is absent, not corrected after.
    expect(screen.queryByText("settings.deleteVault.warning")).toBeNull();
    // myne-md/myne#761: iOS destroys the per-vault keychain item on this same
    // command, so the sentence is reachable on the member arm too. It sits one
    // press away since myne-md/myne#960, which is why this opens the info sheet
    // rather than reading a standing paragraph: "reachable" is the claim, and a
    // trigger that opened nothing would still satisfy a reading of the trigger.
    fireEvent.click(screen.getByTestId("settings.delete-vault.keychain-note-trigger"));
    expect(screen.getByTestId("settings.delete-vault.keychain-note-sheet").textContent).toBe(
      "settings.deleteVault.keychainNote",
    );
    // The submit carries the member sentence, not "Delete this vault".
    expect(screen.getByRole("button", { name: "settings.deleteVault.memberSubmit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "settings.deleteVault.deleteButton" })).toBeNull();
  });

  it("keeps the owner copy on an owner vault", () => {
    renderSheet("delete-vault");

    expect(screen.getByText("settings.deleteVault.warning")).toBeTruthy();
    expect(screen.queryByTestId("settings.member-removal-disclosure")).toBeNull();
    fireEvent.click(screen.getByTestId("settings.delete-vault.keychain-note-trigger"));
    expect(screen.getByTestId("settings.delete-vault.keychain-note-sheet").textContent).toBe(
      "settings.deleteVault.keychainNote",
    );
    expect(screen.getByTestId("settings.panel-title").textContent).toBe(
      "settings.deleteVault.heading",
    );
    expect(screen.getByRole("button", { name: "settings.deleteVault.deleteButton" })).toBeTruthy();
  });

  it("keeps the owner entry label on an owner vault", () => {
    renderSheet("account");
    expect(screen.getByTestId("settings.account.delete-vault").textContent).toBe(
      "settings.deleteVault.heading",
    );
  });

  it("resolves every member key in the English catalog", () => {
    expect(
      MEMBER_REMOVAL_KEYS.filter((key) => {
        const value = localeValue(key);
        return typeof value !== "string" || value === "" || value === key;
      }),
    ).toEqual([]);
  });
});
