// myne-md/myne#911 task 10, retargeted by myne-md/myne#938: the explicit upgrade
// of an existing vault to the password-only (`NTV8`) generation.
//
// **The endpoint moved, and this file moved with it.** `#911` built this upgrade
// to end on `NTV7`, where the owner's identity phrase also opened the vault. That
// second door is exactly what `decisions/protocol/0758` removed: `NTV7` is never
// written again, and the explicit upgrade now chains the owner B2B migration into
// a truncation, so the frame it commits is `NTV8`. Leaving the scenario asserting
// `NTV7` would have been a green-looking claim about a format the product no
// longer produces.
//
// The acceptance line is four claims about ONE vault, in order: before the
// upgrade it works exactly as it did; the upgrade is explicit and names its two
// consequences before the button; after it NEITHER phrase opens the vault and the
// password still does; and the bytes on disk carry the new magic.
//
// **Why the fixture is a SEEDED vault rather than one created in the flow.** A
// vault created today is born `NTV8`, so it has nothing to upgrade.
// This is the existing-user path, and a seeded pre-upgrade vault is the only way
// to stand in it. The seed is `NTV5`, which also exercises the chained arm: the
// upgrade runs the owner B2B migration first (which produces an `NTV7` frame),
// then truncates it, because the group tail is what a password-only vault needs
// to be shareable.
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
  clickByTestId,
  closeSettings,
  dismissImporterOffer,
  openSettings,
  openSyncConnection,
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
  await openSyncConnection(session);
  // `clickByTestId`, not a raw `.click()`, and the difference is the whole
  // failure. Settings' scrolling body is a nested `overflow: auto` container,
  // WebKit's own scroll-into-view does not reliably reach one, and this control
  // is now below the fold: the raw click sat at `element not interactable` for
  // its full 10 s and reported the ELEMENT, which reads as a missing control.
  // `clickByTestId` scrolls inside the container on every poll (the same fix
  // `sync-replication` needed for the SAS button).
  await clickByTestId(session, "sync.panel.add-identity", { timeoutMs: 20_000 });
  await session.byTestId("identity-setup.root", { timeoutMs: 15_000 });
  // Same reason as the line above: a dialog is its own scrolling container, and
  // the create gate sits below the fold of it.
  await clickByTestId(session, "identity-setup.create-cta", { timeoutMs: 20_000 });

  await session.byTestId("identity-setup.phrase", { timeoutMs: 120_000 });
  await clickByTestId(session, "identity-setup.phrase-reveal");
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

  // **The block reports `unregistered`, not `unlocked`, and this scenario has no
  // server, so that is the state it can honestly name (2026-10-25).** The panel's
  // helper is one ternary — `needsRegistration ? unregistered : identityUnlocked
  // ? unlocked : locked` — and a `reserved` identity (on this device, on no
  // server) takes the FIRST arm however unlocked its session is, because
  // `person_register` is what installs the person session and it needs a named
  // endpoint. Waiting for `identity-unlocked` here was waiting for a word the
  // panel deliberately stops printing.
  //
  // What the upgrade itself needs is the identity's KEYPAIR in the session, and
  // that is still asserted, by its consequence: an `NTV5` source signs its first
  // roster, so a ceremony that failed to install the keypair fails the upgrade
  // step below as `IdentityLocked` rather than as a mystery.
  await session.waitForElement(testIdSelector("sync.panel.identity-unregistered"), {
    timeoutMs: 20_000,
  });
  return words;
}

describeE2E("VA-1 upgrade to a password-only vault (myne-md/myne#911 task 10, myne-md/myne#938)", () => {
  it("retires the vault phrase, keeps the password, and leaves no phrase door at all", async () => {
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

        // The first editor mount on a fresh vault offers the importer, and the
        // offer makes the page `inert` (`useOverlayInert`), so EVERY control
        // below it — including the Settings gear — is refused as "element not
        // interactable" while it is up. Dismissing it is not cosmetic.
        await dismissImporterOffer(session);

        // 2. The identity, created after the fact.
        // The words are not needed below any more: no phrase opens this vault
        // after the upgrade. The ceremony is still driven for real, because the
        // upgrade needs the identity's KEYPAIR in the session and a mocked one
        // would prove nothing.
        await createIdentityFromSettings(session);

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
        expect(meta.subarray(0, 4).toString("ascii")).toBe("NTV8");
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
        // `null`, not `true`: the probe answers three states and this one means
        // "this vault has no second credential". A `true` here would be the
        // pre-#938 answer, and the Unlock screen keys the whole recovery door off
        // it (myne-md/myne#938).
        expect(probe.ok).toBeNull();

        await closeSettings(session);

        // 5. The password still opens the vault, exactly as before.
        await (await session.byTestId("editor.lock-cta")).click();
        await unlockToEditor(session, seeded.password);

        // 6. NEITHER phrase is offered, and that is the claim this scenario was
        //    retargeted to make. The saved vault phrase is retired by the
        //    upgrade, and the identity phrase never opens an `NTV8` vault, so the
        //    unlock screen has no recovery link at all: it states the password is
        //    the only way in. The identity ceremony above is what proves the
        //    upgrade needed a real identity rather than a mocked one.
        await (await session.byTestId("editor.lock-cta")).click();
        await session.byTestId("unlock.password-only-note", { timeoutMs: 20_000 });
        expect(await session.byTestIdAll("unlock.recovery-link")).toHaveLength(0);

        // 7. And the password still opens it, which is what "the vault is not
        //    lost" means for this generation.
        await unlockToEditor(session, seeded.password);
      },
    );
  });
});
