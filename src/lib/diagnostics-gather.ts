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
  /**
   * A host-side digest of the running build artefact, for a client that has no
   * served bundle to fetch one from (myne-md/myne#991).
   *
   * Absent on a client whose build identity already arrives in `bundleHash`, and
   * absent on one with no digest at all. Present, it is used ONLY when
   * `bundleHash` is `null`, so a served value always wins: it is the one that
   * names the artefact a deploy published.
   */
  buildDigest?: () => Promise<string>;
  /**
   * A host-side measure of the vault on disk, for a client whose vault is a
   * DIRECTORY rather than a store the page can ask about (myne-md/myne#991).
   *
   * Absent means this client has no such measure and the storage lines come from
   * `navigator.storage.estimate()`, which for a browser store is the right
   * reading. A client that supplies this measure prints nothing else: the page's
   * own estimate would describe the WebView's origin store there, which holds none
   * of the vault, so it is a true number about the wrong thing.
   */
  vaultUsage?: () => Promise<VaultUsage | null>;
}

/**
 * A vault directory's footprint, as the host measured it.
 *
 * Declared HERE rather than in the platform seam, and the seam imports it: that is
 * the direction the tree already uses (`src/platform/filePicker.ts` imports from
 * `src/lib/attachments.ts`), and the other direction would drag a `@tauri-apps/*`
 * importer into a client whose seam is a different module.
 */
export interface VaultUsage {
  /** Files, links and the directories between them, under the vault directory. */
  readonly entries: number;
  /** Total size of the files and links, in bytes. */
  readonly bytes: number;
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

/**
 * How long a host-side measure may take before the block is built without it.
 *
 * Longer than the vault read above, and deliberately: the digest is a pass over
 * an executable of tens of megabytes, and the walk visits every entry in the
 * vault. Neither is a key-store call that can wedge, so the wait is worth more
 * than the line, but it is still bounded: a report a user is waiting to copy
 * must not hang on a network mount.
 */
const HOST_READ_DEADLINE_MS = 5000;

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
  // Both host measures are bounded by the same deadline and awaited ALONGSIDE the
  // doctor, not after it: the block is copied by a user who is waiting, and a
  // digest pass over tens of megabytes on a cold disk must not be added to a key
  // store read it has nothing to do with. A measure that never answers costs its
  // own lines and never the block.
  const [doctor, hostDigest, hostUsage] = await Promise.all([
    withinDeadline(readVaultDoctor(env.call), DOCTOR_DEADLINE_MS),
    env.buildDigest === undefined
      ? Promise.resolve(null)
      : withinDeadline(env.buildDigest(), HOST_READ_DEADLINE_MS),
    env.vaultUsage === undefined
      ? Promise.resolve(null)
      : withinDeadline(env.vaultUsage(), HOST_READ_DEADLINE_MS),
  ]);
  let usage: StorageEstimate | null = null;
  try {
    usage = (await navigator.storage?.estimate?.()) ?? null;
  } catch {
    // Storage estimation is permission- and engine-dependent; an unavailable reading drops
    // the two storage lines, never the copy.
  }
  // A client that MEASURES its vault prints that measure, and prints nothing else.
  // The page's own estimate is not a fallback here: on desktop it describes the
  // WebView's origin store, which holds none of the vault, so falling back would put
  // a true number about the wrong thing in a block whose only purpose is to be acted
  // on. That covers the case where the host read refused or ran out of its deadline
  // as well: the lines are then absent, which is the same answer every other
  // unreadable field gives. A client with no such measure keeps its own estimate,
  // which for a browser store is the right reading.
  const measuresItsVault = env.vaultUsage !== undefined;
  const storageUsedMb = measuresItsVault
    ? hostUsage === null
      ? null
      : mb(hostUsage.bytes)
    : mb(usage?.usage);
  // No quota line either way on a measured vault: a directory has no quota of its
  // own, and the disk's free space is a different fact.
  const storageQuotaMb = measuresItsVault ? null : mb(usage?.quota);
  const storageEntries = hostUsage === null ? null : hostUsage.entries;
  return buildDiagnostics({
    version: __APP_VERSION__,
    channel: import.meta.env.MODE === "development" ? "Development" : "Stable",
    commit: env.commit,
    // A served hash names a published artefact, so it outranks a local digest; the
    // host digest is the desktop's only reading, because a bundle cannot contain the
    // hash of its own bytes (myne-md/myne#991).
    bundleHash: env.bundleHash ?? hostDigest,
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
    storageUsedMb,
    storageQuotaMb,
    storageEntries,
  });
}
