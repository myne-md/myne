// A device awaiting approval stays awaiting approval across a refresh (MYND-635).
//
// # The bug this reproduces
//
// Reported live on `app.example.com`. Signing in enrols the browser on the password
// path, which lands **pending** until an already-approved device approves it —
// the only path a browser has, since the self-approving recovery path is
// deliberately absent from this bundle. The wait screen appeared correctly.
// Refreshing the page then asked for the password and opened an **empty vault**,
// with the wait unreachable and nothing saying why.
//
// Nothing about the store looked wrong, which is what made it hard to see:
// `sync_join_account` fetches the account's real `vault.meta` and writes it
// **before** running the enrolment that comes back pending. So the boot probe —
// which routes on `vault.meta` existence — saw an ordinary vault, and the
// password genuinely opened it. It was empty because a pending device holds no
// token and can pull nothing.
//
// # Why this belongs in the WEB lane
//
// `e2e-web/CLAUDE.md`'s rule is web-specific behaviour only: a flow in the
// shared `src/` tree owes one desktop scenario and nothing here. This qualifies
// on the entry path. **Sync-required entry is web-only** — a browser starting
// from an empty origin has no vault to create and must be told which account to
// pull — and the refresh that loses in-page state is a browser event the desktop
// client does not have. The stage routing itself is unit-tested
// (`tests/stage/web-boot-routing.test.ts`); what only a browser can prove is
// that a real reload of a real bundle lands where the routing says.
//
// # Why the state is seeded rather than enrolled
//
// There is no sync server in this lane, so a real join cannot run. The pending
// state is instead written to OPFS as the bytes the client will read: identity
// persisted, endpoint configured, no token. All of it comes from the real
// container writer via `emit-vault-fixture` — `sync-state.json` and
// `sync-config.json` are both double-buffered, so hand-written JSON would be
// unreadable in a way that looks exactly like a device which never enrolled.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
import { loadVaultFixture, seedPendingVault, seedVault } from "./support/opfs-seed";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";

/** Argon2id at the v0.1 baseline is ~0.5 s in a browser; generous rather than
 *  tight, so a slower machine is not a flake. */
const BOOT_TIMEOUT_MS = 30_000;

describeE2E("a device awaiting approval survives a page refresh", () => {
  it("boots to the wait, not to the unlock form", async () => {
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
      await seedPendingVault(session, vault);

      // The refresh, as a fresh load of `/`. Indistinguishable to the client
      // from the reload that produced the report: the worker restarts, the
      // runtime slot is empty, and boot re-reads the store from scratch.
      await session.navigate(`${server.origin}/`);

      await session.waitForElement('[data-testid="account-bootstrap.pending-notice"]', {
        timeoutMs: BOOT_TIMEOUT_MS,
      });

      // The other half of the claim, and the one the bug actually violated: the
      // unlock form must be ABSENT. Asserting only that the wait is present
      // would pass on a screen showing both.
      expect(
        await session.execute<boolean>(
          "return !!document.querySelector('input[type=\"password\"]');",
        ),
        "a pending device must not be offered the unlock form",
      ).toBe(false);

      // Nor the account-number step. That would be the other wrong answer —
      // sending someone back to the start of a flow they finished, where
      // enrolling again mints a fresh device_id and strands a second pending
      // record on the account.
      expect(
        await session.execute<boolean>(
          "return !!document.querySelector('[data-testid=\"account-entry.input\"]');",
        ),
        "a pending device must not be sent back to account entry",
      ).toBe(false);
    } finally {
      await browser?.teardown().catch(() => {});
      await server.close();
    }
  });

  it("the same vault WITHOUT the pending state still boots to unlock", async () => {
    // The pair that gives the scenario above its meaning. Identical bundle,
    // identical `vault.meta`; the only difference is the seeded sync state. A
    // regression that routed every vault to the wait would satisfy the first
    // test and fail this one — and it is the more damaging direction, because it
    // would lock every ordinary user out of their own vault.
    const vault = loadVaultFixture();
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
    try {
      browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      const { session } = browser;

      await session.navigate(`${server.origin}/__seed`);
      await seedVault(session, vault);
      await session.navigate(`${server.origin}/`);

      await session.waitForElement('input[type="password"]', {
        timeoutMs: BOOT_TIMEOUT_MS,
      });
      expect(
        await session.execute<boolean>(
          "return !!document.querySelector('[data-testid=\"account-bootstrap.pending-notice\"]');",
        ),
        "a vault with no enrolment on disk is not awaiting approval",
      ).toBe(false);
    } finally {
      await browser?.teardown().catch(() => {});
      await server.close();
    }
  });
});
