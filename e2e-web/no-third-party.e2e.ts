// Which origins a real session actually contacts, and whether the policy is
// silently absorbing violations (MYND-574 tasks 55 + 60).
//
// # Why a request LOG and not the CSP
//
// "Zero third-party origins" is claimed in the threat model and depended on by
// the CSP. `scripts/check-web-third-party.mjs` pins which origins appear as
// STRINGS in the bundle, which is a surface question and explicitly not a
// reachability one — a URL in a doc-link constant and a URL in a live `fetch()`
// look identical to a grep.
//
// This asks the reachability question the only way it can be asked: run a
// session and read what the browser actually fetched. The Resource Timing API is
// the browser's own record of every subresource it requested — including ones a
// CSP refused, which is what makes it usable as a violation detector as well as
// an inventory.
//
// # Why a CSP violation must FAIL rather than log
//
// A `securitypolicyviolation` in production is a page doing something the policy
// forbids. In the best case it is dead code and the user sees nothing; in the
// worst it is the app's own function being silently broken, and the user sees a
// feature that does not work with no error anywhere. Neither is something to
// discover from a report endpoint later. `docs/self-host-web.md` calls a loose
// policy fatal; this makes a violated one fail the lane.
//
// Vault-count precondition: **0**. A first-run session contacts fewer origins
// than an unlocked one, so this is a floor rather than the whole story — the
// post-unlock inventory is owed to the server-backed scenarios.

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

describeE2E("no third-party origin is contacted, and no CSP rule is violated", () => {
  it("fetches from its OWN origin and nowhere else", async () => {
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    try {
      const browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      try {
        await openApp(browser.session, server.origin);
        await browser.session.byTestId("account-entry.input", { timeoutMs: 30_000 });

        // Every subresource the browser requested, as the browser recorded it.
        const origins = await browser.session.execute<string[]>(
          "return Array.from(new Set(performance.getEntriesByType('resource')" +
            ".map(function (e) { try { return new URL(e.name).origin; } catch (_) { return null; } })" +
            ".filter(Boolean)));",
        );

        // The allowlist is exactly two: this page's own origin, and the sync
        // server the CSP was generated from. Nothing else is legitimate — not a
        // font CDN, not an analytics beacon, not a source map host.
        const allowed = new Set([server.origin, SYNC_ORIGIN]);
        const foreign = origins.filter((o) => !allowed.has(o));
        expect(
          foreign,
          `the session contacted origin(s) outside {self, sync}: ${foreign.join(", ")}`,
        ).toEqual([]);
        // The inventory must not be trivially empty, or an app that fetched
        // nothing at all would satisfy the assertion above.
        expect(origins.length, "no subresources recorded — the probe read nothing").toBeGreaterThan(
          0,
        );
      } finally {
        await browser.teardown();
      }
    } finally {
      await server.close();
    }
  });

  it("records no CSP violation, from the first byte of the boot", async () => {
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    try {
      const browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      try {
        await openApp(browser.session, server.origin);
        await browser.session.byTestId("account-entry.input", { timeoutMs: 30_000 });
        // Reports are POSTed asynchronously; give the browser a beat to flush
        // any it queued during boot before reading.
        await new Promise((r) => setTimeout(r, 750));
        expect(
          server.cspViolations,
          `the page violated its own CSP:\n  ${server.cspViolations.join("\n  ")}`,
        ).toEqual([]);
      } finally {
        await browser.teardown();
      }
    } finally {
      await server.close();
    }
  });
});
