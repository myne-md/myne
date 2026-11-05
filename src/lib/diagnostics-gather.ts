// The reads that fill the diagnostic block, shared by every client (myne-md/myne#1027).
//
// # Why this is its own module rather than a function in one of its two neighbours
//
// `diagnostics.ts` is deliberately PURE: its allowlist is tested without a DOM, a build define
// or a storage estimate, and the gather reads all three. `collect-diagnostics.ts` cannot be
// imported outside the desktop tree, because it statically imports the desktop's own IPC seam
// and build-info reader: aliasing it into the phone would bundle `@tauri-apps/*` calls into a
// client whose seam is a different module, which is the one rule the platform-seam guard exists
// to hold. So the gather lives here, seam-free, and each client passes what only it knows.
//
// # What was wrong before
//
// The phone had its own copy of this gather (myne-md/myne#1027's first attempt). Two copies of
// the half that CREATES the block's inputs is worse than two copies of the formatting: a field
// added on desktop silently never reaches the phone, so a maintainer diffing two pastes sees
// "the phone has no vaultBinding" and concludes the phone's vault is different, when in fact
// nobody wired the reading. The allowlist can only be one vocabulary if one function fills it.

import { buildDiagnostics, engineLabel, mb, type HostWebView } from "./diagnostics";
import { authorityToken, readVaultDoctor, sessionToken, type VaultDoctorInvoke } from "./vault-doctor";

/** Everything the block needs that only the caller can supply. */
export interface DiagnosticsEnv {
  /** The caller's own IPC seam: `invoke` on desktop and web, the mobile seam on the phone. */
  call: VaultDoctorInvoke;
  /** Which WebView this build is hosted in, or `null` outside a Tauri host. */
  webView: HostWebView | null;
  /** The served/baked commit, or `null` when this client's build has no reading for it. */
  commit: string | null;
  /** The served bundle hash, or `null` for the same reason. */
  bundleHash: string | null;
  /** The last recorded failure code, or the block's own spelling for "none recorded". */
  failureCode: string;
}

/**
 * Which WebView this build is hosted in, from the user agent.
 *
 * One ladder for every client (myne-md/myne#1027 review): these labels are the field vocabulary
 * `engineLabel` prints, so a second copy would name the same engine two ways in two pastes, which
 * is the failure this module exists to prevent. `fallback` is what the caller answers when none of
 * the arms match, and it is the one thing the clients genuinely differ on: a desktop build is
 * running inside some GTK WebView, and a browser is running inside none of them.
 *
 * The order is load-bearing. Android carries both `Linux` and `Android` plus a Chrome token, so it
 * has to be recognised before either; Windows WebView2 carries Chrome's and Edge's tokens plus
 * `Windows`.
 */
export function webViewLabel(ua: string, fallback: HostWebView | null): HostWebView | null {
  if (/Android/i.test(ua)) return "Android WebView";
  if (/Windows/i.test(ua)) return "WebView2";
  if (/Macintosh|Mac OS X|iPhone|iPad|iPod/i.test(ua)) return "WKWebView";
  return fallback;
}

/**
 * How long the vault read may take before the block is built without it.
 *
 * The doctor verifies the vault's roster and reads the OS key store, and this block is what a
 * user hands over when the app has already failed closed. A wedged key store must cost the five
 * vault lines, never the whole report.
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

/** Read the environment and build the block. Every value gathered maps to an allowlisted field. */
export async function gatherDiagnostics(env: DiagnosticsEnv): Promise<string> {
  // The vault's five facts (myne-md/myne#1003), from the same command the sync panel asks.
  // One read, one verdict: a second derivation here would be a second answer to a question
  // whose whole point is that it has one. A refusal, a missing vault and a read that never
  // settles all leave `null`, and the five lines are then ABSENT rather than placeholdered.
  const doctor = await withinDeadline(readVaultDoctor(env.call), DOCTOR_DEADLINE_MS);
  let usage: StorageEstimate | null = null;
  try {
    usage = (await navigator.storage?.estimate?.()) ?? null;
  } catch {
    // Storage estimation is permission- and engine-dependent; an unavailable reading drops
    // the two storage lines, never the copy.
  }
  return buildDiagnostics({
    version: __APP_VERSION__,
    channel: import.meta.env.MODE === "development" ? "Development" : "Stable",
    commit: env.commit,
    bundleHash: env.bundleHash,
    failureCode: env.failureCode,
    vaultGeneration: doctor?.generation ?? null,
    vaultAuthority: doctor ? authorityToken(doctor.authority) : null,
    vaultBinding: doctor?.binding ?? null,
    vaultKeyAtRest: doctor?.key_at_rest ?? null,
    vaultSession: doctor ? sessionToken(doctor.session) : null,
    // The engine and major version only, never the full UA string, whose tail carries device
    // models, OEM tokens and extension markers.
    engine: engineLabel(navigator.userAgent, env.webView),
    crossOriginIsolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false,
    storageUsedMb: mb(usage?.usage),
    storageQuotaMb: mb(usage?.quota),
  });
}
