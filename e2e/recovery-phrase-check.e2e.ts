// RD-1 — the recovery-phrase CHECK in Settings (myne-md/myne#468).
//
// Not the same thing as `recovery-drill.e2e.ts` next door, despite the name
// collision: that one is the real RECOVERY walk (lose the password, get back in
// with the phrase). This is the read-only check a user runs while the vault is
// still OPEN, to find out whether the words they wrote down a year ago will
// work — before the day they need them, which is the day the password is gone.
//
// Four properties, and three of them are absences:
//
//   1. The right phrase is accepted.
//   2. The wrong phrase is REFUSED WITHOUT NAMING A WORD. Asserted by
//      full-literal equality against `RECOVERY_DRILL_FAILED_SENTENCE`, because
//      the privacy property IS the wording: a per-position message would turn
//      one whole-phrase check into 24 one-word checks.
//   3. **The vault stays open, and does not enter recovery.** The editor is
//      still there afterwards. A command that populated `Slot::Recovering` would
//      demand a password reset from a user who was only checking.
//   4. **The phrase is not left in the field, and never reaches disk.** Cleared
//      on both outcomes, and the vault directory is scanned for the words.
//
// The vault is seeded at WEAK KDF: this scenario is about the surface, and
// production Argon2id is already paid twice by `recovery-drill.e2e.ts`. What the
// drill command does with the derived key is a `myne-core` unit test's business
// (`verify_recovery_phrase_leaves_the_slot_untouched` and its siblings).
//
// SYNC-13: never logs the phrase. The plaintext scan reports indices.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import {
  dismissImporterOffer,
  openSettings,
  selectSettingsTopic,
  unlockToEditor,
  waitForBannerText,
} from "./support/flows";
import { seedVault, type SeededVault } from "./support/fixtures";
import { scanForPlaintext } from "./support/plaintext-scan";
import { RECOVERY_DRILL_FAILED_SENTENCE } from "@myne/copy";

/** A real, structurally valid BIP-39 phrase that is NOT this vault's. Typing
 *  gibberish would exercise a weaker case: the point is that a well-formed
 *  phrase belonging to some other vault reads exactly like a wrong one. */
const OTHER_PHRASE =
  "abandon ability able about above absent absorb abstract absurd abuse access " +
  "accident account accuse achieve acid acoustic acquire across act action actor " +
  "actress actual";

describeE2E("RD-1 the Settings recovery-phrase check", () => {
  it("accepts the real phrase, refuses another without naming a word, and leaves the vault open", async () => {
    let fixture!: SeededVault;
    await scenario(
      "rd1-recovery-phrase-check",
      {
        seed: (appDataDir) => {
          fixture = seedVault(appDataDir);
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, fixture.password);
        // The first unlocked editor on a fresh vault shows the importer
        // onboarding offer, a full-screen `aria-modal` backdrop that
        // `useOverlayInert`s the editor behind it. Every reach into the editor
        // owes this dismissal (e2e/AGENTS.md); without it `openSettings`'s gear
        // click is refused as "element not interactable" for its whole budget.
        await dismissImporterOffer(s);
        await openSettings(s, "privacy");
        // The recovery drill lives in Privacy's `locking` topic since
        // myne-md/myne#885; only the active topic's body is mounted.
        await selectSettingsTopic(s, "privacy", "locking");

        const row = await s.byTestId("settings.recovery-drill", { timeoutMs: 15_000 });
        const input = await s.byTestId("settings.recovery-drill-input");
        const submit = await s.byTestId("settings.recovery-drill-submit");
        const result = await s.byTestId("settings.recovery-drill-result");

        // Before anything is typed the row says nothing. Both halves matter: the
        // live region must EXIST already, because a screen reader announces a
        // region it knows about, and it must be empty so there is no verdict
        // about a phrase nobody has entered.
        // `textContent()`, not `text()`: this asserts EMPTINESS, and WebKit's
        // `/text` answers `""` on a just-inserted element, so a `text()` read
        // here would pass vacuously whatever the region held.
        expect((await result.textContent()).trim()).toBe("");
        expect(await row.attribute("data-outcome")).toBe("idle");
        expect(await submit.enabled(), "Check is live with an empty field").toBe(false);

        // ── The WRONG phrase first ──────────────────────────────────────────
        //
        // Deliberately before the right one: if the order were reversed, a
        // command that answered `true` unconditionally would still show the
        // failure sentence never appearing, and this file would pass.
        await input.sendKeys(OTHER_PHRASE);
        await s.waitUntil(() => submit.enabled(), {
          label: "Check enables once a phrase is typed",
          timeoutMs: 10_000,
        });
        await submit.click();
        await s.waitUntil(
          async () => ((await row.attribute("data-outcome")) === "failed" ? true : null),
          { label: "the check reports a refusal", timeoutMs: 60_000 },
        );

        // FULL-literal equality, not a substring. A substring match would pass a
        // future edit that appended "word 7 does not match" to the end, which is
        // the exact regression the sentence exists to prevent. Asserted through
        // `waitForBannerText`, which re-reads on every poll: the `data-outcome`
        // wait above resolves when the ROW's attribute flips, and WebKit's `/text`
        // can still answer `""` for the just-updated region until its render tree
        // catches up, so a one-shot `text()` here reads a correct screen as an
        // empty one (measured: 1 failure in 3).
        await waitForBannerText(
          s,
          "settings.recovery-drill-result",
          RECOVERY_DRILL_FAILED_SENTENCE,
        );
        // And it names no position. Checked independently of the literal above,
        // so a change to BOTH still fails here.
        const refusal = (
          await (await s.byTestId("settings.recovery-drill-result")).textContent()
        ).toLowerCase();
        expect(refusal, "the refusal names a position").not.toMatch(/word\s*#?\s*\d/);
        expect(refusal, "the refusal names a position").not.toMatch(/position\s*\d/);

        // The field is empty again: 24 words left in an unlocked session's DOM
        // is the thing this clears, and the user's next move is to re-read the
        // paper rather than to edit what they typed.
        expect(await input.property<string>("value")).toBe("");

        // ── Then the REAL phrase ────────────────────────────────────────────
        await input.sendKeys(fixture.phrase);
        await s.waitUntil(() => submit.enabled(), {
          label: "Check re-enables",
          timeoutMs: 10_000,
        });
        await submit.click();
        await s.waitUntil(
          async () => ((await row.attribute("data-outcome")) === "passed" ? true : null),
          { label: "the check accepts the vault's own phrase", timeoutMs: 60_000 },
        );
        expect(await input.property<string>("value")).toBe("");

        // ── The vault is still OPEN, and no recovery was started ────────────
        //
        // The property that separates this command from `recover_with_phrase`.
        // Asserted through the UI rather than through the slot: if the drill had
        // moved the slot to `Recovering`, the app would route to the mandatory
        // password-reset step, and the editor behind this modal would be gone.
        await (await s.byTestId("settings.close")).click();
        await s.byTestId("editor.root", { timeoutMs: 20_000 });
        expect(
          await s.byTestIdAll("recover.reset.password-input"),
          "the check routed the user into a password reset",
        ).toHaveLength(0);

        // ── Nothing the user typed reached disk ─────────────────────────────
        //
        // Both phrases: the vault's own (which the drill derived a key from) and
        // the other one (which it failed on). A command that logged or cached
        // either would show up here.
        // The whole phrase, not a word of it: single words like "able" occur in
        // compiled assets and would make this assertion noise. `app.dataHome`
        // rather than `appDataDir`, matching `recovery-drill.e2e.ts`, so the
        // scan covers everything the app wrote and not only the vault tree.
        const hits = scanForPlaintext(app.dataHome, [fixture.phrase, OTHER_PHRASE]);
        expect(hits, `plaintext phrase on disk: ${JSON.stringify(hits)}`).toEqual([]);

        // And it is out of the live DOM too, which the cleared field above
        // asserts for the input and this asserts for everything else — a status
        // line or an aria-label that echoed the words would be invisible to the
        // check above.
        const source = await s.source();
        expect(source.includes(fixture.phrase)).toBe(false);
        expect(source.includes(OTHER_PHRASE)).toBe(false);
      },
    );
  }, 240_000);
});
