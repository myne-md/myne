// VR-1 — the recovery drill at PRODUCTION KDF params (task 6; the
// project's definition of done, vision.md: "lose the password, recover
// from the phrase, plaintext never on disk").
//
// Vault-count precondition: 1 (SYNC-6). Runs at m=256 MiB, t=3, p=2 on
// every pipeline by ratified decision (SYNC-9 / harness grill Q4) —
// fixture generation pays Argon2id ×2 and the in-app phrase unlock +
// password reset pay it again; budget accordingly (vitest.e2e.config
// allows 180 s per test).
//
// SYNC-13: this spec NEVER logs the phrase/passwords; the plaintext
// scan reports needle indices, not contents.

import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { describeE2E, scenario } from "./support/scenario";
import { completePasswordReset, enterRecoveryPhrase } from "./support/flows";
import { seedVault, vaultMetaPath, VAULT_META_OFFSETS as O, type SeededVault } from "./support/fixtures";
import { scanForPlaintext } from "./support/plaintext-scan";

const NEW_PASSWORD = "Qf3#vR8!mZ2&pL5w-drill";

/** Fixed-width field slice — pairs an offset with its §9.3 length. */
function field(buf: Buffer, offset: number, len: number): Buffer {
  return buf.subarray(offset, offset + len);
}

describeE2E("VR-1 recovery drill (1 vault, production KDF)", () => {
  it("recovers with the phrase, resets the password, lands in the editor, leaves no plaintext", async () => {
    let fixture!: SeededVault;
    await scenario(
      "vr1-recovery-drill",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir, { kdf: "production" });
        },
      },
      async (app) => {
        const metaPath = vaultMetaPath(app.appDataDir, fixture.vaultId);
        const metaBefore = readFileSync(metaPath);

        // Boot lands on Unlock (1 vault, all-Empty slots).
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });

        // Enter recovery (cold-start link).
        await (await app.session.byTestId("unlock.recovery-link")).click();

        // Phrase entry: 24 cells in DOM order (shared flow fragment).
        await enterRecoveryPhrase(app.session, fixture.phrase);

        // Submit → A8d (production Argon2id) → password-reset step.
        await (await app.session.byTestId("recover.submit")).click();
        await app.session.byTestId("recover.reset.password-input", { timeoutMs: 60_000 });

        // Set the new password (shared A8f flow; zxcvbn gate inside).
        await completePasswordReset(app.session, NEW_PASSWORD);

        // A8f rewrites the password side → editor mounts.
        await app.session.byTestId("editor.root", { timeoutMs: 60_000 });

        // Disk contract (recovery-flow.md §4.4): password-side fields
        // rewritten, recovery-side bytes byte-preserved.
        const metaAfter = readFileSync(metaPath);
        expect(metaAfter).toHaveLength(O.END);
        // Recovery side: salt + nonce + wrapped blob identical.
        expect(field(metaAfter, O.SALT_RECOVERY, 16)).toEqual(field(metaBefore, O.SALT_RECOVERY, 16));
        expect(field(metaAfter, O.NONCE_RECOVERY_WRAP, 24)).toEqual(
          field(metaBefore, O.NONCE_RECOVERY_WRAP, 24),
        );
        expect(field(metaAfter, O.ENC_ROOT_KEY_RECOVERY, 64)).toEqual(
          field(metaBefore, O.ENC_ROOT_KEY_RECOVERY, 64),
        );
        // Password side: salt + wrapped blob rewritten.
        expect(field(metaAfter, O.SALT_PASSWORD, 16)).not.toEqual(
          field(metaBefore, O.SALT_PASSWORD, 16),
        );
        expect(field(metaAfter, O.ENC_ROOT_KEY_PASSWORD, 64)).not.toEqual(
          field(metaBefore, O.ENC_ROOT_KEY_PASSWORD, 64),
        );

        // Observable wipe proxy (§3.4/§2.4 class): no phrase text
        // remains in the live DOM after the flow completes.
        const source = await app.session.source();
        expect(source.includes(fixture.phrase)).toBe(false);

        // Plaintext-never-on-disk (SYNC-13 / vision.md DoD). Needle
        // indices: 0=phrase, 1=old password, 2=new password.
        const hits = scanForPlaintext(app.dataHome, [
          fixture.phrase,
          fixture.password,
          NEW_PASSWORD,
        ]);
        expect(hits).toEqual([]);
      },
    );
  });
});
