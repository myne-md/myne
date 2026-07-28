// The OPFS fixture seeder, exercised against a real browser
// (phase3-web-client task 105, criterion 5).
//
// # What this proves, and why it is worth its own scenario
//
// The six crash fixtures come from the REAL container writer with the same
// `Fault` injection its unit tests use, so the bytes are trustworthy by
// construction. What was never established is that they SURVIVE the trip into a
// browser: `Uint8Array` round-tripping through a WebDriver script payload,
// nested directory creation in OPFS, and the clearing step that keeps one
// scenario's slots out of the next one's container.
//
// A seeder that silently writes nothing looks exactly like a client that
// handled a crash perfectly. That is the failure this file exists to make
// impossible — every later crash-recovery scenario rests on the seed having
// landed, and none of them can tell the difference on their own.
//
// # Byte equality, not "a file exists"
//
// The assertion is the full byte array, per slot. A seed that wrote a truncated
// or re-encoded slot would produce exactly the condition under test — a torn
// container — and a scenario built on it would "pass" while testing a fault the
// harness invented rather than the one the writer produces.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
import { loadFixtures, seedFixture, readVaultRoot, VAULT_ROOT } from "./support/opfs-seed";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";

describeE2E("the OPFS fixture seeder puts the generator's bytes into a browser", () => {
  it("writes every crash fixture byte-for-byte, and clears the previous one", async () => {
    const fixtures = loadFixtures();
    expect(
      fixtures.length,
      "the lane names six crash states; a different count means the generator and this lane disagree",
    ).toBe(6);

    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
    try {
      browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      const { session } = browser;

      // The blank page on the app's origin. NOT `/` — the app would boot and
      // read the store before a driver could write to it, which is the ordering
      // the whole seeder exists to get right.
      await session.navigate(`${server.origin}/__seed`);

      for (const f of fixtures) {
        await seedFixture(session, f);
        const onDisk = await readVaultRoot(session);

        const seededNames = Object.keys(onDisk).sort();
        const expectedNames = f.files.map((x) => x.name).sort();
        expect(seededNames, `${f.name}: seeded file set`).toEqual(expectedNames);

        for (const file of f.files) {
          expect(onDisk[file.name], `${f.name}: ${file.name} bytes`).toEqual(file.bytes);
        }

        // A fixture that names ONE slot must leave exactly one behind, even
        // though the fixture before it wrote two. This is the clearing step,
        // and without it `stop-before-write` would silently inherit a slot from
        // `steady-state` and stop describing a crash at all.
        expect(seededNames.length, `${f.name}: slot count after clearing`).toBe(f.files.length);
      }

      // The vault root is where the client actually looks — asserted once,
      // explicitly, so a future refactor of the seeder cannot start writing to
      // a path the app never reads while every byte assertion above still
      // passes.
      expect(VAULT_ROOT).toBe("myne/vaults/00000000-0000-7000-8000-ebebebebebeb");
    } finally {
      await browser?.teardown().catch(() => {});
      await server.close();
    }
  });

  it("a seed the app can see: the store is non-empty before the bundle loads", async () => {
    // The ordering claim, made checkable. Seeding on `/__seed` and then loading
    // `/` must leave the app booting onto a store that already has bytes in it;
    // if the seed landed in a different origin's store — the mistake this
    // helper is shaped to prevent — the app would boot onto an empty one and
    // every crash-recovery scenario would quietly become a first-run scenario.
    const fixtures = loadFixtures();
    const steady = fixtures.find((f) => f.name === "steady-state");
    expect(steady, "steady-state fixture").toBeDefined();

    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
    try {
      browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      const { session } = browser;

      await session.navigate(`${server.origin}/__seed`);
      await seedFixture(session, steady!);

      await session.navigate(`${server.origin}/`);
      // Read the store back through the APP's origin after the app has loaded.
      const afterBoot = await readVaultRoot(session);
      expect(
        Object.keys(afterBoot).sort(),
        "the seeded slots must still be there once the bundle is running",
      ).toEqual(steady!.files.map((f) => f.name).sort());
    } finally {
      await browser?.teardown().catch(() => {});
      await server.close();
    }
  });
});
