// Flow-logic: size-class transitions mid-edit — rotation (landscape ⇄
// portrait) and the iPad Split View narrow case (the WINDOW shrinks to phone
// width while the SCREEN stays tablet-sized, so only the viewport changes —
// exactly what setViewportSize emulates against the project's fixed `screen`).
// Editor content must survive every flip; the compact fallback must land on
// the editor screen when a note is open (the reconciliation effect).

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

async function bootToWorkspace(page: Page): Promise<void> {
  await installMockIpc(page, { syncStatus: { state: "idle" } });
  await page.goto("/");
  await expect(page.getByTestId("workspace.split")).toBeVisible();
}

test.describe("size-class transitions", () => {
  test("narrowing to phone width mid-edit lands on the editor screen, content intact", async ({ page }) => {
    await bootToWorkspace(page);

    // Open a fresh note in the detail pane and type into the live editor.
    await page.getByTestId("workspace.empty-detail-new").click();
    await expect(page.locator(".cm-content")).toBeVisible();
    await page.locator(".cm-content").click();
    await page.keyboard.type("tablet rotation survivor");

    // iPad Split View ⅓-pane / phone width: compact fallback with the note open
    // → the editor screen (not the list), back chevron present, list pane gone.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("[data-size-class]")).toHaveAttribute("data-size-class", "compact");
    await expect(page.getByTestId("workspace.split")).toHaveCount(0);
    await expect(page.getByTestId("editor.back")).toBeVisible();
    await expect(page.locator(".cm-content")).toContainText("tablet rotation survivor");

    // Back to the tablet width: the split returns and the SAME note fills the
    // detail pane (the editor remounts from state — content survives).
    const { width, height } = page.viewportSize()!;
    void width;
    void height;
    await page.setViewportSize({ width: 1194, height: 834 });
    await expect(page.getByTestId("workspace.split")).toBeVisible();
    await expect(page.getByTestId("workspace.list-pane")).toBeVisible();
    await expect(page.getByTestId("editor.back")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toContainText("tablet rotation survivor");
  });

  test("landscape ⇄ portrait keeps the split and the open note", async ({ page }) => {
    await bootToWorkspace(page);
    await page.getByTestId("workspace.empty-detail-new").click();
    await page.locator(".cm-content").click();
    await page.keyboard.type("orientation flip");

    const vp = page.viewportSize()!;
    await page.setViewportSize({ width: vp.height, height: vp.width });

    // Both orientations of every tablet project stay ≥700 wide → still a split.
    await expect(page.getByTestId("workspace.split")).toBeVisible();
    await expect(page.locator(".cm-content")).toContainText("orientation flip");

    await page.setViewportSize(vp);
    await expect(page.getByTestId("workspace.split")).toBeVisible();
    await expect(page.locator(".cm-content")).toContainText("orientation flip");
  });
});
