// Deleting the vault in a browser really removes it, and says the right thing
// first. myne-md/myne#556, the `vault.delete` bullet:
//
//   > the disclosure is testid-reachable, and enumerating
//   > `navigator.storage.getDirectory()` from the page answers "no OPFS
//   > container remains" deterministically (where `estimate()` would be
//   > flaky); the reload-then-sign-in leg mirrors `unlock-from-fixture.e2e.ts`.
//
// # The walk this retires
//
// Delete the vault, then go looking for whether it is actually gone. On the
// desktop that is a directory listing; in a browser it is a devtools panel most
// people cannot read, showing a quota number that is cached, rounded and padded
// for privacy. A tester's honest answer to "is it gone" is "the app says so",
// which is exactly the claim under test.
//
// # Why enumeration and not `estimate()`
//
// `StorageManager.estimate()` reports a deliberately imprecise number — padded
// against fingerprinting, updated lazily, and quantised — so an assertion built
// on it is either loose enough to pass with the vault still there or tight
// enough to flake. `navigator.storage.getDirectory()` hands back the real OPFS
// root, and its entries are the ground truth: either the container is in the
// listing or it is not.
//
// # The two halves, and why the copy half is not decoration
//
// **1. The disclosure.** On this client the vault is NOT the only copy — the
// server has one — so `localOnlyVault` is absent from the capability descriptor
// and the confirmation must say the erase is LOCAL. Getting that backwards is
// not a wording nit: a user told "this permanently deletes your notes" on a
// client where it does not is being lied to about the one thing they came to
// that screen to be sure of, and a user told "this only removes it from this
// browser" on a client where it is the only copy loses everything. The literal
// lives in `src/lib/load-bearing-copy.ts` precisely so it can be asserted by
// FULL equality rather than by "contains the word local".
//
// **2. The erase.** Type the confirmation, submit, and enumerate OPFS.
//
// # Non-vacuity, and the granularity that took two runs to get right
//
// The tree is enumerated BEFORE the delete as well, and the vault subtree has to
// be there. "Nothing is left" is trivially true of a store that never held
// anything — and this lane's fixture seeding is exactly the kind of step that
// can silently write nothing, which is why `opfs-seed.e2e.ts` exists at all.
//
// The first version compared whole top-level listings and FAILED, reporting
// `["myne","myne-config"]` as survivors. They are not: they are the container
// scaffolding and are correctly untouched. Measured, walking four levels:
//
//   before:  myne, myne-config, myne/vaults,
//            myne/vaults/<id>, myne/vaults/<id>/notes,
//            myne/vaults/<id>/quarantine/<note>.myn.a,
//            myne/vaults/<id>/vault.meta.a
//   after:   myne, myne-config, myne/vaults
//
// So the assertion is about the `myne/vaults/` SUBTREE, and it is paired with
// the opposite one — the container must still exist. Absence alone would also
// be satisfied by something having wiped the whole origin, and "deleted one
// vault" and "destroyed the store" must not look the same to this test.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault, openSettingsTab } from "./support/fixture-session";
import { LOCAL_ERASE_DISCLOSURE } from "../src/lib/load-bearing-copy";
import type { Session } from "./support/session";
import { testIdSelector } from "./support/session";

/** What the confirmation input demands. `DeleteVaultConfirmForm`'s own
 *  constant; typing anything else leaves the submit disabled. */
const CONFIRM_PHRASE = "DELETE";

/** Where a vault's container sits inside the origin's OPFS root. Measured:
 *  before the delete the tree holds `myne`, `myne-config`, `myne/vaults` and
 *  `myne/vaults/<id>/…`; after it, the first three. */
const VAULTS_PREFIX = "myne/vaults";

/** Top-level OPFS entry names, sorted. The vault container is one of them. */
async function opfsEntries(session: Session): Promise<string[]> {
  const raw = await session.executeAsync<string>(
    "var done = arguments[arguments.length - 1];" +
      "(async function () {" +
      "  try {" +
      "    var root = await navigator.storage.getDirectory();" +
      "    var names = [];" +
      "    async function walk(dir, prefix, depth) {" +
      "      for await (var entry of dir.values()) {" +
      "        var path = prefix + entry.name;" +
      "        names.push(path);" +
      "        if (entry.kind === 'directory' && depth > 0) {" +
      "          await walk(entry, path + '/', depth - 1);" +
      "        }" +
      "      }" +
      "    }" +
      "    await walk(root, '', 4);" +
      "    names.sort();" +
      "    done(JSON.stringify(names));" +
      "  } catch (e) {" +
      "    done('ERR:' + String(e));" +
      "  }" +
      "})();",
  );
  if (raw.startsWith("ERR:")) {
    throw new Error(
      `could not enumerate OPFS: ${raw.slice(4)}. This scenario's whole assertion is ` +
        `the directory listing, so an unreadable root is a failure rather than an ` +
        `empty result.`,
    );
  }
  return JSON.parse(raw) as string[];
}

describeE2E("deleting the vault erases the OPFS container", () => {
  it("shows the local-erase disclosure and leaves no container behind", async () => {
    const ctx = await openFixtureVault();
    try {
      const { session } = ctx;

      // NON-VACUITY, and at the right granularity. The vault lives under
      // `myne/vaults/<id>/`, so "nothing is left" has to be asserted about THAT
      // subtree — the first version of this compared whole top-level listings
      // and failed on `myne` and `myne-config`, which are the container
      // scaffolding and are correctly untouched.
      const before = await opfsEntries(session);
      const vaultBefore = before.filter((name) => name.startsWith(`${VAULTS_PREFIX}/`));
      expect(
        vaultBefore.length,
        `nothing exists under ${VAULTS_PREFIX}/ BEFORE the delete ` +
          `(root holds ${JSON.stringify(before)}), so the assertion after it would ` +
          `hold on a browser that had never opened a vault. The fixture did not land.`,
      ).toBeGreaterThan(0);

      await openSettingsTab(session, "settings.tab-vault");
      // The erase CTA is the Vault panel's `danger` topic (myne-md/myne#885);
      // only the active topic's body is mounted.
      await session.execute(
        "document.querySelector('[data-testid=\"settings.vault-tab-danger\"]').click();",
      );
      // No reveal CTA since myne-md/myne#1020: the typed-confirmation field is on
      // screen in the danger topic, and the desktop scenarios wait on the same
      // testid. Clicking a control that no longer exists null-dereferences inside
      // the page and fails the scenario before any OPFS assertion runs, which reads
      // as a broken client rather than a stale test (myne-md/myne#1022 review).
      await session.waitForElement(testIdSelector("delete-vault.confirm-input"), {
        timeoutMs: 15_000,
      });

      // THE COPY, by full-literal equality. The web client's vault is not the
      // only copy, so `localOnlyVault` is absent and this branch must render —
      // the opposite branch would be telling the user their notes are about to
      // be destroyed everywhere, which on this client is false.
      const disclosure = await session.waitForElement(
        testIdSelector("delete-vault.local-erase-disclosure"),
        { timeoutMs: 15_000 },
      );
      expect(
        (await disclosure.text()).trim(),
        `the local-erase disclosure does not match its constant in ` +
          `src/lib/load-bearing-copy.ts. That literal is the guarantee, not a ` +
          `description of it: a paraphrase that drifts is a different promise, and ` +
          `this is the screen where the user decides whether their notes survive.`,
      ).toBe(LOCAL_ERASE_DISCLOSURE.trim());

      const input = await session.byTestId("delete-vault.confirm-input");
      await input.sendKeys(CONFIRM_PHRASE);
      await session.execute(
        "document.querySelector('[data-testid=\"delete-vault.submit\"]').click();",
      );

      // The app routes away from the editor on success. Waiting for THAT rather
      // than sleeping is what makes the enumeration below a measurement of a
      // finished delete instead of a race with one in flight.
      await session.waitForGone(testIdSelector("editor.bottom-bar"), {
        timeoutMs: 30_000,
      });

      const after = await opfsEntries(session);
      const vaultAfter = after.filter((name) => name.startsWith(`${VAULTS_PREFIX}/`));
      expect(
        vaultAfter,
        `deleting the vault left ${JSON.stringify(vaultAfter)} under ` +
          `${VAULTS_PREFIX}/. The app routed away from the editor, so from the ` +
          `user's side the vault is gone; the bytes are not. On a shared or borrowed ` +
          `browser that is the whole difference between "I removed my notes from ` +
          `this machine" and believing so.`,
      ).toEqual([]);

      // …and the CONTAINER is still there, which is correct and is asserted so
      // that "the delete works" cannot be satisfied by something having wiped
      // the origin wholesale. A delete that took the whole store with it would
      // also leave nothing under the prefix.
      expect(
        after,
        `the vault container ${VAULTS_PREFIX} is gone from OPFS entirely (root now ` +
          `holds ${JSON.stringify(after)}). Deleting one vault must remove that ` +
          `vault, not the store it lives in — and an assertion that only looked for ` +
          `absence would read this as success.`,
      ).toContain(VAULTS_PREFIX);

    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
