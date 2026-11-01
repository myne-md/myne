// One tab per container, proved in a browser (#254).
//
// This is web-specific by construction: it exists because a browser lets the
// user open the same origin twice, and OPFS has no cross-context write
// coordination. `web/src/vault-lock.ts` was written for that — and for months
// nothing imported it, so the guarantee it describes did not exist. Its lock
// name was not even in the shipped bundle.
//
// A unit test can drive the lock module with a fake `LockManager`, and one
// does. What it cannot do is answer the question that made this a defect: does
// a SECOND real browsing context on this origin get refused? That needs two
// contexts, which is what this scenario has.
//
// Vault-count precondition: **0** — a clean profile. The lock is taken before
// anything opens a container, so the refusal is observable on the first-run
// surface with no server and no account.

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

describeE2E("single-tab vault lock", () => {
  it("refuses a second tab on the same origin instead of writing alongside it", async () => {
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    try {
      const browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      try {
        // Tab one boots normally and takes the lock.
        await openApp(browser.session, server.origin);
        await browser.session.byTestId("welcome.root", { timeoutMs: 30_000 });

        const first = await browser.session.windowHandle();

        // Tab two, same browser profile — therefore the same agent cluster, the
        // same origin, and the same OPFS container. Web Locks scopes to exactly
        // that, which is why this is the pair that matters (two separate browser
        // profiles are two containers and must BOTH work).
        await browser.session.newWindow();
        // `navigate`, NOT `openApp`. `openApp` waits for one of the three
        // ADMITTED surfaces (account entry / unlock / editor), and a refused
        // tab renders none of them — it renders the refusal below. So calling
        // it here waited 30 s for a state this tab is defined never to reach,
        // and the scenario failed on its own precondition rather than on the
        // thing it asserts. The refusal testid IS this tab's boot completion.
        await browser.session.navigate(server.origin);

        const refusal = await browser.session.byTestId("web.vault-open-elsewhere", {
          timeoutMs: 30_000,
        });
        expect(refusal, "the second tab must be refused, not admitted").toBeTruthy();

        // Still held by tab one, so no reload CTA yet: the button appears on
        // the lock's release edge, not on arrival. Offering it while the other
        // tab is alive is a button the user presses five times.
        const freed = await refusal.attribute("data-freed");
        expect(freed, "the lock is still held by the first tab").toBe("false");
        const cta = await browser.session.byTestIdAll("web.vault-open-elsewhere-reload");
        expect(cta.length, "no reload offer while the vault is genuinely open").toBe(0);

        // The first tab must be unaffected — the refusal is the second tab's
        // outcome, never a takeover that would strand the tab holding the lock.
        await browser.session.switchToWindow(first);
        const stillThere = await browser.session.byTestIdAll("welcome.root");
        expect(stillThere.length, "the holding tab keeps working").toBeGreaterThan(0);
      } finally {
        await browser.teardown();
      }
    } finally {
      await server.close();
    }
  });
});
