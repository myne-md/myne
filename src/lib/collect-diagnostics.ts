// Read the environment and build the diagnostic block (phase3-web-client task 114).
//
// Split from `src/lib/diagnostics.ts` on purpose: that module is PURE, so its
// allowlist can be tested without a DOM, a build define or a storage estimate.
// This one does the reading, and does nothing else — every value it gathers maps
// to exactly one allowlisted field, so there is no place for an extra one to
// enter.
//
// Nothing is transmitted. The only consumer is a copy-to-clipboard button the
// user presses; there is no endpoint, no beacon and no automatic send, which is
// why task 60's zero-third-party request-log assertion is unaffected.

import { buildDiagnostics, engineLabel } from "./diagnostics";
import { servedBuildInfo } from "../platform/build-info";

/** Bytes → whole MB, or `null`. Rounded deliberately: a byte-exact figure is a
 *  finer reading of the user's storage than a support block needs. */
function mb(bytes: number | undefined): number | null {
  return typeof bytes === "number" ? Math.round(bytes / (1024 * 1024)) : null;
}

export async function collectDiagnostics(failureCode: string): Promise<string> {
  const served = await servedBuildInfo().catch(() => null);
  let usage: StorageEstimate | null = null;
  try {
    usage = (await navigator.storage?.estimate?.()) ?? null;
  } catch {
    // Storage estimation is permission- and engine-dependent; an unavailable
    // reading is `unknown`, never a failed copy.
  }
  return buildDiagnostics({
    version: __APP_VERSION__,
    channel: import.meta.env.MODE === "development" ? "Development" : "Stable",
    // Unsliced, unlike the About row: a maintainer reading a pasted block wants
    // the whole SHA. Served build first for the reason given there — the web
    // define is pinned, so `version.json` is where the commit lives
    // (myne-md/myne#458).
    commit: served?.commit ?? __BUILD_COMMIT__,
    bundleHash: served?.bundleHash ?? null,
    failureCode,
    // The engine and major version only — never the full UA string, whose tail
    // carries device models, OEM tokens and extension markers.
    engine: engineLabel(navigator.userAgent),
    crossOriginIsolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false,
    storageUsedMb: mb(usage?.usage),
    storageQuotaMb: mb(usage?.quota),
  });
}
