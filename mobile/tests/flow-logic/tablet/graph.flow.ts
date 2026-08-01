// Flow-logic: the graph tab on tablets (MYND-530). Runs in every `tablet-*`
// project; navigation branches on the size class (expanded ≥1000 navigates via
// the sidebar, medium via the phone TabBar scoped to the list column). Asserts
// the same layout-persistence observability contract the phone flow pins,
// plus the tablet-geometry hydrate (positions persisted under any box size
// restore verbatim — the fit transform, not the node coordinates, absorbs the
// geometry difference).

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NOTES = [
  { id: "n1", text: "---\ntitle: Alpha\n---\nSee [[Beta]]\n" },
  { id: "n2", text: "---\ntitle: Beta\n---\nSee [[Gamma]]\n" },
  { id: "n3", text: "---\ntitle: Gamma\n---\nSee [[Alpha]]\n" },
];

const PAYLOAD = JSON.stringify({
  v: 1,
  pos: [
    ["n1", 100, 110],
    ["n2", 220, 120],
    ["n3", 160, 230],
  ],
});

const PANE = '[data-testid="editor.graph-pane"]';
const CANVAS = '[data-testid="editor.graph-canvas"]';

const isExpanded = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 1000;

async function openGraph(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace.split")).toBeVisible();
  if (isExpanded(page)) {
    await page.getByTestId("sidebar.nav-graph").click();
  } else {
    await page.getByTestId("workspace.tab-graph").click();
  }
}

test.describe("tablet graph tab", () => {
  test("cold start settles and spans the content width", async ({ page }) => {
    await installMockIpc(page, { notes: NOTES, backendEdgesUnavailable: true });
    await page.goto("/");
    await openGraph(page);

    const pane = page.locator(PANE);
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute("data-node-count", "3");
    await expect(pane).toHaveAttribute("data-layout-hydrated", "false");
    await expect(page.locator(CANVAS)).toHaveAttribute("data-layout-settled", "true");
    if (isExpanded(page)) {
      // Graph is a full-width tab — the list pane makes way (WS-01).
      await expect(page.getByTestId("workspace.list-pane")).toHaveCount(0);
    }
  });

  test("hydrated mount restores the persisted positions on tablet geometry", async ({ page }) => {
    await installMockIpc(page, {
      notes: NOTES,
      backendEdgesUnavailable: true,
      graphLayoutPayload: PAYLOAD,
    });
    await page.goto("/");
    await openGraph(page);

    const pane = page.locator(PANE);
    await expect(pane).toHaveAttribute("data-layout-hydrated", "true");
    // A fully restored layout runs nothing, whatever the box it was persisted
    // under — the geometry is graph-space and the camera absorbs the tablet's
    // different viewport (myne-md/myne#200).
    await expect(page.locator(CANVAS)).toHaveAttribute("data-layout-settled", "true");
    const writes = await page.evaluate(
      () => (window as unknown as { __graphLayoutWrites?: string[] }).__graphLayoutWrites?.length ?? 0,
    );
    expect(writes).toBe(0);
  });
});
