// Seed the checked-in vault fixture, boot, unlock, and hand back the session —
// the six-line preamble every fixture-driven scenario in this lane was
// repeating (myne-md/myne#556).
//
// # Why it is worth extracting rather than copied once more
//
// Three specs had it inline and a fourth was about to. Each copy is a place
// where the boot fork can be waited on WRONG, and this lane has already paid
// for that once: `pending-approval.e2e.ts` records that waiting for the
// password field to go AWAY looks identical to a crash, because the
// fail-closed screen has no password field either. A copy that gets that
// subtlety right today is a copy that can lose it later, silently, in one file.
//
// So the fork-waiter lives here once, positively, over the named set — and a
// scenario that lands somewhere unexpected is told which of the three screens
// it got instead of timing out on one arm of a fork.
//
// # What it deliberately does NOT do
//
// It does not close anything. The caller owns the browser and the server, so
// the `finally` that tears them down stays visible in the scenario rather than
// hiding behind a helper — which is the shape `e2e/AGENTS.md` asks for on the
// desktop side, for the reason a leaked driver is worse than a duplicated line.

import { expect } from "vitest";
import { newBrowserSession, type Session } from "./session";
import { startBundleServer } from "./server";
import { waitForAnyTestId } from "./flows";
import { DRIVER_PORT } from "./worker-ports";
import { loadVaultFixture, seedVault } from "./opfs-seed";
import type { SupportedBrowser } from "./harness";
import { testIdSelector } from "./session";

const BOOT_TIMEOUT_MS = 30_000;
const UNLOCK_TIMEOUT_MS = 120_000;

export interface FixtureVaultSession {
  session: Session;
  server: Awaited<ReturnType<typeof startBundleServer>>;
  browser: Awaited<ReturnType<typeof newBrowserSession>>;
  /** The fixture's password, for a scenario that locks and re-unlocks. */
  password: string;
}

export interface OpenFixtureVaultOptions {
  bundleDir?: string;
  browser?: SupportedBrowser;
  syncOrigin?: string;
  /**
   * Reuse an existing browser profile instead of seeding a fresh one.
   *
   * For a scenario whose subject is what SURVIVES the browser going away. OPFS
   * lives in the profile and is keyed by origin, so the second session needs
   * both the same profile directory and the same server port — hence
   * {@link reopenSameProfile}, which threads both rather than leaving a caller
   * to remember the pair.
   */
  profileDir?: string;
  /** Serve on this port, so a reopened session lands on the SAME origin. */
  bundlePort?: number;
  /** Skip the fixture write. A reopen must find what the first session left. */
  skipSeed?: boolean;
}

/**
 * Bring up a server + browser, seed the fixture into OPFS, unlock, and assert
 * the editor is what answered.
 *
 * The caller MUST tear down `browser` and `server` in a `finally`.
 */
export async function openFixtureVault(
  opts: OpenFixtureVaultOptions = {},
): Promise<FixtureVaultSession> {
  const bundleDir = opts.bundleDir ?? process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
  const browserName =
    opts.browser ?? ((process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser);
  const syncOrigin = opts.syncOrigin ?? "https://sync.example.test";

  const vault = loadVaultFixture();
  const server = await startBundleServer({
    root: bundleDir,
    syncOrigin,
    ...(opts.bundlePort === undefined ? {} : { port: opts.bundlePort }),
  });
  let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
  try {
    browser = await newBrowserSession({
      baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
      browser: browserName,
      ...(opts.profileDir === undefined ? {} : { profileDir: opts.profileDir }),
    });
    const { session } = browser;

    if (opts.skipSeed === true) {
      // A REOPEN. Seeding here would write the fixture over whatever the first
      // session left behind, which is the only thing this kind of scenario is
      // about — so the difference is a parameter rather than a second copy of
      // this function that forgets to stay in step with it.
      await session.navigate(`${server.origin}/`);
    } else {
      await session.navigate(`${server.origin}/__seed`);
      await seedVault(session, vault);
      await session.navigate(`${server.origin}/`);
    }

    const field = await session.waitForElement(testIdSelector("unlock.password-input"), {
      timeoutMs: BOOT_TIMEOUT_MS,
    });
    await field.sendKeys(vault.password);
    await (await session.findElement(testIdSelector("unlock.submit"))).click();

    // Positively, over the whole set. A bare wait on `editor.bottom-bar` would
    // report "the editor never appeared" when what happened is that the vault
    // failed closed — pointing a reader at the wrong arm of the fork.
    const landed = await waitForAnyTestId(
      session,
      ["editor.bottom-bar", "account-bootstrap.pending-notice", "fail-closed.root"],
      UNLOCK_TIMEOUT_MS,
    );
    expect(
      landed,
      "the fixture vault did not open — whatever the scenario asserts after this " +
        "would be asserting it against the wrong screen",
    ).toBe("editor.bottom-bar");

    return { session, server, browser, password: vault.password };
  } catch (e) {
    await browser?.teardown().catch(() => {});
    await server.close();
    throw e;
  }
}

/**
 * Open Settings and select `tab`, waiting on the rail's own `aria-selected`.
 *
 * Clicked through the page rather than through the driver's pointer: headless
 * Chrome opens at 800x600 here (the harness passes no window size), the bottom
 * bar sits below that fold, and `Element.click()` spends ten seconds reporting
 * `element not interactable` — measured, with and without `scrollIntoView`,
 * which does not help because the scroll container is an inner element
 * chromedriver's own auto-scroll does not reach.
 *
 * Whether that control is reachable by POINTER at a given viewport is a real
 * question and it belongs to `a11y.e2e.ts` and the click-target rules. A
 * scenario about what a panel RENDERS should not be silently answering it.
 */
export async function openSettingsTab(session: Session, tab: string): Promise<void> {
  await session.execute(
    "document.querySelector('[data-testid=\"editor.settings-cta\"]').click();",
  );
  await session.waitForElement(testIdSelector("settings.modal"), { timeoutMs: 15_000 });
  await session.execute(
    "document.querySelector('[data-testid=\"' + arguments[0] + '\"]')?.click();",
    [tab],
  );
  await session.waitUntil(
    async () =>
      (await session.execute<boolean>(
        "return document.querySelector('[data-testid=\"' + arguments[0] + '\"]')" +
          "?.getAttribute('aria-selected') === 'true';",
        [tab],
      ))
        ? true
        : null,
    { label: `the ${tab} panel became active`, timeoutMs: 15_000 },
  );
}
