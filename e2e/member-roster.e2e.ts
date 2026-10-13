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
  unlockToEditor,
} from "./support/flows";
import { seedVault, type SeededVault } from "./support/fixtures";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { httpsConfigSeed, syncConfigSeed } from "./support/multi-device";

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
        // The panel mounts with the person-identity step first: the invite
        // path needs a held identity, so the phrase form is what a fresh
        // process shows.
        await app.session.byTestId("member-roster", { timeoutMs: 10_000 });
        await app.session.byTestId("sync.panel.identity-unlock");
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

  it("the invite form takes an identity code and gates the post on a confirmed SAS compare", async () => {
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
        await app.session.byTestId("member-roster", { timeoutMs: 10_000 });
        // The identity unlock is the Sync panel's Identity block, collapsed by
        // default; the member roster no longer carries its own grid
        // (myne-md/myne#831).
        await (await app.session.byTestId("sync.panel.identity-unlock.open")).click();
        // Unlock the person identity; first enrolment mints the owner.
        for (const [index, word] of PERSON_PHRASE.split(" ").entries()) {
          const testId =
            index === 0
              ? "sync.panel.identity-unlock.phrase-input"
              : `sync.panel.identity-unlock.phrase-cell-${index + 1}`;
          await (await app.session.byTestId(testId)).replaceText(word);
        }
        await (await app.session.byTestId("sync.panel.identity-unlock.submit")).click();
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
        // Inspect derives the SAS fingerprint locally (pure; no server needed).
        await (await app.session.byTestId("member-roster.inspect")).click();
        await app.session.byTestId("member-roster.sas-fingerprint");
        // The post is gated on an explicit confirm.
        const submit = await app.session.byTestId("member-roster.invite-confirm");
        expect(await submit.attribute("disabled")).not.toBeNull();
        await (await app.session.byTestId("member-roster.sas-confirm")).click();
        // Submitting would post to the sealed relay, which needs an enrolled
        // vault + server; this scenario pins the local form and the SAS gate. The
        // two-device accept and removal flows are owed (manual-test roster).
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
          await app.session.byTestId("member-roster");
          // The identity unlock now lives in the Sync panel's Identity block
          // (myne-md/myne#831); it is collapsed by default.
          await (await app.session.byTestId("sync.panel.identity-unlock.open")).click();
          for (const [index, word] of PERSON_PHRASE.split(" ").entries()) {
            const testId =
              index === 0
                ? "sync.panel.identity-unlock.phrase-input"
                : `sync.panel.identity-unlock.phrase-cell-${index + 1}`;
            await (await app.session.byTestId(testId)).replaceText(word);
          }
          await (await app.session.byTestId("sync.panel.identity-unlock.submit")).click();
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
          await app.session.byTestId("welcome.identity-cta");
          await (await app.session.byTestId("welcome.identity-cta")).click();
          await (await app.session.byTestId("identity-setup.create-cta")).click();
          await app.session.byTestId("identity-setup.phrase");
          // The type-back below the grid gates Done (myne-md/myne#855): reveal the
          // grid, read the words off it, and answer the four positions the challenge
          // asks for. Without this the scenario can never leave the dialog, which is
          // the point of the challenge.
          await (await app.session.byTestId("identity-setup.phrase-reveal")).click();
          const cells = await app.session.byTestIdAll("identity-setup.phrase-word");
          const words = (
            await Promise.all(cells.map(async (c) => (await c.text()).trim()))
          ).map((t) => t.replace(/^\d+/, "").trim());
          for (const input of await app.session.byTestIdAll("identity-setup.confirm-input")) {
            const pos = Number(await input.attribute("data-index"));
            await input.sendKeys(words[pos - 1]);
          }
          await (await app.session.byTestId("identity-setup.close-cta")).click();
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

  it("a vault-less device with a saved server can still choose a self-hosted server", async () => {
    // Vault-count precondition: 0. A saved endpoint is not a vault or an identity.
    await scenario(
      "mr4-first-run-server-recovery",
      { seedConfig: httpsConfigSeed() },
      async (app) => {
        await (await app.session.byTestId("welcome.identity-cta")).click();
        await app.session.byTestId("identity-setup.create-cta");
        await (await app.session.byTestId("identity-setup.change-server")).click();
        await app.session.byTestId("first-run-server.myne-sync");
        await (await app.session.byTestId("first-run-server.self-hosted")).click();
        await app.session.byTestId("sync.endpoint-config");
        await app.session.byTestId("sync.pin-source");
        expect(await app.session.byTestIdAll("sync.endpoint-reverify")).toHaveLength(0);
        const continueButton = await app.session.byTestId("first-run-server.continue");
        expect(await continueButton.attribute("disabled")).not.toBeNull();
        await (await app.session.byTestId("first-run-server.back")).click();
        await (await app.session.byTestId("first-run-server.back")).click();
        await app.session.byTestId("identity-setup.create-cta");
      },
    );
  });
});
