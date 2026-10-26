// The identity-phrase door on a person-wrapped vault, in a browser
// (myne-md/myne#911 task 13).
//
// # The gap this closes
//
// The browser can CREATE a person-born (`NTV7`) vault through the identity
// ceremony, and that vault's own recovery phrase does not exist: the phrase that
// opens it is the account's. Both commands behind that door
// (`vault_is_person_wrapped` and `unlock_with_person_phrase`) existed in core as
// `*_from_host` functions, but neither was classified in the wasm router, so the
// `vault-unlock` plugin default (`Pending`) refused them. The visible result: a
// browser user who forgot the password of a vault they made in the browser had
// no in-page way back in, and the screen silently offered the LEGACY recovery
// flow instead, which asks for a vault phrase that vault never had.
//
// # What this asserts, and why each step is not decoration
//
// 1. Boot reaches `/unlock` for the seeded container, so the probe is reading a
//    real `vault.meta` through OPFS.
// 2. `unlock.recovery-link` swaps to the identity sub-view. That swap happens
//    only when `vault_is_person_wrapped` answered TRUE; a refused command
//    answers false and the link opens the legacy recovery screen instead, whose
//    first step has no phrase grid. So waiting for the grid is the assertion
//    that the probe is dispatched rather than Pending.
// 3. Typing the 24 words and submitting mounts the vault shell, which is the
//    unlock itself. A phrase that did not open the person wrap would surface
//    `unlock.identity-phrase-error`, and the shell would never mount.
//
// The fixture is minted by `cargo run --release -p myne-core --features
// test-support --example emit-vault-fixture -- --person`, which drives the
// app's OWN creation path with the identity derived from the words below, under
// the SAME default KDF parameters the unlock path derives them under. A fixture
// minted with other parameters would produce a different keypair from the same
// words, and that failure would read as a broken unlock.

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

const PERSON_FIXTURE = "e2e-web/fixtures/person-wrapped-vault.json";
const UNLOCK_TIMEOUT_MS = 30_000;

interface PersonFixture {
  readonly password: string;
  readonly phrase: string;
}

describeE2E("a person-wrapped vault opens with the identity phrase in a browser", () => {
  it("offers the identity door and unlocks through it", async () => {
    const vault = loadVaultFixture(PERSON_FIXTURE);
    const { phrase } = JSON.parse(
      // `loadVaultFixture` validates the vault half; the extra field is this
      // scenario's credential, and reading it from the same file keeps the two
      // from drifting.
      await import("node:fs").then((fs) => fs.readFileSync(PERSON_FIXTURE, "utf8")),
    ) as PersonFixture;
    expect(phrase.split(" ").length, "the fixture carries 24 words").toBe(24);

    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
    try {
      browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      const { session } = browser;

      await session.navigate(`${server.origin}/__seed`);
      await seedVaultAt(session, VAULT_ROOT, vault);
      await session.navigate(`${server.origin}/`);

      await session.waitForElement('input[type="password"]', { timeoutMs: UNLOCK_TIMEOUT_MS });
      expect(await session.execute<string>("return location.pathname;")).toContain("/unlock");

      // The probe's answer, observed through the UI: this link opens the
      // IDENTITY sub-view only on a person-wrapped vault.
      const door = await session.byTestId("unlock.recovery-link");
      await door.scrollIntoView();
      await door.click();

      const submit = await session.byTestId("unlock.identity-phrase-submit", {
        timeoutMs: UNLOCK_TIMEOUT_MS,
      });

      // The sub-view's own ids: the first cell carries `-input`, the rest are
      // numbered 2..24. Filled one at a time because WebDriver's `sendKeys`
      // dispatches no paste event, and the grid's distribute-on-paste path is a
      // keyboard convenience rather than the only way in.
      const words = phrase.split(" ");
      expect(words.length, "the fixture carries 24 words").toBe(24);
      const cellSelector = (i: number) =>
        i === 0
          ? '[data-testid="unlock.identity-phrase-input"]'
          : `[data-testid="unlock.identity-phrase-cell-${i + 1}"]`;
      for (let i = 0; i < words.length; i += 1) {
        const cell = await session.findElement(cellSelector(i));
        await cell.sendKeys(words[i]);
      }

      try {
        await submit.click();
        await session.waitForElement('[data-testid="editor.bottom-bar"]', {
          timeoutMs: UNLOCK_TIMEOUT_MS,
        });
      } catch (e) {
        const diag = await session.execute<string>(
          "return document.body.innerText.slice(0, 300) + ' || path=' + location.pathname;",
        );
        throw new Error(`${(e as Error).message}\nPAGE: ${diag}`);
      }

      const refused = await session.execute<boolean>(
        `return !!document.querySelector('[data-testid="unlock.identity-phrase-error"]');`,
      );
      expect(refused, "the phrase must have opened the vault").toBe(false);
    } finally {
      await browser?.teardown().catch(() => {});
      await server.close();
    }
  });
});
