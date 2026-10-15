// myne-md/myne#476: the erase targets the vault the user is looking at, on the
// two entry paths that never stamped `registry.json`.
//
// **What this covers that VU-12 does not.** `vault-unlock.e2e.ts`'s VU-12 drives
// the lost-credentials delete from the unlock screen, with ONE vault seeded, so
// "the right vault was erased" is true by arithmetic there: there is only one.
// The failure myne-md/myne#241 shipped needs two, and it needs an entry path
// that does not write the on-disk active-vault marker the old resolver read.
// Password unlock writes it. Quick-unlock and recovery do not, and those are
// exactly the two paths a user reaches after the first day.
//
// So each scenario seeds TWO vaults, enters through one of those two paths, and
// asserts BOTH directions: the vault the user was in is gone, and the other one
// is still on disk. Asserting only the first passes on a build that erases
// everything, and asserting only the second passes on a build that erases
// nothing.
//
// **Why the directory rather than the UI.** The post-delete route is a reprobe,
// so with one vault left the app lands on that vault's unlock screen either way.
// The screen looks identical whether the correct vault or the wrong one was
// destroyed. The filesystem is the only observable that can tell them apart,
// which is why the assertions read `vaults/<id>` directly and the routed screen
// is a secondary check rather than the evidence.
//
// SYNC-13: no assertion prints a password or a phrase. The fixture's
// credentials are used as inputs and never reach an expectation's diff.

import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describeE2E, scenario } from "./support/scenario";
import {
  closeSettings,
  completePasswordReset,
  dismissImporterOfferIfPresent,
  enterRecoveryPhrase,
  openSettings,
  selectPickerRow,
  unlockToEditor,
} from "./support/flows";
import { seedVaults, type SeededVault } from "./support/fixtures";
import { testIdSelector, type Session } from "./support/webdriver";

const PIN = "246813";
const NEW_PASSWORD = "Qw8#nT4!zX2&pL6v-vdel";

/** `<appDataDir>/vaults/<id>`, the directory a completed erase removes. */
function vaultDir(appDataDir: string, vaultId: string): string {
  return join(appDataDir, "vaults", vaultId);
}

/**
 * Configure a PIN in Settings -> Privacy from an unlocked editor.
 *
 * Deliberately a second copy of `quick-unlock.e2e.ts`'s helper rather than an
 * import from it: that file is a scenario module, and importing across scenario
 * files couples two suites' budgets. The completion signal is the same and the
 * reason is the same: setup runs Argon2id off the UI thread, so reading the
 * status text the instant the (always-present) status element is found races it.
 * Waiting for the setup button to UNMOUNT is what settles.
 */
async function configurePin(s: Session): Promise<void> {
  await openSettings(s, "privacy");
  await (await s.byTestId("settings.quick-unlock-toggle")).click();
  await (await s.byTestId("settings.quick-unlock-pin-input")).replaceText(PIN);
  await (await s.byTestId("settings.quick-unlock-setup-pin")).click();
  await s.waitForGone(testIdSelector("settings.quick-unlock-setup-pin"));
  await closeSettings(s);
}

/**
 * Settings -> Vault -> Delete vault, typed confirmation, submit.
 *
 * Stops at the click: what happens next is the assertion each scenario makes
 * for itself, and a helper that waited for a particular next screen would be
 * asserting the routing rather than the erase.
 */
async function eraseFromSettings(s: Session): Promise<void> {
  await openSettings(s, "vault");
  await (await s.byTestId("settings.delete-vault-cta")).click();
  const confirm = await s.byTestId("delete-vault.confirm-input", { timeoutMs: 10_000 });
  await confirm.sendKeys("DELETE");
  const submit = await s.byTestId("delete-vault.submit");
  await s.waitUntil(() => submit.enabled(), {
    label: "delete submit enabled on exact DELETE",
    timeoutMs: 10_000,
  });
  await submit.click();
}

describeE2E("vd1 post-quick-unlock erase targets the open vault (myne#476)", () => {
  it("erases the vault entered by PIN and leaves the other one on disk", async () => {
    // Vault-count precondition: 2 -> 1. The second vault is the control, and it
    // is never opened in this scenario: it exists only to make "which one" a
    // real question.
    let vaults: SeededVault[] = [];
    await scenario(
      "vd1-quick-unlock-erase",
      {
        seed: (appDataDir) => {
          vaults = seedVaults(appDataDir, { count: 2 });
        },
      },
      async (app) => {
        const s = app.session;
        const [target, survivor] = vaults;

        // Two vaults on disk -> the picker. Take the target explicitly, so the
        // scenario does not depend on which row the picker happens to order
        // first.
        await selectPickerRow(s, target.vaultId);
        await unlockToEditor(s, target.password);
        await dismissImporterOfferIfPresent(s);

        await configurePin(s);

        // Lock, then re-enter with the PIN. This is the whole point of the
        // scenario: the session that performs the erase was established by
        // quick-unlock, not by a password.
        await (await s.byTestId("editor.lock-cta")).click();
        await (await s.byTestId("unlock.quick-pin-input", { timeoutMs: 20_000 })).replaceText(PIN);
        await (await s.byTestId("unlock.quick-pin-submit")).click();
        await s.byTestId("editor.root", { timeoutMs: 20_000 });
        await dismissImporterOfferIfPresent(s);

        await eraseFromSettings(s);

        // One vault left, so the reprobe lands on ITS unlock screen. That is
        // the same screen a wrongly-targeted erase would produce, which is why
        // it is a liveness check rather than the assertion.
        await s.byTestId("unlock.password-input", { timeoutMs: 30_000 });

        expect(
          existsSync(vaultDir(app.appDataDir, target.vaultId)),
          "the vault the user was inside survived the erase",
        ).toBe(false);
        expect(
          existsSync(vaultDir(app.appDataDir, survivor.vaultId)),
          "the OTHER vault was erased; the target was resolved wrongly",
        ).toBe(true);
      },
    );
  });
});

describeE2E("vd2 post-recovery erase targets the recovered vault (myne#476)", () => {
  it("erases the vault entered by recovery phrase and leaves the other one on disk", async () => {
    // Vault-count precondition: 2 -> 1, same shape as vd1, different entry
    // path. Recovery rewrites the password wrap and re-enters the editor
    // without ever going through the password form, which is the second way a
    // session exists with no active-vault marker written for it.
    let vaults: SeededVault[] = [];
    await scenario(
      "vd2-recovery-erase",
      {
        seed: (appDataDir) => {
          vaults = seedVaults(appDataDir, { count: 2 });
        },
      },
      async (app) => {
        const s = app.session;
        const [target, survivor] = vaults;

        await selectPickerRow(s, target.vaultId);
        await s.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await (await s.byTestId("unlock.recovery-link")).click();

        // **At two or more vaults the recovery link mounts the SELECT step, not
        // the phrase grid** (VR-15 in `vault-recovery.e2e.ts` states it in one
        // line). Waiting for `recover.phrase-grid` here instead failed 3 runs of
        // 3, reporting that the grid never appeared or that cell 0 "vanished",
        // which reads as a re-render race and is really a screen that was never
        // on the way. The vault has to be chosen before there is a phrase to
        // type, and choosing it is also what threads the target through A8d and
        // A8f (SYNC-17).
        await (
          await s.waitForElement(
            testIdSelector("recover.select-row", { "data-vault-id": target.vaultId }),
          )
        ).click();
        await s.byTestId("recover.phrase-grid", { timeoutMs: 15_000 });

        await enterRecoveryPhrase(s, target.phrase);
        await (await s.byTestId("recover.submit")).click();

        // Argon2id twice (unwrap, then re-wrap under the new password), so the
        // reset step's budget is the recovery suite's rather than a default.
        await s.byTestId("recover.reset.password-input", { timeoutMs: 60_000 });
        await completePasswordReset(s, NEW_PASSWORD);
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        await dismissImporterOfferIfPresent(s);

        await eraseFromSettings(s);

        await s.byTestId("unlock.password-input", { timeoutMs: 30_000 });

        expect(
          existsSync(vaultDir(app.appDataDir, target.vaultId)),
          "the recovered vault survived the erase",
        ).toBe(false);
        expect(
          existsSync(vaultDir(app.appDataDir, survivor.vaultId)),
          "the OTHER vault was erased; the target was resolved wrongly",
        ).toBe(true);
      },
    );
  });
});
