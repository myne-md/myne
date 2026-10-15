// MYND-93 — keyboard-only navigation for the working flows (search/command
// palette, settings, change-password). Directly exercises the focus-trap
// retrofit (task 3) at runtime: dialogs trap focus while open and restore it to
// the control that opened them on Esc. Also pins the password→confirm Tab order
// on the reachable change-password form (the create-flow password step sits
// behind the briefing acks). Editor / import / backup keyboard reachability is
// covered transitively — those dialogs route through the same trapped
// ModalShell/useFocusTrap path (task 3 coverage grep) and the existing flow
// specs drive them.
//
// Vault-count precondition: 1 per scenario. Linux-only harness; self-skips
// off-platform via describeE2E.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  openSettings,
  typeIntoEditor,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";
import {
  KEY,
  pressKey,
  pressChord,
  tabSignatures,
  activeTestId,
  activeSignature,
} from "./support/keyboard";

/** True when the focused element is inside the element carrying `testId`. */
function activeWithin(session: Session, testId: string): Promise<boolean> {
  return session.execute<boolean>(
    'var root = document.querySelector(\'[data-testid="\' + arguments[0] + \'"]\');' +
      "return !!(root && document.activeElement && root.contains(document.activeElement));",
    [testId],
  );
}

describeE2E("KN-4 Settings modal traps focus and restores it on Esc (MYND-93)", () => {
  it("opening moves focus in; Tab stays inside; Esc closes and restores the gear", async () => {
    let fixture!: SeededVault;
    await scenario(
      "kn4-settings-trap",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);

        await openSettings(app.session);
        // Trap: focus entered the modal on open.
        expect(await activeWithin(app.session, "settings.modal")).toBe(true);
        // Tab around — focus must NOT leak back to the editor behind it.
        await tabSignatures(app.session, 5);
        expect(await activeWithin(app.session, "settings.modal")).toBe(true);

        // Esc closes the modal and restores focus to the gear button.
        await pressKey(app.session, KEY.ESCAPE);
        await app.session.waitForGone(testIdSelector("settings.modal"));
        expect(await activeTestId(app.session)).toBe("editor.settings-cta");
      },
    );
  });
});

describeE2E("KN-5 Command palette traps focus on open and Esc dismisses it (MYND-93)", () => {
  it("Ctrl+K focuses the search input; Esc closes the palette", async () => {
    let fixture!: SeededVault;
    await scenario(
      "kn5-palette-trap",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        // Focus the editor (the palette toggle's `when` context derives from
        // the focused element) — typeIntoEditor focuses CM via sendKeys.
        await createNote(app.session, "kn5-note");
        await typeIntoEditor(app.session, "x");

        await pressChord(app.session, KEY.CONTROL, "k");
        const input = await app.session.byTestId("palette.input", { timeoutMs: 10_000 });
        // Trap initial focus is the search input.
        expect(await activeTestId(app.session)).toBe("palette.input");

        await input.sendKeys("settings");
        await pressKey(app.session, KEY.ESCAPE);
        await app.session.waitForGone(testIdSelector("palette.input"));
      },
    );
  });
});

describeE2E("KN-6 change-password form Tab order is current → new → confirm (MYND-93)", () => {
  it("the password→confirm order is keyboard-deterministic (load-bearing pin)", async () => {
    let fixture!: SeededVault;
    await scenario(
      "kn6-change-password-order",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);

        await openSettings(app.session, "vault");
        await (await app.session.byTestId("settings.change-password-cta")).click();
        const current = await app.session.byTestId("change-password.current", {
          timeoutMs: 10_000,
        });
        await current.click();

        // Collect the focus order from the current field forward. Eye-toggle
        // buttons may sit between fields, so assert RELATIVE order, not adjacency.
        const seq = [
          await activeSignature(app.session),
          ...(await tabSignatures(app.session, 10)),
        ];
        const iCur = seq.indexOf("testid:change-password.current");
        const iNew = seq.indexOf("testid:change-password.new");
        const iConf = seq.indexOf("testid:change-password.confirm");
        expect(iCur).toBeGreaterThanOrEqual(0);
        expect(iNew).toBeGreaterThan(iCur);
        expect(iConf).toBeGreaterThan(iNew);
      },
    );
  });
});
