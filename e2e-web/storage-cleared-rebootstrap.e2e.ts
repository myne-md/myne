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
// The identity ceremony (`welcome.root`), not a data-loss screen and no longer
// the beta-terms gate. Both moved with `decisions/sync/0767`: the account-number
// door is gone, so a cleared origin has no vault AND no person credential to
// resume from, and the gate now guards registration inside the ceremony's create
// step rather than the entry itself. What survives from the original thesis is
// the part that matters: the three doors are offered, so the route back in is
// `restore this identity, accept the invitation`, and nothing on the screen says
// the notes are gone.
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
import { testIdSelector } from "./support/session";

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
  it("lands on the identity ceremony with the storage really empty", async () => {
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

      // WHERE IT LANDS. The identity ceremony, which is this client's front door
      // since the account-number door was withdrawn (`decisions/sync/0767`): an
      // evicted origin holds no vault AND no person credential, so the honest
      // answer is "who is this" rather than "your notes are gone".
      //
      // The beta-terms gate is NOT in front of it any more, and that is the same
      // decision: it guarded registration, and registration now lives inside the
      // ceremony's create step (`PersonRegisterForm`), not ahead of entry. Waiting
      // on the gate would assert a screen the withdrawal deleted.
      //
      // Waited for BY NAME rather than for "something rendered", so a build that
      // routed an empty container to a data-loss screen fails here saying the
      // welcome never appeared.
      await session.waitForElement(testIdSelector("welcome.root"), {
        timeoutMs: 45_000,
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

      // The two doors THIS client has: create (which starts the identity ceremony)
      // and invited. `welcome.restore-cta` is deliberately not asserted: Welcome
      // renders it only when the host passes `onRestoreBackup`, and a browser has
      // no local `.myne-backup` to import, so requiring it would assert a door the
      // client never draws. On this client the vault is not the only copy (the
      // server has one), so recovery is "restore this identity, accept the
      // invitation", which is exactly these two.
      //
      // This used to be the INVERSE assertion - no create door at all - because the
      // door opened the legacy ACCOUNT creation and would have left a user with a
      // second, empty account. `decisions/sync/0767` moved what it opens: the
      // identity ceremony, whose phrase re-derives the same person
      // (`myne.v0.2 argon2id-person-identity`), so it is a way back in rather than
      // a way to a second identity. Asserting its absence would now assert the
      // dead end the withdrawal could have left.
      for (const id of ["welcome.create-cta", "welcome.invited-cta"]) {
        const door = await session.findElements(testIdSelector(id));
        expect(
          door.length,
          `the emptied origin is missing the ${id} door. An evicted origin can only ` +
            `recover by restoring this identity and accepting an invitation, so every ` +
            `door that path needs has to be on the screen it lands on.`,
        ).toBe(1);
      }
    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
