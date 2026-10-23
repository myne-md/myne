// The B2B member roster, end to end (myne-md/myne#698).
//
// Uses the shared `scenario` helper, which self-skips when the platform or
// binary cannot run the harness (a macOS host, a missing build), the same
// gate every other suite on this lane carries.
//
// What this proves that no other tier can: the Settings → Sync member-roster
// panel exists in the REAL app and answers the PRE-B2B shape honestly. A
// single-account vault (no membership roster extension) renders the panel
// with an EMPTY list, a no-op by construction, not a hidden error. The invite
// is now by identity code and posts to the sealed relay; the two-device accept
// and removal flows are owed (manual-test roster).
//
// The empty-state arm is load-bearing: it pins that the panel is a no-op on
// every vault a pre-B2B user holds, which is the back-compat half of
// decisions/protocol/0592.

import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeE2E, scenario } from "./support/scenario";
import {
  closeSettings,
  dismissImporterOffer,
  openSettings,
  selectSettingsTopic,
  unlockToEditor,
} from "./support/flows";
import { seedVault, type SeededVault } from "./support/fixtures";
import { testIdSelector } from "./support/webdriver";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { syncConfigSeed } from "./support/multi-device";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Deterministic member public halves for the invite (generated once via the
 *  Rust person-keypair fixtures, so the PQ-hybrid wrap succeeds; the member
 *  never accepts, but the roster lists them). */
const MEMBER_FIXTURE: {
  member_kem_ek_hex: string;
  member_ed_pk_hex: string;
  member_mldsa_vk_hex: string;
  member_fingerprint_hex: string;
} = JSON.parse(readFileSync(join(HERE, "fixtures", "b2b", "member.json"), "utf8"));

/** Fixed test phrase for the person identity (the public BIP-39
 *  abandon/about vector, not a secret; first enrolment mints the owner
 *  identity, whose fingerprint varies per run). */
const PERSON_PHRASE = `${"abandon ".repeat(23).trim()} about`;
const IDENTITY_CODE_COPIED = "Identity code copied";
const serverSupport = syncServerSupported();
if (!serverSupport.ok) {
  // eslint-disable-next-line no-console
  console.warn(`[e2e] member-roster identity-home scenario skipped: ${serverSupport.reason}`);
}

describeE2E("MR-1 member roster panel renders (myne-md/myne#698)", () => {
  it("the panel mounts in Sync settings and answers empty on a single-account vault", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "mr1-roster-empty",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        await openSettings(app.session, "sync");
        // **Two topics, and the split is the panel's own** (myne-md/myne#885).
        // The Identity block leads the CONNECTION topic, because the panel's
        // header states the reason: whether this device holds a person identity
        // decides what the rest of the panel can do. The rosters live on DEVICES,
        // with the members that need one. This scenario used to assume one view
        // carried both, which no view does since the split.
        await selectSettingsTopic(app.session, "sync", "connection");
        // The phrase form is what a fresh process shows, and it is a dialog
        // behind the row's own action (myne-md/myne#831, myne-md/myne#885): the
        // grid is no longer inlined under the row, so the affordance is the
        // trigger and the form is one click in.
        await (await app.session.byTestId("sync.panel.identity-unlock.open")).click();
        await app.session.byTestId("sync.panel.identity-unlock");
        await (await app.session.byTestId("sync.panel.identity-unlock.cancel")).click();
        await app.session.waitForGone(
          testIdSelector("sync.panel.identity-unlock"),
          { timeoutMs: 10_000 },
        );

        await selectSettingsTopic(app.session, "sync", "devices");
        await app.session.byTestId("member-roster", { timeoutMs: 10_000 });
        const invitationObservationEndsAt = Date.now() + 1_000;
        await app.session.waitUntil(
          async () => {
            if (Date.now() < invitationObservationEndsAt) return null;
            const errors = await app.session.byTestIdAll("member-roster.invitations-error");
            return errors.length === 0 ? true : null;
          },
          { timeoutMs: 3_000, label: "no invitation error before identity unlock" },
        );
        // The empty-list arm: this is the load-bearing back-compat claim (a
        // single-account vault renders the panel as a no-op, not an error), so
        // the assertion is on the empty paragraph, not merely the mount.
        await app.session.byTestId("member-roster.empty");
        // The invite button is present but DISABLED until identity unlocks;
        // this pins the gate rather than only the mount.
        const invite = await app.session.byTestId("member-roster.invite-button");
        expect(await invite.attribute("disabled")).not.toBeNull();
        await closeSettings(app.session);
      },
    );
  });

  it("the invite form takes an identity code and offers to post it", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "mr2-invite-code",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        await openSettings(app.session, "sync");
        // **The identity is unlocked on CONNECTION, the roster is on DEVICES**
        // (myne-md/myne#885). The two are one click apart, which is the panel's
        // design: the identity question leads the topic about this device's
        // account, and the rosters sit with the members that need one.
        // The phrase form is behind the row's action, not inlined under it
        // (myne-md/myne#831).
        await selectSettingsTopic(app.session, "sync", "connection");
        await (await app.session.byTestId("sync.panel.identity-unlock.open")).click();
        await app.session.byTestId("sync.panel.identity-unlock");
        // Unlock the person identity; first enrolment mints the owner.
        for (const [index, word] of PERSON_PHRASE.split(" ").entries()) {
          const testId =
            index === 0
              ? "sync.panel.identity-unlock.phrase-input"
              : `sync.panel.identity-unlock.phrase-cell-${index + 1}`;
          await (await app.session.byTestId(testId)).replaceText(word);
        }
        await (await app.session.byTestId("sync.panel.identity-unlock.submit")).click();
        // Unlocked: back to the roster's own topic.
        await selectSettingsTopic(app.session, "sync", "devices");
        await app.session.byTestId("member-roster.person-ready");
        await (await app.session.byTestId("member-roster.copy-owner-code")).click();
        await app.session.waitUntil(
          async () => {
            const toasts = await app.session.byTestIdAll("editor.toast-message");
            if (toasts.length === 0) return null;
            const message = (await toasts[0].text()).trim();
            return message === IDENTITY_CODE_COPIED ? true : null;
          },
          { label: "identity code copy reports success", timeoutMs: 10_000 },
        );
        // The invite button is a TWO-STEP door on an unshared vault: the
        // NTV5 -> NTV6 migration is permanent, so a confirmation precedes the
        // form (myne-md/myne#783). The migration is a local `vault.meta`
        // rewrite, so it needs no server. Asserting the form is still closed
        // between the two steps is the half that keeps the confirmation from
        // being decorative.
        await (await app.session.byTestId("member-roster.invite-button")).click();
        await app.session.byTestId("member-roster.share-confirm");
        expect(await app.session.byTestIdAll("member-roster.invite-modal")).toHaveLength(0);
        await (await app.session.byTestId("member-roster.share-confirm-cta")).click();
        // The invite form takes the invitee's identity code (person id +
        // public halves), not three pasted hexes (myne-md/myne#711 task 11).
        await app.session.byTestId("member-roster.invite-modal");
        const code = [
          "MYNE-PERSON-1",
          "77".repeat(16),
          MEMBER_FIXTURE.member_kem_ek_hex,
          MEMBER_FIXTURE.member_ed_pk_hex,
          MEMBER_FIXTURE.member_mldsa_vk_hex,
        ].join(":");
        await (await app.session.byTestId("member-roster.invite-code")).replaceText(code);
        // The local half is what this scenario pins: the code is accepted and the
        // post is offered. Submitting would post to the sealed relay, which needs
        // an enrolled vault + server; the two-device accept and removal flows are
        // owed (manual-test roster).
        const submit = await app.session.byTestId("member-roster.invite-confirm");
        expect(await submit.attribute("disabled")).toBeNull();
        await (await app.session.byTestId("member-roster.invite-cancel")).click();
        await closeSettings(app.session);
      },
    );
  });

  (serverSupport.ok ? it : it.skip)("shows a real invitation-fetch failure after identity unlock", async () => {
    const server = await startSyncServer();
    try {
      await scenario(
        "mr3-invitation-fetch-failure",
        {
          seed: (appDataDir) => {
            seedVault(appDataDir, { password: "CanaryPass-9-animals!" });
          },
          seedConfig: syncConfigSeed(server.url),
        },
        async (app) => {
           await unlockToEditor(app.session, "CanaryPass-9-animals!");
           await dismissImporterOffer(app.session);
           await openSettings(app.session, "sync");
           // The roster lives on the Devices topic since the Sync panel split
           // (myne-md/myne#885), and the IDENTITY block lives on Connection, one
           // topic over. Waiting for the unlock row on the roster's own topic is
           // what made this spec fail: the control had moved, and nothing said
           // so. Re-sited rather than given more budget.
           await selectSettingsTopic(app.session, "sync", "devices");
          await app.session.byTestId("member-roster");
          await selectSettingsTopic(app.session, "sync", "connection");
          // The identity unlock is collapsed by default (myne-md/myne#831).
          await (await app.session.byTestId("sync.panel.identity-unlock.open")).click();
          for (const [index, word] of PERSON_PHRASE.split(" ").entries()) {
            const testId =
              index === 0
                ? "sync.panel.identity-unlock.phrase-input"
                : `sync.panel.identity-unlock.phrase-cell-${index + 1}`;
            await (await app.session.byTestId(testId)).replaceText(word);
          }
          await (await app.session.byTestId("sync.panel.identity-unlock.submit")).click();
          // Back to the roster's topic: `person-ready` and the invite door are
          // the roster's, not the connection block's.
          await selectSettingsTopic(app.session, "sync", "devices");
           await app.session.byTestId("member-roster.person-ready");
           // The sent-invitation fetch is gated on a SHARED vault
           // (myne-md/myne#783): an `NTV5` vault has no roster, so the hook
           // deliberately never asks and this error line is a surface the code
           // does not reach. Migrate first, or the scenario asserts something
           // that cannot happen rather than something that should.
           await (await app.session.byTestId("member-roster.invite-button")).click();
           await app.session.byTestId("member-roster.share-confirm");
           await (await app.session.byTestId("member-roster.share-confirm-cta")).click();
           // The migration is a local `vault.meta` rewrite, so it lands with the
           // server still up. Waiting for the form it opens is what makes the
           // teardown below the FIRST moment the endpoint is unreachable, which
           // is the whole premise of the scenario.
           await app.session.byTestId("member-roster.invite-modal");
           await (await app.session.byTestId("member-roster.invite-cancel")).click();
           await closeSettings(app.session);
           await server.teardown();
           await openSettings(app.session, "sync");
           // The roster lives on the Devices topic since the Sync panel split (myne-md/myne#885).
           await selectSettingsTopic(app.session, "sync", "devices");
           await app.session.byTestId("member-roster.person-ready");
           await app.session.byTestId("member-roster.invitations-error", { timeoutMs: 10_000 });
        },
      );
    } finally {
      await server.teardown();
    }
  });

  (serverSupport.ok ? it : it.skip)("identity-only home exposes the public code and copies it", async () => {
    // Vault-count precondition: 0.
    const server = await startSyncServer();
    try {
      await scenario(
        "mr3-identity-home",
        { seedConfig: syncConfigSeed(server.url) },
        async (app) => {
          // The first run's ONE door (myne-md/myne#911 task 6): the identity
          // ceremony is inline on its own stage, not a dialog over Welcome.
          await (await app.session.byTestId("welcome.create-cta")).click();
          await (await app.session.byTestId("first-run.identity.create-cta")).click();
          await app.session.byTestId("first-run.identity.phrase");
          // The ceremony is TWO steps since myne-md/myne#869: reveal the grid on
          // the phrase step, read the words off it, Continue to the challenge, and
          // answer the four positions it draws. Done is gated on all four, so
          // without this the scenario can never leave the ceremony.
          await (await app.session.byTestId("first-run.identity.phrase-reveal")).click();
          const cells = await app.session.byTestIdAll("first-run.identity.phrase-word");
          const words = (
            await Promise.all(cells.map(async (c) => (await c.text()).trim()))
          ).map((t) => t.replace(/^\d+/, "").trim());
          await (await app.session.byTestId("first-run.identity.phrase-continue")).click();
          // Elements go STALE on step remount, so the confirm handles are fetched
          // AFTER the transition, not before it.
          for (const input of await app.session.byTestIdAll("first-run.identity.confirm-input")) {
            const pos = Number(await input.attribute("data-index"));
            await input.sendKeys(words[pos - 1]);
          }
          await (await app.session.byTestId("first-run.identity.close-cta")).click();
          // Done hands off to vault creation, so reaching the identity home is
          // the ABANDON path: Back from the briefing re-probes, and boot routing
          // answers "identity, no vault" with the home (myne-md/myne#911 task 4).
          // The Esc-block assertion that used to live here moved with the
          // ceremony's own suite (`tests/components/identitySetupTypeBack.test.tsx`
          // refuses all three dismissal routes; the first run has no modal to
          // dismiss).
          await (await app.session.byTestId("create.briefing-back")).click();
          await app.session.byTestId("identity-home.identity-code");
          const code = await app.session.byTestId("identity-home.identity-code");
          expect(await code.attribute("readonly")).not.toBeNull();
          await (await app.session.byTestId("identity-home.copy-code")).click();
          await app.session.waitUntil(
            async () => {
              const toasts = await app.session.byTestIdAll("editor.toast-message");
              if (toasts.length === 0) return null;
              return (await toasts[0].text()).trim() === IDENTITY_CODE_COPIED ? true : null;
            },
            { label: "identity home code copy reports success", timeoutMs: 10_000 },
          );
        },
      );
    } finally {
      await server.teardown();
    }
  });

  // RETIRED (myne-md/myne#911 task 6): "a vault-less device with a saved server
  // can still reach the server step" tested `FirstRunServerStep` as mounted by
  // the identity dialog. Onboarding no longer configures a server at all, so
  // that surface is unreachable by design and the scenario had nothing left to
  // assert. The endpoint form itself still exists under Settings, and it is
  // exercised there by the sync scenarios that drive `sync.endpoint-input`.

});
