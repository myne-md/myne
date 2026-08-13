// Graph layout persistence flow (MYND-530 — the desktop gp1/gp2 contract on
// the mobile tab, mock-IPC tier; rewritten for the shared canvas in
// myne-md/myne#200). Three seeded notes link in a cycle ([[wikilinks]]
// extracted client-side — `backendEdgesUnavailable` rejects the backend sweep),
// so the graph renders 3 connected nodes. The flow asserts the observable
// layout contract: cold start computes + writes `vault.graph`; a hydrated
// mount restores the persisted positions, runs NOTHING and writes nothing;
// a remount is store-served and still hydrated. Byte-level MYG1 correctness is
// `cargo test` + shared-crate territory, not this tier's.
//
// The renderer is a <canvas>, so the per-node `<circle cx cy>` assertions are
// gone. What replaces them is stronger: the layout is deterministic and the
// camera is published, so "restored exactly" is checked as "no layout ran and
// no write happened" — which is the property those coordinates were standing
// in for.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** Three live notes linking in a cycle — every node has degree ≥ 2. */
const NOTES = [
  { id: "n1", text: "---\ntitle: Alpha\n---\nSee [[Beta]]\n" },
  { id: "n2", text: "---\ntitle: Beta\n---\nSee [[Gamma]]\n" },
  { id: "n3", text: "---\ntitle: Gamma\n---\nSee [[Alpha]]\n" },
];

/** A persisted layout covering EVERY node — the fully-restored case. */
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

const writeCount = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () => (window as unknown as { __graphLayoutWrites?: string[] }).__graphLayoutWrites?.length ?? 0,
  );

test.describe("graph layout persistence (phone)", () => {
  test("cold start: computes off-thread, settles, writes the layout", async ({ page }) => {
    await installMockIpc(page, { notes: NOTES, backendEdgesUnavailable: true });
    await page.goto("/");

    await page.getByTestId("workspace.tab-graph").click();
    const pane = page.locator(PANE);
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute("data-node-count", "3");
    await expect(pane).toHaveAttribute("data-layout-hydrated", "false");

    // The worker (or its sync fallback) converges and the run completes.
    await expect(page.locator(CANVAS)).toHaveAttribute("data-layout-settled", "true");

    // The debounced flush lands: last write parses as the v1 position map
    // carrying every seeded id.
    await expect.poll(() => writeCount(page), { timeout: 5_000 }).toBeGreaterThan(0);
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

  test("hydrated mount: restores the layout, runs nothing, writes nothing", async ({ page }) => {
    await installMockIpc(page, {
      notes: NOTES,
      backendEdgesUnavailable: true,
      graphLayoutPayload: PAYLOAD,
    });
    await page.goto("/");

    await page.getByTestId("workspace.tab-graph").click();
    const pane = page.locator(PANE);
    await expect(pane).toHaveAttribute("data-layout-hydrated", "true");
    // Fully restored → settled with no run at all (the stays-put property).
    await expect(page.locator(CANVAS)).toHaveAttribute("data-layout-settled", "true");

    // Flashbang-free AND churn-free: an untouched restored layout neither
    // re-lays-out nor rewrites `vault.graph`.
    await page.waitForTimeout(1_200); // > the 800 ms flush debounce
    expect(await writeCount(page)).toBe(0);
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
    await expect(page.locator(CANVAS)).toHaveAttribute("data-layout-settled", "true");
    // No re-layout on the way back: the arrangement is store-served. (Writes
    // are NOT asserted here — tabbing away unmounts the pane, and the unmount
    // flush is deliberate: it is the seam that catches a drag still inside the
    // 800 ms debounce.)
    await expect(page.locator(CANVAS)).toHaveAttribute("data-force-relayout-count", "0");
  });
});
