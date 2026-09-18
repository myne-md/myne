// QuickPicker "Move note to folder…" suite (palette-gap #32, PR #98
// polish/editor-outline; `src/components/QuickPicker.tsx` + the
// `note.move` action in `src/commands/actions.ts`, wired via
// `CommandPaletteHost.onMoveNote` in `src/screens/Editor.tsx`).
//
// Pins the palette → picker sub-flow through the production binary:
//
//   qp1 — running the palette's "Move note to folder…" action opens the
//     QuickPicker (stacked ABOVE the palette, which closed on action-run);
//     Esc in the picker POPS BACK to the command palette (the `onReopen`
//     stacked-navigation contract) instead of dead-ending; re-running the
//     action and keyboard-selecting a folder (type-to-filter → Enter on
//     the `data-selected` row) fires the real `bulkMoveWithSync` move —
//     the note leaves the sidebar root and lands under the (collapsed)
//     folder, exactly like the ms1 bulk-move (notes.e2e.ts).
//
// Folder targets are the live note folders plus `deliberate_folders`
// (canonical trailing-slash form — the picker option's `data-value` is
// "Arsiv/", the ms1 precedent). Note titles/folder names are in-source
// scenario constants, not credentials (SYNC-13). KDF: weak generator
// fixture (unlock reads params from vault.meta).
//
// ⚠ PLATFORM: the harness drives the production binary via tauri-driver and is
// Linux-only — authored to the conventions but MUST be run green 3× in the
// container (`./scripts/e2e-local.sh`) before merge; not executed on the
// authoring machine (macOS). See e2e/AGENTS.md "definition of done".

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickNewMenuItem,
  createNote,
  dismissImporterOffer,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

// W3C key codepoints — kept as \uE0xx ESCAPE FORMS, never literals (the
// invisible-key hazard: a raw U+E007 in source is unreviewable).
const ESCAPE = "\uE00C";
const ENTER = "\uE007";

/** Read the `data-note-id` of the currently-selected sidebar row — the note
 *  `createNote` just created and left selected (the sp1 helper,
 *  search-palette.e2e.ts). */
async function selectedNoteId(s: Session): Promise<string> {
  const row = await s.waitForElement(
    '[data-testid="notes.row"][aria-current="true"]',
  );
  const id = await row.attribute("data-note-id");
  if (id === null || id === "") {
    throw new Error("selected notes.row carried no data-note-id");
  }
  return id;
}

describeE2E("qp1 palette move-note QuickPicker: Esc pops back, Enter moves (palette-gap #32)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("Esc returns to the palette; keyboard-picking a folder moves the note into it", async () => {
    let password = "";
    await scenario(
      "qp1-quick-picker-move-note",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // An (empty, deliberate) destination folder + one root note. The
        // trailing W3C Enter commits the inline new-folder input (the
        // nc4/ms1 site carries the same key) — this also registers the
        // canonical "Arsiv/" entry in deliberate_folders, which is what the
        // picker lists for an empty folder.
        await clickNewMenuItem(s, "notes.new-folder");
        await (await s.byTestId("notes.new-folder-input")).sendKeys("Arsiv\uE007");
        await s.byTestId("notes.folder-row");

        await createNote(s, "Gezgin Notu");
        const noteId = await selectedNoteId(s);

        // Run the palette action → the QuickPicker dialog opens (the palette
        // itself closes on action-run; the picker is stacked on top).
        await runPaletteAction(s, "note.move", "Move note");
        await s.byTestId("quick-picker.dialog");

        // Esc CANCELS the picker and pops back to the command palette
        // (onClose → onReopen), rather than dropping the user nowhere.
        await (await s.byTestId("quick-picker.input")).sendKeys(ESCAPE);
        await s.waitForGone(testIdSelector("quick-picker.dialog"));
        await s.byTestId("palette.input");

        // Re-run the action from the re-opened palette (runPaletteAction
        // tolerates an already-open palette — openPalette probes first).
        await runPaletteAction(s, "note.move", "Move note");
        await s.byTestId("quick-picker.dialog");

        // Keyboard-select: type-to-filter narrows to the folder ("Vault
        // root" doesn't match), the surviving row is the selection…
        await (await s.byTestId("quick-picker.input")).sendKeys("Arsiv");
        await s.waitForElement(
          testIdSelector("quick-picker.option", {
            "data-value": "Arsiv/",
            "data-selected": "true",
          }),
        );
        // …and Enter commits it (onPick → bulkMoveWithSync → picker closes).
        await (await s.byTestId("quick-picker.input")).sendKeys(ENTER);
        await s.waitForGone(testIdSelector("quick-picker.dialog"));

        // The move lands the note inside the folder, which defaults to
        // collapsed (the ms1 contract) — the root row disappears…
        await s.waitForGone(testIdSelector("notes.row"));
        // …and EXPANDING the folder reveals exactly the moved note.
        await (await s.byTestId("notes.folder-row")).click(); // expand
        await s.waitForElement(testIdSelector("notes.row", { "data-note-id": noteId }));
        expect((await s.byTestIdAll("notes.row")).length).toBe(1);
      },
    );
  });
});
