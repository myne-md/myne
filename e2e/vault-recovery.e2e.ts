// MYND-126 — vault-recovery flow scenarios (the recovery-drill
// regression gate beyond VR-1, which lives in recovery-drill.e2e.ts).
//
// Two load-bearing privacy properties are pinned byte-identical here:
// the §3.4 non-distinguishing failure outcome (wrong phrase vs
// tampered vault MUST be indistinguishable) and the §3.2 absence of
// phrase-entry autocomplete. Boot-routing halves live in MYND-127.
//
// Vault-count preconditions declared per scenario (SYNC-6). SYNC-13:
// no assertion's failure output prints a phrase or password; cell
// checks are emptiness/non-emptiness booleans only.

import { expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { completePasswordReset, enterRecoveryPhrase, unlockToEditor } from "./support/flows";
import {
  denyRead,
  seedVault,
  tamperVaultMeta,
  vaultMetaPath,
  VAULT_META_OFFSETS as O,
  type SeededVault,
} from "./support/fixtures";

import { ioBanner } from "../src/lib/io-banner";
import { RECOVERY_NON_DISTINGUISHING_BANNER } from "../src/lib/load-bearing-copy";
import { testIdSelector, type Session } from "./support/webdriver";

/** 24 valid BIP-39 words that are (astronomically) not the fixture's
 *  phrase — the "wrong phrase" arm's input. */
const WRONG_PHRASE = Array.from({ length: 24 }, () => "abandon").join(" ");

const NEW_PASSWORD = "Rv7#kT2!qY9&mW4z-vrec";

/** The §3.4 user-visible failure outcome, captured as data so the
 *  wrong-phrase and tampered-twin arms can be asserted EQUAL. */
interface NonDistinguishingOutcome {
  banner: string;
  allCellsWiped: boolean;
  onPhraseEntry: boolean;
}

async function captureFailureOutcome(session: Session): Promise<NonDistinguishingOutcome> {
  const banner = await session.byTestId("recover.banner", { timeoutMs: 30_000 });
  // One in-page pass; only the REDUCED boolean leaves the page (SYNC-13:
  // raw cell values must never reach the test process on this path).
  const allWiped = await session.execute<boolean>(
    "var cells = document.querySelectorAll('[data-testid=\"recover.phrase-cell\"]');" +
      "if (cells.length !== 24) return false;" +
      "for (var i = 0; i < cells.length; i++) { if (cells[i].value !== '') return false; }" +
      "return true;",
  );
  return {
    banner: await banner.text(),
    allCellsWiped: allWiped,
    onPhraseEntry: (await session.byTestIdAll("recover.submit")).length === 1,
  };
}

/** Boot (1 vault) → unlock screen → recovery-link → phrase-entry. */
async function enterRecoveryFromUnlock(session: Session): Promise<void> {
  await session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
  await (await session.byTestId("unlock.recovery-link")).click();
  await session.byTestId("recover.phrase-grid", { timeoutMs: 10_000 });
}

describeE2E("VR-2 non-distinguishing pair (MYND-126 task 1)", () => {
  it("wrong phrase and tampered recovery blob produce the IDENTICAL user-visible outcome", async () => {
    // Vault-count precondition: 1 each (weak KDF), two boots — the
    // pair's outcomes are captured as data and asserted equal.
    let wrongPhraseOutcome!: NonDistinguishingOutcome;
    await scenario(
      "vr2-wrong-phrase",
      { seed: (dir) => void seedVault(dir) },
      async (app) => {
        await enterRecoveryFromUnlock(app.session);
        await enterRecoveryPhrase(app.session, WRONG_PHRASE);
        await (await app.session.byTestId("recover.submit")).click();
        wrongPhraseOutcome = await captureFailureOutcome(app.session);
      },
    );

    let tamperedOutcome!: NonDistinguishingOutcome;
    let fixture!: SeededVault;
    await scenario(
      "vr2-tampered-twin",
      {
        seed: (dir) => {
          fixture = seedVault(dir);
          // The recovery-side wrapped blob — the §3.4 tamper class.
          tamperVaultMeta(dir, fixture.vaultId, O.ENC_ROOT_KEY_RECOVERY);
        },
      },
      async (app) => {
        await enterRecoveryFromUnlock(app.session);
        await enterRecoveryPhrase(app.session, fixture.phrase);
        await (await app.session.byTestId("recover.submit")).click();
        tamperedOutcome = await captureFailureOutcome(app.session);
      },
    );

    // §3.4: byte-identical user-visible outcome across the pair, and
    // the banner is the canonical full literal.
    expect(wrongPhraseOutcome).toEqual(tamperedOutcome);
    expect(wrongPhraseOutcome.banner).toBe(RECOVERY_NON_DISTINGUISHING_BANNER);
    expect(wrongPhraseOutcome.allCellsWiped).toBe(true);
    expect(wrongPhraseOutcome.onPhraseEntry).toBe(true);
  });
});

describeE2E("VR-3 cancel rules + delete-link distinction (MYND-126 task 2)", () => {
  it("Cancel exists only on phrase-entry; the delete link is NOT a cancel; A8d never ran", async () => {
    // Vault-count precondition: 1 (weak KDF).
    let fixture!: SeededVault;
    await scenario(
      "vr3-cancel-rules",
      { seed: (dir) => void (fixture = seedVault(dir)) },
      async (app) => {
        await enterRecoveryFromUnlock(app.session);

        // Phrase-entry HAS Cancel; the delete link routes to the
        // typed-DELETE confirm flow, NOT back to unlock.
        expect(await app.session.byTestIdAll("recover.cancel")).toHaveLength(1);
        await (await app.session.byTestId("recover.delete-link")).click();
        await app.session.byTestId("delete-vault.confirm-input", { timeoutMs: 10_000 });
        expect(await app.session.byTestIdAll("unlock.password-input")).toHaveLength(0);
        await (await app.session.byTestId("delete-vault.cancel")).click();
        await app.session.byTestId("recover.phrase-grid", { timeoutMs: 10_000 });

        // Cancel → unlock. At ONE vault the select step never mounted,
        // so the reducer holds no vaultId BY DESIGN (single-vault
        // parity) — the cancel threads none and the unlock takes the
        // sole-vault None path (data-vault-id absent). The ≥2-vault
        // TARGETED cancel is asserted in VR-15 (post-select).
        await (await app.session.byTestId("recover.cancel")).click();
        const form = await app.session.byTestId("unlock.form", { timeoutMs: 10_000 });
        expect(await form.attribute("data-vault-id")).toBeNull();

        // A8d never ran (slot still Empty): the ORIGINAL password
        // unlocks normally — no Recovering interception.
        await unlockToEditor(app.session, fixture.password);
      },
    );
  });

  it("Cancel is absent on Decrypting and on PasswordReset", async () => {
    // Vault-count precondition: 1 — PRODUCTION KDF: the decrypting
    // window must be wide enough to sample (weak decrypt is sub-frame).
    let phrase!: string;
    await scenario(
      "vr3-no-cancel-zones",
      {
        // A LEGACY production-KDF vault, deliberately not the realistic
        // fixture: that one is person-born and has no phrase (myne-md/myne#911
        // task 6), and this scenario's subject is the phrase recovery path a
        // legacy vault still has.
        seed: (dir) => {
          ({ phrase } = seedVault(dir, { kdf: "production" }));
        },
      },
      async (app) => {
        await enterRecoveryFromUnlock(app.session);
        await enterRecoveryPhrase(app.session, phrase);
        await (await app.session.byTestId("recover.submit")).click();

        // Decrypting mounted → NO Cancel anywhere (§3.3).
        await app.session.byTestId("recover.decrypting", { timeoutMs: 10_000 });
        expect(await app.session.byTestIdAll("recover.cancel")).toHaveLength(0);

        // PasswordReset mounted → still no Cancel (§4.1 non-dismissible).
        await app.session.byTestId("recover.reset.password-input", { timeoutMs: 60_000 });
        expect(await app.session.byTestIdAll("recover.cancel")).toHaveLength(0);
      },
    );
  });
});

describeE2E("VR-4 slot-priority resume + VR-5 reload race (MYND-126 task 3)", () => {
  it("VR-4: reload after A8d resumes directly at password-reset and completes to the editor", async () => {
    // Vault-count precondition: 1 (weak KDF).
    let fixture!: SeededVault;
    await scenario(
      "vr4-resume",
      { seed: (dir) => void (fixture = seedVault(dir)) },
      async (app) => {
        await enterRecoveryFromUnlock(app.session);
        await enterRecoveryPhrase(app.session, fixture.phrase);
        await (await app.session.byTestId("recover.submit")).click();
        await app.session.byTestId("recover.reset.password-input", { timeoutMs: 30_000 });

        // Reload: slot-priority lands DIRECTLY at password-reset,
        // phrase-entry skipped (the host kept Slot::Recovering).
        await app.session.refresh();
        const pw = await app.session.byTestId("recover.reset.password-input", {
          timeoutMs: 20_000,
        });
        expect(await app.session.byTestIdAll("recover.phrase-cell")).toHaveLength(0);

        // …and the resumed reset completes the drill to the editor.
        void pw;
        await completePasswordReset(app.session, NEW_PASSWORD);
        await app.session.byTestId("editor.root", { timeoutMs: 60_000 });
      },
    );
  });

  it("VR-5: a reload racing A8d lands on unlock; re-entering the phrase silently advances to reset", async () => {
    // Vault-count precondition: 1 — PRODUCTION KDF (the race needs the
    // multi-second Argon2id window; SYNC-3 forbids any synthetic hook).
    let phrase!: string;
    await scenario(
      "vr5-reload-race",
      {
        // A LEGACY production-KDF vault, deliberately not the realistic
        // fixture: that one is person-born and has no phrase (myne-md/myne#911
        // task 6), and this scenario's subject is the phrase recovery path a
        // legacy vault still has.
        seed: (dir) => {
          ({ phrase } = seedVault(dir, { kdf: "production" }));
        },
      },
      async (app) => {
        await enterRecoveryFromUnlock(app.session);
        await enterRecoveryPhrase(app.session, phrase);
        await (await app.session.byTestId("recover.submit")).click();

        // Reload IMMEDIATELY: the host-side A8d keeps running; the
        // fresh boot (~2 s) beats the production Argon2id (~3+ s), so
        // the probe still sees Empty → unlock screen.
        await app.session.refresh();
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });

        // Re-enter recovery and retype the phrase — by submit time the
        // ORIGINAL A8d has resolved host-side (slot = Recovering), so
        // the backend answers RecoveryAlreadyInProgress and the screen
        // SILENTLY advances to password-reset (Q4): no banner.
        await (await app.session.byTestId("unlock.recovery-link")).click();
        await enterRecoveryPhrase(app.session, phrase);
        // Belt: give the ORIGINAL A8d time to settle host-side before
        // submitting (typing 24 cells already consumed several seconds;
        // this is an honest fixed wait, not a condition).
        await sleep(6_000);
        await (await app.session.byTestId("recover.submit")).click();
        await app.session.byTestId("recover.reset.password-input", { timeoutMs: 60_000 });
        expect(await app.session.byTestIdAll("recover.banner")).toHaveLength(0);
      },
    );
  });
});

describeE2E("IoError + fail-closed cluster (MYND-126 task 4)", () => {
  it("VR-6: chmod fault during A8d → banner-retry with cells PRESERVED; undo → recovery proceeds", async () => {
    // Vault-count precondition: 1 (weak KDF).
    let fixture!: SeededVault;
    await scenario(
      "vr6-a8d-io-fault",
      { seed: (dir) => void (fixture = seedVault(dir)) },
      async (app) => {
        await enterRecoveryFromUnlock(app.session);
        await enterRecoveryPhrase(app.session, fixture.phrase);
        const undo = denyRead(vaultMetaPath(app.appDataDir, fixture.vaultId));
        await (await app.session.byTestId("recover.submit")).click();

        // IoError = "try again", NOT "wrong input": ioBanner shown and
        // the typed cells are PRESERVED (the VR-2 contrast).
        const banner = await app.session.byTestId("recover.banner", { timeoutMs: 15_000 });
        expect(await banner.text()).toBe(ioBanner("PermissionDenied"));
        const cells = await app.session.byTestIdAll("recover.phrase-cell");
        expect(cells.length).toBe(24);
        for (const cell of cells) {
          expect(((await cell.property<string>("value")) ?? "").length > 0).toBe(true);
        }

        // Fault removed → the SAME typed cells submit through to reset.
        undo();
        await (await app.session.byTestId("recover.submit")).click();
        await app.session.byTestId("recover.reset.password-input", { timeoutMs: 30_000 });
      },
    );
  });

  it("VR-11′: fault during A8f → phrase-entry bounce, password wiped, slot Empty (zeroize-on-failure)", async () => {
    // Vault-count precondition: 1 (weak KDF). The authored "stays
    // Recovering" was WRONG — the corrected semantics are pinned here.
    let fixture!: SeededVault;
    await scenario(
      "vr11-a8f-io-fault",
      { seed: (dir) => void (fixture = seedVault(dir)) },
      async (app) => {
        await enterRecoveryFromUnlock(app.session);
        await enterRecoveryPhrase(app.session, fixture.phrase);
        await (await app.session.byTestId("recover.submit")).click();
        const pw = await app.session.byTestId("recover.reset.password-input", {
          timeoutMs: 30_000,
        });

        // Fault lands between A8d and the A8f submit.
        void pw;
        const undo = denyRead(vaultMetaPath(app.appDataDir, fixture.vaultId));
        await completePasswordReset(app.session, NEW_PASSWORD);

        // UI bounce to PHRASE-ENTRY with the ioBanner; vault.meta is
        // untouched (atomic rename never landed).
        await app.session.byTestId("recover.phrase-grid", { timeoutMs: 15_000 });
        const banner = await app.session.byTestId("recover.banner");
        expect(await banner.text()).toBe(ioBanner("PermissionDenied"));

        // FOUND-IN-TEST (the suite's honest pin): the HOST keeps
        // Slot::Recovering on an A8f IO failure — the snapshot-clone
        // pipeline never consumed the slot (both the authored VR-11
        // "stays Recovering" framing AND the grill's "slot Empty"
        // correction were partly wrong; the reducer comment claiming
        // "slot is now Empty" is stale). Observable consequence: a
        // normal unlock attempt is intercepted by the recovery-in-
        // progress surface, whose Continue RESUMES the reset — and the
        // retry completes once the fault is gone.
        undo();
        await (await app.session.byTestId("recover.cancel")).click();
        const input = await app.session.byTestId("unlock.password-input", { timeoutMs: 10_000 });
        await input.sendKeys(fixture.password);
        await (await app.session.byTestId("unlock.submit")).click();
        await app.session.byTestId("unlock.recovery-in-progress-banner", { timeoutMs: 15_000 });
        await (await app.session.byTestId("unlock.resume-cta")).click();
        await app.session.byTestId("recover.reset.password-input", { timeoutMs: 15_000 });
        await completePasswordReset(app.session, NEW_PASSWORD);
        await app.session.byTestId("editor.root", { timeoutMs: 30_000 });
      },
    );
  });

  it("VR-7: items-key tamper → ONE-WAY fail-closed after a correct phrase", async () => {
    // Vault-count precondition: 1 (weak KDF). The recovery wrap-key
    // verifies, then the eager items_key unwrap fails → InvalidVaultMeta.
    let fixture!: SeededVault;
    await scenario(
      "vr7-items-key-tamper",
      {
        seed: (dir) => {
          fixture = seedVault(dir);
          tamperVaultMeta(dir, fixture.vaultId, O.ENC_ITEMS_KEY);
        },
      },
      async (app) => {
        await enterRecoveryFromUnlock(app.session);
        await enterRecoveryPhrase(app.session, fixture.phrase);
        await (await app.session.byTestId("recover.submit")).click();

        const failClosed = await app.session.byTestId("fail-closed.root", { timeoutMs: 30_000 });
        expect(await failClosed.attribute("data-reason")).toBe("corrupted-vault");
        expect(await (await app.session.byTestId("fail-closed.cta")).text()).toBe("Close app");
        // One-way: no phrase grid, no reset form, no unlock form.
        expect(await app.session.byTestIdAll("recover.phrase-cell")).toHaveLength(0);
        expect(await app.session.byTestIdAll("unlock.password-input")).toHaveLength(0);
      },
    );
    // VR-8 (slot-Unlocked during A8d → invalid-state) stays UNIT-covered:
    // the state is structurally unreachable through real UI driving
    // (reaching phrase-entry requires a locked vault) — SYNC-7 split.
  });
});

describeE2E("VR-9/10 reset gating + VR-13′ NFKD/no-autocomplete (MYND-126 task 5)", () => {
  it("reset password gating: weak blocked, mismatch blocked with inline caption", async () => {
    // Vault-count precondition: 1 (weak KDF).
    let fixture!: SeededVault;
    await scenario(
      "vr9-reset-gating",
      { seed: (dir) => void (fixture = seedVault(dir)) },
      async (app) => {
        await enterRecoveryFromUnlock(app.session);
        await enterRecoveryPhrase(app.session, fixture.phrase);
        await (await app.session.byTestId("recover.submit")).click();
        const pw = await app.session.byTestId("recover.reset.password-input", {
          timeoutMs: 30_000,
        });
        const confirm = await app.session.byTestId("recover.reset.confirm-input");
        const submit = await app.session.byTestId("recover.reset.submit");

        // Weak (short + low-score) matching pair → blocked.
        await pw.sendKeys("weakweak123");
        await confirm.sendKeys("weakweak123");
        expect(await submit.enabled()).toBe(false);

        // Strong but MISMATCHED → blocked, inline caption present.
        await pw.replaceText(NEW_PASSWORD);
        await confirm.replaceText(`${NEW_PASSWORD}-x`);
        expect(await submit.enabled()).toBe(false);
        expect((await app.session.source()).includes("Passwords do not match.")).toBe(true);
      },
    );
  });

  it("VR-13′: UPPERCASE/NFKD phrase input recovers identically; no autocomplete surface exists", async () => {
    // Vault-count precondition: 1 (weak KDF).
    let fixture!: SeededVault;
    await scenario(
      "vr13-nfkd-no-autocomplete",
      { seed: (dir) => void (fixture = seedVault(dir)) },
      async (app) => {
        await enterRecoveryFromUnlock(app.session);

        // §3.2: NO autocomplete/typeahead on any of the 24 cells —
        // structural (attributes) + behavioral (no listbox/datalist).
        const cells = await app.session.byTestIdAll("recover.phrase-cell");
        expect(cells.length).toBe(24);
        for (const cell of cells) {
          expect(await cell.attribute("autocomplete")).toBe("off");
          expect(await cell.attribute("spellcheck")).toBe("false");
          expect(await cell.attribute("list")).toBeNull();
        }
        expect(await app.session.findElements("[role='listbox'], datalist")).toHaveLength(0);

        // Sloppy input: UPPERCASE phrase → §7.4 normalization makes the
        // recovery succeed identically (reaches password-reset).
        await enterRecoveryPhrase(app.session, fixture.phrase.toUpperCase());
        await (await app.session.byTestId("recover.submit")).click();
        await app.session.byTestId("recover.reset.password-input", { timeoutMs: 30_000 });
      },
    );
  });
});

describeE2E("multi-vault selection (MYND-126 task 6: VR-15/16/17 + resume)", () => {
  const PASSWORD_A = "e2e-vr15-vault-a-pw";
  const PASSWORD_B = "e2e-vr15-vault-b-pw";

  it("VR-15: select threads the chosen vault through A8d+A8f; wrong-vault = non-distinguishing", async () => {
    // Vault-count precondition: 2 (weak KDF).
    let a!: SeededVault;
    let b!: SeededVault;
    await scenario(
      "vr15-select-threading",
      {
        seed: (dir) => {
          a = seedVault(dir, { password: PASSWORD_A });
          b = seedVault(dir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        // Recovery entry at ≥2 vaults mounts the SELECT step.
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await (
          await app.session.waitForElement(
            testIdSelector("picker.vault-row", { "data-vault-id": a.vaultId }),
          )
        ).click();
        await (await app.session.byTestId("unlock.recovery-link")).click();
        await app.session.byTestId("recover.select-row", { timeoutMs: 10_000 });

        // Wrong-vault arm: select A, type B's CORRECT phrase → the SAME
        // non-distinguishing literal as a typo (§3.4 extended).
        await (
          await app.session.waitForElement(
            testIdSelector("recover.select-row", { "data-vault-id": a.vaultId }),
          )
        ).click();
        await enterRecoveryPhrase(app.session, b.phrase);
        await (await app.session.byTestId("recover.submit")).click();
        const outcome = await captureFailureOutcome(app.session);
        expect(outcome.banner).toBe(RECOVERY_NON_DISTINGUISHING_BANNER);
        expect(outcome.allCellsWiped).toBe(true);

        // Right-vault arm: cancel out, re-enter, select B, B's phrase →
        // reset → editor. The select-threading is then PROVEN by disk:
        // B's password side rewritten, A byte-identical.
        const aBefore = readFileSync(vaultMetaPath(app.appDataDir, a.vaultId));
        const bBefore = readFileSync(vaultMetaPath(app.appDataDir, b.vaultId));
        // The TARGETED cancel (SYNC-17): a vault was SELECTED, so the
        // cancel threads its id onto the unlock form.
        await (await app.session.byTestId("recover.cancel")).click();
        const cancelForm = await app.session.byTestId("unlock.form", { timeoutMs: 10_000 });
        expect(await cancelForm.attribute("data-vault-id")).toBe(a.vaultId);
        await (await app.session.byTestId("unlock.recovery-link")).click();
        await (
          await app.session.waitForElement(
            testIdSelector("recover.select-row", { "data-vault-id": b.vaultId }),
          )
        ).click();
        await enterRecoveryPhrase(app.session, b.phrase);
        await (await app.session.byTestId("recover.submit")).click();
        await app.session.byTestId("recover.reset.password-input", { timeoutMs: 30_000 });
        await completePasswordReset(app.session, NEW_PASSWORD);
        await app.session.byTestId("editor.root", { timeoutMs: 60_000 });

        const aAfter = readFileSync(vaultMetaPath(app.appDataDir, a.vaultId));
        const bAfter = readFileSync(vaultMetaPath(app.appDataDir, b.vaultId));
        expect(aAfter.equals(aBefore)).toBe(true);
        expect(
          bAfter
            .subarray(O.ENC_ROOT_KEY_PASSWORD, O.ENC_ROOT_KEY_PASSWORD + 64)
            .equals(bBefore.subarray(O.ENC_ROOT_KEY_PASSWORD, O.ENC_ROOT_KEY_PASSWORD + 64)),
        ).toBe(false);
        // Recovery side untouched on B (reset rewrites the password side).
        expect(
          bAfter
            .subarray(O.ENC_ROOT_KEY_RECOVERY, O.ENC_ROOT_KEY_RECOVERY + 64)
            .equals(bBefore.subarray(O.ENC_ROOT_KEY_RECOVERY, O.ENC_ROOT_KEY_RECOVERY + 64)),
        ).toBe(true);
      },
    );
  });

  it("VR-16: account-number selector — valid jumps; malformed and no-match share one generic copy", async () => {
    // Vault-count precondition: 2 on disk (+1 retired id whose account
    // number is VALID but matches nothing).
    let b!: SeededVault;
    let retired!: SeededVault;
    await scenario(
      "vr16-account-selector",
      {
        seed: (dir) => {
          seedVault(dir, { password: PASSWORD_A });
          b = seedVault(dir, { password: PASSWORD_B });
          // Mint a third valid account, then retire its vault dir: a
          // well-formed number with NO matching vault on disk.
          retired = seedVault(dir);
          rmSync(join(dir, "vaults", retired.vaultId), { recursive: true, force: true });
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await (
          await app.session.waitForElement(
            testIdSelector("picker.vault-row", { "data-vault-id": b.vaultId }),
          )
        ).click();
        await (await app.session.byTestId("unlock.recovery-link")).click();
        const accountInput = await app.session.byTestId("recover.select-account-input", {
          timeoutMs: 10_000,
        });

        // Malformed input → generic error copy (capture it).
        await accountInput.sendKeys("MY-NOPE");
        await (await app.session.byTestId("recover.select-account-submit")).click();
        const malformedCopy = await (
          await app.session.byTestId("recover.select-account-error", { timeoutMs: 10_000 })
        ).text();

        // Valid-but-no-match → the SAME copy (no which-vaults-exist
        // oracle).
        await accountInput.replaceText(retired.account);
        await (await app.session.byTestId("recover.select-account-submit")).click();
        const noMatchCopy = await (
          await app.session.byTestId("recover.select-account-error", { timeoutMs: 10_000 })
        ).text();
        expect(noMatchCopy).toBe(malformedCopy);

        // Valid + matching → jumps to phrase-entry for that vault
        // (never required — the rows always work too).
        await accountInput.replaceText(b.account);
        await (await app.session.byTestId("recover.select-account-submit")).click();
        await app.session.byTestId("recover.phrase-grid", { timeoutMs: 10_000 });
      },
    );
  });

  it("VR-17: delete-confirm cul-de-sac — cancel preserves typed cells; typed-DELETE removes and reroutes", async () => {
    // Vault-count precondition: 1 → 0 (weak KDF).
    let fixture!: SeededVault;
    await scenario(
      "vr17-delete-culdesac",
      { seed: (dir) => void (fixture = seedVault(dir)) },
      async (app) => {
        await enterRecoveryFromUnlock(app.session);

        // Type a few words, then enter the delete-confirm sub-step.
        const cells = await app.session.byTestIdAll("recover.phrase-cell");
        await cells[0].sendKeys("abandon");
        await cells[1].sendKeys("ability");
        await (await app.session.byTestId("recover.delete-link")).click();
        await app.session.byTestId("delete-vault.confirm-input", { timeoutMs: 10_000 });

        // Cancel → phrase-entry with the typed cells PRESERVED.
        await (await app.session.byTestId("delete-vault.cancel")).click();
        await app.session.byTestId("recover.phrase-grid", { timeoutMs: 10_000 });
        const cellsBack = await app.session.byTestIdAll("recover.phrase-cell");
        expect(((await cellsBack[0].property<string>("value")) ?? "").length > 0).toBe(true);
        expect(((await cellsBack[1].property<string>("value")) ?? "").length > 0).toBe(true);

        // Typed-DELETE → vault dir gone → Welcome.
        await (await app.session.byTestId("recover.delete-link")).click();
        const confirm = await app.session.byTestId("delete-vault.confirm-input", {
          timeoutMs: 10_000,
        });
        await confirm.sendKeys("DELETE");
        const submit = await app.session.byTestId("delete-vault.submit");
        await app.session.waitUntil(() => submit.enabled(), {
          label: "delete submit enabled",
          timeoutMs: 10_000,
        });
        await submit.click();
        await app.session.byTestId("welcome.root", { timeoutMs: 20_000 });
        expect(existsSync(join(app.appDataDir, "vaults", fixture.vaultId))).toBe(false);
      },
    );
  });

  it("VR-18: ≥2-vault resume targets the RECOVERING vault (post-MYND-220)", async () => {
    // Vault-count precondition: 2 (weak KDF). Pre-MYND-220 the resumed
    // A8f's None-fallback fell to the legacy path and bounce-looped;
    // the fix resolves the sole Recovering slot. Disk-level proof:
    // the SELECTED vault's password side is rewritten, the sibling
    // stays byte-identical.
    let a!: SeededVault;
    let b!: SeededVault;
    await scenario(
      "vr18-multi-resume",
      {
        seed: (dir) => {
          a = seedVault(dir, { password: PASSWORD_A });
          b = seedVault(dir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        // Select B on the picker, enter recovery, select B again on the
        // recovery select step, run A8d.
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await (
          await app.session.waitForElement(
            testIdSelector("picker.vault-row", { "data-vault-id": b.vaultId }),
          )
        ).click();
        await (await app.session.byTestId("unlock.recovery-link")).click();
        await (
          await app.session.waitForElement(
            testIdSelector("recover.select-row", { "data-vault-id": b.vaultId }),
          )
        ).click();
        await enterRecoveryPhrase(app.session, b.phrase);
        await (await app.session.byTestId("recover.submit")).click();
        await app.session.byTestId("recover.reset.password-input", { timeoutMs: 30_000 });

        const aBefore = readFileSync(vaultMetaPath(app.appDataDir, a.vaultId));
        const bBefore = readFileSync(vaultMetaPath(app.appDataDir, b.vaultId));

        // RELOAD mid-recovery: the resumed reset has NO UI-side vault
        // id — the runtime must resolve the Recovering slot (MYND-220).
        await app.session.refresh();
        await app.session.byTestId("recover.reset.password-input", { timeoutMs: 20_000 });
        expect(await app.session.byTestIdAll("recover.phrase-cell")).toHaveLength(0);
        await completePasswordReset(app.session, NEW_PASSWORD);
        await app.session.byTestId("editor.root", { timeoutMs: 60_000 });

        // The RIGHT vault was reset: B's password side changed, A is
        // byte-identical (the pre-fix bug would have missed B).
        const aAfter = readFileSync(vaultMetaPath(app.appDataDir, a.vaultId));
        const bAfter = readFileSync(vaultMetaPath(app.appDataDir, b.vaultId));
        expect(aAfter.equals(aBefore)).toBe(true);
        expect(
          bAfter
            .subarray(O.ENC_ROOT_KEY_PASSWORD, O.ENC_ROOT_KEY_PASSWORD + 64)
            .equals(bBefore.subarray(O.ENC_ROOT_KEY_PASSWORD, O.ENC_ROOT_KEY_PASSWORD + 64)),
        ).toBe(false);
      },
    );
  });

  it("single-vault parity: recovery entry never mounts the select step", async () => {
    // Vault-count precondition: 1 (weak KDF).
    await scenario(
      "vr15-single-parity",
      { seed: (dir) => void seedVault(dir) },
      async (app) => {
        await enterRecoveryFromUnlock(app.session);
        // Phrase grid mounted directly — no select rows, no account
        // affordance anywhere.
        expect(await app.session.byTestIdAll("recover.select-row")).toHaveLength(0);
        expect(await app.session.byTestIdAll("recover.select-account-input")).toHaveLength(0);
      },
    );
  });
});
