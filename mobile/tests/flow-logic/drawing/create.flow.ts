// Flow-logic: the mobile drawing-note create affordance (MYND-515). The whole
// drawing engine (canvas render, autosave, reopen) already landed with the
// Excalidraw-compatibility work; this pins the fix — a discoverable "New drawing"
// entry in the note-list create surface + the folder action sheet — so a user can
// actually reach a drawing note without digging into the command palette.
//
// The Excalidraw canvas itself is lazy-loaded and heavy; here we only assert the
// affordance routes to the drawing surface (`drawing.pane` renders). The byte
// layout of a `kind: drawing` note is covered by the shared @myne/editor tests.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

test.describe("mobile drawing-note create affordance", () => {
  test("the New drawing tile opens the drawing surface", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "idle" } });
    await page.goto("/");
    // Default boot lands on the note list (the create tiles live here).
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();

    await page.getByTestId("notes.new-drawing-tile").click();

    // The create action routed to the drawing canvas surface, not the text editor.
    await expect(page.getByTestId("drawing.pane")).toBeVisible();
  });

  test("the New drawing tile shows by default", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "idle" } });
    await page.goto("/");
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();
    // No hide pref set → the drawing tile is present out of the box.
    await expect(page.getByTestId("notes.new-drawing-tile")).toBeVisible();
  });

  test("the New drawing tile hides via the shared home-tile pref (MYND-538)", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "idle" } });
    // The drawing tile joined Templates/Daily/Views on the MYND-479 hide/show
    // mechanism: a device-local `myne.home-tiles-hidden` list in localStorage,
    // persisted across restarts. Seeding it with "new-drawing" (as a Settings →
    // Appearance toggle would) must drop the tile while the list still renders.
    await page.addInitScript(() =>
      localStorage.setItem("myne.home-tiles-hidden", JSON.stringify(["new-drawing"])),
    );
    await page.goto("/");
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();
    await expect(page.getByTestId("notes.new-drawing-tile")).toHaveCount(0);
  });
});
