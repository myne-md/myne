// Read the environment and build the diagnostic block (phase3-web-client task 114).
//
// Split from `src/lib/diagnostics.ts` on purpose: that module is PURE, so its
// allowlist can be tested without a DOM, a build define or a storage estimate.
// This one does the reading, and does nothing else — every value it gathers maps
// to an allowlisted field, so there is no place for an extra one to enter. The
// vault doctor (myne-md/myne#1003) is the one read that fills five fields, and
// each of those is a closed enum token the allowlist names one by one.
//
// Nothing is transmitted. The only consumer is a copy-to-clipboard button the
// user presses; there is no endpoint, no beacon and no automatic send, which is
// why task 60's zero-third-party request-log assertion is unaffected.

import { buildDiagnostics, engineLabel, type HostWebView } from "./diagnostics";
import { authorityToken, readVaultDoctor, sessionToken } from "./vault-doctor";
import { servedBuildInfo } from "../platform/build-info";
import { HAS_TAURI } from "./app-window";

/**
 * Bytes → whole MB, or `null` (which omits the line).
 *
 * Rounded deliberately: a byte-exact figure is a finer reading of the user's
 * storage than a support block needs. Two cases are NOT rounding, though, and
 * both used to reach the pasted text as facts (myne-md/myne#556):
 *
 *   * a NON-FINITE reading. `typeof NaN === "number"`, so a partial or
 *     in-progress `estimate()` passed the old guard and `String(NaN)` landed in
 *     the block as the literal `NaN`. A field saying NaN says the app is broken
 *     in a way it is not, and the honest answer for an unusable reading already
 *     exists one line down: no line at all.
 *   * a NON-EMPTY store rounding to `0`. Anything under 512 KB — a small but
 *     real vault — came out as a bare `0`, which is not a coarse version of
 *     "some", it is the one value that says the opposite. The block exists to
 *     be acted on, and `storageUsedMb: 0` is what a maintainer uses to rule
 *     storage out of an investigation.
 *
 * So sub-megabyte usage reports as 1 rather than 0. That over-states by less
 * than a megabyte, at a granularity where a megabyte is already the unit — and
 * it is the only direction that cannot mislead: "at least a bit" is true of
 * every non-empty store, "none" is true of none of them.
 */
function mb(bytes: number | undefined): number | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  const whole = Math.round(bytes / (1024 * 1024));
  return whole === 0 && bytes > 0 ? 1 : whole;
}

/**
 * Which WebView this desktop build is hosted in, or `null` in a browser.
 *
 * The UA order is load-bearing. Android carries both `Linux` and `Android` and a
 * Chrome token, so it has to be recognised before either; Windows WebView2
 * carries Chrome's and Edge's tokens plus `Windows`.
 */
function desktopWebView(): HostWebView | null {
  if (!HAS_TAURI) return null;
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "Android WebView";
  if (/Windows/i.test(ua)) return "WebView2";
  if (/Macintosh|Mac OS X|iPhone|iPad/i.test(ua)) return "WKWebView";
  return "WebKitGTK";
}

/**
 * How long the vault read may take before the block is built without it.
 *
 * The doctor verifies the vault's roster and reads the OS key store, and this block is what
 * a user hands over when the app has already failed closed. A wedged key store must cost the
 * five vault lines, never the whole report: this block was assembled from local facts before
 * that command existed, and it stays that way.
 */
const DOCTOR_DEADLINE_MS = 2000;

/** Settle with the work's value, or with `null` at the deadline (or on a rejection). */
function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export async function collectDiagnostics(failureCode: string): Promise<string> {
  const served = await servedBuildInfo().catch(() => null);
  // The vault's five facts (myne-md/myne#1003), from the same command the sync panel asks.
  // One read, one verdict: a second derivation here would be a second answer to a question
  // whose whole point is that it has one. A refusal, a missing vault and a read that never
  // settles all leave `null`, and the five lines are then ABSENT rather than placeholdered.
  const doctor = await withinDeadline(readVaultDoctor(), DOCTOR_DEADLINE_MS);
  let usage: StorageEstimate | null = null;
  try {
    usage = (await navigator.storage?.estimate?.()) ?? null;
  } catch {
    // Storage estimation is permission- and engine-dependent; an unavailable
    // reading drops the two storage lines, never the copy.
  }
  return buildDiagnostics({
    version: __APP_VERSION__,
    channel: import.meta.env.MODE === "development" ? "Development" : "Stable",
    // Unsliced, unlike the About row: a maintainer reading a pasted block wants
    // the whole SHA. Served build first for the reason given there — the web
    // define is pinned, so `version.json` is where the commit lives
    // (myne-md/myne#458).
    // `unknown` is what the define falls back to in a checkout with no git
    // history; that is an absent reading, not a value, so it omits the line
    // (issue #970, item 15) instead of being pasted as a fact.
    commit: served?.commit ?? (__BUILD_COMMIT__ === "unknown" ? null : __BUILD_COMMIT__),
    bundleHash: served?.bundleHash ?? null,
    failureCode,
    vaultGeneration: doctor?.generation ?? null,
    vaultAuthority: doctor ? authorityToken(doctor.authority) : null,
    vaultBinding: doctor?.binding ?? null,
    vaultKeyAtRest: doctor?.key_at_rest ?? null,
    vaultSession: doctor ? sessionToken(doctor.session) : null,
    // The engine and major version only — never the full UA string, whose tail
    // carries device models, OEM tokens and extension markers.
    engine: engineLabel(navigator.userAgent, desktopWebView()),
    crossOriginIsolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false,
    storageUsedMb: mb(usage?.usage),
    storageQuotaMb: mb(usage?.quota),
  });
}
