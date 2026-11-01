// axe on the screens only a browser reaches (MYND-574 task 59).
//
// # Why this is not "the desktop a11y suite, again"
//
// `e2e/a11y-axe.e2e.ts` already runs the WCAG 2.2 AA rule set over the shared
// screens (welcome, unlock, the editor, settings, the palette), and both
// clients render that same source. The shared `tests/a11y/axe-config.ts` this
// lane imports raised the bar to 2.2 AA (myne-md/myne#728), so `target-size`
// now applies to the web-only screens below too: that is inherited
// deliberately, and a target-size finding there is in scope for the gate. Re-running it here would be the dual-driving
// this lane exists to avoid (`e2e-web/AGENTS.md`).
//
// What it cannot cover is the set of screens that exist **only** on web:
// account-number entry, the bootstrap password step, the pending-approval wait,
// the storage-lost surfaces, the device-revoked terminal screen, and the
// unsupported-environment refusal. Those were written for this feature, no
// desktop user ever sees them, and several of them are the ones a person reads
// while something has gone wrong — which is the worst moment for a contrast
// failure or an unlabelled control.
//
// The shared axe helper is reused verbatim (`e2e/support/axe.ts`), so the two
// lanes cannot disagree about which rule set "AA" means.
//
// Vault-count precondition: **0**. The screens reachable without a sync server
// are covered here; the post-unlock web-only surfaces are owed to the
// server-backed scenarios.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { openApp } from "./support/flows";
import { DRIVER_PORT } from "./support/worker-ports";
import { formatAxe, runAxeInPage } from "../e2e/support/axe";
import type { SupportedBrowser } from "./support/harness";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";

describeE2E("accessibility on the web-only screens", () => {
  it("axe (incl. contrast) is clean on the browser's front door", async () => {
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    try {
      const browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      try {
        await openApp(browser.session, server.origin);
        await browser.session.byTestId("welcome.root", { timeoutMs: 30_000 });
        const violations = await runAxeInPage(browser.session);
        expect(violations.length, formatAxe(violations)).toBe(0);
      } finally {
        await browser.teardown();
      }
    } finally {
      await server.close();
    }
  });

});
