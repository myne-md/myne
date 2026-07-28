// Reaching an unlocked vault with NO sync server (phase3-web-client tasks 87 + 105).
//
// # The precondition this unblocks
//
// The web client is sync-required for SIGN-IN, and that has kept every
// post-unlock surface out of CI: there is no sync server in the lane, so there
// was no way to get past the account-entry screen. But **unlock does not need a
// server** — it reads `vault.meta`, derives a key with Argon2id, and never
// makes a request. Seeding a real `vault.meta` is therefore the whole
// difference between "the lane can test first-run screens" and "the lane can
// test the app".
//
// That is what makes task 87's conflict and quarantine surfaces reachable here:
// their commands answer `[]` with no vault open, so asserting anything about
// them requires an unlocked one.
//
// # Why the fixture is minted by Rust rather than written here
//
// `core/examples/emit-vault-fixture.rs` drives the app's own vault-creation
// path and frames the result with the app's own container writer. A
// `vault.meta` assembled in TypeScript would encode a second opinion about a
// 345-byte layout AND about the 8-byte generation frame around it — and a
// fixture that drifted would have this lane testing an unlock of something
// production never writes.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
import { loadVaultFixture, seedVault } from "./support/opfs-seed";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";

/** Argon2id at the v0.1 baseline is ~0.5 s in a browser, and the unlock screen
 *  does other work around it. Generous rather than tight: a timeout tuned to
 *  one machine turns into a flake on every slower one. */
const UNLOCK_TIMEOUT_MS = 30_000;

describeE2E("a seeded vault.meta reaches an unlocked vault with no sync server", () => {
  it("boots to unlock rather than first-run, and unlocks", async () => {
    const vault = loadVaultFixture();
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
    try {
      browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      const { session } = browser;

      // Seed on the blank page — on `/` the app has already probed the store.
      await session.navigate(`${server.origin}/__seed`);
      await seedVault(session, vault);

      await session.navigate(`${server.origin}/`);

      // The boot probe's answer, read from the ROUTE rather than from any
      // internal state: `Missing` routes to account entry, `Exists` to unlock.
      // A seeded store that still routed to account entry would mean the probe
      // never saw the bytes — the exact failure the seeder's ordering exists to
      // prevent, and one no byte assertion can catch.
      const unlockField = await session.waitForElement('input[type="password"]', {
        timeoutMs: UNLOCK_TIMEOUT_MS,
      });
      // The route is read through the page rather than a driver getter: the
      // shared W3C client has `navigate` but no URL read, and adding one for a
      // single assertion would widen the client for a test's convenience.
      expect(await session.execute<string>("return location.pathname;")).toContain("/unlock");

      await unlockField.sendKeys(vault.password);
      const submit = await session.findElement('[data-testid="unlock.submit"]');
      await submit.click();

      // Unlocked = the VAULT SHELL, waited on positively. "The password field
      // went away" is also what a crash looks like, and this lane has already
      // seen the shape: an unported command made a fully working unlock land on
      // the fail-closed screen, which has no password field either.
      //
      // The bottom bar rather than the editor: the fixture vault holds no
      // notes, so nothing mounts CodeMirror — waiting on `.cm-content` would
      // fail against a perfectly unlocked vault, and did.
      try {
        await session.waitForElement('[data-testid="editor.bottom-bar"]', {
          timeoutMs: UNLOCK_TIMEOUT_MS,
        });
      } catch (e) {
        const diag = await session.execute<string>(
          "return document.body.innerText.slice(0, 300) + ' || path=' + location.pathname;",
        );
        throw new Error(`${(e as Error).message}\nPAGE: ${diag}`);
      }
      // The ROUTE is deliberately not asserted here. On a vault with notes the
      // unlock lands on `/editor/<uuid>`; this fixture holds none, so there is
      // no note to route to and the path stays `/unlock` while the shell is
      // mounted and usable. Asserting the route would encode the
      // has-notes case as though it were the only one — and the shell is the
      // claim this scenario makes.
      expect(
        await session.execute<boolean>(
          "return !!document.querySelector('[data-testid=\"editor.bottom-bar\"]');",
        ),
        "the vault shell is mounted",
      ).toBe(true);
    } finally {
      await browser?.teardown().catch(() => {});
      await server.close();
    }
  });
});
