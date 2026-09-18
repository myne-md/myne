// The B2B member roster, end to end (myne-md/myne#698).
//
// Uses the shared `scenario` helper, which self-skips when the platform or
// binary cannot run the harness (a macOS host, a missing build), the same
// gate every other suite on this lane carries.
//
// What this proves that no other tier can: the Settings → Sync member-roster
// panel exists in the REAL app and answers the PRE-B2B shape honestly. A
// single-account vault (no membership roster extension) renders the panel
// with an EMPTY list, a no-op by construction, not a hidden error. The full
// two-device invite flow needs the Grill 4 wire route and lands with it.
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
        await app.session.byTestId("member-roster.person-unlock");
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

  it("the roster lists the owner and member with role badges after an invite", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "mr2-roster-roles",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        await openSettings(app.session, "sync");
        await app.session.byTestId("member-roster", { timeoutMs: 10_000 });
        // Unlock the person identity; first enrolment mints the owner.
        const phraseInput = await app.session.byTestId("member-roster.phrase-input");
        await phraseInput.replaceText(PERSON_PHRASE);
        await (await app.session.byTestId("member-roster.person-unlock-button")).click();
        await app.session.byTestId("member-roster.person-ready");
        // Invite the deterministic fixture member through the real form.
        await (await app.session.byTestId("member-roster.invite-button")).click();
        await app.session.byTestId("member-roster.invite-modal");
        await (await app.session.byTestId("member-roster.invite-kem")).replaceText(
          MEMBER_FIXTURE.member_kem_ek_hex,
        );
        await (await app.session.byTestId("member-roster.invite-ed")).replaceText(
          MEMBER_FIXTURE.member_ed_pk_hex,
        );
        await (await app.session.byTestId("member-roster.invite-mldsa")).replaceText(
          MEMBER_FIXTURE.member_mldsa_vk_hex,
        );
        await (await app.session.byTestId("member-roster.invite-confirm")).click();
        await app.session.byTestId("member-roster.invite-result");
        // The roster reloads after a successful invite; wait for both rows
        // (owner + member) rather than asserting on the first paint.
        let rows = await app.session.findElements('[data-testid="member-roster.row"]');
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          rows = await app.session.findElements('[data-testid="member-roster.row"]');
          if (rows.length === 2) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(rows).toHaveLength(2);
        // Role badges: one Owner, one Member (real i18n English, not keys).
        const badges = await app.session.findElements('[data-testid="member-roster.role"]');
        const badgeTexts: string[] = [];
        for (const b of badges) {
          badgeTexts.push(((await b.textContent()) ?? "").trim());
        }
        expect(badgeTexts.sort()).toEqual(["Member", "Owner"]);
        // The invited member is listed by fingerprint (first 16 of the
        // deterministic fixture); the owner fingerprint varies per run.
        const fps = await app.session.findElements(
          '[data-testid="member-roster.fingerprint"]',
        );
        const fpTexts: string[] = [];
        for (const f of fps) {
          fpTexts.push(((await f.textContent()) ?? "").trim());
        }
        expect(fpTexts).toHaveLength(2);
        expect(
          fpTexts.some((t) =>
            t.startsWith(MEMBER_FIXTURE.member_fingerprint_hex.slice(0, 16)),
          ),
        ).toBe(true);
        await closeSettings(app.session);
      },
    );
  });
});
