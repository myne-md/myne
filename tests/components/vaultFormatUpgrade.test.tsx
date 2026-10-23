// @vitest-environment jsdom
//
// The explicit upgrade to one-phrase recovery, as the Settings row offers it
// (myne-md/myne#911 task 10).
//
// Three claims live here, and the third is the one a driver cannot make:
//
//  1. The row is OMITTED on a vault that already carries the person wrap. An
//     offer whose only outcome is `AlreadyUpgraded` is the affordance the
//     capability descriptor exists to keep off the screen, and this is the same
//     rule one layer down.
//  2. The two irreversible consequences appear BEFORE the confirming button, not
//     after it. The upgrade zeroes a recovery credential; a warning that arrives
//     with the result has warned nobody.
//  3. Each refusal names the remedy it actually has. `PersonRequired` and
//     `IdentityLocked` both mean "you need your identity" and mean two different
//     actions, so they cannot share a sentence.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const vaultIsPersonWrapped = vi.fn();
const upgradeVaultToNtv7 = vi.fn();

vi.mock("../../src/lib/vault-format-upgrade", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/vault-format-upgrade")>()),
  vaultIsPersonWrapped: (...args: unknown[]) => vaultIsPersonWrapped(...args),
  upgradeVaultToNtv7: (...args: unknown[]) => upgradeVaultToNtv7(...args),
}));

import { VaultFormatUpgrade } from "../../src/components/settings/VaultFormatUpgrade";
import i18n from "../../src/i18n";

beforeEach(() => {
  vaultIsPersonWrapped.mockReset();
  upgradeVaultToNtv7.mockReset();
});
afterEach(cleanup);

describe("the vault-format upgrade row", () => {
  it("is omitted when the vault already carries the person wrap", async () => {
    vaultIsPersonWrapped.mockResolvedValue(true);
    render(<VaultFormatUpgrade />);

    await waitFor(() => expect(vaultIsPersonWrapped).toHaveBeenCalled());
    // Nothing to press and nothing to read: the vault is already on the
    // one-phrase format.
    expect(screen.queryByTestId("settings.vault.format-cta")).toBeNull();
    expect(screen.queryByTestId("settings.vault.format-done")).toBeNull();
  });

  it("is omitted when the probe cannot answer at all", async () => {
    // A client with no person plane: the command refuses, so the row must not
    // be rendered against it.
    vaultIsPersonWrapped.mockRejectedValue({ kind: "Unsupported" });
    render(<VaultFormatUpgrade />);

    await waitFor(() => expect(vaultIsPersonWrapped).toHaveBeenCalled());
    expect(screen.queryByTestId("settings.vault.format-cta")).toBeNull();
  });

  it("names both irreversible consequences before the confirming button", async () => {
    vaultIsPersonWrapped.mockResolvedValue(false);
    upgradeVaultToNtv7.mockResolvedValue({
      upgraded_from: "NTV5",
      group_key_epoch: 1,
    });
    render(<VaultFormatUpgrade />);

    const cta = await screen.findByTestId("settings.vault.format-cta");
    // The offer alone carries no warning: it is one press away from a decision,
    // not the decision.
    expect(screen.queryByTestId("settings.vault.format-warning")).toBeNull();

    fireEvent.click(cta);
    const warning = await screen.findByTestId("settings.vault.format-warning");
    expect(warning.textContent).toContain(
      i18n.t("settings.vault.format.warningPhrase"),
    );
    expect(warning.textContent).toContain(
      i18n.t("settings.vault.format.warningDevices"),
    );
    // And the command has not run yet: the confirmation is a second press.
    expect(upgradeVaultToNtv7).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("settings.vault.format-confirm"));
    await waitFor(() => expect(upgradeVaultToNtv7).toHaveBeenCalledTimes(1));
    const done = await screen.findByTestId("settings.vault.format-done");
    expect(done.textContent).toContain("NTV5");
  });

  it("gives each refusal the remedy it actually has", async () => {
    vaultIsPersonWrapped.mockResolvedValue(false);
    upgradeVaultToNtv7.mockRejectedValue({ kind: "PersonRequired" });
    render(<VaultFormatUpgrade />);

    fireEvent.click(await screen.findByTestId("settings.vault.format-cta"));
    fireEvent.click(screen.getByTestId("settings.vault.format-confirm"));

    const error = await screen.findByTestId("settings.vault.format-error");
    expect(error.textContent).toBe(
      i18n.t("settings.vault.format.error.personRequired"),
    );
    // The row stays, so a user who creates the identity can come back rather
    // than hunting for a control that vanished.
    expect(screen.getByTestId("settings.vault.format-cta")).toBeTruthy();
  });

  it("cancelling leaves the vault untouched", async () => {
    vaultIsPersonWrapped.mockResolvedValue(false);
    render(<VaultFormatUpgrade />);

    fireEvent.click(await screen.findByTestId("settings.vault.format-cta"));
    fireEvent.click(screen.getByTestId("settings.vault.format-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("settings.vault.format-warning")).toBeNull(),
    );
    expect(upgradeVaultToNtv7).not.toHaveBeenCalled();
  });
});
