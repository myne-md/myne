// Two vault containers under one origin (myne-md/myne#911 task 13).
//
// # What this scenario is for
//
// The web client used to answer with ONE fixed vault id, so a browser could hold
// exactly one vault. `discover_vaults_via_io` is the walk that replaced that, and
// this is the only lane that can prove it against the real OPFS: seed two
// containers, boot, and expect the picker with both of them listed.
//
// # Why it asserts the ROUTE first and the row count second
//
// `picker` is the boot decision for two vaults and `unlock` is the decision for
// one (`client-core/src/stage-decision.ts`), so the route alone says which count
// the boot probe got. The row count then says the picker rendered the two
// containers rather than one container plus a stray.
//
// # The trap this scenario exists to keep out, and it caught it once
//
// A previous run reported the boot probe seeing one container while the Unlock
// screen's own `listVaults()` saw two. It did not: `unlock.back-to-picker` used
// to be gated on >=2 vaults and has not been since myne-md/myne#411, so its
// presence said nothing about the list. The real cause was that the bundle under
// test carried a **stale `web/wasm/pkg`** built five days before the walk landed:
// `pnpm web:build` compiles the TS and bundles the PREBUILT wasm, so a `cargo`
// change to the wasm entry surface needs `scripts/build-wasm.sh` first. With the
// wasm rebuilt, the boot probe finds both containers and this scenario passes on
// the first try.
//
// So the assertion below is about the app, and the build note above is about how
// a green web lane can be measuring last week's binary.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
import { loadVaultFixture, seedVaultAt, VAULT_ROOT } from "./support/opfs-seed";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";

/** A second container beside the fixed one. A valid UUIDv7 on purpose: the walk
 *  parses every directory name as a `VaultId`, and `VaultId::parse` accepts only
 *  version 7, so a hand-made id with a `4` in the version nibble would be
 *  skipped silently and this scenario would be measuring the fixture instead of
 *  the client. */
const SECOND_ROOT = "myne/vaults/00000000-0000-7000-8000-000000000002";

const BOOT_TIMEOUT_MS = 30_000;
const ROW_TIMEOUT_MS = 15_000;

/** The boot surface the app landed on, read from the address bar. The web client
 *  keeps its route in the URL, so this is its own answer rather than a guess
 *  from a DOM coincidence. */
async function bootRoute(session: {
  execute<T>(script: string): Promise<T>;
}): Promise<string> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const path = await session.execute<string>("return location.pathname;");
    if (path === "/picker" || path === "/unlock" || path === "/account-entry") {
      return path;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return await session.execute<string>("return location.pathname;");
}

/** Every entry under a path in OPFS, as `name:kind`. Read from the PAGE, which
 *  is the half of the assertion the app cannot fake: the client's walk may only
 *  be told about entries that really exist. */
async function listOpfsDir(
  session: { executeAsync<T>(script: string, args?: unknown[]): Promise<T> },
  path: string,
): Promise<string[]> {
  return session.executeAsync<string[]>(
    `
    const done = arguments[arguments.length - 1];
    const root = arguments[0];
    (async () => {
      try {
        const opfs = await navigator.storage.getDirectory();
        let dir = opfs;
        for (const p of root.split("/")) {
          if (!p) continue;
          dir = await dir.getDirectoryHandle(p);
        }
        const out = [];
        for await (const [name, h] of dir.entries()) out.push(name + ":" + h.kind);
        out.sort();
        done(out);
      } catch (e) {
        done([]);
      }
    })();
    `,
    [path],
  );
}

describeE2E("two vault containers under one origin", () => {
  it("boots to the picker with both vaults listed", async () => {
    const vault = loadVaultFixture();
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
    try {
      browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      const { session } = browser;

      // Seed on a page that is not the app's, then navigate, so the boot probe
      // runs against a store that already holds both containers.
      await session.navigate(`${server.origin}/__seed`);
      await seedVaultAt(session, VAULT_ROOT, vault);
      await seedVaultAt(session, SECOND_ROOT, vault);

      const containers = await listOpfsDir(session, "myne/vaults");
      expect(
        containers,
        "the page must see both seeded containers as directories",
      ).toEqual(
        [
          `${VAULT_ROOT.split("/").pop()}:directory`,
          `${SECOND_ROOT.split("/").pop()}:directory`,
        ].sort(),
      );

      await session.navigate(`${server.origin}/`);
      const route = await bootRoute(session);
      expect(route, "boot must choose the picker for two vaults").toBe("/picker");

      // The picker paints after the route, so the row count is polled rather
      // than read once: a count taken on the frame the route lands is a race,
      // and a race that fails low reads as "the walk found nothing".
      const deadline = Date.now() + ROW_TIMEOUT_MS;
      let rows = 0;
      while (Date.now() < deadline) {
        rows = await session.execute<number>(
          `return document.querySelectorAll('[data-testid="picker.vault-row"]').length;`,
        );
        if (rows >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(rows, "the picker must list both containers").toBe(2);

      // A reload must land on the picker again with both rows: the containers
      // are OPFS state, not session state, and the boot probe is the only thing
      // that decides where a new document starts (the acceptance line this
      // scenario exists for).
      await session.navigate(`${server.origin}/`);
      expect(await bootRoute(session), "a reload must reach the picker too").toBe("/picker");
      await session.waitForElement('[data-testid="picker.vault-row"]', {
        timeoutMs: ROW_TIMEOUT_MS,
      });

      // And a row must open THAT vault: the picker is pre-unlock, so the only
      // thing a click may do is address the unlock screen by vault id.
      const rowsNow = await session.findElements('[data-testid="picker.vault-row"]');
      expect(rowsNow.length, "the reloaded picker lists both").toBe(2);
      await rowsNow[0].click();
      const unlockDeadline = Date.now() + BOOT_TIMEOUT_MS;
      let unlockPath = "";
      while (Date.now() < unlockDeadline) {
        unlockPath = await session.execute<string>("return location.pathname;");
        if (unlockPath === "/unlock") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(unlockPath, "a picker row must open the unlock screen").toBe("/unlock");
    } finally {
      await browser?.teardown();
      await server.close();
    }
  });
});
