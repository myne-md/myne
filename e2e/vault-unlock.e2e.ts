// MYND-125 — vault-unlock flow scenarios (e2e-vault-unlock).
//
// The unlock screen is the app's front door: vault-addressed targeting
// (SYNC-6), the §7.3 non-distinguishing compound banner, fail-closed
// corruption surfaces, retryable IO faults, and the lost-credentials
// delete-vault escape. Boot-ROUTING halves live in the MYND-127 suite;
// here the asserts are flow-internal (banner literals, gating, input
// preservation, targeting, the sole-Unlocked invariant mid-switch).
//
// Vault-count preconditions declared per scenario (SYNC-6). SYNC-13:
// assertion shapes never print fixture credentials.

import { expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import {
  dismissImporterOffer,
  selectPickerRow,
  switchToVault,
  unlockToEditor,
} from "./support/flows";
import {
  corruptVaultMetaWholesale,
  deleteVaultMetaKeepArtifacts,
  denyRead,
  seedVault,
  vaultMetaPath,
  type SeededVault,
} from "./support/fixtures";
import { seedProductionVault } from "./support/realistic-fixture";
import { activeTestId, typeIntoActive } from "./support/keyboard";
import { ioBanner } from "../src/lib/io-banner";
import { UNLOCK_NON_DISTINGUISHING_BANNER } from "../src/lib/load-bearing-copy";

/** Full-literal banner copies (SYNC-8 equality asserts). The permission
 *  banner derives from the canonical `ioBanner` mapping the production
 *  surface renders; VaultNotFound is Unlock.tsx's OWN inline literal, so
 *  the test pins it independently (a drift between the two surfaces
 *  should fail here, not be papered over by a shared import). */
const PERMISSION_IO_BANNER = ioBanner("PermissionDenied");
const VAULT_NOT_FOUND_BANNER = "Vault file not found. Please restart the app.";

describeE2E("VU-1/VU-9/VU-10 happy path + decrypting cluster (MYND-125 task 1)", () => {
  it("gates empty input, survives a recovery round-trip, decrypts at production KDF", async () => {
    // Vault-count precondition: 1 — the VC-1-captured production-KDF
    // fixture (a vault the app itself created); generator fallback
    // keeps the suite standalone-runnable.
    let password!: string;
    let vaultId!: string;
    await scenario(
      "vu1-happy-decrypting",
      {
        seed: (appDataDir) => {
          ({ password, vaultId } = seedProductionVault(appDataDir));
        },
      },
      async (app) => {
        // Boot → unlock, vault-addressed (story 1).
        const form = await app.session.byTestId("unlock.form", { timeoutMs: 20_000 });
        expect(await form.attribute("data-vault-id")).toBe(vaultId);

        // Empty-password gating: submit disabled, links visible (idle).
        const submit = await app.session.byTestId("unlock.submit");
        expect(await submit.enabled()).toBe(false);
        expect(await app.session.byTestIdAll("unlock.recovery-link")).toHaveLength(1);
        expect(await app.session.byTestIdAll("unlock.delete-link")).toHaveLength(1);

        // VU-10: recovery link enters phrase-entry; Cancel returns.
        await (await app.session.byTestId("unlock.recovery-link")).click();
        await app.session.byTestId("recover.phrase-grid", { timeoutMs: 10_000 });
        await (await app.session.byTestId("recover.cancel")).click();
        const input = await app.session.byTestId("unlock.password-input", { timeoutMs: 10_000 });

        // Correct password → decrypting cluster (the production-KDF
        // window is seconds long — sample it right after submit).
        await input.sendKeys(password);
        const submit2 = await app.session.byTestId("unlock.submit");
        await submit2.click();
        // Story 3/6: input + submit disabled; label flips; links hidden.
        await app.session.waitUntil(
          async () => (await submit2.text()).includes("Decrypting") || null,
          { label: "decrypting label", timeoutMs: 10_000 },
        );
        expect(await input.enabled()).toBe(false);
        expect(await submit2.enabled()).toBe(false);
        expect(await app.session.byTestIdAll("unlock.recovery-link")).toHaveLength(0);
        expect(await app.session.byTestIdAll("unlock.delete-link")).toHaveLength(0);

        // …and the production Argon2id completes into the editor.
        await app.session.byTestId("editor.root", { timeoutMs: 120_000 });
      },
    );
  });
});

describeE2E("VU-2 compound banner full literal (MYND-125 task 2)", () => {
  it("wrong password shows the full compound literal; input survives; typing clears it", async () => {
    // Vault-count precondition: 1 (weak KDF).
    let fixture!: SeededVault;
    await scenario(
      "vu2-compound-banner",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir);
        },
      },
      async (app) => {
        const input = await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        const WRONG = "definitely-not-the-password";
        await input.sendKeys(WRONG);
        await (await app.session.byTestId("unlock.submit")).click();

        // §7.3 compound copy by FULL equality — collapsing to a single
        // leg ("Wrong password") must fail this test.
        const banner = await app.session.byTestId("unlock.error-banner", { timeoutMs: 15_000 });
        expect(await banner.text()).toBe(UNLOCK_NON_DISTINGUISHING_BANNER);

        // The typed password survived the decrypting→idle bounce…
        expect(await input.property<string>("value")).toBe(WRONG);

        // …and the next keystroke clears the banner.
        await input.sendKeys("x");
        await app.session.waitForGone('[data-testid="unlock.error-banner"]');

        // Control: the real password still opens the vault.
        await input.replaceText(fixture.password);
        await (await app.session.byTestId("unlock.submit")).click();
        await app.session.byTestId("editor.root", { timeoutMs: 30_000 });
      },
    );
  });
});

describeE2E("corruption fail-closed cluster (MYND-125 task 3)", () => {
  it("VU-4a: missing vault.meta with artifacts fails closed at boot — no form", async () => {
    // Vault-count precondition: 1 (discovered, not well-formed —
    // presence-only `well_formed` semantics).
    let fixture!: SeededVault;
    await scenario(
      "vu4a-missing-meta",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir);
          deleteVaultMetaKeepArtifacts(appDataDir, fixture.vaultId);
        },
      },
      async (app) => {
        const failClosed = await app.session.byTestId("fail-closed.root", { timeoutMs: 20_000 });
        expect(await failClosed.attribute("data-reason")).toBe("corrupted-vault");
        expect(await (await app.session.byTestId("fail-closed.cta")).text()).toBe("Close app");
        expect(await app.session.byTestIdAll("unlock.password-input")).toHaveLength(0);
      },
    );
  });

  it("VU-4b: garbage vault.meta lists as Exists; submit fails closed ONE-WAY", async () => {
    // Vault-count precondition: 1 (presence-only well_formed → form
    // renders; the parse failure surfaces at submit).
    let fixture!: SeededVault;
    await scenario(
      "vu4b-garbage-meta",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir);
          corruptVaultMetaWholesale(appDataDir, fixture.vaultId);
        },
      },
      async (app) => {
        const input = await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await input.sendKeys(fixture.password);
        await (await app.session.byTestId("unlock.submit")).click();

        // InvalidVaultMeta → the same fail-closed surface as boot…
        const failClosed = await app.session.byTestId("fail-closed.root", { timeoutMs: 15_000 });
        expect(await failClosed.attribute("data-reason")).toBe("corrupted-vault");
        expect(await (await app.session.byTestId("fail-closed.cta")).text()).toBe("Close app");

        // …and it is ONE-WAY: no password form remains anywhere.
        expect(await app.session.byTestIdAll("unlock.password-input")).toHaveLength(0);
        expect(await app.session.byTestIdAll("unlock.recovery-link")).toHaveLength(0);
      },
    );
  });
});

describeE2E("mid-attempt IO faults (MYND-125 task 4, Linux-canonical)", () => {
  it("chmod-000 vault.meta → retryable permission ioBanner; fault removal → unlock succeeds", async () => {
    // Vault-count precondition: 1 (weak KDF; boot reads vault.meta
    // BEFORE the fault lands, so the form is already up).
    let fixture!: SeededVault;
    await scenario(
      "vu5-chmod-iobanner",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir);
        },
      },
      async (app) => {
        const input = await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });

        // Inject the at-rest fault between boot and submit.
        const undo = denyRead(vaultMetaPath(app.appDataDir, fixture.vaultId));
        await input.sendKeys(fixture.password);
        await (await app.session.byTestId("unlock.submit")).click();

        // Retryable banner (NOT fail-closed) — full literal.
        const banner = await app.session.byTestId("unlock.error-banner", { timeoutMs: 15_000 });
        expect(await banner.text()).toBe(PERMISSION_IO_BANNER);
        expect(await input.enabled()).toBe(true);

        // Remove the fault → the SAME form retries to success.
        undo();
        await (await app.session.byTestId("unlock.submit")).click();
        await app.session.byTestId("editor.root", { timeoutMs: 30_000 });
      },
    );
  });

  it("vault dir deleted under a live form → VaultNotFound banner", async () => {
    // Vault-count precondition: 1 (weak KDF).
    let fixture!: SeededVault;
    await scenario(
      "vu5-vault-not-found",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir);
        },
      },
      async (app) => {
        const input = await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        rmSync(join(app.appDataDir, "vaults", fixture.vaultId), {
          recursive: true,
          force: true,
        });
        await input.sendKeys(fixture.password);
        await (await app.session.byTestId("unlock.submit")).click();
        const banner = await app.session.byTestId("unlock.error-banner", { timeoutMs: 15_000 });
        expect(await banner.text()).toBe(VAULT_NOT_FOUND_BANNER);
      },
    );
  });
});

describeE2E("VU-11′ lock → re-unlock round-trip (MYND-125 task 5, post-MYND-219)", () => {
  const PASSWORD_A = "e2e-vu11-vault-a-pw";
  const PASSWORD_B = "e2e-vu11-vault-b-pw";

  it("≥2 vaults: Lock re-targets the SAME vault; its password reopens it", async () => {
    // Vault-count precondition: 2 — the exact regression MYND-219
    // fixes (pre-fix: lock fell to the sole-vault None path →
    // VaultNotFound dead-end at ≥2 vaults).
    let a!: SeededVault;
    await scenario(
      "vu11-multi-roundtrip",
      {
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: PASSWORD_A });
          seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await selectPickerRow(app.session, a.vaultId);
        await unlockToEditor(app.session, PASSWORD_A);
        await dismissImporterOffer(app.session);

        // Lock CTA → unlock(Exists) TARGETED at A (asserted, not
        // inferred).
        await (await app.session.byTestId("editor.lock-cta")).click();
        const form = await app.session.byTestId("unlock.form", { timeoutMs: 15_000 });
        expect(await form.attribute("data-vault-id")).toBe(a.vaultId);

        // A's password reopens A — no VaultNotFound dead-end.
        await unlockToEditor(app.session, PASSWORD_A);
      },
    );
  });

  it("single-vault control: the same round-trip with one vault", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "vu11-single-control",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir);
        },
      },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        await (await app.session.byTestId("editor.lock-cta")).click();
        const form = await app.session.byTestId("unlock.form", { timeoutMs: 15_000 });
        expect(await form.attribute("data-vault-id")).toBe(fixture.vaultId);
        await unlockToEditor(app.session, fixture.password);
      },
    );
  });
});

describeE2E("multi-vault flow surfaces (MYND-125 task 6)", () => {
  const PASSWORD_A = "e2e-vu6-vault-a-pw";
  const PASSWORD_B = "e2e-vu6-vault-b-pw";

  it("unlock-from-picker: wrong-vault password preserved through the bounce; right one opens", async () => {
    // Vault-count precondition: 2. (The Stage/route half lives in
    // MYND-127 — this arm pins the FLOW internals on the targeted
    // unlock: banner literal + input preservation + recovery.)
    let b!: SeededVault;
    await scenario(
      "vu6-picker-flow-internals",
      {
        seed: (appDataDir) => {
          seedVault(appDataDir, { password: PASSWORD_A });
          b = seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await selectPickerRow(app.session, b.vaultId);
        const input = await app.session.byTestId("unlock.password-input");
        await input.sendKeys(PASSWORD_A);
        await (await app.session.byTestId("unlock.submit")).click();
        const banner = await app.session.byTestId("unlock.error-banner", { timeoutMs: 15_000 });
        expect(await banner.text()).toBe(UNLOCK_NON_DISTINGUISHING_BANNER);
        // Flow internal: the wrong attempt is preserved for editing.
        expect(await input.property<string>("value")).toBe(PASSWORD_A);
        await input.replaceText(PASSWORD_B);
        await (await app.session.byTestId("unlock.submit")).click();
        await app.session.byTestId("editor.root", { timeoutMs: 30_000 });
      },
    );
  });

  it("corrupted row: selection mounts the form; submit is a one-way fail-closed", async () => {
    // Vault-count precondition: 2 (one garbage meta).
    let b!: SeededVault;
    await scenario(
      "vu6-corrupted-row-one-way",
      {
        seed: (appDataDir) => {
          seedVault(appDataDir, { password: PASSWORD_A });
          b = seedVault(appDataDir, { password: PASSWORD_B });
          corruptVaultMetaWholesale(appDataDir, b.vaultId);
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await selectPickerRow(app.session, b.vaultId);
        await (await app.session.byTestId("unlock.password-input")).sendKeys(PASSWORD_B);
        await (await app.session.byTestId("unlock.submit")).click();
        const failClosed = await app.session.byTestId("fail-closed.root", { timeoutMs: 15_000 });
        expect(await failClosed.attribute("data-reason")).toBe("corrupted-vault");
        expect(await (await app.session.byTestId("fail-closed.cta")).text()).toBe("Close app");
        expect(await app.session.byTestIdAll("unlock.password-input")).toHaveLength(0);
      },
    );
  });

  it("switch-while-unlocked: the prior vault is relocked BEFORE the target unlocks", async () => {
    // Vault-count precondition: 2 (A unlocked at switch time).
    let a!: SeededVault;
    let b!: SeededVault;
    await scenario(
      "vu6-switch-relock-invariant",
      {
        seed: (appDataDir) => {
          a = seedVault(appDataDir, { password: PASSWORD_A });
          b = seedVault(appDataDir, { password: PASSWORD_B });
        },
      },
      async (app) => {
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
        await selectPickerRow(app.session, a.vaultId);
        await unlockToEditor(app.session, PASSWORD_A);
        await dismissImporterOffer(app.session);

        // Switch to B → land on B's unlock form WITHOUT typing B's
        // password yet.
        await switchToVault(app.session, b.vaultId);
        const form = await app.session.byTestId("unlock.form", { timeoutMs: 15_000 });
        expect(await form.attribute("data-vault-id")).toBe(b.vaultId);

        // MID-SWITCH invariant probe: reload now. The host's slot map
        // outlives the WebView; if A were still unlocked the boot
        // probe's slot-priority would land on the EDITOR. Landing on
        // the PICKER proves every slot is Empty — A was relocked
        // BEFORE B's unlock, not lazily at B's open (SYNC-1).
        // (The transient switching overlay itself is too short-lived
        // under a weak-KDF flush to gate on — same posture as the
        // MYND-127 suite.)
        await app.session.refresh();
        await app.session.byTestId("picker.root", { timeoutMs: 20_000 });
      },
    );
  });
});

describeE2E("VU-12 lost-credentials delete-vault sub-view (MYND-125 task 7)", () => {
  it("cancel preserves the vault; only the exact typed DELETE proceeds and reroutes to Welcome", async () => {
    // Vault-count precondition: 1 → 0 (the destructive arm).
    let fixture!: SeededVault;
    await scenario(
      "vu12-delete-vault",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir);
        },
      },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await (await app.session.byTestId("unlock.delete-link")).click();

        // Typed-confirmation gating: wrong text keeps Submit disabled.
        const confirmInput = await app.session.byTestId("delete-vault.confirm-input", {
          timeoutMs: 10_000,
        });
        const submit = await app.session.byTestId("delete-vault.submit");
        await confirmInput.sendKeys("DELET");
        expect(await submit.enabled()).toBe(false);

        // Cancel arm: everything intact, back on the password form.
        await (await app.session.byTestId("delete-vault.cancel")).click();
        await app.session.byTestId("unlock.password-input", { timeoutMs: 10_000 });
        expect(existsSync(vaultMetaPath(app.appDataDir, fixture.vaultId))).toBe(true);

        // Confirm arm: exact "DELETE" → vault dir removed → Welcome.
        await (await app.session.byTestId("unlock.delete-link")).click();
        const confirmInput2 = await app.session.byTestId("delete-vault.confirm-input", {
          timeoutMs: 10_000,
        });
        await confirmInput2.sendKeys("DELETE");
        const submit2 = await app.session.byTestId("delete-vault.submit");
        await app.session.waitUntil(() => submit2.enabled(), {
          label: "delete submit enabled on exact DELETE",
          timeoutMs: 10_000,
        });
        await submit2.click();
        await app.session.byTestId("welcome.root", { timeoutMs: 20_000 });
        expect(existsSync(join(app.appDataDir, "vaults", fixture.vaultId))).toBe(false);
      },
    );
  });
});

// VU-13 — myne-md/myne#557's `vault.unlock` bullet: "the password field owns
// focus at first paint and keys typed immediately all land".
//
// # Why this was a roster row, and why it does not need to be
//
// It reads like a thing only a person can judge — you open the app, you start
// typing, and either your first characters are there or they are not. Two facts
// make it mechanical. `launchApp` IS a cold boot, so "first paint" is the state
// every scenario already starts in; and `support/keyboard.ts::activeTestId`
// reads `document.activeElement`'s testid, so "owns focus" is a string
// comparison.
//
// # The second half is the one with teeth
//
// A focus that arrives one frame LATE passes an `activeElement` check taken a
// moment later and still eats the user's first keystrokes: they land on the
// document, not the field. So the assertion that matters is not where focus is,
// it is that a burst typed at the earliest possible moment arrives WHOLE. This
// types immediately after the element resolves — no settle, no focus click, no
// intervening wait — and compares the field's `value` against the payload
// character for character. A dropped prefix fails on the exact characters lost.
//
// The payload is a scenario constant and not a credential (SYNC-13): it is never
// submitted, and nothing about it reaches a failure diff that a password would.
describeE2E("VU-13 the unlock field owns focus at first paint (myne-md/myne#557)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("focuses the password field on a cold boot and loses no keystroke typed into it", async () => {
    // Deliberately not a password shape: mixed case, digits and punctuation, so
    // a dropped leading character cannot be mistaken for a shift-key artefact.
    const BURST = "abcdefghij0123456789";
    await scenario(
      "vu13-first-paint-focus",
      { seed: (dir) => void seedVault(dir) },
      async (app) => {
        const s = app.session;

        // Cold boot. Resolve the field and do NOTHING else — no click, no
        // settle. Anything here would hand focus to the field ourselves and
        // make the assertion about our own click.
        const field = await s.byTestId("unlock.password-input", { timeoutMs: 20_000 });

        // 1. Focus is already there.
        await s.waitUntil(
          async () =>
            (await activeTestId(s)) === "unlock.password-input" ? true : null,
          {
            label: "the password field owns focus at first paint",
            timeoutMs: 10_000,
          },
        );

        // 2. …and it owned focus early enough that a burst typed right now
        //    arrives whole. `typeIntoActive`, not `Element.sendKeys`:
        //    element-scoped typing FOCUSES the element first, which is exactly
        //    the thing under test.
        await typeIntoActive(s, BURST);
        await s.waitUntil(
          async () => ((await field.property<string>("value")) === BURST ? true : null),
          {
            label: `every keystroke of a ${BURST.length}-character burst landed`,
            timeoutMs: 10_000,
          },
        );
        expect(await field.property<string>("value")).toBe(BURST);
      },
    );
  });
});
