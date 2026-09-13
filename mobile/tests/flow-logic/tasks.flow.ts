// Flow-logic: the mobile task surfaces (MYND-620 tasks 3, 4, 8; panel redesigned
// for myne-md/myne#656). Headless Chromium + mock IPC - NOT end-to-end.
//
// What this tier is for here is stated in the task itself: **a navigation change
// must not be able to silently remove these surfaces.** So the assertions are
// about existence and routing (the destination is in the bar, one tap reaches
// it, the sheet opens from the editor and shows only that note), and about the
// one behaviour that spans surfaces - that ticking from a list writes to the
// **note the task came from**, not to whatever note happens to be open.
//
// It does NOT re-test filtering or sorting. Those are the desktop's code, used
// here verbatim through `@myne/task-panel`, and the desktop already covers them;
// re-asserting them would only test that an alias works.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "./mock-ipc";

/** Two notes, four tasks - enough that a vault-wide list is visibly wider than
 *  a note-scoped one, which is the distinction under test.
 *
 *  The undated rows spell their absent fields as `null` rather than omitting the
 *  keys, because that is what `vault_indices_tasks` actually answers with: Rust's
 *  `Option<String>` serializes as `null`, and the struct cannot gain a
 *  `skip_serializing_if` (it is also the on-disk `MYI1` payload). A fixture that
 *  omitted them would be testing a shape the app never receives - and did, until
 *  the All filter crashed on it (myne-md/myne-mobile#36). */
const TASKS = [
  {
    noteId: "note-a",
    noteTitle: "Groceries",
    noteFolder: "Home",
    lineIndex: 1,
    rawLine: "- [ ] buy milk",
    completed: false,
    oversized: false,
    due: "2026-08-01",
  },
  {
    noteId: "note-a",
    noteTitle: "Groceries",
    noteFolder: "Home",
    lineIndex: 2,
    rawLine: "- [ ] buy bread",
    completed: false,
    oversized: false,
    due: null,
    remind: null,
    repeat: null,
    priority: null,
    done: null,
  },
  {
    noteId: "note-b",
    noteTitle: "Work",
    noteFolder: "Office",
    lineIndex: 4,
    rawLine: "- [ ] send the invoice",
    completed: false,
    oversized: false,
    due: "2026-08-02",
  },
  {
    noteId: "note-b",
    noteTitle: "Work",
    noteFolder: "Office",
    lineIndex: 7,
    rawLine: "- [ ] chase the reply",
    completed: false,
    oversized: false,
    due: null,
    remind: null,
    repeat: null,
    priority: null,
    done: null,
  },
];

const NOTE_BODIES = {
  "note-a": "# Groceries\n- [ ] buy milk\n- [ ] buy bread\n",
  "note-b": "# Work\n\n\n\n- [ ] send the invoice\n\n\n- [ ] chase the reply\n",
};

async function openTasksDestination(page: Page): Promise<void> {
  await page.getByTestId("workspace.tab-tasks").click();
}

/** Open the filter builder if closed, select the Folder axis, pick a value. */
async function pickFolder(page: Page, prefix: string, value: string): Promise<void> {
  if ((await page.getByTestId(`${prefix}.filtersPanel`).count()) === 0) {
    await page.getByTestId(`${prefix}.filtersButton`).click();
  }
  await page.getByTestId(`${prefix}.builderTab.folder`).click();
  await page.getByTestId(`${prefix}.builderOption.folder.${value}`).click();
}

test.describe("mobile task surfaces", () => {
  test("the Tasks destination is one tap away and lists tasks across notes", async ({
    page,
  }) => {
    await installMockIpc(page, { tasks: TASKS, noteIds: ["note-a", "note-b"], noteBodies: NOTE_BODIES });
    await page.goto("/");

    // In the bar itself - the information-architecture decision this task made,
    // and the one a navigation change could silently undo.
    const destination = page.getByTestId("workspace.tab-tasks");
    await expect(destination).toBeVisible();

    await destination.click();

    // Across notes: a vault-wide list whose rows all came from one note would
    // not be a vault-wide list.
    await expect(page.getByText("buy milk")).toBeVisible();
    await expect(page.getByText("send the invoice")).toBeVisible();
    // And each row names where it came from, which is the whole reason the row
    // is two lines on a phone.
    await expect(page.getByText("Groceries").first()).toBeVisible();
    await expect(page.getByText("Work").first()).toBeVisible();
  });

  test("a task the index reports with null dates renders, undated", async ({ page }) => {
    // The one tier that runs the real chain in a browser: the mobile fetch, the
    // shared panel, the shared row. The desktop cannot reproduce this at all -
    // it decodes at its own boundary - so if this surface is going to regress,
    // it regresses here or nowhere (myne-md/myne-mobile#36).
    await installMockIpc(page, { tasks: TASKS, noteIds: ["note-a", "note-b"], noteBodies: NOTE_BODIES });
    await page.goto("/");
    await openTasksDestination(page);

    // Present, not merely un-crashed: the undated rows sit in their own section,
    // so a fix that dropped every null-bearing row would not pass.
    await expect(page.getByText("buy bread")).toBeVisible();
    await expect(page.getByText("chase the reply")).toBeVisible();
    await expect(page.getByText("buy milk")).toBeVisible();
  });

  test("the sections and the filter row are there", async ({ page }) => {
    await installMockIpc(page, { tasks: TASKS, noteIds: ["note-a", "note-b"], noteBodies: NOTE_BODIES });
    await page.goto("/");
    await openTasksDestination(page);

    // The dated buckets (both due 2026-08 are in the past against the real
    // clock) and the undated bucket each get a labelled section.
    await expect(page.getByTestId("tasks.vault.section.overdue")).toBeVisible();
    await expect(page.getByTestId("tasks.vault.section.none")).toBeVisible();
    // The toolbar is search plus a single Filters button; the axes live in the
    // builder behind it (myne-md/myne#656 review).
    await expect(page.getByTestId("tasks.vault.search")).toBeVisible();
    await expect(page.getByTestId("tasks.vault.filtersButton")).toBeVisible();
    await expect(page.getByTestId("tasks.vault.filtersPanel")).toHaveCount(0);
    await page.getByTestId("tasks.vault.filtersButton").click();
    await expect(page.getByTestId("tasks.vault.filtersPanel")).toBeVisible();
    await expect(page.getByTestId("tasks.vault.builderTab.status")).toBeVisible();
    await expect(page.getByTestId("tasks.vault.builderTab.folder")).toBeVisible();
  });

  test("the folder filter narrows (AND)", async ({ page }) => {
    await installMockIpc(page, { tasks: TASKS, noteIds: ["note-a", "note-b"], noteBodies: NOTE_BODIES });
    await page.goto("/");
    await openTasksDestination(page);

    await pickFolder(page, "tasks.vault", "Office");

    await expect(page.getByText("send the invoice")).toBeVisible();
    await expect(page.getByText("buy milk")).toHaveCount(0);

    await pickFolder(page, "tasks.vault", "any");
    await expect(page.getByText("buy milk")).toBeVisible();
  });

  test("the editor sheet lists only the open note's tasks", async ({ page }) => {
    await installMockIpc(page, { tasks: TASKS, noteIds: ["note-a", "note-b"], noteBodies: NOTE_BODIES });
    await page.goto("/");

    await page.getByTestId("notes.row").first().click();
    await page.getByTestId("editor.more").click();
    await page.getByTestId("editor.note-menu-tasks").click();

    // Scoped to the PANEL: the note's body is open in the editor behind the
    // sheet, so an unscoped text match resolves to the editor line, the tab
    // preview and the row all at once.
    const panel = page.getByTestId("tasks.note.panel");
    await expect(panel.getByText("buy milk")).toBeVisible();
    // The point of the note scope: the other note's tasks are absent.
    await expect(panel.getByText("send the invoice")).toHaveCount(0);
  });

  test("ticking from the vault-wide list writes to the task's own note", async ({ page }) => {
    await installMockIpc(page, { tasks: TASKS, noteIds: ["note-a", "note-b"], noteBodies: NOTE_BODIES });
    await page.goto("/");
    await openTasksDestination(page);

    // Tick a task belonging to note-b while nothing is open. The write must
    // land in note-b - a list that wrote to "the current note" would corrupt a
    // different note every time.
    const row = page
      .getByTestId("tasks.vault.row.row")
      .filter({ hasText: "send the invoice" });
    await row.getByTestId("tasks.vault.row.checkbox").click();

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __noteUpdates?: string[] }).__noteUpdates))
      .toEqual([expect.stringContaining("- [x] send the invoice")]);
    // And nothing about the OTHER note was written.
    const written = await page.evaluate(
      () => (window as unknown as { __noteUpdates?: string[] }).__noteUpdates ?? [],
    );
    expect(written.join("\n")).not.toContain("buy milk\n- [x]");
  });
});
