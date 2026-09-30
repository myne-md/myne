// `myne://open-file?path=...` deep-link handling (myne-md/myne#788, task 12):
// the latch precedent is `src/lib/themeDeepLink.ts`, and the shape here is
// deliberately the same: a pure parser, a single-slot latch for arrivals
// before anything can present them, and a bare event that tells the mounted
// surface to drain the latch.
//
// ## Trust posture
//
// Any website can serve a `myne://` link, so `path` is hostile input. Three
// gates stand between it and an open:
//
//   1. This module only accepts the `open-file` action and a non-empty,
//      length-capped path parameter whose control and bidi characters are
//      stripped before anything else sees it. A link whose path fails any of
//      that is ignored outright.
//   2. `plainFileResolvePath` (host-side) checks the device-local gate,
//      canonicalises the path and validates the extension and size cap on the
//      CANONICAL file. Only its answer is latched, so the confirmation shows
//      the real target: a link naming `~/notes.md` while that is a symlink
//      elsewhere cannot get a yes for a file the user never saw.
//   3. Nothing opens until the user confirms, and the confirmed open
//      re-validates from scratch host-side.
//
// Gate off means silence: the route is ignored with no modal, no open and no
// log line (a path is a DENY-class value; see `src-tauri/AGENTS.md`
// "Secret-handling logging discipline").
//
// A resolution failure with the gate ON (unsupported extension, missing file,
// oversized) is also ignored here rather than surfaced: nothing mints such a
// link today, and the open path re-checks anyway.

import { loadDeepLink } from "../platform/deepLink";
import { plainFileGateGet, plainFileResolvePath } from "../platform/plainFile";
import { HAS_TAURI } from "../lib/app-window";

/** The URL action this module owns: `myne://open-file`. */
const OPEN_HOST = "open-file";

/** Display cap for the query parameter. A filesystem path, not a document. */
export const MAX_PATH_CHARS = 4096;

/** A parsed, structurally-sound open request awaiting a gate and resolve. */
export interface OpenFileRequest {
  /** The canonical path, resolved host-side; what the confirmation shows. */
  path: string;
}

/**
 * Why a `myne://` URL did not become an open-file request.
 *
 * Both reasons are SILENT at the handler: `"not-an-open-file-link"` covers
 * every other `myne://` action (the theme install, the mobile client's own
 * routes) and junk, and `"malformed"` is a genuine attempt with a path this
 * module refuses. Neither surfaces anything; the distinction exists so the
 * parser is testable.
 */
export type OpenFileDeepLinkRejection = "not-an-open-file-link" | "malformed";

export type OpenFileDeepLinkResult =
  | { ok: true; path: string }
  | { ok: false; reason: OpenFileDeepLinkRejection };

/**
 * Parse one `myne://` URL into an open-file request.
 *
 * Pure: no gate check, no resolution, no side effects, so the whole rejection
 * matrix is unit-testable. {@link handleOpenFileDeepLinkUrl} is the
 * production caller, and it is where the gate and the host-side resolve run.
 */
export function parseOpenFileUrl(raw: string): OpenFileDeepLinkResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not-an-open-file-link" };
  }
  if (url.protocol !== "myne:") return { ok: false, reason: "not-an-open-file-link" };
  // A non-special scheme keeps its host verbatim (the WHATWG opaque-host
  // parser does not lowercase), so fold it here rather than trusting the URL
  // object.
  if (url.host.toLowerCase() !== OPEN_HOST) {
    return { ok: false, reason: "not-an-open-file-link" };
  }
  // `myne://open-file` takes its target as the one query parameter; a
  // pathname would make the route ambiguous, so it is refused.
  if (url.pathname.replace(/^\/+/, "").replace(/\/+$/, "") !== "") {
    return { ok: false, reason: "not-an-open-file-link" };
  }

  const path = url.searchParams.get("path");
  if (path === null || path === "" || path.length > MAX_PATH_CHARS) {
    return { ok: false, reason: "malformed" };
  }
  // Strip C0/C1 controls plus the bidi overrides (U+200E/200F, U+202A-202E,
  // U+2066-2069) with the exact class `src/lib/themeDeepLink.ts` uses for its
  // display strings. A path carrying a control is not describing a real file,
  // and a path carrying a bidi override is worse than malformed: rendered in
  // the confirmation it can read as one target while naming another. Removing
  // the characters rather than rejecting keeps every position they occupied
  // out of the string the confirmation shows and the host then resolves.
  const stripped = path.replace(
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
  if (stripped === "" || stripped.length > MAX_PATH_CHARS) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, path: stripped };
}

/**
 * Window event fired when a resolved open request is waiting in the latch.
 *
 * The latch is the payload, deliberately: it is what enforces
 * consume-exactly-once. The event only says "drain it now", so a second
 * listener can never act on the same request.
 */
export const OPEN_FILE_EVENT = "myne://plain-file-open-requested";

/**
 * A resolved request that arrived before anything could present it: a cold
 * launch, or a link that landed before `App` mounted.
 *
 * Deliberately a single slot, not a queue: these are user-initiated clicks,
 * and a second click before the first is confirmed means the user changed
 * their mind. The newest link wins.
 */
let pendingOpen: OpenFileRequest | null = null;

/** Take (and clear) the latched request. */
export function consumePendingOpenFile(): OpenFileRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

/**
 * Discard any latched request without acting on it. No production caller
 * today: the latch is page memory, so a quit drops it anyway; this exists so
 * tests can reset the module between cases.
 */
export function clearPendingOpenFile(): void {
  pendingOpen = null;
}

/**
 * Route one incoming URL: gate, resolve, then latch and announce.
 *
 * Every rejection path is silent and logs nothing (a path is a DENY value).
 * The resolve is what turns the link's claimed path into the canonical one
 * the confirmation shows, and the gate check ahead of it is what makes
 * "gate off = no modal" explicit rather than a consequence of the resolve
 * failing.
 *
 * Exported for unit coverage; {@link initOpenFileDeepLinks} is the production
 * caller.
 */
export async function handleOpenFileDeepLinkUrl(raw: string): Promise<void> {
  const parsed = parseOpenFileUrl(raw);
  if (!parsed.ok) return;
  try {
    if (!(await plainFileGateGet())) return;
    const canonical = await plainFileResolvePath(parsed.path);
    pendingOpen = { path: canonical };
    window.dispatchEvent(new Event(OPEN_FILE_EVENT));
  } catch {
    // Gate off, unsupported extension, missing file, unreadable: the route is
    // ignored. Nothing is shown and nothing is logged.
  }
}

/**
 * Subscribe to the launch URL + runtime opens. Called once at boot.
 *
 * `getCurrent()` is the COLD-START arm and `onOpenUrl` the WARM one; the two
 * exist for the same platform reasons `themeDeepLink`'s docs spell out. The
 * theme module holds its own subscription over the same plugin; the two
 * parsers ignore each other's actions by design.
 *
 * No-op outside Tauri (browser dev) and inert if the plugin is unavailable,
 * so a host without deep-link support degrades to "links simply do nothing".
 */
export async function initOpenFileDeepLinks(): Promise<void> {
  if (!HAS_TAURI) return;
  try {
    const { onOpenUrl, getCurrent } = await loadDeepLink();
    const current = await getCurrent().catch(() => null);
    current?.forEach((url) => {
      void handleOpenFileDeepLinkUrl(url);
    });
    await onOpenUrl((urls: string[]) => {
      urls.forEach((url) => {
        void handleOpenFileDeepLinkUrl(url);
      });
    });
  } catch {
    // Plugin missing / older host: deep links are simply inert.
  }
}
