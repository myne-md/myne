// Flow-logic: Settings → Editor → Toolbar buttons — reorder + show/hide the
// editor's above-keyboard format bar (MYND-555). Headless Chromium + mock IPC —
// NOT end-to-end.
//
// The two halves that can regress independently:
//   • the PANEL persists what the user did (whole-value writes, hidden sorted to
//     match what the Rust codec canonicalizes), and
//   • the live BAR reflects it — the bar reads the same `usePrefs` nonce, so a
//     write in Settings must reorder the real bar with no remount.
//
// Also pinned: the pinned chrome (attach / library / record / raw toggle /
// hide-keyboard) is NOT in the vocabulary, so it survives hiding every format
// action. That is the property that keeps the customization surface from removing
// its own escape hatches.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";
import { closeSheet } from "../helpers";

const NOTE_ID = "note-format-bar-1";
const BODY = `---\ntitle: Draft\n---\n\nSome text.\n`;

/** Open Settings → Editor → Toolbar buttons. */
async function openFormatBarPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByText("Editor", { exact: true }).click();
  await page.getByTestId("settings.format-bar-row").click();
  await expect(page.getByTestId("settings.format-bar-item-bold")).toBeVisible();
}

/** Open the note so the editor + its format bar mount. */
async function openEditor(page: Page): Promise<void> {
  await page.getByTestId("notes.row").first().click();
  await expect(page.getByTestId("editor.format-bar")).toBeVisible();
}

/** The format-action ids currently rendered on the bar, in bar order. */
function barIds(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid="editor.format-bar"] [data-format-item]', (els) =>
    els.map((e) => e.getAttribute("data-format-item") ?? ""),
  );
}

const orderWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as { __toolbarOrderWrites?: string[][] }).__toolbarOrderWrites ?? []);
const hiddenWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as { __toolbarHiddenWrites?: string[][] }).__toolbarHiddenWrites ?? []);

test.describe("format-bar customization", () => {
  test("an un-customized bar renders the canonical order", async ({ page }) => {
    await installMockIpc(page, { noteIds: [NOTE_ID], noteBodies: { [NOTE_ID]: BODY } });
    await page.goto("/");
    await openEditor(page);

    expect(await barIds(page)).toEqual([
      "undo", "redo", "heading1", "heading2", "bold", "italic",
      "bulletList", "checklist", "quote", "code", "wikilink", "link",
    ]);
  });

  test("hiding an action removes it from the live bar and persists sorted", async ({ page }) => {
    await installMockIpc(page, { noteIds: [NOTE_ID], noteBodies: { [NOTE_ID]: BODY } });
    await page.goto("/");
    await openFormatBarPanel(page);

    await page.getByTestId("settings.format-bar-toggle-bold").click();

    // Persisted as a set (the codec sorts + dedupes; the panel matches so the
    // optimistic draft and the next read agree).
    await expect.poll(() => hiddenWrites(page)).toContainEqual(["bold"]);

    // The row stays listed — that is how you bring it back — and the live bar
    // drops the button.
    await expect(page.getByTestId("settings.format-bar-item-bold")).toBeVisible();
    await closeSheet(page);
    await openEditor(page);
    expect(await barIds(page)).not.toContain("bold");
  });

  test("moving an action down reorders the live bar", async ({ page }) => {
    await installMockIpc(page, { noteIds: [NOTE_ID], noteBodies: { [NOTE_ID]: BODY } });
    await page.goto("/");
    await openFormatBarPanel(page);

    // `undo` is first; push it one slot down so it swaps with `redo`.
    await page.getByTestId("settings.format-bar-down-undo").click();

    // The write is the WHOLE resolved list, not a sparse diff.
    await expect.poll(() => orderWrites(page)).toHaveLength(1);
    const written = (await orderWrites(page))[0]!;
    expect(written.slice(0, 2)).toEqual(["redo", "undo"]);
    expect(written).toHaveLength(12);

    await closeSheet(page);
    await openEditor(page);
    expect((await barIds(page)).slice(0, 2)).toEqual(["redo", "undo"]);
  });

  test("move-up is disabled on the first row and move-down on the last", async ({ page }) => {
    await installMockIpc(page, { noteIds: [NOTE_ID], noteBodies: { [NOTE_ID]: BODY } });
    await page.goto("/");
    await openFormatBarPanel(page);

    await expect(page.getByTestId("settings.format-bar-up-undo")).toBeDisabled();
    await expect(page.getByTestId("settings.format-bar-down-link")).toBeDisabled();
    expect(await orderWrites(page)).toEqual([]);
  });

  test("a persisted layout is restored on boot", async ({ page }) => {
    await installMockIpc(page, {
      noteIds: [NOTE_ID],
      noteBodies: { [NOTE_ID]: BODY },
      prefs: { editor_toolbar_order: ["link", "bold"], editor_toolbar_hidden: ["undo", "redo"] },
    });
    await page.goto("/");
    await openEditor(page);

    const ids = await barIds(page);
    expect(ids.slice(0, 2)).toEqual(["link", "bold"]);
    expect(ids).not.toContain("undo");
    expect(ids).not.toContain("redo");
  });

  test("a desktop-authored layout degrades instead of leaving holes", async ({ page }) => {
    // Reachable via a backup restore — `vault.prefs` is inside MYB1 even though
    // the field is device-local in sync. Desktop-only ids must be dropped, and a
    // desktop-only hidden id must hide nothing.
    await installMockIpc(page, {
      noteIds: [NOTE_ID],
      noteBodies: { [NOTE_ID]: BODY },
      prefs: {
        editor_toolbar_order: ["highlight", "strike", "quote", "numberedList"],
        editor_toolbar_hidden: ["highlight", "strike"],
      },
    });
    await page.goto("/");
    await openEditor(page);

    const ids = await barIds(page);
    expect(ids[0]).toBe("quote");
    expect(ids).toHaveLength(12); // nothing hidden — the hidden ids were foreign
    for (const foreign of ["highlight", "strike", "numberedList", "heading"]) {
      expect(ids).not.toContain(foreign);
    }
  });

  test("hiding every format action keeps the pinned chrome reachable", async ({ page }) => {
    // The escape-hatch guarantee: attach / library / record / raw-toggle /
    // hide-keyboard are outside the vocabulary, so an emptied format region cannot
    // strand the user in source mode or behind the keyboard.
    await installMockIpc(page, {
      noteIds: [NOTE_ID],
      noteBodies: { [NOTE_ID]: BODY },
      prefs: {
        editor_toolbar_hidden: [
          "undo", "redo", "heading1", "heading2", "bold", "italic",
          "bulletList", "checklist", "quote", "code", "wikilink", "link",
        ],
      },
    });
    await page.goto("/");
    await openEditor(page);

    expect(await barIds(page)).toEqual([]);
    await expect(page.getByTestId("editor.format-bar")).toBeVisible();
    for (const chrome of ["Attach new file", "Insert from library", "Record voice note", "Hide keyboard"]) {
      await expect(page.getByRole("button", { name: chrome })).toBeVisible();
    }
  });
});
