// Task-reminder settings (MYND-618).
//
// The reminder block became a reachable user-facing flow when it was rendered
// into Settings → Editor and its scheduler mounted, so it owes a scenario on this
// harness (root `AGENTS.md`: a new user-facing flow ships WITH its E2E coverage).
//
// Two things here are structurally out of reach of the unit suite, and they are
// the whole reason for this file:
//
//   1. **The preference round-trips through the real stack.** `reminders_enabled`
//      defaults `true` and is written omit-when-default, so flipping it OFF is the
//      only value that ever reaches `vault.prefs` — through the real ACL (the
//      `build.rs` mirror, the permissions list AND the `[[permission]]` block, all
//      three of which a missing entry fails CLOSED at runtime), the real canonical
//      encoder, and a real AEAD round-trip on re-unlock. A unit test asserts the
//      encoding; only this asserts the wiring.
//
//   2. **The honest sentence is the one that renders.** While reminders are
//      in-app only, nothing leaves the encrypted vault, so the OS-registration
//      disclosure must be ABSENT and the limitation present. Asserted by
//      full-literal equality against the constants, the same discipline the AI
//      trust disclosure and the export sentences follow — a reword is a change to
//      what Myne promises, and copy drift is what a test catches and a review does
//      not.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  openSettings,
  pickSelect,
  selectOptionValues,
  unlockToEditor,
} from "./support/flows";
import {
  REMINDER_IN_APP_ONLY_SENTENCE,
  REMINDER_OS_DISCLOSURE_SENTENCE,
} from "../src/lib/load-bearing-copy";
import type { Session } from "./support/webdriver";

/** Settings → Editor, scrolled to the reminder block. */
async function openReminderSettings(s: Session): Promise<void> {
  await openSettings(s, "editor");
  await s.byTestId("settings.reminders");
}

async function toggleState(s: Session): Promise<string | null> {
  return (await s.byTestId("settings.reminders-toggle")).attribute("aria-checked");
}

describeE2E("tr1 the reminder switch tells the truth and remembers (MYND-618)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("shows the in-app-only sentence, hides the OS disclosure, and persists OFF across a lock", async () => {
    let password = "";
    await scenario(
      "tr1-task-reminders",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await openReminderSettings(s);

        // ── The copy, by full-literal equality ──
        const limitation = await s.byTestId("settings.reminders.in-app-only");
        expect(await limitation.textContent()).toBe(REMINDER_IN_APP_ONLY_SENTENCE);

        // The OS-registration disclosure describes a cost this build does not
        // impose. Its ABSENCE is the assertion — a leak disclosed where none
        // exists would also imply closed-app delivery that is not there.
        expect(await s.byTestIdAll("settings.reminders.disclosure")).toHaveLength(0);
        expect(await limitation.textContent()).not.toBe(REMINDER_OS_DISCLOSURE_SENTENCE);

        // The horizon LINE and the task-text opt-in belong to the OS tier: the
        // first is unobservable without an OS registration, the second has no
        // preference behind it.
        expect(await s.byTestIdAll("settings.reminders.horizon")).toHaveLength(0);
        expect(await s.byTestIdAll("settings.reminders-text-toggle")).toHaveLength(0);

        // The horizon CONTROL is not tier-gated, and the split is the point
        // (myne#508). `useReminderScheduler` threads this value into
        // `runReminderPass` on every build, so shortening it really does shrink
        // the set of instants the running app arms; only the sentence claiming
        // an OS registration has to wait for one. Gating the control too would
        // also have satisfied `check-ipc-binding-callers.mjs` with a branch
        // nothing renders, which is the invisibility that let #508 ship.
        //
        // The helper carries what the line cannot say on this tier, so the
        // control is never a knob whose meaning is stated nowhere.
        await s.byTestId("settings.reminders-horizon-row");
        await s.byTestId("settings.reminders-horizon-helper");
        // The horizon row is a `Select` (#769), so its four choices live in a
        // body portal that exists only while the menu is open — the helper
        // opens it, reads the roster and shuts it again.
        expect(await selectOptionValues(s, "settings.reminders-horizon-picker")).toEqual([
          "1",
          "3",
          "5",
          "7",
        ]);

        // ── The horizon survives a real AEAD round-trip ──
        // Presence alone cannot fail on the defect this issue IS: a control
        // wired to nothing renders identically. So the scenario chooses the
        // shortest horizon, and the lock / re-unlock below re-reads it from
        // disk the same way it re-reads the switch.
        expect(
          await (await s.byTestId("settings.reminders-horizon-picker")).attribute("data-value"),
        ).toBe("7");
        await pickSelect(s, "settings.reminders-horizon-picker", "1");
        await s.waitUntil(async () =>
          (await (await s.byTestId("settings.reminders-horizon-picker")).attribute("data-value")) ===
          "1"
            ? true
            : null,
        );

        // ── Default ON, then flipped OFF ──
        expect(await toggleState(s)).toBe("true");
        await (await s.byTestId("settings.reminders-toggle")).click();
        await s.waitUntil(async () => ((await toggleState(s)) === "false" ? true : null));

        // ── Lock → re-unlock: the pref survives a real AEAD round-trip ──
        // `false` is the only value the omit-when-default encoder ever writes for
        // this field, so a decode that lost it would come back `true` and this is
        // what would catch it.
        await (await s.byTestId("settings.close")).click();
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(s, password);
        // Second mount of this scenario: the offer is a fresh-vault first-editor
        // overlay and does NOT re-appear here, so the hard variant would burn its
        // whole timeout waiting for something that is never coming.
        await dismissImporterOfferIfPresent(s);

        await openReminderSettings(s);
        expect(await toggleState(s)).toBe("false");

        // The horizon rode the same round-trip. Turning reminders back on is
        // what reveals its row, which is also the assertion that the row's gate
        // is the switch and not something that happens to be true on a fresh
        // vault. `1` is not the default, so a decode that lost the field would
        // come back selecting `7` and this is what would catch it.
        await (await s.byTestId("settings.reminders-toggle")).click();
        await s.waitUntil(async () => ((await toggleState(s)) === "true" ? true : null));
        expect(
          await (await s.byTestId("settings.reminders-horizon-picker")).attribute("data-value"),
        ).toBe("1");
      },
    );
  });
});
