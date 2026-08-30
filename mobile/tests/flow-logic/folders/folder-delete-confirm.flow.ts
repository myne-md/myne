// Flow-logic: deleting a folder from the mobile action sheet asks first
// (myne-md/myne#628). Headless Chromium + mock IPC, NOT end-to-end.
//
// The desktop has gated this since MYND-133: `deleteFolderAction` moves a
// note-EMPTY folder without a prompt and confirms a non-empty one, naming how
// many notes go to Trash. Mobile's danger row called `trashFolderFromMenu`
// straight through, so the identical action was a dialog on one client and a
// single tap on the other, and the tap moved a whole subtree.
//
// Both halves are covered, because a confirm that fires on every folder would be
// the opposite regression:
//
//   • NON-EMPTY: the sheet appears, Cancel leaves the folder alone, Confirm
//     trashes the subtree.
//   • EMPTY: no sheet; a folder with nothing in it goes on the tap, as on
//     desktop.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";
import { folderRow, longPress, noteDeletes, noteUpdates } from "../helpers";

const NOTE_ID = "note-folder-delete-1";
const NOTE_BODY = `---\nfolder: Projects/\ntitle: Roadmap\n---\n\nDraft.\n`;

/**
 * Boot to the tree with one note in `Projects/`.
 *
 * `notes` rather than `noteIds` + `noteBodies`: only that seed lands in the
 * mock's mutable store, so a `note_update` is visible to the next `note_read`.
 * With the other seed the trash stamp is written and then read back stale, and
 * the tree assertions below would fail for a reason that has nothing to do with
 * the code under test.
 */
async function openWithFolder(page: Page): Promise<void> {
  await installMockIpc(page, {
    notes: [{ id: NOTE_ID, text: NOTE_BODY }],
    statefulNoteWrites: true,
  });
  await page.goto("/");
  await expect(folderRow(page, "Projects")).toBeVisible();
}

/** Long-press a folder row and tap its danger row. */
async function tapDelete(page: Page, name: string): Promise<void> {
  await longPress(page, `[data-testid="notes.folder-row"][data-folder-path="${name}"]`);
  await page.getByTestId("notes.folder-delete-action").click();
}

test.describe("mobile folder delete confirmation", () => {
  test("a folder holding notes asks before anything moves, and Cancel means nothing moved", async ({
    page,
  }) => {
    await openWithFolder(page);

    await tapDelete(page, "Projects");

    // The discriminating assertion: the sheet is up and the folder is still
    // there. Before #628 the tree would already have lost it.
    await expect(page.getByTestId("notes.folder-delete-confirm")).toBeVisible();
    await expect(folderRow(page, "Projects")).toBeVisible();
    // The sheet names what goes, and the COUNT is the promise rather than
    // chrome: it is what the user is agreeing to. Asserting the confirm button's
    // own label instead would only have proved the button renders its own key.
    await expect(page.getByTestId("notes.folder-delete-body")).toContainText("1 note");

    await page.getByTestId("notes.folder-delete-cancel").click();
    await expect(page.getByTestId("notes.folder-delete-confirm")).toHaveCount(0);
    await expect(folderRow(page, "Projects")).toBeVisible();
    // The row surviving is the visible half; the load-bearing half is that no
    // note was written at all, which a still-rendering tree alone would not show.
    expect(await noteUpdates(page)).toEqual([]);
  });

  test("confirming moves the subtree to Trash", async ({ page }) => {
    await openWithFolder(page);

    await tapDelete(page, "Projects");
    await page.getByTestId("notes.folder-delete-confirm").click();

    await expect(page.getByTestId("notes.folder-delete-confirm")).toHaveCount(0);
    // The folder was note-derived, so it disappears once its note carries
    // `trashed:`, which is the soft-trash the sheet's warning copy promises,
    // not a hard delete. Both facts are asserted: the tree lost the row, and the
    // body that produced it is a trash stamp rather than a delete.
    await expect(folderRow(page, "Projects")).toHaveCount(0);
    const written = await noteUpdates(page);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("trashed:");
    expect(await noteDeletes(page)).toEqual([]);
  });

  test("an empty folder goes without a prompt, as on desktop", async ({ page }) => {
    await installMockIpc(page, { prefs: { deliberate_folders: ["Ideas/"] } });
    await page.goto("/");
    await expect(folderRow(page, "Ideas")).toBeVisible();

    await tapDelete(page, "Ideas");

    await expect(page.getByTestId("notes.folder-delete-confirm")).toHaveCount(0);
    await expect(folderRow(page, "Ideas")).toHaveCount(0);
  });
});
