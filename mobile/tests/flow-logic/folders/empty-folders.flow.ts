// Flow-logic: empty (note-less) folders are visible in the mobile folder tree
// (MYND-560). Headless Chromium + mock IPC — NOT end-to-end.
//
// An empty folder has NO note carrying its `folder:` path, so it exists only as a
// `deliberate_folders` prefs entry (the virtual-folder model: implicit folders
// vanish when their last note leaves, deliberate ones persist). That makes this
// the one folder class with no note-derived evidence in the tree — and the class
// that regressed. Both halves are covered:
//
//   • CREATE — "New folder" → name → the row appears immediately, still empty,
//     and it is a normal folder (opens a subfolder prompt, renames, takes notes).
//   • ARRIVE — a `deliberate_folders` entry that came from disk/sync renders on
//     boot, including when it is the vault's ONLY content (the empty-state trap:
//     a tree with zero notes must not short-circuit to "No notes yet" when a
//     deliberate folder exists).
//
// The mock's deliberate-folders store is STATEFUL (mock-ipc.ts), so the created
// folder survives the `prefs_read` re-read the nonce bump triggers — without that
// this spec would pass on the write payload alone and never prove the render.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NOTE_ID = "note-empty-folders-1";
/** A note in `Projects/` so the tree has one note-derived folder to sit beside. */
const NOTE_BODY = `---\nfolder: Projects/\ntitle: Roadmap\n---\n\nDraft.\n`;

const folderRows = (page: Page) => page.getByTestId("notes.folder-row");
const folderNamed = (page: Page, name: string) =>
  page.locator(`[data-testid="notes.folder-row"][data-folder-path="${name}"]`);

/** Open a folder's subtree so its nested rows render. The tree starts fully
 *  COLLAPSED since MYND-561 (desktop parity), so any assertion about a nested
 *  folder must expand its parent chain first. */
async function expandFolder(page: Page, name: string): Promise<void> {
  const row = folderNamed(page, name);
  await row.click();
  await expect(row).toHaveAttribute("data-collapsed", "false");
}

/** Drive the New-folder prompt: open, type `name`, confirm. */
async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByTestId("notes.new-folder").click();
  await page.getByTestId("notes.folder-prompt-input").fill(name);
  await page.getByTestId("notes.folder-prompt-submit").click();
}

/** Fire a long-press (the 480ms hold with no move/up) to open a row's sheet —
 *  the recognizer the folder-decoration spec drives the same way. */
async function longPress(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) throw new Error(`longPress: no element for ${sel}`);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: r.x + 8, clientY: r.y + 8 }),
    );
  }, selector);
  await page.waitForTimeout(600);
}

test.describe("empty folders in the mobile folder tree", () => {
  test("a folder created with no notes appears in the tree immediately", async ({ page }) => {
    await installMockIpc(page, { noteIds: [NOTE_ID], noteBodies: { [NOTE_ID]: NOTE_BODY } });
    await page.goto("/");

    // Baseline: only the note-derived folder exists.
    await expect(folderNamed(page, "Projects")).toBeVisible();
    await expect(folderRows(page)).toHaveCount(1);

    await createFolder(page, "Ideas");

    // The empty folder is a row of its own, with a zero subtree count.
    await expect(folderNamed(page, "Ideas")).toBeVisible();
    await expect(folderRows(page)).toHaveCount(2);
    await expect(folderNamed(page, "Ideas")).toContainText("0");

    // …and it was persisted as a deliberate entry (the carrier that makes it
    // survive being empty), canonical trailing-slash.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __deliberateFolderWrites?: string[][] }).__deliberateFolderWrites ?? []))
      .toContainEqual(["Ideas/"]);
  });

  test("an empty folder is the vault's only content — no 'no notes yet' short-circuit", async ({ page }) => {
    // The empty-state trap: `treeEmpty` must count deliberate folders, not just
    // notes, or a vault whose sole content is an empty folder renders the
    // "No notes yet" placeholder INSTEAD of the tree and the folder is unreachable.
    await installMockIpc(page, { prefs: { deliberate_folders: ["Ideas/"] } });
    await page.goto("/");

    await expect(folderNamed(page, "Ideas")).toBeVisible();
    await expect(page.getByTestId("notes.row")).toHaveCount(0);
  });

  test("an empty folder arriving from disk/sync renders on boot", async ({ page }) => {
    await installMockIpc(page, {
      noteIds: [NOTE_ID],
      noteBodies: { [NOTE_ID]: NOTE_BODY },
      prefs: { deliberate_folders: ["Archive/", "Projects/Spikes/"] },
    });
    await page.goto("/");

    // A root-level empty folder…
    await expect(folderNamed(page, "Archive")).toBeVisible();
    // …and an empty folder NESTED under a note-derived one: it must be parented
    // to `Projects` (ancestor-expanded), not orphaned to the root — so it appears
    // only once `Projects` is opened.
    await expect(folderNamed(page, "Projects")).toBeVisible();
    await expect(folderNamed(page, "Spikes")).toHaveCount(0);
    await expandFolder(page, "Projects");
    await expect(folderNamed(page, "Spikes")).toBeVisible();
  });

  test("an empty folder behaves like a normal folder — subfolder + rename", async ({ page }) => {
    await installMockIpc(page, { prefs: { deliberate_folders: ["Ideas/"] } });
    await page.goto("/");
    await expect(folderNamed(page, "Ideas")).toBeVisible();

    // Long-press → the folder action sheet offers the normal folder actions.
    await longPress(page, '[data-testid="notes.folder-row"][data-folder-path="Ideas"]');
    await expect(page.getByTestId("notes.folder-icon-action")).toBeVisible();

    // Creating a subfolder under it nests correctly and keeps the parent visible.
    await page.getByTestId("notes.folder-new-subfolder").click();
    await page.getByTestId("notes.folder-prompt-input").fill("Inbox");
    await page.getByTestId("notes.folder-prompt-submit").click();

    await expect(folderNamed(page, "Ideas")).toBeVisible();
    await expandFolder(page, "Ideas");
    await expect(folderNamed(page, "Inbox")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __deliberateFolderWrites?: string[][] }).__deliberateFolderWrites ?? []))
      .toContainEqual(["Ideas/", "Ideas/Inbox/"]);
  });
});
