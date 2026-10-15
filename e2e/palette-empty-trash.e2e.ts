// Palette "Empty trash" count-aware confirm suite (PR #98
// polish/editor-outline; action `trash.empty` in `src/commands/actions.ts`,
// deferred confirm in `CommandPaletteHost` (`src/screens/Editor.tsx`)
// rendering the same `DeleteConfirmModal` the TrashPanel footer uses).
//
// Pins the destructive-action gate through the production binary:
//
//   et1 — running the palette's "Empty trash" action NEVER purges directly:
//     it opens the count-aware DeleteConfirmModal ("Empty trash?" /
//     "<n> notes will be permanently deleted."). Cancel leaves the trash
//     INTACT (both notes still restorable in the Trash panel); re-running
//     and CONFIRMING purges — the Trash panel then holds zero rows and its
//     footer "Empty trash" button (rendered only when count > 0) is gone.
//
// The confirm copy is asserted by FULL-LITERAL equality via an in-page read
// of the modal's aria-labelledby/-describedby anchors (`delete-confirm-title`
// / `delete-confirm-body` — the modal's stable a11y contract; the hh3
// toast-reader shape): the “2” in the body is the count-awareness proof.
//
// Note titles are in-source scenario constants, not credentials (SYNC-13).
// KDF: weak generator fixture (unlock reads params from vault.meta).
//
// ⚠ PLATFORM: the harness drives the production binary via tauri-driver and is
// Linux-only — authored to the conventions but MUST be run green 3× in the
// container (`./scripts/e2e-local.sh`) before merge; not executed on the
// authoring machine (macOS). See e2e/AGENTS.md "definition of done".

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickRibbonUntilVisible,
  confirmDeleteWithEnter,
  createNote,
  dismissImporterOffer,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Right-click an element and pick a context-menu item by its
 *  `data-item-id` (the nc3 helper, notes.e2e.ts). */
async function contextMenuPick(
  session: Session,
  target: { rightClick(): Promise<void> },
  itemId: string,
): Promise<void> {
  await target.rightClick();
  await (
    await session.waitForElement(
      testIdSelector("notes.context-menu-item", { "data-item-id": itemId }),
    )
  ).click();
}

/** Read the confirm modal's title + body via its aria anchors (stable ids on
 *  the alertdialog — `DeleteConfirmModal` labels itself with them). */
async function readConfirmCopy(s: Session): Promise<{ title: string; body: string }> {
  return s.execute<{ title: string; body: string }>(
    'const t = document.getElementById("delete-confirm-title");' +
      'const b = document.getElementById("delete-confirm-body");' +
      "return {" +
      "  title: t && t.textContent ? t.textContent : ''," +
      "  body: b && b.textContent ? b.textContent : ''," +
      "};",
  );
}

/** Open the Trash panel and poll until it shows exactly `count` restorable
 *  rows (the purge/cancel outcome), then close it. Gated on `trash.panel`
 *  first so a zero count can never pass vacuously against a closed panel. */
async function expectTrashCount(s: Session, count: number): Promise<void> {
  await clickRibbonUntilVisible(s, "trash.open", "trash.panel");
  await s.byTestId("trash.panel");
  await s.waitUntil(
    async () => ((await s.byTestIdAll("trash.restore")).length === count ? true : null),
    { label: `trash panel shows ${count} restorable row(s)` },
  );
  if (count === 0) {
    // Emptied: the footer "Empty trash" button only renders when count > 0.
    expect((await s.byTestIdAll("trash.empty")).length).toBe(0);
  }
  await (await s.byTestId("trash.close")).click();
  await s.waitForGone(testIdSelector("trash.panel"));
}

describeE2E("et1 palette empty-trash confirms with count; cancel keeps, confirm purges", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("trash.empty opens the count-aware confirm; cancel is a no-op, confirm empties", async () => {
    let password = "";
    await scenario(
      "et1-palette-empty-trash",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Two notes, both soft-trashed via the row's real context menu
        // (reversible — no confirm on the way IN; the nc3 pattern).
        await createNote(s, "Cop Aday Bir");
        await createNote(s, "Cop Aday Iki");
        await contextMenuPick(s, await s.byTestId("notes.row"), "delete");
        await s.waitUntil(
          async () => ((await s.byTestIdAll("notes.row")).length === 1 ? true : null),
          { label: "first note soft-trashed" },
        );
        await contextMenuPick(s, await s.byTestId("notes.row"), "delete");
        await s.waitForGone(testIdSelector("notes.row"));

        // Palette → "Empty trash": the permanent purge does NOT fire — the
        // count-aware confirm renders instead (the TrashPanel footer's modal).
        await runPaletteAction(s, "trash.empty", "Empty trash");
        await s.byTestId("delete-confirm.confirm");
        const copy = await readConfirmCopy(s);
        expect(copy.title).toBe("Empty trash?");
        expect(copy.body).toBe("2 notes will be permanently deleted.");

        // Cancel → the modal unmounts and the trash is INTACT.
        await (await s.byTestId("delete-confirm.cancel")).click();
        await s.waitForGone(testIdSelector("delete-confirm.cancel"));
        await expectTrashCount(s, 2);

        // Run again → confirm with ENTER → the purge lands and the trash is
        // empty.
        //
        // Enter rather than a click, and this is the only lane that can say
        // anything about it. myne-md/myne#628 made Enter perform the destructive
        // action, and this dialog is one of the two that perform the
        // cryptographic erase of `docs/decisions/storage/0105`: no undo, and
        // nothing outside a `.myne-backup` gets the note back. Its jsdom tests
        // are not evidence for the shipping WebView, and myne-md/myne#683 is the
        // reason to believe that rather than assert it: the guard those tests
        // exercised was refusing the harness's press at 14 ms of dialog age,
        // under load, with every jsdom-level check green. `docs/decisions/ui/
        // 0680` records the measurement and what replaced the guard.
        //
        // It also exercises guard 4 end to end. The palette selects its row on an
        // Enter KEYDOWN, so the dialog mounts with that key still down and
        // refuses to confirm until an Enter keyup has been seen. The keyup from
        // the palette's own press is what opens it, so a user who releases and
        // presses again gets a confirm, and a user who simply holds the key does
        // not. `pressKey` sends a keydown and a keyup, which is that sequence.
        await runPaletteAction(s, "trash.empty", "Empty trash");
        await confirmDeleteWithEnter(s);
        await expectTrashCount(s, 0);

        // The purged notes are gone from the working tree too (not restored).
        expect((await s.byTestIdAll("notes.row")).length).toBe(0);
      },
    );
  });
});
