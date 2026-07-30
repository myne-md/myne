// Flow-logic: un-favoriting from the Favorites strip (MYND-597). Headless
// Chromium + mock IPC — NOT end-to-end. Proves the bug is closed: a favorited
// note is pulled OUT of the list into the strip, and before this fix the strip
// tile had no long-press, so the note could never be un-favorited from the
// default view. Now a long-press on the tile opens the row action sheet (the
// same recognizer NoteRow uses), whose "Remove from favorites" returns the note
// to the list.
//
// The long-press is dispatched synthetically: a bare `pointerdown` (no
// pointermove/up) lets the shared `useHold` 480ms timer fire `onHold` — the same
// gesture the folder-decoration spec drives.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";
import { longPress } from "../helpers";

const NOTE_ID = "note-fav-1";
// A root-level note (no `folder:`), so with no favorite it renders as a
// top-level NoteRow — the row the strip replaces while it is favorited.
const NOTE_BODY = "---\ntitle: Roadmap\n---\n\nDraft.\n";

const tileSel = `[data-testid="notes.favorite-tile"][data-note-id="${NOTE_ID}"]`;
const rowSel = `[data-testid="notes.row"][data-note-id="${NOTE_ID}"]`;

test.describe("favorites strip un-favorite (MYND-597)", () => {
  test("long-press → Remove from favorites returns the note to the list", async ({ page }) => {
    await installMockIpc(page, {
      noteIds: [NOTE_ID],
      noteBodies: { [NOTE_ID]: NOTE_BODY },
      prefs: { favorites: [NOTE_ID] },
    });
    await page.goto("/");

    // The trap: the favorited note is in the strip and is ABSENT from the list.
    await expect(page.locator(tileSel)).toBeVisible();
    await expect(page.locator(rowSel)).toHaveCount(0);

    // Long-press the tile → the row action sheet with the un-favorite action,
    // WITHOUT navigating into the note (the hold must not also open it).
    await longPress(page, tileSel);
    await expect(page.getByTestId("notes.favorite-action")).toBeVisible();
    await expect(page.getByTestId("editor.back")).toHaveCount(0); // still on the list
    await page.getByTestId("notes.favorite-action").click();

    // The whole-list setter fired with the note removed (→ empty)…
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __favoriteWrites?: string[][] }).__favoriteWrites ?? [],
        ),
      )
      .toContainEqual([]);
    // …and the note is back in the list with its tile gone — no stale state.
    await expect(page.locator(rowSel)).toBeVisible();
    await expect(page.locator(tileSel)).toHaveCount(0);
  });

  test("a short tap still opens the note", async ({ page }) => {
    await installMockIpc(page, {
      noteIds: [NOTE_ID],
      noteBodies: { [NOTE_ID]: NOTE_BODY },
      prefs: { favorites: [NOTE_ID] },
    });
    await page.goto("/");
    await expect(page.locator(tileSel)).toBeVisible();

    // A short tap (no hold) opens the note — the editor chrome appears. The
    // "hold does not also open" half is asserted in the un-favorite test above.
    await page.locator(tileSel).click();
    await expect(page.getByTestId("editor.back")).toBeVisible();
  });

  test("a drifting press (a scroll) does not fire the hold", async ({ page }) => {
    await installMockIpc(page, {
      noteIds: [NOTE_ID],
      noteBodies: { [NOTE_ID]: NOTE_BODY },
      prefs: { favorites: [NOTE_ID] },
    });
    await page.goto("/");
    await expect(page.locator(tileSel)).toBeVisible();

    // pointerdown then a >10px horizontal move (a swipe of the strip) cancels the
    // pending hold, so the action sheet must NOT open.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`no element for ${sel}`);
      const r = el.getBoundingClientRect();
      const at = { clientX: r.x + 8, clientY: r.y + 8, bubbles: true, cancelable: true };
      el.dispatchEvent(new PointerEvent("pointerdown", at));
      el.dispatchEvent(
        new PointerEvent("pointermove", { ...at, clientX: r.x + 40 }), // >10px drift
      );
    }, tileSel);
    await page.waitForTimeout(600);
    await expect(page.getByTestId("notes.favorite-action")).toHaveCount(0);
  });
});
