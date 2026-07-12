// Flow-logic: the compact fallback on a tablet-sized SCREEN — the iPad Split
// View / Android split-screen case. The window is phone-width from the start
// (viewport narrowed before load), the screen stays the project's tablet size,
// and the app must present the plain phone layout end to end: full-screen
// list, push navigation into the editor, back chevron out.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

async function bootNarrow(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMockIpc(page, { syncStatus: { state: "idle" } });
  await page.goto("/");
  await expect(page.getByTestId("workspace.app-header")).toBeVisible();
}

test.describe("compact fallback on a tablet screen", () => {
  test("phone layout end to end: list → editor push → back to list", async ({ page }) => {
    await bootNarrow(page);

    await expect(page.locator("[data-size-class]")).toHaveAttribute("data-size-class", "compact");
    // No split, no sidebar — the phone chrome owns the screen.
    await expect(page.getByTestId("workspace.split")).toHaveCount(0);
    await expect(page.getByTestId("workspace.sidebar")).toHaveCount(0);
    await expect(page.getByTestId("workspace.tab-bar")).toBeVisible();

    // New note pushes the full-screen editor (the list leaves the screen).
    await page.getByLabel("New note").click();
    await expect(page.getByTestId("editor.top-bar")).toBeVisible();
    await expect(page.getByTestId("workspace.app-header")).toHaveCount(0);
    await expect(page.getByTestId("editor.back")).toBeVisible();

    // Back pops to the list (empty new note is discarded, not persisted).
    await page.getByTestId("editor.back").click();
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();
    await expect(page.getByText("No notes yet")).toBeVisible();
  });
});
