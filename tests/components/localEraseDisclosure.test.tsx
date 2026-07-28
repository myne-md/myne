// @vitest-environment jsdom
//
// What `vault_delete` promises, on a client where the promise is different
// (phase3-web-client task 72).
//
// The command is the same command on both clients and removes the same bytes.
// What differs is what the user is told, and getting that wrong is not a copy
// bug — it is a false statement about where someone's notes are:
//
//  * Desktop/mobile may hold the ONLY copy. "Permanently deletes… cannot be
//    undone… your recovery phrase will not restore the data" is true there.
//  * The web client's OPFS container is a CACHE of a sync-held vault
//    (`decisions.md` 2026-07-26 makes sync required). The same sentence there
//    would tell a user trying to destroy their notes that they had — while every
//    synced note sat on the server. That is the `REMOVE_DEVICE_DISCLOSURE`
//    failure shape ("removal is not a remote wipe") pointing the other way.
//
// So the branch is asserted from BOTH sides, by the load-bearing literal rather
// than by a substring: a paraphrase is a failing test, not a review comment.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const hasMock = vi.fn((_cap: string) => true);
vi.mock("../../src/platform/capabilities", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/capabilities")>();
  return { ...real, has: (cap: string) => hasMock(cap) };
});

const { DeleteVaultConfirmForm } = await import("../../src/components/DeleteVaultConfirmForm");
const { LOCAL_ERASE_DISCLOSURE } = await import("@myne/copy");
// The suite loads the real English catalog, so `t()` resolves. Resolving the
// expected strings through the SAME catalog rather than pasting them keeps this
// a test of the BRANCH; the wording of the i18n'd half is the catalog's business
// and only the load-bearing constant is pinned literally.
const i18n = (await import("../../src/i18n")).default;

afterEach(() => {
  cleanup();
  hasMock.mockReset();
});

/** Render the idle-mode form with `localOnlyVault` answered by `only`. */
function renderForm(only: boolean) {
  hasMock.mockImplementation((cap: string) => (cap === "localOnlyVault" ? only : true));
  render(
    <DeleteVaultConfirmForm
      onSubmit={() => {}}
      onCancel={() => {}}
      onContinueAfterPartial={() => {}}
      partialFailContext={null}
    />,
  );
}

describe("the delete-vault promise", () => {
  it("renders the local-erase disclosure VERBATIM where the vault is not the only copy", () => {
    renderForm(false);
    expect(screen.getByTestId("delete-vault.local-erase-disclosure").textContent).toBe(
      LOCAL_ERASE_DISCLOSURE,
    );
  });

  it("does not render it where the vault may be the only copy", () => {
    renderForm(true);
    expect(screen.queryByTestId("delete-vault.local-erase-disclosure")).toBeNull();
  });

  /**
   * The specific claim that must not survive the crossing: the permanent-
   * deletion sentence must be ABSENT, not merely joined by a caveat. A user who
   * reads "cannot be undone, and your recovery phrase will not restore the data"
   * has already made their decision by the time a second paragraph corrects it.
   */
  it("never shows the permanent-deletion copy on a sync-backed client", () => {
    renderForm(false);
    const body = document.body.textContent ?? "";
    expect(body).not.toContain(i18n.t("settings.deleteVault.copyPrimary"));
    expect(screen.getByTestId("delete-vault.eyebrow").textContent).toBe(
      i18n.t("settings.deleteVault.localEraseEyebrow"),
    );
  });

  it("keeps the desktop copy where it is true", () => {
    renderForm(true);
    const body = document.body.textContent ?? "";
    expect(body).toContain(i18n.t("settings.deleteVault.copyPrimary"));
    expect(body).not.toContain(LOCAL_ERASE_DISCLOSURE);
    expect(screen.getByTestId("delete-vault.eyebrow").textContent).toBe(
      i18n.t("settings.deleteVault.eyebrow"),
    );
  });

  /**
   * The typed-DELETE gate does NOT relax on the web branch. Unsynced edits die
   * with the local copy and nothing brings them back — the last sentence of the
   * disclosure says exactly that, and the gate is what backs it.
   */
  it("keeps the typed confirmation on both branches", () => {
    for (const only of [true, false]) {
      renderForm(only);
      expect(screen.getByTestId("delete-vault.confirm-input")).toBeTruthy();
      expect((screen.getByTestId("delete-vault.submit") as HTMLButtonElement).disabled).toBe(true);
      cleanup();
    }
  });
});

describe("the post-fail banner", () => {
  function renderFail(vaultDirPath: string | null) {
    hasMock.mockImplementation(() => true);
    render(
      <DeleteVaultConfirmForm
        onSubmit={() => {}}
        onCancel={() => {}}
        onContinueAfterPartial={() => {}}
        partialFailContext={{ kind: "partial-delete", remainingCount: 2, vaultDirPath }}
      />,
    );
  }

  it("shows the manual-cleanup path when there is one", () => {
    const path = "/home/a/.local/share/md.myne.desktop/vault";
    renderFail(path);
    expect(document.body.textContent).toContain(path);
  });

  /**
   * `path.appDataDir` is a typed refusal in the browser seam, so the web
   * consumer passes `null`. A "Vault path:" line with nothing after it would be
   * worse than its absence — it would point at a location the user cannot open.
   */
  it("omits the path line entirely when the client has no path", () => {
    renderFail(null);
    const body = document.body.textContent ?? "";
    // The label, not the value: an empty interpolation would still render it.
    expect(body).not.toContain(i18n.t("settings.deleteVault.vaultPath", { path: "" }).trim());
    expect(body).toContain(i18n.t("settings.deleteVault.partialFailTitle"));
  });
});
