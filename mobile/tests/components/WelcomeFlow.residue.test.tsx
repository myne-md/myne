// @vitest-environment jsdom
//
// The Welcome screen's leftover-cleanup banner (myne-md/myne#159 surface,
// `decisions/clients/0746`).
//
// # The failure this pins
//
// The banner used to be driven by ONE number from ONE resolved path, and the
// button behind it was the gate-free sweep. Two states made that a lie, and
// both were reachable on a real phone:
//
//   1. the resolved path was a LIVE vault, so the count was a healthy vault's
//      file count and the sweep refused it as `VaultPresent` for ever;
//   2. the residue still carried a `vault.meta`, so the sweep refused it for
//      ever as well.
//
// Either way the user got "Couldn't finish cleaning up. Please try again." on
// every tap, with nothing saying retrying could not work. The report is now per
// root and carries `hasVaultMeta`, so the surface can route the second case to
// the typed DELETE that owns it.
//
// # What is asserted, and why each half is needed
//
//  1. A repairable-only report shows the cleanup action and the count is the
//     REPAIRABLE entries only, so a live-or-gated neighbour cannot inflate it.
//  2. A `vault.meta`-carrying root NEVER gets the gate-free button, and the
//     delete it does get is inert until DELETE is typed.
//  3. `PartialDelete` renders its own sentence WITH the count, instead of the
//     generic failure line that swallowed the taxonomy.
//  4. Every key this surface reaches resolves non-empty in
//     `locales/en/common.json`, because `useTranslation` echoes keys here and
//     an echoed key passes while the shipped phone renders nothing (the mobile
//     AGENTS.md gotcha).
//
// `useTranslation` interpolates its options in this file (unlike the plain
// echo other mobile specs use) because the COUNT is the thing under test in
// assertions 1 and 3, and an echoed key cannot carry it.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scan = vi.hoisted(() => ({ value: [] as unknown[] }));
const scanSpy = vi.hoisted(() => vi.fn(async () => scan.value));
const repairSpy = vi.hoisted(() => vi.fn(async () => 0));
const deleteSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../src/lib/app-window", () => ({ HAS_TAURI: true }));
vi.mock("../../src/lib/vault-repair", () => ({
  vaultResidueScan: scanSpy,
  vaultRepair: repairSpy,
}));
vi.mock("../../src/lib/vault-delete", () => ({ deleteVault: deleteSpy }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts === undefined ? key : `${key}${JSON.stringify(opts)}`,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import { WelcomeFlow } from "../../src/app/flows/WelcomeFlow";
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

/** Every key this surface reaches, so the catalog claim is one list. */
const WELCOME_RESIDUE_KEYS = [
  "welcome.residueBanner",
  "welcome.cleanUpFiles",
  "welcome.repairResidue.cleaningUp",
  "welcome.repairCleanedUp_one",
  "welcome.repairCleanedUp_other",
  "welcome.repairFailed",
  "welcome.repairResidue.partialBody_one",
  "welcome.repairResidue.partialBody_other",
  "welcome.repairResidue.cancel",
  "welcome.residueGated",
  "welcome.residueGatedDelete",
  "welcome.residueGatedHint",
  "settings.deleteVault.deleteError",
];

const noop = () => {};

async function renderWelcome() {
  const view = render(<WelcomeFlow onHaveIdentity={noop} onIdentity={noop} />);
  // The scan is awaited in an effect, so the first paint has no banner yet.
  await waitFor(() => expect(scanSpy).toHaveBeenCalled());
  return view;
}

afterEach(() => cleanup());

beforeEach(() => {
  scan.value = [];
  scanSpy.mockClear();
  repairSpy.mockClear();
  repairSpy.mockImplementation(async () => 0);
  deleteSpy.mockClear();
});

describe("WelcomeFlow leftover banner", () => {
  it("counts only the repairable roots and sweeps them", async () => {
    scan.value = [
      { vaultId: "a", entries: 3, hasVaultMeta: false },
      { vaultId: "b", entries: 40, hasVaultMeta: true },
    ];
    repairSpy.mockImplementation(async () => 3);
    await renderWelcome();

    const banner = await screen.findByTestId("welcome.residue-banner");
    expect(banner.textContent).toContain(`{"n":3}`);
    expect(banner.textContent).not.toContain(`{"n":43}`);

    await act(async () => {
      fireEvent.click(screen.getByTestId("welcome.residue-clean"));
    });
    await waitFor(() => expect(repairSpy).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId("welcome.repair-message")).textContent).toContain(
      "welcome.repairCleanedUp",
    );
    // The gated root is NOT swept by the gate-free command.
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("never offers the gate-free cleanup over a vault.meta-carrying root", async () => {
    scan.value = [{ vaultId: "b", entries: 2, hasVaultMeta: true }];
    await renderWelcome();

    expect(await screen.findByTestId("welcome.residue-gated")).toBeTruthy();
    expect(screen.queryByTestId("welcome.residue-banner")).toBeNull();
    expect(screen.queryByTestId("welcome.residue-clean")).toBeNull();

    fireEvent.click(screen.getByTestId("welcome.residue-delete-open"));
    const confirm = screen.getByTestId("welcome.residue-delete") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("welcome.residue-delete-confirm"), {
      target: { value: "delete" },
    });
    await waitFor(() =>
      expect((screen.getByTestId("welcome.residue-delete") as HTMLButtonElement).disabled).toBe(false),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("welcome.residue-delete"));
    });
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith("b"));
    expect(repairSpy).not.toHaveBeenCalled();
  });

  it("reports a locked file with its count instead of the generic line", async () => {
    scan.value = [{ vaultId: "a", entries: 2, hasVaultMeta: false }];
    repairSpy.mockImplementation(async () => {
      throw { kind: "PartialDelete", detail: { remaining_count: 2 } };
    });
    await renderWelcome();

    await act(async () => {
      fireEvent.click(screen.getByTestId("welcome.residue-clean"));
    });
    const message = await screen.findByTestId("welcome.repair-message");
    expect(message.textContent).toContain("welcome.repairResidue.partialBody");
    expect(message.textContent).toContain(`{"count":2}`);
    expect(message.textContent).not.toBe("welcome.repairFailed");
  });

  it("resolves every key this surface reaches in the English catalog", () => {
    expect(
      WELCOME_RESIDUE_KEYS.filter((key) => {
        const value = localeValue(key);
        return typeof value !== "string" || value === "" || value === key;
      }),
    ).toEqual([]);
  });
});
