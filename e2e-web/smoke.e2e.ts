// The web lane's first real scenario (MYND-574 task 105).
//
// It proves the lane and the app's front door together: the bundle server sends
// the PRODUCTION security headers, a browser loads what it serves, and the boot
// probe reaches a screen a user could act on.
//
// The CSP assertion is not decoration. `support/server.ts` deliberately serves
// through `securityHeaders()` from `web/csp.ts` rather than a copy, and this is
// the check that the wiring survived — a lane running against headers looser
// than production would go green on precisely the misconfiguration
// `myne-agents/docs/self-host-web.md` calls fatal.
//
// Vault-count precondition: **0** — a clean browser profile with no OPFS
// container, which is the state the first-run flow is specified against.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { openApp } from "./support/flows";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
/** A syntactically valid sync origin. Nothing is fetched from it here; it is the
 *  value the CSP's `connect-src` is generated from, which is what is asserted. */
const SYNC_ORIGIN = "https://sync.example.test";

describeE2E("web lane smoke", () => {
  it("serves the production headers and boots to a screen the user can act on", async () => {
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    try {
      // Asserted over HTTP before a browser is involved: if the headers are
      // wrong, a browser failure would be a downstream symptom and the message
      // would name the wrong thing.
      const res = await fetch(`${server.origin}/index.html`);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain(SYNC_ORIGIN);
      // The two headers cross-origin isolation needs. Without them
      // `SharedArrayBuffer` is undefined and the sync backoff's blocking waiter
      // cannot exist — a failure that would surface much later as a hang.
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(res.headers.get("cross-origin-embedder-policy")).toBe("require-corp");

      const browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      try {
        // `openApp` waits for whichever boot surface renders and names the set
        // it watched if none does — so a boot that dies reports which three
        // screens never appeared rather than one arbitrary arm of the fork.
        await openApp(browser.session, server.origin);
        // A clean profile has no OPFS container, so the boot probe must land on
        // the first-run identity step. Landing on `unlock` here would mean the
        // profile was not clean — the isolation bug this lane cannot tolerate,
        // and the reason it is asserted rather than assumed.
        await browser.session.byTestId("welcome.root", { timeoutMs: 30_000 });
      } finally {
        await browser.teardown();
      }
    } finally {
      await server.close();
    }
  });
});
