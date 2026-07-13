// Floating-toolbar customization suite (MYND-336, PR #98
// polish/editor-outline; Settings list
// `src/components/settings/ToolbarCustomizeSettings.tsx`, vocabulary
// `src/notes/toolbarItems.ts`, live feed `src/notes/ToolbarLayoutSync.tsx`,
// renderer `editor/src/toolbar/plugin.ts`).
//
// Pins the customize → render contract through the production binary:
//
//   tc1 — the Settings → Editor "Toolbar" list hides/shows a RENDERABLE
//     control and the floating selection toolbar follows: hiding
//     "highlight" drops its button from the next toolbar render, un-hiding
//     restores it; both states READ BACK from disk across a Settings
//     reopen (the persistence regression this PR fixed — the list loads
//     `prefsRead()` in a mount effect); and the 5 not-yet-renderable
//     vocabulary rows (bulletList/numberedList/checklist/quote/wikilink,
//     `EDITOR_TOOLBAR_PENDING_IDS`) are pinned DISABLED, non-toggleable.
//
// Driving notes: the floating toolbar needs a non-empty text selection.
// This suite double-clicks the note's single word (`Element.doubleClick`,
// the folder-row MYND-370 primitive) — the PR's mouseup catch-all
// re-evaluates the toolbar on every double-click, so the surface-and-check
// runs inside ONE retry loop: each iteration re-selects (a fresh render
// that re-reads the fed layout) and only a render matching the expected
// highlight presence/absence passes — a late prefs propagation heals on
// the next iteration instead of flaking. `.cm-toolbar` (a CM-plugin
// surface, the `.cm-content` selector-exception class) is the positive
// control that the toolbar IS up when asserting the button's absence.
// `toolbar.highlight` is the one renderable control carrying a testid,
// which is what makes it the byTestId-observable hide/show probe.
//
// In-source scenario constants are not credentials; SYNC-13 applies to
// passwords/phrases, which never appear in any assert below. KDF: weak
// generator fixture (unlock reads params from vault.meta).
//
// ⚠ PLATFORM: the harness drives the production binary via tauri-driver and is
// Linux-only — authored to the conventions but MUST be run green 3× in the
// container (`./scripts/e2e-local.sh`) before merge; not executed on the
// authoring machine (macOS). See e2e/CLAUDE.md "definition of done".

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  openSettings,
  typeIntoEditor,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const EDITOR = '[data-testid="editor.content"]';
const CM_LINE = `${EDITOR} .cm-content .cm-line`;
// The floating selection toolbar mounts on document.body as `.cm-toolbar` —
// a CodeMirror-plugin surface (the `.cm-content` selector-exception class;
// its only testid-carrying renderable control is `toolbar.highlight`).
const FLOATING_TOOLBAR = ".cm-toolbar";

/** The pinned not-yet-renderable vocabulary ids (EDITOR_TOOLBAR_PENDING_IDS —
 *  a frozen on-disk vocabulary, so the literal list is stable to assert). */
const PENDING_IDS = ["bulletList", "numberedList", "checklist", "quote", "wikilink"];

/** Double-click the note's single word until the floating toolbar surfaces
 *  WITH the expected highlight-button presence. Re-selecting per iteration is
 *  load-bearing: each double-click re-renders the toolbar, which re-reads the
 *  layout fed by ToolbarLayoutSync — so a just-persisted customization that
 *  hasn't propagated yet fails the iteration, not the scenario. */
async function surfaceToolbar(s: Session, expectHighlight: boolean): Promise<void> {
  await s.waitUntil(
    async () => {
      const line = await s.waitForElement(CM_LINE, { timeoutMs: 2_000 });
      await line.doubleClick();
      try {
        await s.waitForElement(FLOATING_TOOLBAR, { timeoutMs: 2_000 });
      } catch {
        return null; // selection/toolbar not up yet — re-select
      }
      const highlight = await s.findElements(testIdSelector("toolbar.highlight"));
      return (highlight.length > 0) === expectHighlight ? true : null;
    },
    {
      label: `floating toolbar up, highlight ${expectHighlight ? "present" : "absent"}`,
      timeoutMs: 30_000,
    },
  );
}

/** The customize list's checkbox for one vocabulary id. */
async function customizeToggle(s: Session, itemId: string) {
  return s.waitForElement(
    testIdSelector("settings.toolbar-customize.toggle", { "data-item-id": itemId }),
  );
}

/** Poll the highlight toggle's persisted read-back (the list loads
 *  `prefsRead()` in a mount effect — poll, don't snapshot the pre-effect
 *  default; the pf1 discipline). */
async function expectHighlightToggleReadsBack(s: Session, checked: boolean): Promise<void> {
  await s.waitUntil(
    async () =>
      (await (await customizeToggle(s, "highlight")).property<boolean>("checked")) === checked ||
      null,
    { label: `highlight toggle reads back ${checked ? "checked" : "unchecked"}` },
  );
}

describeE2E("tc1 toolbar customize: hide/show follows + persists; pending rows pinned (MYND-336)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("hiding highlight drops its button, un-hiding restores it, both survive a Settings reopen", async () => {
    let password = "";
    await scenario(
      "tc1-toolbar-customize",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // A single-word note body: double-click selects the whole word, the
        // unambiguous real-UI path to a non-empty selection under this driver
        // (Shift+Arrow send-keys drops Shift — the hc1 scope note).
        await createNote(s, "Arac Cubugu Notu");
        await typeIntoEditor(s, "vurguhedefkelime42x");

        // Baseline: the default layout renders the highlight control.
        await surfaceToolbar(s, true);

        // Settings → Editor → Toolbar list. The 5 not-yet-renderable rows are
        // pinned hidden: visibly disabled, non-toggleable ("Coming soon").
        await openSettings(s, "editor");
        await s.byTestId("settings.toolbar-customize");
        for (const id of PENDING_IDS) {
          expect(
            await (await customizeToggle(s, id)).enabled(),
            `pending row "${id}" must be disabled`,
          ).toBe(false);
        }

        // Hide "highlight" (a renderable, toggleable row): starts shown…
        await expectHighlightToggleReadsBack(s, true);
        await (await customizeToggle(s, "highlight")).click();
        await expectHighlightToggleReadsBack(s, false);
        await closeSettings(s);

        // …and the floating toolbar no longer renders its button (the
        // toolbar itself is up — the positive control inside surfaceToolbar).
        await surfaceToolbar(s, false);

        // Persistence across a Settings REOPEN (the regression this PR
        // fixed): the mount effect re-reads vault.prefs from disk, so the
        // hidden state must read back — not reset to the default.
        await openSettings(s, "editor");
        await expectHighlightToggleReadsBack(s, false);

        // Un-hide → the button is back on the next selection.
        await (await customizeToggle(s, "highlight")).click();
        await expectHighlightToggleReadsBack(s, true);
        await closeSettings(s);
        await surfaceToolbar(s, true);

        // And the show-all state ALSO survives a reopen (the stored hidden
        // set is now exactly the pinned pending ids — non-empty by the
        // resolveToolbarHidden contract, so it can't be mistaken for unset).
        await openSettings(s, "editor");
        await expectHighlightToggleReadsBack(s, true);
        await closeSettings(s);
      },
    );
  });
});
