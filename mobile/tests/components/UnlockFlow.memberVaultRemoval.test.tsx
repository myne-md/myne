// @vitest-environment jsdom
//
// The member-vault removal copy on the unlock surface (audit K2-i, mobile half).
//
// # The failure this pins
//
// A SHARED (member) vault used to be shown the OWNER's destructive copy: the
// heading "Delete this vault?" and the lost-both-secrets sentence. Said to a
// member that is false twice in the dangerous direction — the shared vault is not
// theirs to destroy, and removing it from this device is reversible (they can add
// it again from their own recovery phrase). The member arm must render the member
// heading, its eyebrow, and the shared disclosure, and the owner's sentences must
// be ABSENT rather than followed by a correction.
//
// # What is asserted, and why each half is needed
//
//  1. The disclosure is pinned by FULL-literal equality against
//     `MEMBER_VAULT_REMOVAL_DISCLOSURE` — a substring match would pass a sentence
//     with a clause dropped, and the literal is the whole claim. It is imported
//     from the client shim (`src/lib/load-bearing-copy.ts`), so this also proves
//     the shim re-exports the shared family rather than declaring a second copy.
//  2. The owner's copy is ABSENT (heading and sentence), and the danger link and
//     submit carry the member sentences.
//  3. The owner arm still shows exactly what it showed before, so the member
//     branch cannot have leaked across.
//  4. Every member key the flow reaches is resolved in `locales/en/common.json`
//     non-empty: `useTranslation` echoes its keys here, so without this a
//     renamed or deleted key would pass these assertions while the shipped phone
//     renders the raw key. This is the mobile AGENTS.md gotcha made mechanical.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memberVaultStatus = vi.hoisted(() => vi.fn());
const memberUnlockStatus = vi.hoisted(() => vi.fn());
const quickUnlockStatus = vi.hoisted(() => vi.fn());
const deleteVault = vi.hoisted(() => vi.fn());
const soleVaultId = vi.hoisted(() => vi.fn());

// The member probe only runs behind a Tauri host, so the host is stubbed true and
// every command the Exists surface reaches on mount is stubbed too. The two
// member reads are the fixture that decides the arm under test.
vi.mock("../../src/lib/app-window", () => ({ HAS_TAURI: true, closeApp: vi.fn() }));
vi.mock("../../src/lib/personAccount", () => ({
  memberVaultStatus,
  memberUnlockStatus,
  personUnlockMemberVault: vi.fn(),
  personUnlockMemberVaultWithBiometric: vi.fn(),
  personUnlockMemberVaultWithPassword: vi.fn(),
  personUnlockMemberVaultWithPin: vi.fn(),
}));
vi.mock("../../src/lib/quick-unlock", () => ({
  quickUnlockStatus,
  quickUnlockWithPin: vi.fn(),
  quickUnlockWithBiometric: vi.fn(),
}));
vi.mock("../../src/lib/vault-delete", () => ({ deleteVault }));
vi.mock("../../src/lib/vault-list", () => ({ soleVaultId }));
vi.mock("../../src/lib/commands", () => ({ unlockWithPassword: vi.fn() }));
// `useTranslation` echoes keys, so the copy assertions below read as i18n keys
// rather than as English retyped here; `initReactI18next` is required because the
// shared `@myne/i18n` runtime calls it on import.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import { UnlockFlow } from "../../src/app/flows/UnlockFlow";
// The literal through the client shim: a second hand-copy in this file would test
// the copy rather than the re-export.
import {
  MEMBER_VAULT_REMOVAL_DISCLOSURE,
  LOST_BOTH_SECRETS_SENTENCE,
} from "../../src/lib/load-bearing-copy";
// The REAL English catalog (the alias the mobile test config resolves to it), so
// a key the flow echoes is proven to exist rather than assumed.
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
  "unlock.memberRemoveLink",
  "settings.deleteVault.memberHeading",
  "settings.deleteVault.memberEyebrow",
  "settings.deleteVault.memberSubmit",
  "settings.deleteVault.memberSubmitInFlight",
];

const VAULT_ID = "vault-id-hex";

beforeEach(() => {
  memberVaultStatus.mockReset().mockResolvedValue(false);
  memberUnlockStatus.mockReset().mockResolvedValue(null);
  quickUnlockStatus.mockReset().mockResolvedValue({ available: false });
  deleteVault.mockReset().mockResolvedValue(undefined);
  soleVaultId.mockReset().mockResolvedValue(VAULT_ID);
});

afterEach(() => cleanup());

function renderUnlock() {
  return render(
    <UnlockFlow
      initialStatus={{ kind: "Exists" }}
      vaultId={VAULT_ID}
      onUnlocked={() => {}}
      onStartRecovery={() => {}}
      onDeleteVaultSuccess={() => {}}
    />,
  );
}

/** Open the danger sheet and return its confirm button. */
async function openRemovalSheet(): Promise<HTMLButtonElement> {
  fireEvent.click(await screen.findByTestId("unlock-delete-link"));
  return (await screen.findByTestId("unlock-delete-confirm")) as HTMLButtonElement;
}

describe("UnlockFlow member-vault removal copy (audit K2-i)", () => {
  it("renders the shared disclosure verbatim and hides the owner's copy", async () => {
    memberVaultStatus.mockResolvedValue(true);
    renderUnlock();
    // The probe is async: the member label is the sentinel that the arm resolved.
    await screen.findByText("unlock.memberRemoveLink");
    await openRemovalSheet();

    // 1. Full-literal equality: the rendered bytes ARE the shared literal.
    expect(screen.getByTestId("unlock-member-removal-disclosure").textContent).toBe(
      MEMBER_VAULT_REMOVAL_DISCLOSURE,
    );
    expect(screen.getByTestId("unlock-member-remove-eyebrow").textContent).toBe(
      "settings.deleteVault.memberEyebrow",
    );

    // 2. The owner's permanent-deletion copy is absent, not corrected after.
    expect(screen.queryByText("unlock.deleteConfirmTitle")).toBeNull();
    expect(document.body.textContent ?? "").not.toContain(LOST_BOTH_SECRETS_SENTENCE);

    // 3. The action carries the member sentence, not "Delete vault".
    expect(screen.getByTestId("unlock-delete-link").textContent).toBe("unlock.memberRemoveLink");
    expect(screen.getByTestId("unlock-delete-confirm").textContent).toBe(
      "settings.deleteVault.memberSubmit",
    );
  });

  it("keeps the owner copy on an owner vault", async () => {
    renderUnlock();
    await screen.findByText("vaultRecover.phrase.deleteLink");
    await openRemovalSheet();

    expect(screen.getByText("unlock.deleteConfirmTitle")).toBeTruthy();
    expect(document.body.textContent ?? "").toContain(LOST_BOTH_SECRETS_SENTENCE);
    // The member arm did NOT leak into an owner vault.
    expect(screen.queryByTestId("unlock-member-removal-disclosure")).toBeNull();
    expect(screen.getByTestId("unlock-delete-link").textContent).toBe(
      "vaultRecover.phrase.deleteLink",
    );
    expect(screen.getByTestId("unlock-delete-confirm").textContent).toBe(
      "settings.deleteVault.heading",
    );
  });

  it("resolves every member key in the English catalog", () => {
    // The echoed-key half: a key the REAL catalog does not carry renders nothing
    // in the shipped app while passing every assertion above.
    expect(
      MEMBER_REMOVAL_KEYS.filter((key) => {
        const value = localeValue(key);
        return typeof value !== "string" || value === "" || value === key;
      }),
    ).toEqual([]);
  });
});
