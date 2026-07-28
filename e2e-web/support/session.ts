// The browser session layer for the web E2E lane (MYND-574 task 105).
//
// # Why this is thirty lines and not a driver
//
// `e2e/support/webdriver.ts` is a hand-rolled zero-dependency W3C WebDriver
// client that has driven 92 desktop scenario files. Exactly ONE function in it
// is tauri-driver-specific — `newSession`, which sends a `tauri:options`
// capability naming an app binary. Everything else (`Session`, `Element`,
// `byTestId`, `waitUntil`, the stale-element retries) is protocol, and protocol
// is the same whether the other end is tauri-driver, chromedriver or
// geckodriver.
//
// So this module is the capability payload and nothing else. `decisions.md`
// 2026-07-27 rejected Playwright partly because the alternative "was already
// built and already justified"; re-implementing the client here would have quietly
// made that false.
//
// # Profile isolation is not optional here, and it is not the same as origin
// # isolation
//
// Two separate leaks, two separate fixes, and conflating them is how a suite
// starts sharing vaults between tests:
//
// * **Origin.** OPFS is keyed by origin, and `worker-ports.ts` already gives each
//   vitest slot its own bundle-server port and therefore its own origin. That
//   isolates PARALLEL slots from each other.
// * **Profile.** Within one slot, successive scenarios hit the SAME origin — so
//   without a fresh browser profile per session, test 2 opens test 1's vault.
//   Every session here gets a throwaway `--user-data-dir` / `-profile`, which is
//   also what makes "a clean browser profile" (the state task 85's first-run flow
//   is specified against) actually clean.
//
// # Headless
//
// On by default, because the CI runner has no display. Overridable via
// `MYNE_WEB_E2E_HEADED=1` for local debugging — the one thing a hand-rolled
// client cannot give you is a trace viewer, and watching it is the substitute.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../../e2e/support/webdriver";
import type { SupportedBrowser } from "./harness";

/** Re-exported so scenarios import their whole vocabulary from one place. */
export { Session, Element, testIdSelector, WebDriverError } from "../../e2e/support/webdriver";

export interface BrowserSessionOptions {
  /** The driver endpoint, e.g. `http://127.0.0.1:4544`. */
  readonly baseUrl: string;
  /** Which browser the driver drives. */
  readonly browser: SupportedBrowser;
  /** Run without a visible window. Defaults to true (CI has no display). */
  readonly headless?: boolean;
}

/** A session plus the throwaway profile it owns. */
export interface BrowserSession {
  readonly session: Session;
  /**
   * The throwaway profile this session was launched with.
   *
   * Exposed for the at-rest residue scan (task 107), which is the one scenario
   * whose subject is the profile itself rather than the page: it ends the
   * session, scans this directory, and only then lets it be removed. Every
   * other scenario should ignore it — reading a live browser's profile is
   * reading a data race.
   */
  readonly profileDir: string;
  /**
   * Ends the session and removes the profile. Safe to call twice.
   *
   * `keepProfile` ends the session but leaves the directory, for a caller that
   * needs to inspect what the browser left behind. That caller owns removing
   * it — hence `removeProfile()` rather than a second teardown mode, so the
   * cleanup is a visible statement instead of a flag someone forgets.
   */
  teardown(opts?: { keepProfile?: boolean }): Promise<void>;
  /** Remove the profile directory. Idempotent. */
  removeProfile(): void;
}

/**
 * The W3C capabilities for one browser, with a throwaway profile.
 *
 * Pure, and exported for its own test: the properties that matter here are
 * "every session gets its own profile directory" and "headless is the default",
 * and both are decidable without a browser. A capability payload that silently
 * lost its profile flag would produce a suite that passes locally on a fresh
 * machine and shares vaults everywhere else.
 */
export function capabilitiesFor(
  browser: SupportedBrowser,
  profileDir: string,
  headless: boolean,
): Record<string, unknown> {
  switch (browser) {
    case "chrome":
      return {
        browserName: "chrome",
        "goog:chromeOptions": {
          args: [
            `--user-data-dir=${profileDir}`,
            ...(headless ? ["--headless=new"] : []),
            // The container runs as root and Chrome refuses to start without
            // this there. Harmless elsewhere: the sandbox it disables protects
            // the HOST from the page, and the page here is our own bundle
            // served from loopback.
            "--no-sandbox",
            // A small /dev/shm (the Docker default) makes Chrome crash on
            // navigation rather than fail a test, which reads as a flake.
            "--disable-dev-shm-usage",
          ],
        },
      };
    case "firefox":
      return {
        browserName: "firefox",
        "moz:firefoxOptions": {
          args: ["-profile", profileDir, ...(headless ? ["-headless"] : [])],
          prefs: {
            // Firefox gates OPFS's synchronous access handles behind this in
            // some channels; the storage design under test is unreachable
            // without them, and a suite that silently tested a different code
            // path would be worse than one that failed.
            "dom.fs.enabled": true,
          },
        },
      };
    case "safari":
      // safaridriver takes no profile or headless options at all — it drives the
      // user's own Safari. That is exactly why Safari is a MANUAL per-release
      // gate rather than a lane (`decisions.md` 2026-07-27): the isolation this
      // module provides everywhere else cannot be had there, so a Safari run is
      // a human watching, not a suite asserting.
      return { browserName: "safari" };
  }
}

/**
 * Open a session against an already-running driver.
 *
 * Deliberately does NOT spawn the driver. The desktop lane spawns tauri-driver
 * because tauri-driver exists to be spawned per run; a browser driver is a
 * long-lived service that CI starts once for the whole lane, and
 * `worker-ports.ts` is explicit that `MYNE_WEB_E2E_DRIVER_PORT` is an opt-in
 * meaning "a driver is running". Spawning here would make that flag a lie and
 * re-open the bug it was introduced to fix — a lane that opens its gate on a
 * machine with no chromedriver and then fails instead of skipping.
 */
export async function newBrowserSession(
  opts: BrowserSessionOptions,
): Promise<BrowserSession> {
  const headless = opts.headless ?? process.env.MYNE_WEB_E2E_HEADED !== "1";
  const profileDir = mkdtempSync(join(tmpdir(), "myne-web-e2e-profile-"));
  let session: Session;
  try {
    const value = await wireNewSession(
      opts.baseUrl,
      capabilitiesFor(opts.browser, profileDir, headless),
    );
    session = new Session(opts.baseUrl, value.sessionId);
  } catch (e) {
    // The profile is this function's to clean up until a session owns it.
    rmSync(profileDir, { recursive: true, force: true });
    throw e;
  }

  let torn = false;
  const removeProfile = () => rmSync(profileDir, { recursive: true, force: true });
  return {
    session,
    profileDir,
    removeProfile,
    async teardown(opts) {
      if (torn) return;
      torn = true;
      // Order matters: end the session first so the browser releases its
      // handles on the profile, THEN remove it. The reverse leaves Windows and
      // some Linux filesystems with a directory the browser still holds open.
      await session.deleteSession().catch(() => {
        // A dead browser has already ended its session; the profile still needs
        // removing, and failing here would hide that.
      });
      // The residue scan needs the profile to outlive the session — the whole
      // question it asks is what the browser flushed on the way out.
      if (!opts?.keepProfile) removeProfile();
    },
  };
}

/** `POST /session`, in the same shape the desktop client's `wire` helper uses. */
async function wireNewSession(
  baseUrl: string,
  alwaysMatch: Record<string, unknown>,
): Promise<{ sessionId: string }> {
  const res = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capabilities: { alwaysMatch } }),
  });
  const body = (await res.json()) as {
    value?: { sessionId?: string; error?: string; message?: string };
  };
  const sessionId = body.value?.sessionId;
  if (!res.ok || sessionId === undefined) {
    // The driver's own message is the useful part — "session not created:
    // This version of ChromeDriver only supports Chrome version N" is the single
    // most common failure here and is unguessable from a status code.
    throw new Error(
      `could not create a ${alwaysMatch.browserName} session: ` +
        `${body.value?.error ?? res.status} ${body.value?.message ?? ""}`.trim(),
    );
  }
  return { sessionId };
}
