// Chrome DevTools Protocol passthrough for the web lane (myne-md/myne#556).
//
// # What this is for, and the one thing it must never become
//
// Two bullets on that issue need the browser to change something about the
// MACHINE rather than about the page: `prefers-color-scheme`, and
// `prefers-reduced-motion`. Neither has a web API — that is the point of them,
// they report the user's OS setting — and neither is reachable through W3C
// WebDriver. chromedriver exposes CDP at `POST /session/{id}/goog/cdp/execute`,
// and `Emulation.setEmulatedMedia` is the command that answers both.
//
// The rule this file exists under: CDP may only be used to change the
// ENVIRONMENT the app runs in — the same levers a user's OS pulls. It may never
// be used to reach into the app, read its state, or force it into a state the
// UI cannot produce. That would be a test hook wearing a protocol's name, and
// `e2e/CLAUDE.md`'s "zero test hooks" rule is about the property, not the
// spelling.
//
// # Chromium only, and said out loud rather than skipped
//
// geckodriver has no CDP passthrough. A scenario that needs this must self-skip
// on Firefox with a stated reason rather than silently asserting less — the
// lane's own `capabilitiesFor` refuses a mobile-emulation request on Firefox
// for exactly this reason, and the comment there is worth reading: "a
// silently-dropped emulation flag produces a scenario that drives a DESKTOP
// browser while asserting a phone is refused — it fails, but it fails saying
// the product is broken."

import type { Session } from "./session";
import type { SupportedBrowser } from "./harness";

/** Whether this browser can be driven through the CDP passthrough at all. */
export function supportsCdp(browser: SupportedBrowser): boolean {
  return browser === "chrome";
}

/**
 * One CDP command. Chromium only — the caller is expected to have checked
 * {@link supportsCdp}, and a call on another engine fails by name rather than
 * producing a driver error nobody can read.
 */
export async function cdp(
  session: Session,
  browser: SupportedBrowser,
  cmd: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  if (!supportsCdp(browser)) {
    throw new Error(
      `${cmd} was requested on ${browser}, which has no CDP passthrough. A scenario ` +
        `that needs CDP must self-skip on this engine with a stated reason — see ` +
        `support/cdp.ts. Failing here rather than silently doing nothing, because a ` +
        `no-op emulation makes the scenario assert the app is broken.`,
    );
  }
  return await session.send("POST", "/goog/cdp/execute", { cmd, params });
}

/** One `Emulation.setEmulatedMedia` feature. */
export interface MediaFeature {
  readonly name: string;
  readonly value: string;
}

/**
 * Override CSS media features for the page, live.
 *
 * Live is the load-bearing word: this is not a launch flag. The app's response
 * to a theme change is a `matchMedia` listener, and a launch-time override
 * would test the boot path while leaving the listener — the part that breaks —
 * unexercised.
 *
 * Passing an empty list clears every override, which is how a scenario returns
 * the seat to its default before asserting the round trip.
 */
export async function setEmulatedMedia(
  session: Session,
  browser: SupportedBrowser,
  features: readonly MediaFeature[],
): Promise<void> {
  await cdp(session, browser, "Emulation.setEmulatedMedia", {
    features: features.map((f) => ({ name: f.name, value: f.value })),
  });
}
