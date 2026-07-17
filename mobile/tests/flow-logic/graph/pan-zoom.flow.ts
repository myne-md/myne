// Graph pan/zoom + node interaction flow (MYND-530). Drives the background
// pan, the node drag (→ persisted write), the tap-to-open, and the
// double-tap-to-fit against the mock IPC. Pinch (two-pointer) stays on the
// real-device checklist — headless mouse events can't express it faithfully.

import { test, expect } from "@playwright/test";
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
const VIEW_G = `${PANE} svg > g`;

async function openSettledGraph(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("workspace.tab-graph").click();
  await expect(page.locator(PANE)).toHaveAttribute("data-layout-settled", "true");
}

test.describe("graph pan/zoom + node gestures (phone)", () => {
  test("background drag pans the view and never opens a note", async ({ page }) => {
    await installMockIpc(page, {
      notes: NOTES,
      backendEdgesUnavailable: true,
      graphLayoutPayload: PAYLOAD,
    });
    await openSettledGraph(page);

    const before = await page.locator(VIEW_G).getAttribute("transform");
    const box = (await page.locator(`${PANE} svg`).boundingBox())!;
    // Top-left corner is empty background (the layout is fit-centered).
    await page.mouse.move(box.x + 8, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 88, box.y + 58, { steps: 5 });
    await page.mouse.up();

    await expect
      .poll(() => page.locator(VIEW_G).getAttribute("transform"))
      .not.toBe(before);
    // Still on the graph — a pan is not a tap.
    await expect(page.locator(PANE)).toBeVisible();
    await expect(page.getByTestId("editor.top-bar")).toHaveCount(0);
  });

  test("double-tap on the background returns to the fitted view", async ({ page }) => {
    await installMockIpc(page, {
      notes: NOTES,
      backendEdgesUnavailable: true,
      graphLayoutPayload: PAYLOAD,
    });
    await openSettledGraph(page);

    const fitted = await page.locator(VIEW_G).getAttribute("transform");
    const box = (await page.locator(`${PANE} svg`).boundingBox())!;
    // Pan away from the fit…
    await page.mouse.move(box.x + 8, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 80, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(() => page.locator(VIEW_G).getAttribute("transform"))
      .not.toBe(fitted);

    // …then double-tap an empty corner: positions unchanged → same fit.
    await page.mouse.dblclick(box.x + 12, box.y + 12);
    await expect.poll(() => page.locator(VIEW_G).getAttribute("transform")).toBe(fitted);
  });

  test("node drag rearranges and persists; node tap opens the note", async ({ page }) => {
    await installMockIpc(page, {
      notes: NOTES,
      backendEdgesUnavailable: true,
      graphLayoutPayload: PAYLOAD,
    });
    await openSettledGraph(page);

    // Drag the first node ~50 px: a write must land (debounced).
    const node = page.locator(`${PANE} circle`).first();
    const nb = (await node.boundingBox())!;
    await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
    await page.mouse.down();
    await page.mouse.move(nb.x + nb.width / 2 + 50, nb.y + nb.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __graphLayoutWrites?: string[] }).__graphLayoutWrites?.length ?? 0),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);

    // Wait for the post-drag settle, then a clean tap opens the note.
    await expect(page.locator(PANE)).toHaveAttribute("data-layout-settled", "true");
    const target = page.locator(`${PANE} circle`).first();
    const tb = (await target.boundingBox())!;
    await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await expect(page.getByTestId("editor.top-bar")).toBeVisible();
  });
});
