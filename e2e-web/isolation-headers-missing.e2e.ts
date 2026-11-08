// A deployment served without the isolation headers is REFUSED at boot —
// myne-md/myne#556, the `web.deploy.headers-and-isolation` bullet:
//
//   > `securityHeaders()` is a parameter of `e2e-web/support/server.ts`, so a
//   > header-less variant is a one-line fixture; the boot refusal and the
//   > 429-into-`Atomics.wait` consequence against a stub sync origin are
//   > deterministic.
//
// # What goes wrong without the refusal, in the gate's own words
//
// `web/src/environment-gate.ts` spells out why this is a boot-time refusal
// rather than a degraded mode:
//
//   > The backoff sleeps via `Atomics.wait` on a `SharedArrayBuffer`, which is
//   > unavailable without isolation; the Rust side treats that as a hard
//   > failure on purpose (a backoff that does not wait is a hot retry loop
//   > against a server that is already rate-limiting), so the wasm instance
//   > aborts. The page then rejects every later `invoke` with a fatal error for
//   > the rest of its life — no save, no read, no lock — and the aborted
//   > Worker's linear memory, which held the vault keys, stays resident until
//   > the tab is reloaded.
//
// So the failure this prevents is not "a feature is missing". It is a vault
// that opens, accepts typing, silently stops saving, and cannot be locked,
// while the keys sit in a Worker nobody can reach. `myne-agents/docs/self-host-web.md`
// calls this misconfiguration fatal.
//
// # Why nothing was exercising it
//
// Every scenario in this lane is served the correct headers by construction —
// `startBundleServer` calls `securityHeaders()` and always has. The smoke spec
// asserts the headers ARE sent, which is the opposite direction: it proves the
// good path, and a refusal that had quietly stopped working would look exactly
// the same from there.
//
// Making the header set a parameter is what lets a scenario be the
// misconfigured operator instead of only ever being the correct one.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { openApp } from "./support/flows";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
import { testIdSelector } from "./support/session";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";

/** The pair the browser requires before it grants cross-origin isolation. */
const ISOLATION_HEADERS = ["Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy"];

describeE2E("a deployment without the isolation headers", () => {
  it("is refused at boot, naming the missing capability, instead of half-working", async () => {
    const server = await startBundleServer({
      root: BUNDLE_DIR,
      syncOrigin: SYNC_ORIGIN,
      stripHeaders: ISOLATION_HEADERS,
    });
    let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
    try {
      // Asserted over HTTP first, before a browser is involved: if the strip
      // did not take, the browser result below would be a downstream symptom
      // and the message would name the wrong thing. The smoke spec makes the
      // same argument in the other direction.
      const res = await fetch(`${server.origin}/index.html`);
      for (const h of ISOLATION_HEADERS) {
        expect(
          res.headers.get(h.toLowerCase()),
          `the server still sends ${h}, so this scenario is serving a CORRECT ` +
            `deployment and whatever the app does below is the good path`,
        ).toBeNull();
      }

      browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      const { session } = browser;
      await session.navigate(`${server.origin}/`);

      // The browser's own verdict, before the app's. If this were somehow true
      // the refusal would be wrong to demand and the assertion after it would
      // be asserting a bug.
      const isolated = await session.execute<boolean>(
        "return globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';",
      );
      expect(
        isolated,
        "the browser reports cross-origin isolation even with both headers " +
          "stripped — the premise of this scenario does not hold in this seat",
      ).toBe(false);

      // THE assertion: a refusal screen, not the app.
      await session.waitForElement(testIdSelector("web.unsupported-environment"), {
        timeoutMs: 30_000,
      });

      // …and it says WHICH capability is missing, because "this browser is not
      // supported" sends an operator to change browsers when the fix is two
      // response headers on their own server.
      const reasons =
        (await session.execute<string>(
          "return document.querySelector('[data-testid=\"web.unsupported-reasons\"]')?.textContent ?? '';",
        )) ?? "";
      expect(
        reasons.length,
        "the refusal screen lists no reasons, so an operator is told their browser " +
          "is unsupported and given nothing to act on",
      ).toBeGreaterThan(0);
      expect(
        reasons.toLowerCase(),
        `the refusal names no isolation-related reason (it said: ${JSON.stringify(reasons)}). ` +
          `The fix is two response headers on the operator's own server, and a ` +
          `message that does not say so points them at their browser instead.`,
      ).toMatch(/isolat|cross-origin|sharedarraybuffer/);

      // The app must NOT be behind it. A refusal screen rendered ON TOP of a
      // booted app would leave every consequence above intact.
      const appSurfaces =
        (await session.execute<number>(
          "return document.querySelectorAll(" +
            "'[data-testid=\"unlock.password-input\"],[data-testid=\"welcome.root\"],[data-testid=\"editor.bottom-bar\"]'" +
            ").length;",
        )) ?? 0;
      expect(
        appSurfaces,
        "an app surface rendered alongside the refusal, so the environment gate is " +
          "a banner rather than a gate — and everything it exists to prevent is " +
          "still reachable behind it",
      ).toBe(0);
    } finally {
      await browser?.teardown().catch(() => {});
      await server.close();
    }
  });

  it("boots normally when the same server sends them — the control arm", async () => {
    // Without this, a refusal screen that rendered unconditionally would pass
    // the test above and take the whole product down.
    //
    // On its OWN port, i.e. its own ORIGIN — hygiene rather than a fix.
    //
    // Worth saying plainly, because the first explanation written here was
    // wrong and confident: this arm was failing, a shared-origin HTTP cache was
    // blamed, the port was split, and it failed identically. The actual cause
    // was that the hand-rolled boot wait omitted `bootstrap.beta-terms` — a
    // legitimate surface `openApp` exists to walk. The separate origin fixed
    // nothing.
    //
    // It stays because an origin is what OPFS keys a vault by, which
    // `e2e-web/AGENTS.md` calls the more dangerous shared thing in this lane,
    // and two arms of one file asserting opposite boot outcomes should not
    // share one. But it is not load-bearing here, and pretending it was would
    // leave the next reader with a cache theory to chase.
    const server = await startBundleServer({
      root: BUNDLE_DIR,
      syncOrigin: SYNC_ORIGIN,
      port: Number(process.env.MYNE_WEB_E2E_BUNDLE_PORT ?? "4545") + 1,
    });
    let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
    try {
      browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      const { session } = browser;
      await session.navigate(`${server.origin}/`);
      // Over the whole boot set rather than one arm. A clean profile lands on
      // account-entry, a profile that kept an OPFS container from an earlier
      // session lands on unlock, and a bare wait on the first would report "the
      // entry screen never appeared" for a perfectly healthy second case —
      // pointing a reader at the app when the answer is profile reuse.
      // Through the lane's own `openApp`, not a hand-rolled wait. The first
      // version listed the three post-gate surfaces and timed out reporting
      // `bootstrap.beta-terms` — a legitimate boot surface, and one `openApp`
      // exists to walk (review, scroll, accept) precisely because everyone who
      // hand-rolls this wait forgets it. The lane already lost most of its
      // scenarios to that once; its comment says so.
      await openApp(session, server.origin);
      const refused = await session.execute<number>(
        "return document.querySelectorAll('[data-testid=\"web.unsupported-environment\"]').length;",
      );
      expect(
        refused,
        "the environment gate refuses a correctly-served deployment too, so it is " +
          "not a gate — it is an outage",
      ).toBe(0);
    } finally {
      await browser?.teardown().catch(() => {});
      await server.close();
    }
  });
});
