// The browser evicts the origin's storage, and the app asks for the account
// again rather than announcing a loss. myne-md/myne#556, the
// `web.storage.eviction-rebootstrap` bullet:
//
//   > from the app's side an eviction is "every origin store is empty", which
//   > the lane can produce (delete OPFS plus IndexedDB and localStorage, or CDP
//   > `Storage.clearDataForOrigin`); lands on account re-entry, vault returns,
//   > fingerprint compare presented again, no "your notes are gone" copy.
//
// # The walk this retires, and why nobody runs it
//
// Get a browser to evict your origin, then open the app. Eviction is the
// browser's decision, made under storage pressure, on its own schedule — a
// tester cannot produce it on demand and so cannot check what happens after
// it. What they can do is clear site data by hand, which is the same thing from
// the app's side and is exactly what this drives.
//
// # Why the copy is the assertion and not a detail
//
// On this client the vault is not the only copy: the server has one. So an
// evicted origin is a re-bootstrap, not data loss — the user signs in again and
// the vault materialises. The failure this guards is the app treating an empty
// container as a catastrophe and telling the user their notes are gone, which
// on the web client is false and is the single most alarming thing it could
// say. `decisions.md` 2026-07-26 records the same reasoning for a CORRUPT
// container on this client: it routes to account entry rather than to a
// data-loss screen.
//
// The inverse failure is just as real and is asserted too: an empty container
// must not land somewhere that offers to CREATE a vault, because that would
// leave a user with a second, empty account and their notes still on the
// server under the first.
//
// # Where it actually lands, measured
//
// `/account-entry`, showing the BETA-TERMS gate first — not the account form
// directly. That is correct and is asserted rather than stepped over: the
// acceptance was stored on this origin and the eviction took it too, so the
// user is asked again. `AccountBootstrap.tsx` is explicit that this is a gate
// rather than a dialog ("the entry form is not rendered at all until the terms
// are accepted"), so a re-bootstrap that skipped it would mean the acceptance
// had survived a wipe of the origin — the same class of failure as the vault
// surviving it.
//
// # What is NOT asserted, and why
//
// "The vault returns" and "the fingerprint compare is presented again" both
// need a sync server, which this lane does not have — `e2e-web/AGENTS.md` lists
// first-sync as outstanding for that reason. What is here is everything up to
// that boundary: the storage is really empty, the app boots, and it asks for
// the account. The rest belongs with the sync fixture when one exists.
//
// # Chromium only
//
// `Storage.clearDataForOrigin` is CDP. The scenario self-skips on Firefox
// naming why — `support/cdp.ts` carries the rule. Clearing OPFS from the page
// instead would be weaker: it would leave IndexedDB and localStorage behind, so
// it would test "OPFS is gone" rather than "the origin was evicted", and those
// are different app states.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault } from "./support/fixture-session";
import { cdp, supportsCdp } from "./support/cdp";
import { harnessEnv, type SupportedBrowser } from "./support/harness";
import type { Session } from "./support/session";

/** Everything the app could have stored on this origin. */
const STORAGE_TYPES = "appcache,cookies,file_systems,indexeddb,local_storage,shader_cache,websql,service_workers,cache_storage";

/** Top-level OPFS entries, so "empty" is measured rather than assumed. */
async function opfsEntries(session: Session): Promise<string[]> {
  const raw = await session.executeAsync<string>(
    "var done = arguments[arguments.length - 1];" +
      "(async function () {" +
      "  try {" +
      "    var root = await navigator.storage.getDirectory();" +
      "    var names = [];" +
      "    for await (var name of root.keys()) names.push(name);" +
      "    names.sort();" +
      "    done(JSON.stringify(names));" +
      "  } catch (e) {" +
      "    done('ERR:' + String(e));" +
      "  }" +
      "})();",
  );
  if (raw.startsWith("ERR:")) {
    throw new Error(
      `could not enumerate OPFS: ${raw.slice(4)}. The emptiness of this store IS ` +
        `the precondition, so an unreadable root is a failure rather than an empty ` +
        `result.`,
    );
  }
  return JSON.parse(raw) as string[];
}

describeE2E("an evicted origin re-bootstraps instead of reporting a loss", () => {
  it("lands on account entry with the storage really empty", async () => {
    const browser = harnessEnv().browser as SupportedBrowser;
    if (!supportsCdp(browser)) {
      expect(
        browser,
        "this scenario needs CDP (Storage.clearDataForOrigin) and only Chromium " +
          "has it — see support/cdp.ts. Nothing is asserted on this engine.",
      ).not.toBe("chrome");
      return;
    }

    const ctx = await openFixtureVault();
    try {
      const { session } = ctx;

      // NON-VACUITY: there is something to evict. "The app asks for an account
      // when the store is empty" is trivially true of a browser that never held
      // a vault, and this lane's seeding is exactly the step that can silently
      // write nothing (`opfs-seed.e2e.ts` exists for that).
      const before = await opfsEntries(session);
      expect(
        before.length,
        `the OPFS root is already empty before the eviction, so this scenario would ` +
          `be booting a browser that never had a vault and calling the result a ` +
          `re-bootstrap. The fixture did not land.`,
      ).toBeGreaterThan(0);

      const origin = await session.execute<string>("return location.origin;");
      await cdp(session, browser, "Storage.clearDataForOrigin", {
        origin,
        storageTypes: STORAGE_TYPES,
      });

      // Reload onto the emptied origin — the state a user meets after the
      // browser reclaimed the space while the tab was closed.
      await session.execute("window.location.reload();");

      // WHERE IT LANDS. The bootstrap gate, not a data-loss screen and not the
      // Welcome create screen — measured: the route is `/account-entry` and the
      // first thing rendered is the beta-terms gate.
      //
      // The terms gate appearing is CORRECT and is asserted rather than
      // stepped over: the acceptance was stored on this origin and the eviction
      // took it with everything else, so the user is asked again. Its own
      // comment is explicit that this is a gate rather than a dialog — "the
      // entry form is not rendered at all until the terms are accepted. A
      // dismissable dialog in front of a live form would be a route past the
      // gate, not a gate." A re-bootstrap that skipped it would mean the
      // acceptance had survived a wipe of the origin, which is the same class
      // of failure as the vault surviving it.
      // Waited for BY NAME rather than for "something rendered", so a build that
      // routes an empty container to the Welcome/create screen fails here saying
      // the bootstrap gate never appeared — verified by injecting exactly that
      // into `initialStageFromProbe`.
      await session.waitForElement('[data-testid="bootstrap.beta-terms"]', {
        timeoutMs: 45_000,
      });
      const route = await session.execute<string>("return location.pathname;");
      expect(
        route,
        `the emptied origin booted to ${route}. It must reach the account-entry ` +
          `route: on this client the vault is not the only copy, so an evicted ` +
          `origin is somebody signing back in.`,
      ).toBe("/account-entry");

      // Through the gate, the way a user goes through it.
      await session.execute(
        "document.querySelector('[data-testid=\"bootstrap.beta-terms.open\"]').click();",
      );
      await session.waitForElement('[data-testid="sync.beta-terms.accept"]', {
        timeoutMs: 15_000,
      });
      await session.execute(
        "document.querySelector('[data-testid=\"sync.beta-terms.accept\"]').click();",
      );

      // …and the account form is what is behind it.
      await session.waitForElement('[data-testid="account-entry.input"]', {
        timeoutMs: 30_000,
      });

      // …and the storage really is empty, checked AFTER the boot so the
      // assertion covers what the app itself found rather than what CDP
      // reported. A container the app recreated on boot is fine; a vault
      // surviving the clear is not.
      const after = await opfsEntries(session);
      const survivors = after.filter((name) => name.startsWith("myne/vaults/"));
      expect(
        survivors,
        `the eviction left ${JSON.stringify(survivors)} under myne/vaults/, so the ` +
          `app reached account entry with a vault still on disk. Either the clear ` +
          `did not cover OPFS or the routing is not reading the container it thinks ` +
          `it is — and a user who signs in again would then have two.`,
      ).toEqual([]);

      // The inverse failure. An empty container on this client is a re-bootstrap,
      // and offering to CREATE one would leave the user with a second, empty
      // account while their notes sit on the server under the first. The Welcome
      // screen's create CTA is the surface that must NOT be what answered.
      const created = await session.findElements('[data-testid="welcome.create-cta"]');
      expect(
        created.length,
        `the emptied origin landed on a screen offering to create a new vault. On ` +
          `this client the vault is not the only copy — the server has one — so an ` +
          `evicted origin is somebody signing back in, not somebody starting over.`,
      ).toBe(0);
    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
