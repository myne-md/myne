// Cross-origin isolation, and the width range a browser tab actually spans
// (MYND-574 tasks 55 + 74).
//
// Both are properties only a real browser can answer, and both had been asserted
// one layer short of where they matter:
//
// * **Isolation** was checked as two response HEADERS. Headers are the input;
//   `crossOriginIsolated` is the browser's verdict, and it can be `false` with
//   both headers correct — a cross-origin subresource without CORP, an iframe, a
//   popup opener. The consequence is specific and late: `SharedArrayBuffer`
//   becomes undefined, so the sync backoff's blocking waiter
//   (`core/src/task.rs`) cannot exist, and the symptom is a hang rather than an
//   error.
// * **The layout** was swept as arithmetic over `computeResponsiveCollapse`
//   (`tests/screens/browserViewportRange.test.ts`). That pins the DECISION; it
//   cannot see a pane that overflows its row because a style disagrees with the
//   arithmetic. This resizes a real window and asks the document.
//
// Vault-count precondition: **0**. Everything here is reachable on the first-run
// screen, so neither scenario needs a sync server.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { openApp } from "./support/flows";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";

/** The widths a browser tab realistically lands on, narrow end first. */
const VIEWPORTS: readonly [number, number, string][] = [
  [400, 900, "a quarter-screen snap — narrower than the desktop window can go"],
  [800, 900, "half of a 1600 display"],
  [1280, 900, "half of a 2560 ultrawide"],
  [1920, 1080, "maximised 1080p"],
  [2560, 1080, "a 21:9 ultrawide"],
];

describeE2E("cross-origin isolation and the browser viewport range", () => {
  it("reports crossOriginIsolated true — the headers' EFFECT, not their presence", async () => {
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    try {
      const browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      try {
        await openApp(browser.session, server.origin);
        const isolated = await browser.session.execute<boolean>(
          "return window.crossOriginIsolated === true;",
        );
        expect(
          isolated,
          "COOP + COEP are served but the page is not isolated — SharedArrayBuffer " +
            "will be undefined and the sync backoff's blocking waiter cannot exist",
        ).toBe(true);
        // The capability the isolation exists FOR. Asserting the flag alone
        // would pass on a browser that reports isolation and still withholds the
        // constructor, which is the only thing the app actually needs.
        const hasSab = await browser.session.execute<boolean>(
          "return typeof SharedArrayBuffer === 'function';",
        );
        expect(hasSab, "isolated but no SharedArrayBuffer").toBe(true);
      } finally {
        await browser.teardown();
      }
    } finally {
      await server.close();
    }
  });

  it("never overflows its own document, from a quarter-screen snap to an ultrawide", async () => {
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    try {
      const browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      try {
        await openApp(browser.session, server.origin);
        for (const [width, height, label] of VIEWPORTS) {
          await browser.session.send("POST", "/window/rect", { width, height, x: 0, y: 0 });
          // One frame for the resize observers to settle before measuring.
          await browser.session.execute(
            "return new Promise(r => requestAnimationFrame(() => r(null)));",
          );
          const overflow = await browser.session.execute<{ scroll: number; client: number }>(
            "return { scroll: document.documentElement.scrollWidth," +
              " client: document.documentElement.clientWidth };",
          );
          // HORIZONTAL overflow only. A page taller than the viewport is normal
          // and scrolls; a page WIDER than its viewport is content escaping its
          // container, which is the clipping this criterion is about.
          expect(
            overflow.scroll,
            `${width}×${height} (${label}) overflows horizontally: ` +
              `scrollWidth ${overflow.scroll} > clientWidth ${overflow.client}`,
          ).toBeLessThanOrEqual(overflow.client + 1); // +1 absorbs sub-pixel rounding
        }
      } finally {
        await browser.teardown();
      }
    } finally {
      await server.close();
    }
  });
});
