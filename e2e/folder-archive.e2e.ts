// Folder-archive lifecycle suite (folder-archive, e2e).
//
// Story:
//   fa1 — a folder with a note is archived as a UNIT via the folder context
//         menu ("Arşivle"). The whole subtree leaves the live tree; the Archive
//         panel lists the folder as a single row; Restore returns the folder +
//         its note to the live tree. The folder-level twin of the note-archive
//         ar1 lifecycle (archive.e2e.ts) — a pure `archived_folders` prefs-set
//         mutation, no note frontmatter written.
//   fa2 — deleting an archived folder is gated by the shared <DeleteConfirmModal>
//         (#202, replacing the old inline confirm band). Arm → Cancel leaves the
//         folder in the Archive; arm → Confirm soft-trashes its subtree (the note
//         lands in Trash) and drops the folder row from the Archive.
//
// All driving is real: folder create via the sidebar input, the folder context
// menu via the W3C Actions API right-click (`contextMenuPick`). No test hooks.

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickNewItem,
  clickRibbonUntilVisible,
  createNote,
  dismissImporterOffer,
  nameNewNote,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Right-click an element and pick a context-menu item by its `data-item-id`. */
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

/** Create a folder via the sidebar new-folder input. The trailing ``
 *  (W3C Enter code point) commits the inline input, else `notes.folder-row`
 *  never materializes (the `createFolder` helper in folder-notes.e2e.ts carries
 *  the same commit key). */
async function createFolder(s: Session, name: string): Promise<void> {
  await clickNewItem(s, "notes.new-folder");
  await (await s.byTestId("notes.new-folder-input")).sendKeys(`${name}`);
  await s.byTestId("notes.folder-row");
}

/** Create a note INSIDE `folder` via its "New note here" item and commit `title`
 *  through the inline-rename input (the `nc4` pattern). Trailing `` (W3C
 *  Enter) commits the rename, else `waitForGone` times out. */
async function createNoteInFolder(
  s: Session,
  folder: { rightClick(): Promise<void> },
  title: string,
): Promise<void> {
  await contextMenuPick(s, folder, "new-note");
  await nameNewNote(s, title);
}

describeE2E("fa1 folder-archive lifecycle (folder-archive)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("context-menu Arşivle archives a folder as a unit; Archive panel restores it", async () => {
    const FOLDER = "Arsivlik";
    let password = "";
    await scenario(
      "fa1-folder-archive-restore",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Seed a folder with one note inside it (plus a root note so the tree is
        // never empty and the folder row is unambiguous).
        await createNote(s, "Kok Not");
        await createFolder(s, FOLDER);
        await createNoteInFolder(
          s,
          await s.byTestId("notes.folder-row"),
          "Klasor Notu",
        );

        // Archive the folder as a unit → the folder row (and its subtree) leaves
        // the live tree.
        await contextMenuPick(
          s,
          await s.byTestId("notes.folder-row"),
          "folder.archive",
        );
        await s.waitForGone(testIdSelector("notes.folder-row"));

        // The Archive panel lists the folder as a single row.
        await clickRibbonUntilVisible(s, "archive.open", "archive.panel");
        await s.byTestId("archive.panel");
        await s.byTestId("archive.folder-row");

        // Restore → the folder + its note re-enter the live tree.
        await (await s.byTestId("archive.folder-restore")).click();
        await s.waitForGone(testIdSelector("archive.folder-restore"));
        await (await s.byTestId("archive.close")).click();
        await s.byTestId("notes.folder-row");
      },
    );
  });
});

describeE2E("fa2 archived-folder delete confirm (folder-archive, #202)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("arm → Cancel keeps the folder; arm → Confirm trashes the subtree", async () => {
    const FOLDER = "Silinecek";
    let password = "";
    await scenario(
      "fa2-folder-delete-confirm",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Seed a folder with one note, then archive the folder as a unit.
        await createNote(s, "Kok Not");
        await createFolder(s, FOLDER);
        await createNoteInFolder(
          s,
          await s.byTestId("notes.folder-row"),
          "Klasor Notu",
        );
        await contextMenuPick(
          s,
          await s.byTestId("notes.folder-row"),
          "folder.archive",
        );
        await s.waitForGone(testIdSelector("notes.folder-row"));

        // Open the Archive panel; the folder shows as a single row.
        await clickRibbonUntilVisible(s, "archive.open", "archive.panel");
        await s.byTestId("archive.panel");
        await s.byTestId("archive.folder-row");

        // Arm the delete → the shared confirm modal appears. Cancel it → the
        // modal is gone and the folder is untouched (still in the Archive).
        await (await s.byTestId("archive.folder-delete")).click();
        await s.byTestId("archive.folder-delete-confirm");
        await (await s.byTestId("archive.folder-delete-cancel")).click();
        await s.waitForGone(testIdSelector("archive.folder-delete-confirm"));
        await s.byTestId("archive.folder-row");

        // Arm again → Confirm → the folder row leaves the Archive.
        await (await s.byTestId("archive.folder-delete")).click();
        await (await s.byTestId("archive.folder-delete-confirm")).click();
        await s.waitForGone(testIdSelector("archive.folder-row"));

        // The subtree note is now in Trash (soft-trash, recoverable).
        await (await s.byTestId("archive.close")).click();
        await clickRibbonUntilVisible(s, "trash.open", "trash.panel");
        await s.byTestId("trash.panel");
        await s.byTestId("trash.restore");
      },
    );
  });
});
