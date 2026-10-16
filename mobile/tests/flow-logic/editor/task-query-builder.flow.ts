// Flow-logic: the task-query builder on a phone (myne-md/myne#884 task 9).
// Headless Chromium against the dev server with mock IPC, NOT end-to-end.
//
// The builder stays a CENTRED DIALOG rather than becoming a sheet, which is the
// design session's own decision (a labelled form is not a list). What it gains
// for a narrow screen is two things a stylesheet states and only a layout engine
// can confirm: each label sits ABOVE its control instead of beside it, and the
// dialog is no taller than the viewport it is centred in, so its Cancel/Insert
// row cannot be pushed off the bottom.
//
// jsdom is the wrong tier twice over here: it computes no geometry at all, and
// the media query that does the stacking is `(pointer: coarse), (max-width:
// 480px)`, which jsdom does not evaluate.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NOTE_ID = "note-query-builder";
const NOTE_BODY = "---\ntitle: Gundem\n---\n\nbir satir\n";

async function openNote(page: Page): Promise<void> {
  await installMockIpc(page, { notes: [{ id: NOTE_ID, text: NOTE_BODY }] });
  await page.goto("/");
  await page.locator(`[data-testid="notes.row"][data-note-id="${NOTE_ID}"]`).click();
  await expect(page.getByTestId("editor.top-bar")).toBeVisible();
  await page.locator(".cm-content").getByText("bir satir").click();
  await page.keyboard.press("End");
  // The slash trigger needs a line start or whitespace before it (the caret is at
  // the end of real text here), so the user's own gesture is a fresh line.
  await page.keyboard.press("Enter");
}

test.describe("the task-query builder on a phone", () => {
  test("stacks each label above its control, and fits inside the viewport", async ({ page }) => {
    await openNote(page);
    await page.keyboard.type("/task-query");

    // Assert WHICH row is highlighted before accepting it, so a future change to
    // the fuzzy ranking fails here with the name of the row it picked instead of
    // opening nothing and reporting a missing dialog.
    const selected = page.locator(".cm-slash-menu-row-selected");
    await expect(selected).toContainText("Task list");
    await page.keyboard.press("Enter");

    const dialog = page.getByTestId("editor.task-query-builder");
    await expect(dialog).toBeVisible();

    const geometry = await dialog.evaluate((el) => {
      const rows = [...el.querySelectorAll(".cm-task-query-builder-row")];
      return {
        rows: rows.map((row) => {
          const label = row.querySelector(":scope > span")!.getBoundingClientRect();
          const control = row
            .querySelector(":scope > select, :scope > input")!
            .getBoundingClientRect();
          return {
            labelBottom: label.bottom,
            controlTop: control.top,
            controlWidth: control.width,
          };
        }),
        height: el.getBoundingClientRect().height,
        vh: window.innerHeight,
        insertBottom: (
          el.querySelector('[data-testid="editor.task-query-builder.insert"]') as HTMLElement
        ).getBoundingClientRect().bottom,
      };
    });

    // The rows exist, or the loop below proves nothing.
    expect(geometry.rows.length).toBeGreaterThanOrEqual(5);

    // 1. STACKED, not squeezed: every control begins below its own label.
    for (const row of geometry.rows) {
      expect(
        row.controlTop,
        "a control sits beside its label rather than under it",
      ).toBeGreaterThanOrEqual(row.labelBottom - 1);
      // And it gets the width the stacking was for.
      expect(row.controlWidth).toBeGreaterThan(280);
    }

    // 2. It fits the viewport, and the commit control is inside it.
    expect(geometry.height).toBeLessThanOrEqual(geometry.vh + 1);
    expect(geometry.insertBottom).toBeLessThanOrEqual(geometry.vh + 1);
  });
});
