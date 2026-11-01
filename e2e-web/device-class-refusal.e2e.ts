// The web client refuses phones and tablets — and still boots in a narrow
// desktop window.
//
// These two scenarios pull in opposite directions on purpose, and keeping them
// in one file is the point: the cheap way to refuse a phone is a width check,
// and a width check refuses a desktop window snapped to a quarter of the screen.
// `environment-gate.ts` therefore reads the primary POINTER and the platform's
// own mobile boolean, never a dimension, and this file is where that holds or
// does not.
//
// Why it belongs to this lane rather than the desktop one: the refusal exists
// only in the browser, and the signals it reads (`(pointer: coarse)`,
// `navigator.userAgentData.mobile`) are things only a real browser produces.
// `tests/web/environment-gate.test.ts` pins the DECISION against hand-written
// signal rows; hand-written rows cannot tell you whether a browser under touch
// emulation actually reports what the table assumes.
//
// **Chrome only.** Mobile emulation is a chromedriver capability; geckodriver
// has no equivalent, and safaridriver drives the user's own browser. So on
// Firefox the refusal scenario skips rather than pretending — see the guard
// below. The viewport half runs everywhere.
//
// Vault-count precondition: **0**. The refusal lands before anything mounts, and
// the boot check only needs the first-run screen, so neither scenario needs a
// sync server.

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

/** The narrow end of the supported range: a desktop window snapped to a quarter
 *  of a 1600 display. Same width `isolation-and-viewport.e2e.ts` sweeps. */
const SNAPPED_DESKTOP: readonly [number, number] = [400, 900];

describeE2E("device-class refusal", () => {
  it.skipIf(BROWSER !== "chrome")(
    "refuses an emulated phone, before the app mounts",
    async () => {
      const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
      try {
        const browser = await newBrowserSession({
          baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
          browser: BROWSER,
          emulateMobile: true,
        });
        try {
          await browser.session.navigate(server.origin);

          // Deliberately NOT `openApp`: that helper waits for the first-run
          // screen, and the whole assertion here is that the first-run screen
          // never arrives.
          const refusal = await browser.session.byTestId("web.unsupported-environment", {
            timeoutMs: 30_000,
          });
          expect(refusal).toBeTruthy();

          // WHICH refusal. A phone shown the capability heading reads it as a
          // browser problem and goes looking for a different browser. Read as a
          // discriminator rather than as heading TEXT: the runner's browser
          // decides the language, and this assertion must not depend on it.
          // The wording itself is pinned by
          // `tests/web/unsupported-environment.test.tsx`.
          expect(await refusal.attribute("data-refusal")).toBe("device-class");

          // Nothing mounted. The gate's guarantee is its ORDERING — refusal
          // before any Worker starts and any derivation is attempted — so the
          // app surfaces must be absent, not merely hidden.
          for (const id of ["welcome.root", "unlock.password-input", "editor.root"]) {
            expect(
              (await browser.session.byTestIdAll(id)).length,
              `${id} rendered on a device that was refused`,
            ).toBe(0);
          }
        } finally {
          await browser.teardown();
        }
      } finally {
        await server.close();
      }
    },
  );

  // The regression the refusal design is shaped to avoid. `isolation-and-viewport`
  // resizes an ALREADY-BOOTED app; this one boots INTO the narrow window, which
  // is the only way a gate that ran at boot could refuse it.
  it("boots normally in a quarter-screen desktop window", async () => {
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    try {
      const browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      try {
        const [width, height] = SNAPPED_DESKTOP;
        await browser.session.send("POST", "/window/rect", { width, height, x: 0, y: 0 });
        // Resolves only on a first-run/unlock/editor surface, so a refusal
        // screen fails it by timing out rather than by passing quietly.
        await openApp(browser.session, server.origin);
        expect((await browser.session.byTestIdAll("web.unsupported-environment")).length).toBe(0);
      } finally {
        await browser.teardown();
      }
    } finally {
      await server.close();
    }
  });
});
