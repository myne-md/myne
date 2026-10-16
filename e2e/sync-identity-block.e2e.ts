// The Sync settings Identity block (myne-md/myne#792).
//
// Uses the shared `scenario` helper (self-skips off-platform / without a build),
// like every suite on this lane.
//
// What this proves that the component test cannot: the block renders in the
// REAL app in its empty state, and it flips to "unlocked" after the identity is
// unlocked through the block's own inline phrase entry. That flip is the reason
// the block subscribes to the shared person-identity store rather than a
// mount-time probe (myne-md/myne#792 review): the locked -> unlocked transition
// has to be visible without reopening Settings.
//
// The block's LOCKED state (the held identity's public code plus an unlock
// action, on an `NTV6` vault whose identity is not held this session) is covered
// by `tests/components/SyncPanel.identity-block.test.tsx`; reaching it in E2E
// needs a device that holds a sealed identity without a held person session,
// which this harness does not provision. The phrase unlock path itself is
// covered by `member-roster.e2e.ts` mr2.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import {
  closeSettings,
  dismissImporterOffer,
  openSettings,
  selectSettingsTopic,
  unlockToEditor,
} from "./support/flows";
import { seedVault, type SeededVault } from "./support/fixtures";

/** Fixed test phrase for the person identity (the public BIP-39 abandon/about
 *  vector, not a secret). First enrolment mints the owner identity. */
const PERSON_PHRASE = `${"abandon ".repeat(23).trim()} about`;

describeE2E("SYNC-IDENTITY identity block (myne-md/myne#792)", () => {
  it("renders the block, offers Add when no identity exists, and flips to unlocked after the roster unlock", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "sync-identity-block",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir);
        },
      },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        await openSettings(app.session, "sync");

        // The block renders even when no identity exists: the Add CTA is the
        // empty state (before this change the whole block was absent).
        await app.session.byTestId("sync.panel.add-identity", { timeoutMs: 10_000 });

         // Unlock the identity through the block's own inline phrase entry
         // (moved here from the member roster, myne-md/myne#831). The block is on
         // the Connection topic; the roster is on Devices (myne-md/myne#885).
         // The recovery-phrase grid is collapsed by default.
         await (await app.session.byTestId("sync.panel.identity-unlock.open")).click();
         for (const [index, word] of PERSON_PHRASE.split(" ").entries()) {
          const testId =
            index === 0
              ? "sync.panel.identity-unlock.phrase-input"
              : `sync.panel.identity-unlock.phrase-cell-${index + 1}`;
          await (await app.session.byTestId(testId)).replaceText(word);
        }
        await (await app.session.byTestId("sync.panel.identity-unlock.submit")).click();

        // The block reflects the unlock through the shared store, without a
        // Settings reopen, and the Add CTA is gone.
        await app.session.byTestId("sync.panel.identity-unlocked", { timeoutMs: 10_000 });
        expect(await app.session.byTestIdAll("sync.panel.add-identity")).toHaveLength(0);

        // And the roster, one topic over, sees the same unlocked person.
        await selectSettingsTopic(app.session, "sync", "devices");
        await app.session.byTestId("member-roster", { timeoutMs: 10_000 });
        await app.session.byTestId("member-roster.person-ready");

        await closeSettings(app.session);
      },
    );
  });
});
