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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const hasMock = vi.fn((_cap: string) => true);
vi.mock("../../src/platform/capabilities", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/capabilities")>();
  return { ...real, has: (cap: string) => hasMock(cap) };
});

const { DeleteVaultConfirmForm } = await import("../../src/components/DeleteVaultConfirmForm");
const { LOCAL_ERASE_DISCLOSURE, MEMBER_VAULT_REMOVAL_DISCLOSURE } = await import("@myne/copy");
// The suite loads the real English catalog, so `t()` resolves. Resolving the
// expected strings through the SAME catalog rather than pasting them keeps this
// a test of the BRANCH; the wording of the i18n'd half is the catalog's business
// and only the load-bearing constant is pinned literally.
const i18n = (await import("../../src/i18n")).default;

afterEach(() => {
  cleanup();
  hasMock.mockReset();
});

/** The delete disclosure's own text: the mechanics that moved behind the
 *  question mark with myne-md/myne#960. Present while collapsed, which is what
 *  lets a claim about the copy be asserted without opening anything. */
function disclosureText(): string {
  return screen.getByTestId("delete-vault.details-explanation").textContent ?? "";
}

/**
 * The label the disclosure's trigger shows, and the assertion that it is
 * VISIBLE text rather than only the trigger's accessible name.
 *
 * A bare question mark is the right shape in Settings, where it rides directly
 * after a setting's title and the icon means "more about THIS". In this dialog
 * there is no such title, and the icon-only trigger shipped a lone glyph under
 * the warning with nothing on screen saying what it explained: a control whose
 * subject exists only in its accessible name, which no audit catches and which
 * fails every reader who is looking rather than listening. Found from the
 * before/after capture on myne-md/myne#960, not by a test.
 */
/** The trigger is an ICON whose accessible name is the label (owner, 2026-11-08:
 *  the labelled button was a whole sentence of chrome beside the one sentence
 *  that matters). "Icon-only" here means no text node, not "unlabelled". */
function expectTriggerIsIconOnly(): void {
  const trigger = screen.getByRole("button", {
    name: i18n.t("settings.deleteVault.detailsLabel"),
  });
  expect(trigger.textContent?.trim() ?? "").toBe("");
}

/** Render the idle-mode form with `localOnlyVault` answered by `only`. */
function renderForm(only: boolean, variant?: "owner" | "member", keychain = true) {
  hasMock.mockImplementation((cap: string) => {
    if (cap === "localOnlyVault") return only;
    if (cap === "biometricQuickUnlock") return keychain;
    return true;
  });
  render(
    <DeleteVaultConfirmForm
      onSubmit={() => {}}
      onCancel={() => {}}
      onContinueAfterPartial={() => {}}
      partialFailContext={null}
      variant={variant}
    />,
  );
}

// **The inline layout is a different flow, not different spacing**
// (myne-md/myne#1020). `VaultPanel` used to hold a CTA whose only job was to
// replace the panel with this form, so the form introduced itself: its own
// heading, its own eyebrow, and a Cancel that went back to what the press came
// from. In Settings it is simply on the page under the section's own heading.
// These assertions are what says that, and they are STRUCTURAL on purpose: the
// typed-`DELETE` gate is asserted alongside them, because a layout that dropped
// the gate would be a much worse bug than one that kept a heading.
describe("the inline layout", () => {
  function renderInline() {
    hasMock.mockImplementation((cap: string) => {
      if (cap === "localOnlyVault") return false;
      if (cap === "biometricQuickUnlock") return true;
      return true;
    });
    render(
      <DeleteVaultConfirmForm
        layout="inline"
        onSubmit={() => {}}
        onCancel={() => {}}
        onContinueAfterPartial={() => {}}
        partialFailContext={null}
      />,
    );
  }

  it("does not introduce itself: no heading, no eyebrow, no cancel", () => {
    renderInline();
    expect(screen.queryByTestId("delete-vault.heading")).toBeNull();
    expect(screen.queryByTestId("delete-vault.eyebrow")).toBeNull();
    expect(screen.queryByTestId("delete-vault.cancel")).toBeNull();
  });

  it("still states the disclosure and still gates the erase on the typed word", () => {
    renderInline();
    // The claim the section deliberately does NOT repeat (it renders here once).
    expect(disclosureText().length).toBeGreaterThan(0);
    const submit = screen.getByTestId("delete-vault.submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("delete-vault.confirm-input"), {
      target: { value: "DELETE" },
    });
    expect((screen.getByTestId("delete-vault.submit") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("does not steal the caret, and the panel layout still does", () => {
    // A settings panel that focuses an irreversible field the moment its tab
    // opens is a trap; the panel layout is the result of a press, so focusing
    // the gate there is a service. Both halves are asserted, since either one
    // alone is satisfied by simply removing `autoFocus`.
    cleanup();
    renderForm(false);
    expect(document.activeElement).toBe(screen.getByTestId("delete-vault.confirm-input"));
    cleanup();
    renderInline();
    expect(document.activeElement).not.toBe(screen.getByTestId("delete-vault.confirm-input"));
  });
});

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

  /**
   * The disclosure's trigger says on screen what it is for. Asserted inside a
   * test that already renders the form, because `visibleLabel` is a property of
   * the shape this dialog chose, not of the primitive.
   */
  it("renders the disclosure trigger as an icon that still carries its name", () => {
    renderForm(true);
    expectTriggerIsIconOnly();
  });

  /**
   * The trigger sits on the HEADING's line, at its trailing edge.
   *
   * A labelled button parked under the warning reads as a step in the flow (the
   * thing to do next) rather than as an annotation on the title, which is the
   * one thing a question mark means. The assertion is structural on purpose: no
   * layout runs here, so "is it in the heading row" is the only property jsdom
   * can honestly hold, and it is the property that decides what the eye reads.
   */
  it("puts the disclosure on the heading's own line", () => {
    renderForm(true);
    const heading = screen.getByTestId("delete-vault.heading");
    const trigger = screen.getByRole("button", {
      name: i18n.t("settings.deleteVault.detailsLabel"),
    });
    expect(heading.parentElement?.contains(trigger)).toBe(true);
  });

  it("keeps the desktop copy where it is true, without an eyebrow over it", () => {
    renderForm(true);
    const body = document.body.textContent ?? "";
    expect(body).toContain(i18n.t("settings.deleteVault.copyPrimary"));
    expect(body).not.toContain(LOCAL_ERASE_DISCLOSURE);
    // The owner vault's eyebrow is GONE (owner, 2026-11-08): "IRREVERSIBLE" over a
    // sentence that already says "cannot be undone" is one fact twice. The two
    // capability-shaped eyebrows stay, because those name WHICH store the command
    // touches — asserted on the web branch right below.
    expect(screen.queryByTestId("delete-vault.eyebrow")).toBeNull();
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

  /**
   * myne-md/myne#761: the erase destroys the per-vault keychain item on the
   * platforms that have one, and there is none on the others. The sentence is
   * the non-Apple half of the class rule, so it is asserted on the arm that
   * carries a keychain and ABSENT on the browser, whose copy is a different
   * claim about a different store.
   */
  it("says which platforms have a quick-unlock keychain item to erase", () => {
    // The Tauri client: it HAS the provider and therefore an item to erase. The
    // gate is the capability, not `localOnlyVault`: asserting this on the web arm
    // is what certified the inversion this test now guards against.
    //
    // The sentence moved into the disclosure's description element with
    // myne-md/myne#960 (it was a standing grey paragraph). The CLAIM is
    // unchanged, so the assertion reads the description element rather than a
    // paragraph testid of its own, and the description element is in the
    // document while collapsed, which is `HelperDisclosure`'s contract, and the
    // reason this still works without opening anything.
    renderForm(true);
    expect(disclosureText()).toContain(i18n.t("settings.deleteVault.keychainNote"));
  });

  it("does not claim a keychain cleanup on a client that has no keychain", () => {
    // The browser: no provider, no item, no sentence. The zeroization sentence
    // it DOES carry is asserted alongside, so a disclosure that rendered nothing
    // at all could not pass this by being empty.
    renderForm(false, undefined, false);
    const text = disclosureText();
    expect(text).toContain(i18n.t("settings.deleteVault.copySecondary"));
    expect(text).not.toContain(i18n.t("settings.deleteVault.keychainNote"));
  });

  it("answers the gate with the capability, not with `onlyCopy`", () => {
    // The two values CO-VARY on every case above (the Tauri client is both the
    // only copy and the one with a keychain), so those two specs cannot tell the
    // two predicates apart. Measured: `const hasKeychainItem = onlyCopy;` left
    // them green. This case is the disagreement: a copy that is NOT the only one,
    // on a client that still has a keychain item to erase.
    renderForm(false, undefined, true);
    expect(disclosureText()).toContain(i18n.t("settings.deleteVault.keychainNote"));
  });
});

describe("the member vault's removal (audit K2-i)", () => {
  /**
   * Both capability answers, because the defect this covers was ON the desktop
   * arm: `localOnlyVault` is true there, so a member vault fell into the owner
   * branch and read "Delete vault … cannot be undone … your recovery phrase will
   * not restore the data". The member sentence is checked FIRST for exactly this
   * reason, and the test drives both answers so the ordering cannot regress.
   */
  for (const only of [true, false]) {
    it(`renders the member disclosure VERBATIM where localOnlyVault=${only}`, () => {
      renderForm(only, "member");
      expect(screen.getByTestId("delete-vault.member-removal-disclosure").textContent).toBe(
        MEMBER_VAULT_REMOVAL_DISCLOSURE,
      );
    });

    /**
     * The claim that must not survive, stated as absence rather than as a
     * correction: a member who reads "permanently deletes this vault and every
     * note inside it" has already been told their shared vault is gone.
     */
    it(`never shows the owner's permanent-deletion copy to a member (localOnlyVault=${only})`, () => {
      renderForm(only, "member");
      const body = document.body.textContent ?? "";
      expect(body).not.toContain(i18n.t("settings.deleteVault.copyPrimary"));
      expect(body).not.toContain(LOCAL_ERASE_DISCLOSURE);
      expect(body).not.toContain(i18n.t("settings.deleteVault.eyebrow"));
      expect(screen.getByTestId("delete-vault.eyebrow").textContent).toBe(
        i18n.t("settings.deleteVault.memberEyebrow"),
      );
      expect(screen.getByTestId("delete-vault.heading").textContent).toBe(
        i18n.t("settings.deleteVault.memberHeading"),
      );
      expect(screen.getByTestId("delete-vault.submit").textContent).toBe(
        i18n.t("settings.deleteVault.memberSubmit"),
      );
    });
  }

  it("keeps the typed confirmation on the member arm too", () => {
    // Unsynced edits on this device die with its copy, and the last sentence of
    // the disclosure says so; the gate is what backs it.
    renderForm(true, "member");
    expect(screen.getByTestId("delete-vault.confirm-input")).toBeTruthy();
    expect((screen.getByTestId("delete-vault.submit") as HTMLButtonElement).disabled).toBe(true);
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
