// Graph layout persistence flow (MYND-530 — the desktop gp1/gp2 contract on
// the mobile tab, mock-IPC tier). Three seeded notes link in a cycle
// ([[wikilinks]] extracted client-side — `backendEdgesUnavailable` rejects the
// backend sweep), so the graph renders 3 connected nodes. The flow asserts the
// observable layout contract: cold start computes + writes `vault.graph`;
// a hydrated mount restores the exact persisted positions, stays put
// (nonce never climbs — flashbang-free) and never writes without interaction;
// a remount is store-served and still hydrated. Byte-level MYG1 correctness is
// `cargo test` + shared-crate territory, not this tier's.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** Three live notes linking in a cycle — every node has degree ≥ 2. */
const NOTES = [
  { id: "n1", text: "---\ntitle: Alpha\n---\nSee [[Beta]]\n" },
  { id: "n2", text: "---\ntitle: Beta\n---\nSee [[Gamma]]\n" },
  { id: "n3", text: "---\ntitle: Gamma\n---\nSee [[Alpha]]\n" },
];

/** A persisted layout with distinctive, assertable coordinates. */
const PAYLOAD = JSON.stringify({
  v: 1,
  pos: [
    ["n1", 100, 110],
    ["n2", 220, 120],
    ["n3", 160, 230],
  ],
});

const PANE = '[data-testid="editor.graph-pane"]';

test.describe("graph layout persistence (phone)", () => {
  test("cold start: computes off-thread, settles, writes the layout", async ({ page }) => {
    await installMockIpc(page, { notes: NOTES, backendEdgesUnavailable: true });
    await page.goto("/");

    await page.getByTestId("workspace.tab-graph").click();
    const pane = page.locator(PANE);
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute("data-node-count", "3");
    await expect(pane).toHaveAttribute("data-layout-hydrated", "false");
    await expect(pane).toHaveAttribute("data-layout-nonce", "1");

    // The worker (or its sync fallback) converges and the sim parks.
    await expect(pane).toHaveAttribute("data-layout-settled", "true");

    // The debounced flush lands: last write parses as the v1 position map
    // carrying every seeded id.
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __graphLayoutWrites?: string[] }).__graphLayoutWrites?.length ?? 0),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);
    const last = await page.evaluate(() => {
      const w = (window as unknown as { __graphLayoutWrites?: string[] }).__graphLayoutWrites!;
      return w[w.length - 1];
    });
    const parsed = JSON.parse(last) as { v: number; pos: [string, number, number][] };
    expect(parsed.v).toBe(1);
    expect(parsed.pos.map(([id]) => id).sort()).toEqual(["n1", "n2", "n3"]);
    for (const [, x, y] of parsed.pos) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  test("hydrated mount: restores the exact positions, stays put, zero writes", async ({ page }) => {
    await installMockIpc(page, {
      notes: NOTES,
      backendEdgesUnavailable: true,
      graphLayoutPayload: PAYLOAD,
    });
    await page.goto("/");

    await page.getByTestId("workspace.tab-graph").click();
    const pane = page.locator(PANE);
    await expect(pane).toHaveAttribute("data-layout-hydrated", "true");
    // Fully restored → settled immediately (alpha 0 — the stays-put property).
    await expect(pane).toHaveAttribute("data-layout-settled", "true");
    await expect(pane).toHaveAttribute("data-layout-nonce", "1");

    // The circles sit at EXACTLY the persisted graph-space coordinates (the
    // pan/zoom fit lives on the <g> transform, not the node attributes).
    await expect(page.locator('circle[cx="100"][cy="110"]')).toBeVisible();
    await expect(page.locator('circle[cx="220"][cy="120"]')).toBeVisible();
    await expect(page.locator('circle[cx="160"][cy="230"]')).toBeVisible();

    // Flashbang-free: the layout effect ran exactly once — the nonce never
    // climbs while the pane sits open — and an untouched restored layout
    // never writes.
    await page.waitForTimeout(1_200); // > the 800 ms flush debounce
    await expect(pane).toHaveAttribute("data-layout-nonce", "1");
    const writes = await page.evaluate(
      () => (window as unknown as { __graphLayoutWrites?: string[] }).__graphLayoutWrites?.length ?? 0,
    );
    expect(writes).toBe(0);
  });

  test("remount: tab away and back is store-served and still hydrated", async ({ page }) => {
    await installMockIpc(page, {
      notes: NOTES,
      backendEdgesUnavailable: true,
      graphLayoutPayload: PAYLOAD,
    });
    await page.goto("/");

    await page.getByTestId("workspace.tab-graph").click();
    const pane = page.locator(PANE);
    await expect(pane).toHaveAttribute("data-layout-hydrated", "true");

    // Away (unmount) and back (fresh mount, session latch → store-served).
    await page.getByTestId("workspace.tab-notes").click();
    await expect(pane).toHaveCount(0);
    await page.getByTestId("workspace.tab-graph").click();

    await expect(pane).toHaveAttribute("data-layout-hydrated", "true");
    await expect(pane).toHaveAttribute("data-layout-settled", "true");
    await expect(page.locator('circle[cx="100"][cy="110"]')).toBeVisible();
  });
});
