// Flow-logic: folder icon + note/folder color decoration (MYND-516). Headless
// Chromium + mock IPC — NOT end-to-end. Proves the two halves of the feature:
//
//   • Assignment — long-press a folder row → "Icon…" → pick a glyph invokes
//     `set_folder_icons` with the folder's FOLDED identity as the key (MYND-562);
//     and long-press a note row → "Color…" → pick a swatch invokes
//     `set_item_colors` keyed by the note UUID. (Key discipline: item_colors is
//     keyed by note id OR the folded folder identity (`folderKey`); folder_icons
//     by the folded folder identity only — the same keys desktop writes post-
//     MYND-562, so a decoration round-trips across clients regardless of case.)
//   • Display — a desktop-assigned `folder_icons` / `item_colors` (arriving via
//     synced `vault.prefs`, seeded here keyed by folded identity) renders the
//     glyph + color dots on the rows.
//
// The long-press is dispatched synthetically: a bare `pointerdown` (no
// pointermove/up) lets the row's 480ms hold timer fire `onHold` and open the
// action sheet — the same recognizer the swipe-back spec drives via TouchEvent.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";
import { expandFolder, longPress } from "../helpers";

const NOTE_ID = "note-decoration-1";
const FOLDER_PATH = "Projects/";
// The folded folder identity (`folderKey(FOLDER_PATH)`) — the key decorations
// are stored under on every client post-MYND-562.
const FOLDER_KEY = "projects/";
// A note living in `Projects/` (canonical trailing-slash `folder:` frontmatter),
// so the tree builds one folder row + one note row.
const NOTE_BODY = `---\nfolder: ${FOLDER_PATH}\ntitle: Roadmap\n---\n\nDraft.\n`;

/** Fire a long-press on the first element matching `selector`: a bubbling
 *  `pointerdown`, then wait past the 480ms hold threshold with no pointer
 *  move/up so the row's hold timer resolves and opens its action sheet. */
test.describe("folder icon + color decoration", () => {
  test("assign a folder icon → set_folder_icons keyed by the folder path", async ({ page }) => {
    await installMockIpc(page, { noteIds: [NOTE_ID], noteBodies: { [NOTE_ID]: NOTE_BODY } });
    await page.goto("/");

    // The tree shows the seeded folder — default glyph (no icon assigned yet).
    await expect(page.getByTestId("notes.folder-row")).toBeVisible();
    await expect(page.getByTestId("notes.folder-glyph")).toHaveCount(0);

    // Long-press the folder row → action sheet → "Icon…" → the picker.
    await longPress(page, '[data-testid="notes.folder-row"]');
    await page.getByTestId("notes.folder-icon-action").click();
    await expect(page.getByTestId("notes.decoration-sheet")).toBeVisible();

    // Pick the "book" glyph.
    await page.locator('[data-testid="notes.decoration-icon"][data-icon-name="book"]').click();

    // The whole-map setter fired with the folder's FOLDED identity as key.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __folderIconWrites?: Array<Record<string, string>> }).__folderIconWrites ?? []))
      .toContainEqual({ [FOLDER_KEY]: "book" });
  });

  test("assign a note color → set_item_colors keyed by the note id", async ({ page }) => {
    await installMockIpc(page, { noteIds: [NOTE_ID], noteBodies: { [NOTE_ID]: NOTE_BODY } });
    await page.goto("/");

    // Long-press the note row → row action sheet → "Color…" → the picker.
    await expandFolder(page, "Projects");
    await expect(page.getByTestId("notes.row")).toBeVisible();
    await longPress(page, '[data-testid="notes.row"]');
    await page.getByTestId("notes.note-color-action").click();
    await expect(page.getByTestId("notes.decoration-sheet")).toBeVisible();
    // A note's picker is color-only — no icon grid.
    await expect(page.getByTestId("notes.decoration-icon")).toHaveCount(0);

    // Pick the "clay" swatch.
    await page.locator('[data-testid="notes.decoration-color"][data-color-slot="clay"]').click();

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __itemColorWrites?: Array<Record<string, string>> }).__itemColorWrites ?? []))
      .toContainEqual({ [NOTE_ID]: "clay" });
  });

  test("clearing a folder color → set_item_colors omits the key", async ({ page }) => {
    // Folder starts with a color; picking "None" writes the map back without it.
    await installMockIpc(page, {
      noteIds: [NOTE_ID],
      noteBodies: { [NOTE_ID]: NOTE_BODY },
      prefs: { item_colors: { [FOLDER_KEY]: "moss" } },
    });
    await page.goto("/");

    await expect(page.getByTestId("notes.folder-row")).toBeVisible();
    await longPress(page, '[data-testid="notes.folder-row"]');
    await page.getByTestId("notes.folder-color-action").click();
    await expect(page.getByTestId("notes.decoration-sheet")).toBeVisible();
    await page.locator('[data-testid="notes.decoration-color"][data-color-slot="none"]').click();

    // The whole desired map is written with the folder key deleted (→ empty).
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __itemColorWrites?: Array<Record<string, string>> }).__itemColorWrites ?? []))
      .toContainEqual({});
  });

  test("fold-on-load migrates a legacy display-cased decoration to its folded key", async ({ page }) => {
    // MYND-562: a mobile-only user's pre-change color was stored under a
    // display-cased path (`Projects/`). On load, mobile now re-keys it to the
    // folded identity (`projects/`) and persists once — else it goes invisible
    // (the read looks up the folded key).
    await installMockIpc(page, {
      noteIds: [NOTE_ID],
      noteBodies: { [NOTE_ID]: NOTE_BODY },
      prefs: { item_colors: { [FOLDER_PATH]: "moss" } }, // legacy display-cased key
    });
    await page.goto("/");

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __itemColorWrites?: Array<Record<string, string>> }).__itemColorWrites ?? []))
      .toContainEqual({ [FOLDER_KEY]: "moss" });
  });

  test("display: a desktop-assigned icon + colors render on the rows", async ({ page }) => {
    await installMockIpc(page, {
      noteIds: [NOTE_ID],
      noteBodies: { [NOTE_ID]: NOTE_BODY },
      prefs: {
        folder_icons: { [FOLDER_KEY]: "book" },
        item_colors: { [FOLDER_KEY]: "clay", [NOTE_ID]: "moss" },
      },
    });
    await page.goto("/");

    // The folder row swaps its default glyph for the assigned "book" icon and
    // trails a "clay" color dot.
    const folderRow = page.getByTestId("notes.folder-row");
    await expect(folderRow.getByTestId("notes.folder-glyph")).toHaveAttribute("data-icon-name", "book");
    await expect(folderRow.locator('[data-color-slot="clay"]')).toBeVisible();

    // The note row shows a leading "moss" dot (its folder must be open first).
    await expandFolder(page, "Projects");
    await expect(page.getByTestId("notes.row").locator('[data-color-slot="moss"]')).toBeVisible();
  });
});
