// myne-md/myne#911 task 10: the explicit upgrade of an existing vault to the
// person-wrapped (`NTV7`) generation.
//
// The acceptance line is four claims about ONE vault, in order: before the
// upgrade it works exactly as it did; the upgrade is explicit and names its two
// consequences before the button; after it the saved vault phrase no longer
// opens the vault, the password still does, and the owner's identity phrase
// does; and the bytes on disk carry the new magic.
//
// **Why the fixture is a SEEDED vault rather than one created in the flow.** A
// vault created today is born `NTV7` (task 5), so it has nothing to upgrade.
// This is the existing-user path, and a seeded pre-upgrade vault is the only way
// to stand in it. The seed is `NTV5`, which also exercises the chained arm: the
// upgrade runs the owner B2B migration first, because `NTV7` carries that tail.
//
// **Why the identity is created from Settings rather than from the first run.**
// This device already has a vault, so boot lands on Unlock and the first-run
// chain is unreachable. Creating the identity afterwards is the real path for an
// existing user, and it is the one that proves the upgrade does not need a
// device that was born into the person model.
//
// Nothing here asserts a phrase or a password into the failure output: the
// identity words are captured as data and compared positionally.

import { expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import {
  closeSettings,
  openSettings,
  pageSeatInvoke,
  selectSettingsTopic,
  unlockToEditor,
} from "./support/flows";
import { seedVaults, vaultMetaPath, type SeededVault } from "./support/fixtures";
import { testIdSelector, type Session } from "./support/webdriver";
import i18n from "../src/i18n";

/**
 * Create the identity from Settings → Sync, and return its 24 words.
 *
 * The ceremony is the shared `IdentitySetupPanel` the first run mounts, so the
 * steps are the same ones `startFirstRunIdentity` takes; only the door differs.
 * The panel's own prefix (`identity-setup`) is the dialog's default.
 */
async function createIdentityFromSettings(session: Session): Promise<string[]> {
  await openSettings(session, "sync");
  await selectSettingsTopic(session, "sync", "connection");
  await (
    await session.byTestId("sync.panel.add-identity", { timeoutMs: 20_000 })
  ).click();
  await session.byTestId("identity-setup.root", { timeoutMs: 15_000 });
  await (
    await session.byTestId("identity-setup.create-cta", { timeoutMs: 20_000 })
  ).click();

  await session.byTestId("identity-setup.phrase", { timeoutMs: 120_000 });
  await (await session.byTestId("identity-setup.phrase-reveal")).click();
  const words = await session.execute<string[]>(
    "var words = [];" +
      "for (var i = 1; i <= 24; i++) {" +
      "  var el = document.querySelector(" +
      "    '[data-testid=\"identity-setup.phrase-word\"][data-index=\"' + i + '\"] span:last-child');" +
      "  words.push(el ? el.textContent || '' : '');" +
      "}" +
      "return words;",
  );
  expect(words.length).toBe(24);
  expect(words.every((word) => word.length > 0)).toBe(true);

  const cont = await session.byTestId("identity-setup.phrase-continue");
  await session.waitUntil(() => cont.enabled(), {
    label: "identity phrase continue enabled after reveal",
    timeoutMs: 10_000,
  });
  await cont.click();

  const cells = await session.byTestIdAll("identity-setup.confirm-input");
  expect(cells.length).toBe(4);
  for (const cell of cells) {
    const pos = Number(await cell.attribute("data-index"));
    expect(pos).toBeGreaterThanOrEqual(1);
    expect(pos).toBeLessThanOrEqual(24);
    await cell.sendKeys(words[pos - 1]);
  }
  const done = await session.byTestId("identity-setup.close-cta");
  await session.waitUntil(() => done.enabled(), {
    label: "identity done enabled after type-back",
    timeoutMs: 10_000,
  });
  await done.click();

  // The upgrade needs the identity's KEYPAIR in the session, not merely the
  // sealed file on disk: an `NTV5` source signs its first roster. This is the
  // assertion that the ceremony installed it, so a regression here fails as
  // `IdentityLocked` in the next step rather than as a mystery.
  await session.waitForElement(testIdSelector("sync.panel.identity-unlocked"), {
    timeoutMs: 20_000,
  });
  return words;
}

/** Type a 24-word phrase into the identity-phrase unlock grid. */
async function enterIdentityPhrase(session: Session, words: string[]): Promise<void> {
  // The grid's first cell carries its own id and every later cell a numbered
  // one (`PhraseEntryGrid`'s `cellTestId`), so the loop addresses them the way
  // the component names them rather than by DOM order.
  for (let index = 1; index <= 24; index += 1) {
    const testId =
      index === 1
        ? "unlock.identity-phrase-input"
        : `unlock.identity-phrase-cell-${index}`;
    const cell = await session.byTestId(testId, { timeoutMs: 10_000 });
    await cell.sendKeys(words[index - 1]);
  }
}

describeE2E("VA-1 upgrade to one-phrase recovery (myne-md/myne#911 task 10)", () => {
  it("retires the vault phrase, keeps the password, and opens with the identity phrase", async () => {
    let seeded!: SeededVault;
    await scenario(
      "va1-upgrade",
      {
        seed: (dir) => {
          seeded = seedVaults(dir, { count: 1 })[0];
        },
      },
      async (app) => {
        const { session } = app;

        // 1. Before the upgrade: the vault opens with the password it was made
        //    with, and its own phrase is still a credential.
        await unlockToEditor(session, seeded.password);
        expect(
          await readFileSync(vaultMetaPath(app.appDataDir, seeded.vaultId))
            .subarray(0, 4)
            .toString("ascii"),
        ).toBe("NTV5");

        // 2. The identity, created after the fact.
        const identityWords = await createIdentityFromSettings(session);

        // 3. The upgrade, through the Vault panel.
        await openSettings(session, "vault");
        await selectSettingsTopic(session, "vault", "vault");
        await (
          await session.byTestId("settings.vault.format-cta", { timeoutMs: 20_000 })
        ).click();
        // Both irreversible consequences are on screen BEFORE the confirming
        // button: the phrase stops working, and older clients cannot open it.
        const warning = await session.byTestId("settings.vault.format-warning", {
          timeoutMs: 10_000,
        });
        const warningText = await warning.textContent();
        expect(warningText).toContain(i18n.t("settings.vault.format.warningPhrase"));
        expect(warningText).toContain(i18n.t("settings.vault.format.warningDevices"));
        await (
          await session.byTestId("settings.vault.format-confirm")
        ).click();
        await session.byTestId("settings.vault.format-done", { timeoutMs: 60_000 });

        // 4. The bytes on disk are the new generation, and the frame is marked
        //    for the sync loop: nothing else would push it, because the upgrade
        //    edits no note and the meta phase only pushes a dirty meta.
        const meta = readFileSync(vaultMetaPath(app.appDataDir, seeded.vaultId));
        expect(meta.subarray(0, 4).toString("ascii")).toBe("NTV7");
        expect(
          existsSync(
            join(app.appDataDir, "vaults", seeded.vaultId, "vault.meta-dirty"),
          ),
        ).toBe(true);
        const probe = await pageSeatInvoke(
          session,
          "plugin:vault-unlock|vault_is_person_wrapped",
          {},
          15_000,
        );
        expect(probe.err).toBeUndefined();
        expect(probe.ok).toBe(true);

        await closeSettings(session);

        // 5. The password still opens the vault, exactly as before.
        await (await session.byTestId("editor.lock-cta")).click();
        await unlockToEditor(session, seeded.password);

        // 6. The saved vault phrase is retired: the unlock screen's escape hatch
        //    is the identity phrase, not the vault-recovery flow. That the link
        //    says so is the assertion that the phrase arm is unreachable.
        await (await session.byTestId("editor.lock-cta")).click();
        const link = await session.byTestId("unlock.recovery-link", {
          timeoutMs: 20_000,
        });
        expect(await link.textContent()).toBe(i18n.t("unlock.identityPhraseLink"));
        await link.click();
        await session.byTestId("unlock.identity-phrase-grid", { timeoutMs: 10_000 });
        await enterIdentityPhrase(session, identityWords);
        await (
          await session.byTestId("unlock.identity-phrase-submit")
        ).click();

        // 7. The identity phrase opened it.
        await session.byTestId("editor.root", { timeoutMs: 45_000 });
      },
    );
  });
});
