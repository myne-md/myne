// MYND-93: the real-render axe-core gate (task 7), raised to **WCAG 2.2 AA** by
// myne-md/myne#728 task 17. Injects axe into the live WebKit WebView and runs
// the whole tag set against the core flow screens, including the two rules
// jsdom cannot evaluate: `color-contrast` and, new with 2.2, `target-size`
// (SC 2.5.8). A violation fails the screen. Contrast remediation goes to the
// token source (`design/colors_and_type.css`), never to a per-component
// override; target-size remediation goes to `--target-min` (task 11), never to
// a per-control literal.
//
// **There is no baseline any more.** This file used to filter four rule ids
// through a `KNOWN_PREEXISTING_DEBT` set, and that filter was by RULE rather
// than by node, so a rule with one remaining bad node and a rule with forty
// read identically: green. Nobody could tell a full fix from a partial one,
// which is the reason the set is deleted rather than emptied. An empty
// baseline is an invitation to put something back into it. Each of the four is
// fixed at its source:
//
//   - `nested-interactive`, a focusable close button inside a `role="tab"`.
//     Task 3: the per-tab × became a mouse affordance outside the
//     accessibility tree, and the keyboard paths that carry the capability
//     (Mod-W, Delete/Backspace on the focused tab, the tab context menu) are
//     named in `TabStrip.tsx`.
//   - `aria-required-children`, the same strip's `+` and `…` sitting inside
//     the tablist, and `treeitem` rows with no `tree` parent in the sidebar.
//     Tasks 3, 6 and 7.
//   - `aria-input-field-name`, `.cm-content` and the palette listbox with no
//     accessible name. Task 4.
//   - `scrollable-region-focusable`, the palette listbox. Task 5, and it is
//     the one worth reading twice: the rule now does not MATCH, because axe's
//     own matcher skips a combobox popup and the listbox is one. The
//     violation was removed rather than suppressed.
//
// Vault-count precondition declared per scenario. Linux-only; self-skips.

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
import { KEY, pressChord } from "./support/keyboard";
import { runAxeInPage, formatAxe } from "./support/axe";
import { testIdSelector } from "./support/webdriver";

describeE2E("AX-1 Welcome screen has no WCAG 2.2 AA violations (MYND-93)", () => {
  it("axe (incl. contrast) is clean on the cold-boot Welcome screen", async () => {
    // Vault-count precondition: 0.
    await scenario("ax1-welcome", {}, async (app) => {
      await app.session.byTestId("welcome.root", { timeoutMs: 20_000 });
      const violations = await runAxeInPage(app.session);
      expect(violations, formatAxe(violations)).toEqual([]);
    });
  });
});

describeE2E("AX-2 Unlock screen has no WCAG 2.2 AA violations (MYND-93)", () => {
  it("axe (incl. contrast) is clean on the unlock front door", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "ax2-unlock",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.form", { timeoutMs: 20_000 });
        void fixture;
        const violations = await runAxeInPage(app.session);
        expect(violations, formatAxe(violations)).toEqual([]);
      },
    );
  });
});

describeE2E("AX-3 Editor has no WCAG 2.2 AA violations (MYND-93)", () => {
  it("axe (incl. contrast) is clean on the unlocked editor", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "ax3-editor",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        const violations = await runAxeInPage(app.session);
        expect(violations, formatAxe(violations)).toEqual([]);
      },
    );
  });
});

describeE2E("AX-4 Settings modal has no WCAG 2.2 AA violations (MYND-93)", () => {
  it("axe (incl. contrast) is clean across the settings panels", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "ax4-settings",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        await openSettings(app.session);
        const violations = await runAxeInPage(app.session);
        expect(violations, formatAxe(violations)).toEqual([]);
      },
    );
  });
});

describeE2E("AX-5 Command palette has no WCAG 2.2 AA violations (MYND-93)", () => {
  it("axe (incl. contrast) is clean on the open command palette", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "ax5-palette",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        // Focus the editor so the palette toggle's `when` context resolves.
        await createNote(app.session, "ax5-note");
        await typeIntoEditor(app.session, "x");
        await pressChord(app.session, KEY.CONTROL, "k");
        await app.session.byTestId("palette.input", { timeoutMs: 10_000 });
        // Scope to the palette dialog: AX-5 asserts the PALETTE surface is
        // clean, not the editor content behind it (a note + its frontmatter
        // were created above only to open the palette; their pre-existing debt
        // is the editor's concern, not the palette's).
        const violations = await runAxeInPage(
          app.session,
          testIdSelector("palette.dialog"),
        );
        expect(violations, formatAxe(violations)).toEqual([]);
      },
    );
  });
});
