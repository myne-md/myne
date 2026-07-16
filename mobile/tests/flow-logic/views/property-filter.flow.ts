// Saved-view PROPERTY condition flow (mobile authoring + renderer). The view
// editor can now author the engine's property leaf (key + op + value), so this
// drives the phone flow end-to-end against the dev server with the mock IPC:
// seed two notes plus a canned `vault_indices_property_values` universe, build
// a `status == urgent` view through the sheet, then open it and assert the
// renderer paints exactly the matching note.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** Two live notes; which one matches is decided by the canned property pairs,
 *  not the note bodies (the engine's property resolver reads the index). */
const NOTES = [
  { id: "n1", text: "---\ntitle: Alpha\n---\n" },
  { id: "n2", text: "---\ntitle: Beta\n---\n" },
];

test.describe("saved-view property condition (phone)", () => {
  test("creates a `status == urgent` view and renders only the matching note", async ({ page }) => {
    await installMockIpc(page, {
      notes: NOTES,
      propertyKeys: ["status"],
      propertyValues: {
        status: [
          ["n1", { key: "status", type: "string", value: "urgent" }],
          ["n2", { key: "status", type: "string", value: "later" }],
        ],
      },
    });
    await page.goto("/");

    // Views → "+ New view" opens the editor sheet.
    await page.getByRole("button", { name: "Views" }).first().click();
    await page.getByText("New view").click();
    await page.getByPlaceholder("View name").fill("Urgent only");

    // Add a condition and switch it to a property row: the key select defaults
    // to the sole indexed key ("status"), the op to `==`; type the value.
    await page.getByText("+ Add condition").click();
    await page.getByTestId("view-editor.condition-type").selectOption("property");
    await expect(page.getByTestId("view-editor.condition-prop-key")).toHaveValue("status");
    await page.getByTestId("view-editor.condition-prop-op").selectOption("==");
    await page.getByTestId("view-editor.condition-prop-value").fill("urgent");
    await page.getByText("Create view").click();

    // Reopen Views and activate — the renderer paints exactly the matching note.
    await page.getByRole("button", { name: "Views" }).first().click();
    await page.getByText("Urgent only").click();
    await expect(page.getByTestId("view.list")).toBeVisible();
    await expect(page.getByTestId("view.list-row")).toHaveCount(1);
    await expect(
      page.locator('[data-testid="view.list-row"][data-note-id="n1"]'),
    ).toBeVisible();
    await expect(page.getByText("Alpha")).toBeVisible();
  });
});
