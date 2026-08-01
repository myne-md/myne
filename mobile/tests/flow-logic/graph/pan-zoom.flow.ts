// Graph pan/zoom + node interaction flow (MYND-530, rewritten for the shared
// canvas in myne-md/myne#200). Drives the background pan, the node drag
// (→ persisted write), the tap-to-open and the double-tap-to-fit against the
// mock IPC. Pinch (two-pointer) stays on the real-device checklist — headless
// mouse events can't express it faithfully.
//
// The renderer is a <canvas> now, so there is no `<g transform>` to read and no
// `<circle>` to locate. Two things replace them, and both are better:
//   - the camera is published as `data-view-x/y/k` on the canvas element;
//   - the layout is DETERMINISTIC, so a persisted position is exactly where the
//     node is, and screen = graph * k + translate turns that into a pixel.
// Hit-testing a canvas used to be called inherently unreliable. It stopped
// being so the moment the layout stopped being random.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NOTES = [
  { id: "n1", text: "---\ntitle: Alpha\n---\nSee [[Beta]]\n" },
  { id: "n2", text: "---\ntitle: Beta\n---\nSee [[Gamma]]\n" },
  { id: "n3", text: "---\ntitle: Gamma\n---\nSee [[Alpha]]\n" },
];

/** Every node is persisted, so the graph mounts at exactly these coordinates
 *  and never runs a layout — which is what lets the tests compute pixels. */
const POSITIONS: Record<string, { x: number; y: number }> = {
  n1: { x: 100, y: 110 },
  n2: { x: 220, y: 120 },
  n3: { x: 160, y: 230 },
};

const PAYLOAD = JSON.stringify({
  v: 1,
  pos: Object.entries(POSITIONS).map(([id, p]) => [id, p.x, p.y]),
});

const PANE = '[data-testid="editor.graph-pane"]';
const CANVAS = '[data-testid="editor.graph-canvas"]';

async function openGraph(page: Page) {
  await page.goto("/");
  await page.getByTestId("workspace.tab-graph").click();
  await expect(page.locator(CANVAS)).toBeVisible();
  // The camera is only published once the first frame has painted.
  await expect(page.locator(CANVAS)).toHaveAttribute("data-view-k", /.+/);
}

/** The current view transform, as the renderer published it. */
async function view(page: Page): Promise<{ x: number; y: number; k: number }> {
  const el = page.locator(CANVAS);
  const [x, y, k] = await Promise.all([
    el.getAttribute("data-view-x"),
    el.getAttribute("data-view-y"),
    el.getAttribute("data-view-k"),
  ]);
  return { x: Number(x), y: Number(y), k: Number(k) };
}

/** Where a graph-space point currently sits on screen. */
async function screenPoint(page: Page, at: { x: number; y: number }) {
  const v = await view(page);
  const box = (await page.locator(CANVAS).boundingBox())!;
  return { x: box.x + at.x * v.k + v.x, y: box.y + at.y * v.k + v.y };
}

/** A point far from every node — safe to treat as background. */
async function backgroundPoint(page: Page) {
  const box = (await page.locator(CANVAS).boundingBox())!;
  return { x: box.x + 8, y: box.y + 8 };
}

test.describe("graph pan/zoom + node gestures (phone)", () => {
  test("background drag pans the view and never opens a note", async ({ page }) => {
    await installMockIpc(page, {
      notes: NOTES,
      backendEdgesUnavailable: true,
      graphLayoutPayload: PAYLOAD,
    });
    await openGraph(page);

    const before = await view(page);
    const from = await backgroundPoint(page);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 80, from.y + 50, { steps: 5 });
    await page.mouse.up();

    await expect.poll(async () => (await view(page)).x).not.toBe(before.x);
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
    await openGraph(page);

    const fitted = await view(page);
    const from = await backgroundPoint(page);
    // Pan away from the fit…
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 120, from.y + 80, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await view(page)).x).not.toBe(fitted.x);

    // …then double-tap an empty corner: positions unchanged → same fit.
    const corner = await backgroundPoint(page);
    await page.mouse.click(corner.x, corner.y);
    await page.mouse.click(corner.x, corner.y);
    await expect.poll(async () => (await view(page)).x).toBe(fitted.x);
    await expect.poll(async () => (await view(page)).k).toBe(fitted.k);
  });

  test("node drag rearranges and persists; node tap opens the note", async ({ page }) => {
    await installMockIpc(page, {
      notes: NOTES,
      backendEdgesUnavailable: true,
      graphLayoutPayload: PAYLOAD,
    });
    await openGraph(page);

    // n1 sits exactly at its persisted position — drag it ~50 px and a write
    // must land (debounced).
    const { k } = await view(page);
    const at = await screenPoint(page, POSITIONS["n1"]!);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 50, at.y + 30, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __graphLayoutWrites?: string[] }).__graphLayoutWrites?.length ?? 0),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);

    // The node followed the pointer in GRAPH space; recompute its pixel from
    // the live camera rather than reusing the pre-drag one. The camera moves on
    // its own here: the debounced index sweep rebuilds the model, and a rebuild
    // refits — so a screen point captured before the wait is stale by the time
    // the write lands.
    const dragged = { x: POSITIONS["n1"]!.x + 50 / k, y: POSITIONS["n1"]!.y + 30 / k };
    const now = await screenPoint(page, dragged);
    await page.mouse.click(now.x, now.y);
    await expect(page.getByTestId("editor.top-bar")).toBeVisible();
  });
});
