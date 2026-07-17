// Saved-view LIST render flow (mobile authoring + renderer). Now that a view is
// user-creatable (the ViewEditorSheet view_type picker defaults to "list") and
// renders through `MobileViewRenderHost`, this drives the phone flow end-to-end
// against the dev server with the mock IPC: seed a couple of notes, create a new
// (list) view, then open it and assert the list renderer paints one row per
// matching note. A second case renders a preseeded view directly (fewer steps,
// the robust render anchor).

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";
import type { SavedView } from "../../../src/lib/prefs";

/** Two live notes (frontmatter title only) — an "all" filter matches both. */
const NOTES = [
  { id: "n1", text: "---\ntitle: Alpha\n---\n" },
  { id: "n2", text: "---\ntitle: Beta\n---\n" },
];

/** A preseeded list view over everything. */
const LIST_VIEW: SavedView = {
  id: "v-list",
  name: "Everything",
  view_type: "list",
  filters: { kind: "all" },
};

test.describe("saved-view list render (phone)", () => {
  test("renders a preseeded list view with one row per matching note", async ({ page }) => {
    await installMockIpc(page, { notes: NOTES, savedViews: [LIST_VIEW] });
    await page.goto("/");

    // Open the Views sheet and activate the preseeded view.
    await page.getByRole("button", { name: "Views" }).first().click();
    await page.getByText("Everything").click();

    // The list renderer paints, one row per note (both match the "all" filter).
    await expect(page.getByTestId("view.list")).toBeVisible();
    await expect(page.getByTestId("view.list-row")).toHaveCount(2);
    await expect(
      page.locator('[data-testid="view.list-row"][data-note-id="n1"]'),
    ).toBeVisible();
    await expect(page.getByText("Alpha")).toBeVisible();
  });

  test("creates a new (list) view and renders it", async ({ page }) => {
    await installMockIpc(page, { notes: NOTES });
    await page.goto("/");

    // Views → "+ New view" opens the editor sheet (view_type defaults to list).
    await page.getByRole("button", { name: "Views" }).first().click();
    await page.getByText("New view").click();

    // Name it and create.
    await page.getByPlaceholder("View name").fill("My list");
    await page.getByText("Create view").click();

    // Reopen Views — the created view is now listed — and activate it.
    await page.getByRole("button", { name: "Views" }).first().click();
    await page.getByText("My list").click();

    // It renders as a list, one row per seeded note.
    await expect(page.getByTestId("view.list")).toBeVisible();
    await expect(page.getByTestId("view.list-row")).toHaveCount(2);
  });
});
