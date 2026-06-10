// Change-password suite (MYND-224, e2e-expansion wave 2).
//
// Pins the Settings → Account → Change password flow end-to-end on the
// production bundle: the rotation happy path (NO relock — the slot stays
// Unlocked, only the password wrap rotates; commands.rs logs
// "root_key unchanged"), the form's gating shapes, and the load-bearing
// invariant that a password change leaves the RECOVERY WRAP untouched —
// proven here end-to-end by recovering with the original phrase after a
// rotation (the Rust suite pins the same invariant at byte level:
// vault_change_password/commands.rs byte-range asserts).
//
// KDF: weak generator fixtures (SYNC-9) — change_password re-derives with
// the params read from vault.meta (commands.rs:236), no code branch.
//
// SYNC-13: passwords appear only as in-source scenario constants; no
// assert prints a typed value on failure (gating asserts are boolean,
// banner asserts compare PUBLIC copy literals).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  completePasswordReset,
  dismissImporterOffer,
  enterRecoveryPhrase,
  openSettings,
  unlockToEditor,
} from "./support/flows";
import { UNLOCK_NON_DISTINGUISHING_BANNER } from "../src/lib/load-bearing-copy";
import { testIdSelector, type Session } from "./support/webdriver";

// AccountPanel.tsx `mapChangePasswordError` — InvalidCredentialOrVault
// leg. Inline production copy (not in load-bearing-copy.ts); full-literal
// equality here is what pins it against a silent collapse.
const WRONG_CURRENT_BANNER = "Wrong current password or vault file is corrupted.";

/** Open Settings → Account → "Change password" and wait for the form. */
async function openChangePasswordForm(session: Session): Promise<void> {
  await openSettings(session);
  await (await session.byTestId("settings.change-password-cta")).click();
  await session.byTestId("change-password.submit");
}

/** Fill all three fields. Does NOT wait on the submit gate — cp2's
 *  gating cases assert the submit stays disabled. */
async function fillChangePassword(
  session: Session,
  current: string,
  next: string,
  confirm = next,
): Promise<void> {
  await (await session.byTestId("change-password.current")).replaceText(current);
  await (await session.byTestId("change-password.new")).replaceText(next);
  await (await session.byTestId("change-password.confirm")).replaceText(confirm);
}

/** Wait out the zxcvbn gate, then submit. */
async function submitChangePassword(session: Session): Promise<void> {
  const submit = await session.byTestId("change-password.submit");
  await session.waitUntil(() => submit.enabled(), {
    label: "submit enabled (zxcvbn ready)",
    timeoutMs: 15_000,
  });
  await submit.click();
}

describeE2E("cp1 rotation happy path — no relock (MYND-224)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("rotates in place, then the old password fails with the compound literal and the new one opens", async () => {
    const NEW_PASSWORD = "korkuluk-deniz-91-fener";
    let fixture!: SeededVault;
    await scenario(
      "cp1-rotate-no-relock",
      { seed: (dir) => void (fixture = seedVault(dir)) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, fixture.password);
        await dismissImporterOffer(s);

        await openChangePasswordForm(s);
        await fillChangePassword(s, fixture.password, NEW_PASSWORD);
        await submitChangePassword(s);

        // Success closes the modal and toasts — and does NOT relock:
        // the editor stays mounted, no unlock form appears.
        const toast = await s.byTestId("editor.toast", { timeoutMs: 20_000 });
        expect(await toast.text()).toBe("Password updated");
        await s.waitForGone(testIdSelector("settings.modal"));
        await s.byTestId("editor.root");
        expect((await s.byTestIdAll("unlock.password-input")).length).toBe(0);

        // Lock, then prove the rotation took: the OLD password now fails
        // with the §7.3 compound literal (full equality), the NEW opens.
        await (await s.byTestId("editor.lock-cta")).click();
        const input = await s.byTestId("unlock.password-input");
        await input.sendKeys(fixture.password);
        await (await s.byTestId("unlock.submit")).click();
        const banner = await s.byTestId("unlock.error-banner", { timeoutMs: 15_000 });
        expect(await banner.text()).toBe(UNLOCK_NON_DISTINGUISHING_BANNER);
        await input.replaceText(NEW_PASSWORD);
        await (await s.byTestId("unlock.submit")).click();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
      },
    );
  });
});

describeE2E("cp2 form gating + wrong-current banner (MYND-224)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("weak/mismatched input never enables submit; a wrong current password reports the full literal", async () => {
    const NEW_PASSWORD = "korkuluk-deniz-91-fener";
    let fixture!: SeededVault;
    await scenario(
      "cp2-gating",
      { seed: (dir) => void (fixture = seedVault(dir)) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, fixture.password);
        await dismissImporterOffer(s);
        await openChangePasswordForm(s);
        const submit = await s.byTestId("change-password.submit");

        // Too-short new password (frontend MIN_PASSWORD_LEN gate).
        await fillChangePassword(s, fixture.password, "kisa-parola");
        expect(await submit.enabled()).toBe(false);

        // Confirm mismatch.
        await fillChangePassword(s, fixture.password, NEW_PASSWORD, `${NEW_PASSWORD}-x`);
        expect(await submit.enabled()).toBe(false);

        // Wrong current password: the frontend cannot pre-flight this —
        // the backend AEAD verify rejects and the form maps it to the
        // banner. Asserted by FULL literal so a copy collapse fails.
        await fillChangePassword(s, "definitely-not-the-password", NEW_PASSWORD);
        await submitChangePassword(s);
        const banner = await s.byTestId("change-password.error", { timeoutMs: 20_000 });
        expect(await banner.text()).toBe(WRONG_CURRENT_BANNER);

        // Wrong-current is retryable: the form stayed mounted.
        expect((await s.byTestIdAll("change-password.submit")).length).toBe(1);
      },
    );
  });
});

describeE2E("cp3 recovery invariant across a rotation (MYND-224)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the original phrase still recovers a vault whose password was rotated", async () => {
    const NEW_PASSWORD = "korkuluk-deniz-91-fener";
    const RESET_PASSWORD = "yelkovan-kuyu-37-akasya";
    let fixture!: SeededVault;
    await scenario(
      "cp3-recovery-invariant",
      { seed: (dir) => void (fixture = seedVault(dir)) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, fixture.password);
        await dismissImporterOffer(s);

        // Rotate the password.
        await openChangePasswordForm(s);
        await fillChangePassword(s, fixture.password, NEW_PASSWORD);
        await submitChangePassword(s);
        await s.waitForGone(testIdSelector("settings.modal"), { timeoutMs: 20_000 });

        // Lock, enter recovery with the ORIGINAL seeded phrase. If the
        // rotation had touched the recovery wrap, A8d would fail with
        // the non-distinguishing banner here instead of advancing.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await (await s.byTestId("unlock.recovery-link")).click();
        await enterRecoveryPhrase(s, fixture.phrase);
        await (await s.byTestId("recover.submit")).click();
        await completePasswordReset(s, RESET_PASSWORD);
        await s.byTestId("editor.root", { timeoutMs: 30_000 });

        // And the chained reset password is now the live credential.
        await (await s.byTestId("editor.lock-cta")).click();
        const input = await s.byTestId("unlock.password-input");
        await input.sendKeys(RESET_PASSWORD);
        await (await s.byTestId("unlock.submit")).click();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
      },
    );
  });
});
