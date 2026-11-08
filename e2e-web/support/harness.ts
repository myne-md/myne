// Can this machine run the web E2E lane, and if not, exactly why
// (MYND-574 task 105).
//
// # Why the reason is a value and not a `console.warn`
//
// The desktop lane learned this the hard way: a suite that skips silently is a
// suite that has been skipping for three weeks and nobody noticed. So the check
// returns a REASON, one sentence, naming the missing thing and how to get it —
// and the scenario layer prints it once at import time so even a filtered run
// that matches nothing explains itself.
//
// # Why the checks are separate rather than one boolean
//
// Because their fixes are different, and a merged "harness unavailable" hides
// which fix applies. A missing bundle is `pnpm web:build`; a missing driver is a
// pinned install; an unsupported host is not fixable at all. Reporting them as
// one string would send someone to the wrong one.
//
// This module deliberately contains **no browser code**, so it is unit-testable
// on any machine — which matters, because it is the thing that decides whether
// the lane is honest when the browser is absent.

import { existsSync } from "node:fs";
import { join } from "node:path";

/** What the lane needs, resolved from the environment. */
export interface HarnessEnv {
  /** The built web bundle's directory. */
  readonly bundleDir: string;
  /** Whether a WebDriver endpoint is expected to be reachable. */
  readonly driverConfigured: boolean;
  /** Which browser the run targets. */
  readonly browser: string;
}

/** The lane's supported browsers. Chromium and Firefox are the CI matrix
 *  (`agent-tooling/design-notes.md` 2026-07-27); Safari is a manual macOS gate and is
 *  accepted here so a local run on a Mac is possible, never in CI. */
export const SUPPORTED_BROWSERS = ["chrome", "firefox", "safari"] as const;
export type SupportedBrowser = (typeof SUPPORTED_BROWSERS)[number];

export type Support = { ok: true } | { ok: false; reason: string };

/**
 * Whether the lane can run, with one actionable reason when it cannot.
 *
 * Pure over its argument — no filesystem, no network — except for the bundle
 * existence check, which is injected as a predicate so this is testable without
 * building anything.
 */
export function harnessSupport(
  env: HarnessEnv,
  bundleExists: (dir: string) => boolean = (d) => existsSync(join(d, "index.html")),
): Support {
  if (!(SUPPORTED_BROWSERS as readonly string[]).includes(env.browser)) {
    return {
      ok: false,
      reason:
        `MYNE_WEB_E2E_BROWSER="${env.browser}" is not one of ` +
        `${SUPPORTED_BROWSERS.join(", ")}. Safari runs only on a macOS host and ` +
        `never in CI (agent-tooling/design-notes.md 2026-07-27 — the runner is Linux-only).`,
    };
  }
  if (env.browser === "safari" && process.platform !== "darwin") {
    return {
      ok: false,
      reason:
        "the Safari seat requires a macOS host; it is a manual per-release gate, " +
        "not a CI lane (agent-tooling/docs/dev/e2e.md, the browser matrix).",
    };
  }
  if (!bundleExists(env.bundleDir)) {
    return {
      ok: false,
      reason: `no built web bundle at ${env.bundleDir} — run \`pnpm web:build\` first.`,
    };
  }
  if (!env.driverConfigured) {
    return {
      ok: false,
      reason:
        "no WebDriver endpoint configured: set MYNE_WEB_E2E_DRIVER_PORT and start " +
        "the pinned chromedriver/geckodriver (agent-tooling/docs/dev/e2e.md). Browser binaries " +
        "are pinned or self-hosted — never an unpinned download in a blocking step.",
    };
  }
  return { ok: true };
}

/** Read the lane's configuration out of the environment. */
export function harnessEnv(): HarnessEnv {
  return {
    bundleDir: process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? join("web", "dist"),
    // Set by `worker-ports.ts` per vitest slot. Its presence means a port was
    // ALLOCATED, not that anything is listening on it — the session layer finds
    // that out and fails loudly, which is the right place for it: a configured
    // port with nothing behind it is a broken setup, not an unsupported host.
    driverConfigured: process.env.MYNE_WEB_E2E_DRIVER_PORT !== undefined,
    browser: process.env.MYNE_WEB_E2E_BROWSER ?? "chrome",
  };
}
