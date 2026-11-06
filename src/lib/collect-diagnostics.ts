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

import type { HostWebView } from "./diagnostics";
import { gatherDiagnostics, webViewLabel } from "./diagnostics-gather";
import { servedBuildInfo } from "../platform/build-info";
import { invoke } from "../platform/core";
import { HAS_TAURI } from "./app-window";

/** Which WebView this desktop build is hosted in, or `null` in a browser. */
function desktopWebView(): HostWebView | null {
  if (!HAS_TAURI) return null;
  // The ladder is shared with the phone; only the fallback is this client's own answer, because a
  // Tauri desktop that matched no arm is still running inside a GTK WebView.
  return webViewLabel(navigator.userAgent, "WebKitGTK");
}

export async function collectDiagnostics(failureCode: string): Promise<string> {
  const served = await servedBuildInfo().catch(() => null);
  return gatherDiagnostics({
    call: invoke,
    webView: desktopWebView(),
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
  });
}
