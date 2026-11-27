// Flow-logic: the tablet workspace layout (size-class adaptive split). Runs in
// every `tablet-*` Playwright project; assertions branch on the project's
// viewport width where expanded (≥1000: nav RAIL + list + detail) and medium
// (≥700, two-pane: list + detail with the phone chrome) legitimately differ.
// Same mock-IPC tier as the rest of flow-logic — no device, no Rust.
//
// **The expanded shape is a rail, not the 248pt labelled sidebar** (owner,
// 2026-11-27: three columns on a portrait iPad read as "çok rahatsız edici bir
// look"). `workspace.ribbon` is the rail; every destination it offers keeps the
// `ribbon.nav-*` testid the old `sidebar.nav-*` rows carried.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** Boot the mock app to the editor stage and wait for the workspace split. */
async function bootToWorkspace(page: Page): Promise<void> {
  await installMockIpc(page, { syncStatus: { state: "idle" } });
  await page.goto("/");
  await expect(page.getByTestId("workspace.split")).toBeVisible();
}

const isExpanded = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 1000;

test.describe("tablet workspace layout", () => {
  test("panes match the size class (three-pane on expanded, two-pane + phone chrome on medium)", async ({ page }) => {
    await bootToWorkspace(page);

    await expect(page.getByTestId("workspace.list-pane")).toBeVisible();
    await expect(page.getByTestId("workspace.detail-pane")).toBeVisible();
    // No note open yet → the detail pane shows the empty state.
    await expect(page.getByTestId("workspace.empty-detail")).toBeVisible();

    if (isExpanded(page)) {
      // The rail absorbs the AppHeader + TabBar destinations.
      await expect(page.getByTestId("workspace.ribbon")).toBeVisible();
      await expect(page.getByTestId("workspace.sidebar")).toHaveCount(0);
      await expect(page.getByTestId("workspace.app-header")).toHaveCount(0);
      await expect(page.getByTestId("workspace.tab-bar")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("workspace.ribbon")).toHaveCount(0);
      await expect(page.getByTestId("workspace.sidebar")).toHaveCount(0);
      await expect(page.getByTestId("workspace.app-header")).toBeVisible();
      await expect(page.getByTestId("workspace.tab-bar")).toBeVisible();
    }

    const sizeClass = await page.locator("[data-size-class]").getAttribute("data-size-class");
    expect(sizeClass).toBe(isExpanded(page) ? "expanded" : "medium");
  });

  test("new note fills the detail pane while the list stays on screen; no back chevron", async ({ page }) => {
    await bootToWorkspace(page);

    await page.getByTestId("workspace.empty-detail-new").click();

    // Editor pane is up (top bar + live editor), the list did NOT navigate away,
    // and the compact-only back chevron is absent (nothing to go "back" to).
    await expect(page.getByTestId("editor.top-bar")).toBeVisible();
    await expect(page.locator(".cm-content")).toBeVisible();
    await expect(page.getByTestId("workspace.list-pane")).toBeVisible();
    await expect(page.getByTestId("editor.back")).toHaveCount(0);
    await expect(page.getByTestId("workspace.empty-detail")).toHaveCount(0);
  });

  test("focusing an existing note keeps the left panes open; the top-bar toggle hides and restores them", async ({ page }) => {
    // Seed one existing note so we can focus a saved note (a brand-new note
    // deliberately keeps the list up — see the previous test).
    await installMockIpc(page, { syncStatus: { state: "idle" }, noteIds: ["n1"] });
    await page.goto("/");
    await expect(page.getByTestId("workspace.split")).toBeVisible();
    await expect(page.getByTestId("workspace.list-pane")).toBeVisible();

    // Open it → the note opens BESIDE the list (owner, 2026-11-27: "iPad'de notu
    // açınca default olarak sidebar'ı kapatıyor, bunu yapmamalı, direkt sağda
    // açması lazım"). Collapsing is now an explicit choice, never the default.
    await page.getByTestId("notes.row").first().click();
    await expect(page.getByTestId("editor.top-bar")).toBeVisible();
    await expect(page.getByTestId("workspace.list-pane")).not.toHaveAttribute("data-collapsed", "true");
    await expect(page.getByTestId("workspace.list-pane")).toBeVisible();
    if (isExpanded(page)) await expect(page.getByTestId("workspace.ribbon")).toBeVisible();

    // The EditorTopBar toggle still hides the panes for a distraction-free read.
    // The pane stays mounted for the width animation — the collapsed state rides
    // on `data-collapsed` (width 0), not an unmount.
    await page.getByTestId("editor.toggle-list").click();
    await expect(page.getByTestId("workspace.list-pane")).toHaveAttribute("data-collapsed", "true");

    // ...and brings them back.
    await page.getByTestId("editor.toggle-list").click();
    await expect(page.getByTestId("workspace.list-pane")).not.toHaveAttribute("data-collapsed", "true");
  });

  test("rail navigation drives the full-width tabs and the list slices (expanded only)", async ({ page }) => {
    test.skip(!isExpanded(page), "the rail renders only on the expanded size class");
    await bootToWorkspace(page);

    // Graph spans the content width (the list pane makes way).
    await page.getByTestId("ribbon.nav-graph").click();
    await expect(page.getByTestId("workspace.list-pane")).toHaveCount(0);

    // Back to notes; Trash is a list slice, so the split returns.
    await page.getByTestId("ribbon.nav-trash").click();
    await expect(page.getByTestId("workspace.list-pane")).toBeVisible();
    await expect(page.getByText("Trash is empty")).toBeVisible();

    await page.getByTestId("ribbon.nav-notes").click();
    // Back on the notes slice with nothing in it. Row count rather than the
    // "No notes yet" placeholder: a deliberate folder keeps the tree non-empty
    // since myne-md/myne#613.
    await expect(page.getByTestId("workspace.list-pane")).toBeVisible();
    await expect(page.getByTestId("notes.row")).toHaveCount(0);
  });

  test("sheets clamp to a centered card instead of stretching edge to edge", async ({ page }) => {
    await bootToWorkspace(page);

    // Open Settings (the rail's gear on expanded; the AppHeader gear on medium).
    if (isExpanded(page)) await page.getByTestId("ribbon.settings").click();
    else await page.getByLabel("Settings").click();

    const card = page.getByTestId("sheet.card");
    await expect(card).toBeVisible();
    const box = await card.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.width).toBeLessThanOrEqual(560);
    // Centered: side gaps within a pixel of each other.
    expect(Math.abs(box!.x - (viewport.width - box!.x - box!.width))).toBeLessThanOrEqual(1);
  });
});
