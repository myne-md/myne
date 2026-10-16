// Flow-logic: the typeahead pickers arrive as docked sheets on a phone
// (myne-md/myne#884, task 5). Headless Chromium against the dev server with mock
// IPC, NOT end-to-end.
//
// Two of the three pickers are driven here from an ordinary note (the slash menu
// and the `[[` wikilink picker); the third, the `{{` template-token menu, is
// asserted for its GATING only, because a `template: true` note is never part of
// the working set and so has no row to open. That note is in the test that says
// so, and the positive half of the third surface is in the unit tier.
//
// # Why this file exists rather than another case in the unit tier
//
// `tests/editor/dockedPickers.test.ts` proves the DOM shape: which container the
// rows land in, that the sheet is a child of the body rather than a modal, and
// that filtering and the keymap still work. It cannot prove a single thing about
// the LAYOUT, because jsdom computes no geometry, and layout is most of what
// "docked" means: pinned to the bottom edge of the visible viewport, never taller
// than the viewport, and thumb-sized rows. This tier is the only one with a real
// engine and the phone viewport pinned (390×844, `mobile/playwright.config.ts`).
//
// The engine difference is also the reason the keyboard-adjacent half belongs
// here: the sheet's whole pitch is that the editor KEEPS the focus so the user
// narrows the list by continuing to type. A unit test can dispatch keys at a view
// and prove nothing about who would have received them.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NOTE_ID = "note-docked-pickers";
const NOTE_BODY = "---\ntitle: Freedom\n---\n\nbir satir\n";

async function openNote(page: Page, noteId: string, line: string): Promise<void> {
  await installMockIpc(page, { notes: [{ id: NOTE_ID, text: NOTE_BODY }] });
  await page.goto("/");
  await page.locator(`[data-testid="notes.row"][data-note-id="${noteId}"]`).click();
  await expect(page.getByTestId("editor.top-bar")).toBeVisible();
  await page.locator(".cm-content").getByText(line).click();
  await page.keyboard.press("End");
  // The slash/token triggers only fire at a line start or after whitespace, and
  // the caret is at the end of real text. A fresh line is what the user would do.
  await page.keyboard.press("Enter");
}

/** The sheet's box against the visible viewport, in CSS pixels. */
async function geometry(
  page: Page,
  testId: string,
): Promise<{ bottom: number; top: number; height: number; width: number; vh: number }> {
  return page.getByTestId(testId).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      bottom: r.bottom,
      top: r.top,
      height: r.height,
      width: r.width,
      vh: window.innerHeight,
    };
  });
}

test.describe("the typeahead pickers dock on a phone", () => {
  test("the slash menu is a sheet pinned to the viewport's bottom edge", async ({ page }) => {
    await openNote(page, NOTE_ID, "bir satir");
    await page.keyboard.type("/");

    const sheet = page.getByTestId("editor.slash-menu-sheet");
    await expect(sheet).toBeVisible();
    // The anchored popover is what it replaced, and a phone must not render both.
    await expect(page.locator(".cm-slash-menu")).toHaveCount(0);

    const g = await geometry(page, "editor.slash-menu-sheet");
    // Pinned to the bottom: the sheet's bottom edge IS the viewport's.
    expect(Math.abs(g.bottom - g.vh)).toBeLessThanOrEqual(1);
    // Never taller than the space it was given, so its body scrolls instead of
    // running off the screen.
    expect(g.height).toBeLessThanOrEqual(g.vh + 1);
    // Full-bleed at phone width (the shell's max-width only bites on a tablet).
    expect(g.width).toBeGreaterThanOrEqual(389);
  });

  test("the sheet leaves the keyboard with the editor, so typing keeps filtering", async ({
    page,
  }) => {
    await openNote(page, NOTE_ID, "bir satir");
    await page.keyboard.type("/");

    const list = page.getByTestId("editor.slash-menu-sheet-list");
    await expect(list).toBeVisible();
    const all = await list.locator(".cm-slash-menu-row").count();
    expect(all).toBeGreaterThan(3);

    // The proof that the sheet is not modal: these keystrokes are not dispatched
    // at the sheet, and they still narrow it.
    await page.keyboard.type("h1");
    await expect(list.locator(".cm-slash-menu-row")).toHaveCount(1);
    await expect(list.locator(".cm-slash-menu-label")).toHaveText("Heading 1");
  });

  test("the wikilink picker arrives in the same sheet, with its own filtering", async ({
    page,
  }) => {
    await openNote(page, NOTE_ID, "bir satir");
    await page.keyboard.type("[[");

    const sheet = page.getByTestId("editor.wikilink-picker-sheet");
    await expect(sheet).toBeVisible();
    await expect(page.locator(".cm-wiki-picker")).toHaveCount(0);

    const rows = sheet.locator('[data-testid="picker.note-row"]');
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasText: "Freedom" })).toHaveCount(1);

    await page.keyboard.type("freed");
    await expect(sheet.locator(".cm-slash-menu-label")).toHaveText("Freedom");
  });

  test("an ordinary note opens no template-token sheet, and leaves `{{` literal", async ({
    page,
  }) => {
    // The third picker's GATING, in the app rather than in jsdom. Its docked
    // POSITIVE path is not reachable from this tier: a `template: true` note is
    // "never part of the working set" (`editor/src/host/notes/selectors.ts`), so
    // it never renders a `notes.row` to open, and the mock IPC carries no
    // template route that would put one in front of the user. That half stays in
    // `tests/editor/dockedPickers.test.ts`.
    await openNote(page, NOTE_ID, "bir satir");
    await page.keyboard.type("{{");

    await expect(page.getByTestId("editor.template-token-sheet")).toHaveCount(0);
    await expect(page.locator(".cm-slash-menu")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toContainText("{{");
  });
});
