// tm — note templates: creation-side reachability (#237). Vault-count
// precondition: 1 (weak KDF).
//
// Pins the templates usability pass against the production binary — the surfaces
// that made template *creation* reachable outside the command palette:
//   - tm1: the editor "…" note-actions menu offers the new template row for an
//     ordinary note (convert-to-template, NOT convert-to-note); running "Turn
//     into template" promotes the note through the real `convertNoteToTemplate`
//     IPC — an undo toast fires and the note LEAVES the sidebar (templates are
//     inverse-visibility, hidden like trash). The note stays open in the pane,
//     so re-opening the menu now offers the INVERSE row (convert-to-note,
//     context-aware); demoting returns it to the sidebar.
//
// SYNC-13: note titles are scenario content, not credentials. KDF: weak
// generator fixtures (unlock reads params from vault.meta).
//
// ⚠️ NEW SCENARIO — authored to the harness conventions but NOT yet validated in
// the container (this dev platform is macOS; the suite is Linux/tauri-driver
// only). Definition of done per e2e/CLAUDE.md is "green 3× consecutive" via
// ./scripts/e2e-buildrun.sh (it adds the template-action testids to production).
// Run ISOLATED — the full suite contaminates.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Read the `data-note-id` of the currently-selected sidebar row (the note
 *  `createNote` just created and left selected — the qp1 precedent). */
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

/** Open the editor "…" menu and return every row's `data-action`. The menu
 *  builds all rows synchronously on open, so one wait proves the set. */
async function openNoteActions(s: Session): Promise<(string | null)[]> {
  await (await s.byTestId("editor.note-actions-menu")).click();
  await s.waitForElement(testIdSelector("editor.note-actions-menu-item"));
  return Promise.all(
    (await s.byTestIdAll("editor.note-actions-menu-item")).map((i) =>
      i.attribute("data-action"),
    ),
  );
}

/** Click one row of the ALREADY-OPEN "…" menu by its stable `data-action`. */
async function clickNoteAction(s: Session, action: string): Promise<void> {
  await (
    await s.waitForElement(
      testIdSelector("editor.note-actions-menu-item", { "data-action": action }),
    )
  ).click();
}

describeE2E("tm1 templates: convert a note to/from a template via the '…' menu (#237)", () => {
  it("offers the template rows, promotes with an undo toast (note leaves the sidebar), and the menu flips to convert-to-note", async () => {
    let seeded: SeededVault;
    await scenario(
      "tm1-templates-convert",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);
        await createNote(s, "tm1source");
        const noteId = await selectedNoteId(s);

        // An ordinary note offers convert-to-template, and NOT the inverse
        // convert-to-note.
        const actions = await openNoteActions(s);
        expect(actions, "menu offers convert-to-template").toContain(
          "convert-to-template",
        );
        expect(
          actions,
          "normal note does not offer convert-to-note",
        ).not.toContain("convert-to-note");

        // Promote → the real convertNoteToTemplate IPC. An undo toast fires and
        // the note leaves the sidebar (it is now a hidden template).
        await clickNoteAction(s, "convert-to-template");
        await s.byTestId("editor.toast");
        await s.byTestId("editor.toast-action"); // the Undo affordance
        await s.waitForGone(
          testIdSelector("notes.row", { "data-note-id": noteId }),
        );

        // The note stays open in the pane → the menu is now context-aware:
        // it offers convert-to-note, not convert-to-template.
        const afterActions = await openNoteActions(s);
        expect(afterActions, "template note offers convert-to-note").toContain(
          "convert-to-note",
        );
        expect(
          afterActions,
          "template note no longer offers convert-to-template",
        ).not.toContain("convert-to-template");

        // Demote → the note returns to the sidebar.
        await clickNoteAction(s, "convert-to-note");
        await s.byTestId("editor.toast");
        await s.waitForElement(
          testIdSelector("notes.row", { "data-note-id": noteId }),
        );
      },
    );
  });
});
