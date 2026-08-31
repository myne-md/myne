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
import { expandFolder, longPress } from "../helpers";

const NOTE_ID = "note-empty-folders-1";
/** A note in `Projects/` so the tree has one note-derived folder to sit beside. */
const NOTE_BODY = `---\nfolder: Projects/\ntitle: Roadmap\n---\n\nDraft.\n`;

const folderRows = (page: Page) => page.getByTestId("notes.folder-row");
const folderNamed = (page: Page, name: string) =>
  page.locator(`[data-testid="notes.folder-row"][data-folder-path="${name}"]`);

/** Drive the New-folder prompt: open, type `name`, confirm. */
async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByTestId("notes.new-folder").click();
  await page.getByTestId("notes.folder-prompt-input").fill(name);
  await page.getByTestId("notes.folder-prompt-submit").click();
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
      .poll(() => page.evaluate(() => (window as unknown as { __deliberateFolderWrites?: Array<Record<string, unknown>> }).__deliberateFolderWrites ?? []))
      .toContainEqual({
        add: ["Ideas/"],
        addUnlessRemoved: [],
        remove: [],
        removePrefix: [],
        renamePrefix: [],
      });
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
      .poll(() => page.evaluate(() => (window as unknown as { __deliberateFolderWrites?: Array<Record<string, unknown>> }).__deliberateFolderWrites ?? []))
      // States the ADDITION, not the resulting set. Under myne-md/myne#613 a
      // subfolder create says what it added; the whole-set write this used to
      // assert is the shape that let a stale view delete a peer's folder.
      .toContainEqual({
        add: ["Ideas/Inbox/"],
        addUnlessRemoved: [],
        remove: [],
        removePrefix: [],
        renamePrefix: [],
      });
  });
  test("deleting a folder states the SUBTREE, not the survivors this view holds", async ({
    page,
  }) => {
    // myne-md/myne#613, review round 2. `trashFolderFromMenu` used to build its
    // removal by filtering `prefs.deliberate_folders`, which is the `usePrefs`
    // cache: it starts at DEFAULT_PREFS and catches up only through a nonce-bump
    // round trip, and this same change gave mobile fire-and-forget at-fill
    // registrations that write behind it. A delete inside that window stated
    // `remove: []`, the registration survived on disk, and the folder came back
    // EMPTY at the next unlock and on every device, because the surviving entry
    // carries a newer add clock than the removal.
    //
    // The assertion is on the VERB, not on the resulting set. A resulting set
    // cannot tell "removed this subtree" from "wrote the set I happened to
    // hold", and telling those apart is the whole issue.
    //
    // Mobile has no other automated UI lane, so without this case nothing
    // anywhere reaches the mobile delete.
    await installMockIpc(page, {
      prefs: { deliberate_folders: ["Ideas/", "Ideas/Inbox/", "IdeasX/"] },
    });
    await page.goto("/");
    await expect(folderNamed(page, "Ideas")).toBeVisible();

    await longPress(page, '[data-testid="notes.folder-row"][data-folder-path="Ideas"]');
    await page.getByTestId("notes.folder-delete").click();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __deliberateFolderWrites?: Array<Record<string, unknown>> })
              .__deliberateFolderWrites ?? [],
        ),
      )
      .toContainEqual({
        add: [],
        addUnlessRemoved: [],
        remove: [],
        removePrefix: ["ideas/"],
        renamePrefix: [],
      });

    // And the core's rule really applied: the descendant went, the name-prefix
    // sibling stayed. This is the half a `remove:` list could not have got
    // right, because the cache never held `Ideas/Inbox/` as a separate concern.
    await expect(folderNamed(page, "Ideas")).toHaveCount(0);
    await expect(folderNamed(page, "IdeasX")).toBeVisible();
  });
});
