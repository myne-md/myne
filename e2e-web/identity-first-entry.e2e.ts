// The browser's identity-first create path (myne-md/myne#911 task 13).
//
// # What this proves, and what it deliberately does not
//
// Before task 13 the web client had no identity entry at all: a fresh origin
// booted to account entry, whose "create one" door opened the LEGACY vault
// creation, and an identity could only be added afterwards from Settings. The
// door now opens the first run, and this is the scenario that keeps it open:
// account entry -> the ceremony -> the 24 words with the browser's own caveats.
//
// It stops before vault creation ON PURPOSE. A vault on this client is
// sync-backed (`decisions.md` 2026-07-26), so creation provisions against a
// server and this lane has none; asserting that step here would test the
// failure screen. The vault half is covered by the desktop lane, which has a
// server-building fixture, and by `create-account.e2e.ts`, which owns the
// provisioning ORDER.
//
// # Why the caveat is the second assertion
//
// A browser keeps no person credential at rest (task 13's decision): the sealed
// keypair and the device token live in the Worker's memory, so a reload asks for
// the 24 words again. That is a product promise made on the screen that shows
// the words, and `personCredentialPersisted` being absent is what makes it
// render. An entry that reached the ceremony without it would be a browser
// quietly claiming the phrase is kept.

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

/** Argon2id at the v0.1 baseline plus the identity derivation: the ceremony's
 *  create step is the slowest thing in this lane, and a tight timeout there
 *  flakes on every slower machine. */
const CEREMONY_TIMEOUT_MS = 60_000;

describeE2E("the browser's create door is identity-first", () => {
  it("reaches the identity ceremony and states the session-only cost", async () => {
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
    try {
      browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      const { session } = browser;

      // A clean profile: account entry, the sign-in half of the browser's front
      // door. It stays the PRIMARY door, because a browser is a window onto an
      // account that already exists more often than it is a place to make one.
      await openApp(session, server.origin);
      await session.byTestId("welcome.root", { timeoutMs: 30_000 });

      // The secondary door. Before task 13 this opened vault creation directly
      // and the identity was unreachable from here.
      const create = await session.byTestId("welcome.create-cta");
      await create.scrollIntoView();
      await create.click();

      // The stage, then the ceremony inside it.
      const createCta = await session.byTestId("first-run.identity.create-cta", {
        timeoutMs: 30_000,
      });
      const path = await session.execute<string>("return location.pathname;");
      expect(path, "the create door must address the first-run stage").toBe("/first-run");

      await createCta.click();

      // The identity now exists in the Worker's memory and its phrase is on
      // screen. This is the step that proves the person plane is dispatched in
      // wasm rather than refused: a refused command leaves the panel on its
      // error line.
      await session.byTestId("first-run.identity.phrase", {
        timeoutMs: CEREMONY_TIMEOUT_MS,
      });
      await session.byTestId("first-run.identity.phrase.caveats-session-notice");

      // The words must actually be reachable, not only their container: the
      // reveal control is what a user presses to read them.
      const reveal = await session.findElements('[data-testid="first-run.identity.phrase-reveal"]');
      expect(reveal.length, "the phrase must have a reveal control").toBe(1);
    } finally {
      await browser?.teardown();
      await server.close();
    }
  });
});
