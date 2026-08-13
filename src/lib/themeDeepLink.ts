// `myne://theme/install` deep-link handling (MYND-567) — the desktop half of
// the one-click theme install. The website (MYND-568) hands the OS a
// `myne://theme/install?…` link; the OS resolves it to the installed app; this
// module turns the URL into a confirmable install request.
//
// ## Why the palette rides INSIDE the URL
//
// The obvious design — put a `source` URL in the link and let the app fetch the
// theme — is **structurally impossible here**: the client has no network egress
// path at all. The WebView CSP `connect-src` is an allowlist of `'self'` + the
// local IPC/attachment schemes, the Rust host carries no HTTP-client crate, and
// both facts are enforced as a hard gate (`src-tauri/src/no_egress.rs`). So the
// link carries the whole palette as a base64url-encoded JSON payload, and the
// app never dereferences anything. A `src` parameter may ride along, but it is
// **displayed provenance only** — never fetched.
//
// This costs nothing in practice: a real gallery theme is a flat map of ~21
// required tokens, ~480–730 bytes minified, ~640–970 base64url chars. A whole
// link stays near 1 KB, well inside the tightest platform budget (the Windows
// registry `%1` command line).
//
// ## Trust posture — every field here is hostile input
//
// Any website can serve a `myne://` link, so nothing in the URL is trusted:
//
//   - The palette is NOT applied by parsing. It still has to clear the shared
//     `theme_validator` value-shape allowlist inside `themes_import` — the
//     security-load-bearing injection guard (a value reaching the DOM executes
//     under `style-src 'unsafe-inline'`; threat-model §149) — before any write.
//     This module deliberately does NOT re-implement that allowlist: it does
//     only the structural decode needed to render a preview, so the grammar
//     keeps ONE source of truth, host-side.
//   - `name` / `author` / `src` are attacker-chosen display strings. They are
//     length-capped and control-character-stripped here, and the dialog frames
//     them as claims made by the link, never as verified facts.
//   - A deep-linked theme is NEVER applied without explicit confirmation.
//
// ## Scheme grammar (shared across the fleet)
//
// `myne://` is co-owned with the mobile client, which already ships
// `myne://open` and `myne://capture?mode=voice` (`mobile/src/lib/deep-link.ts`).
// Desktop adds the `theme` action; the two parsers ignore each other's actions
// by design, so neither has to know the other's grammar.
//
//   myne://theme/install?v=1&name=<name>&author=<author>&src=<url>&payload=<base64url>

import { loadDeepLink } from "../platform/deepLink";
import { HAS_TAURI } from "./app-window";
import type { ThemePalette } from "./themes";

/** The URL action this module owns: `myne://theme/install`. */
const INSTALL_HOST = "theme";
const INSTALL_PATH = "install";

/**
 * The only payload-format version this build understands. A link minted by a
 * NEWER website is rejected as {@link ThemeDeepLinkRejection} `"unsupported-version"`
 * so the user is told to update rather than shown a silently-wrong theme.
 */
export const THEME_DEEP_LINK_VERSION = "1";

/**
 * Decoded-payload ceiling. ~20× the largest real gallery theme (a 724-byte
 * Nocturne), so it never binds on legitimate input while still bounding what a
 * hostile link can push through the decoder and into the host validator.
 */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

/** Cheap pre-decode guard so a pathological URL is rejected before `atob`. */
const MAX_ENCODED_PAYLOAD_CHARS = Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3) + 4;

/** Display-string ceilings — a theme name is a label, not a document. */
export const MAX_NAME_CHARS = 64;
const MAX_AUTHOR_CHARS = 96;
const MAX_SOURCE_CHARS = 256;

/** A parsed, structurally-sound install request awaiting user confirmation. */
export interface ThemeInstallRequest {
  /** The name the theme will be stored under. Sanitized, never empty. */
  name: string;
  /** Claimed author, for display only. `null` when the link omitted it. */
  author: string | null;
  /** Claimed source URL, for display only — NEVER fetched. `null` when absent. */
  source: string | null;
  /**
   * The decoded palette JSON, verbatim, as it will be handed to `themes_import`.
   * Still UNVALIDATED against the value-shape allowlist — that happens host-side.
   */
  paletteJson: string;
  /** The same palette parsed into a map, for rendering the confirm preview. */
  palette: ThemePalette;
}

/**
 * Why a `myne://` URL did not become an install request.
 *
 * `"not-a-theme-link"` is the SILENT case — it covers junk and, more
 * importantly, the mobile client's own actions (`myne://open`, `myne://capture`).
 * Every other reason is a genuine theme-install attempt that failed and must be
 * surfaced, so a bad link never fails quietly (MYND-567 AC: an invalid payload
 * is rejected with a visible error and nothing is written).
 */
export type ThemeDeepLinkRejection =
  | "not-a-theme-link"
  | "unsupported-version"
  | "invalid-name"
  | "missing-payload"
  | "malformed-payload"
  | "payload-too-large";

export type ThemeDeepLinkResult =
  | { ok: true; request: ThemeInstallRequest }
  | { ok: false; reason: ThemeDeepLinkRejection };

/**
 * Strip control characters (including the bidi overrides that could make a
 * displayed name lie about itself) and collapse whitespace, then cap the length.
 * Returns `null` when nothing printable survives.
 */
function sanitizeDisplay(raw: string | null, maxChars: number): string | null {
  if (raw === null) return null;
  // C0/C1 controls plus the bidi overrides (U+200E/200F, U+202A-202E,
  // U+2066-2069) — a name carrying those could render right-to-left and
  // display something other than what gets stored.
  const stripped = raw.replace(
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;
  // Slice by CODE POINTS. `String.slice` cuts UTF-16 units, so a name whose
  // boundary falls inside a surrogate pair would yield a lone surrogate — which
  // `JSON.stringify` happily emits and `serde_json` then rejects, turning a
  // perfectly good link into a generic import failure. It also makes the cap
  // mean what it says for emoji and astral-plane scripts.
  const points = Array.from(collapsed);
  return points.length <= maxChars ? collapsed : points.slice(0, maxChars).join("");
}

/**
 * Decode an unpadded base64url payload to its UTF-8 text.
 *
 * Rejects (returns `null`) on a non-base64url alphabet, a broken decode, or
 * bytes that are not valid UTF-8 (`TextDecoder` runs in `fatal` mode) — a
 * malformed payload must never reach the host as a half-decoded string.
 */
function decodeBase64UrlUtf8(encoded: string): { text: string; byteLength: number } | null {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) return null;
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(withPadding);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), byteLength: bytes.length };
  } catch {
    return null;
  }
}

/**
 * Structural read of the decoded payload: it must be a flat JSON object whose
 * every value is a string.
 *
 * This is NOT the security check — the value-shape allowlist that decides which
 * CSS values are safe lives in the `theme_validator` crate and runs host-side in
 * `themes_import`. Duplicating it here would create a second grammar to keep in
 * sync. All this buys is an honest early error and a renderable preview.
 */
function parsePaletteShape(json: string): ThemePalette | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const palette: ThemePalette = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") return null;
    palette[key] = entry;
  }
  return palette;
}

/**
 * Parse one `myne://` URL into an install request.
 *
 * Pure — no DOM writes, no IPC, no side effects — so the whole rejection matrix
 * is unit-testable. The caller decides what to surface;
 * {@link handleThemeDeepLinkUrl} is the production caller.
 */
export function parseThemeInstallUrl(raw: string): ThemeDeepLinkResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not-a-theme-link" };
  }
  if (url.protocol !== "myne:") return { ok: false, reason: "not-a-theme-link" };
  // A non-special scheme keeps its host verbatim (the WHATWG opaque-host parser
  // does not lowercase), so fold it here rather than trusting the URL object.
  const action = url.host.toLowerCase();
  const path = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
  if (action !== INSTALL_HOST || path !== INSTALL_PATH) {
    return { ok: false, reason: "not-a-theme-link" };
  }

  // Past this point the link IS a theme-install attempt, so every failure is
  // reported rather than swallowed.
  if (url.searchParams.get("v") !== THEME_DEEP_LINK_VERSION) {
    return { ok: false, reason: "unsupported-version" };
  }

  const name = sanitizeDisplay(url.searchParams.get("name"), MAX_NAME_CHARS);
  if (name === null) return { ok: false, reason: "invalid-name" };

  const encoded = url.searchParams.get("payload");
  if (encoded === null || encoded === "") return { ok: false, reason: "missing-payload" };
  if (encoded.length > MAX_ENCODED_PAYLOAD_CHARS) return { ok: false, reason: "payload-too-large" };

  const decoded = decodeBase64UrlUtf8(encoded);
  if (decoded === null) return { ok: false, reason: "malformed-payload" };
  if (decoded.byteLength > MAX_PAYLOAD_BYTES) return { ok: false, reason: "payload-too-large" };

  const palette = parsePaletteShape(decoded.text);
  if (palette === null) return { ok: false, reason: "malformed-payload" };

  // Provenance is shown, never dereferenced — but a `src` that is not a plain
  // web URL is dropped rather than displayed, so the dialog cannot be used to
  // render a `javascript:`/`data:` string that looks like a source.
  let source = sanitizeDisplay(url.searchParams.get("src"), MAX_SOURCE_CHARS);
  if (source !== null) {
    try {
      const parsed = new URL(source);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") source = null;
    } catch {
      source = null;
    }
  }

  return {
    ok: true,
    request: {
      name,
      author: sanitizeDisplay(url.searchParams.get("author"), MAX_AUTHOR_CHARS),
      source,
      paletteJson: decoded.text,
      palette,
    },
  };
}

/**
 * Window event fired when a theme-install link arrives while the app is already
 * running and past unlock. Cold launch (and arrival while locked) is covered by
 * the latch below instead — the editor is not mounted to hear an event yet.
 */
export const THEME_INSTALL_EVENT = "myne://theme-install-requested";

/**
 * A result that arrived before anything could show it — a cold launch, or a
 * link that landed on the locked vault. Held until the editor mounts
 * post-unlock, then consumed exactly once.
 *
 * Deliberately a single slot, not a queue: these are user-initiated clicks, and
 * a second click before the first is even confirmed means the user changed
 * their mind. The newest link wins.
 */
let pendingSignal: ThemeDeepLinkResult | null = null;

/**
 * Take (and clear) a signal latched before the editor could present it.
 *
 * Dropping it on read is what implements "drop the request if the user never
 * unlocks" — the latch lives in page memory only, so quitting at the unlock
 * screen discards it with the process, and nothing is ever persisted to disk.
 */
export function consumePendingThemeInstall(): ThemeDeepLinkResult | null {
  const signal = pendingSignal;
  pendingSignal = null;
  return signal;
}

/**
 * Discard any latched result without acting on it. No production caller today —
 * the latch is page memory, so a lock or quit drops it anyway; this exists so
 * tests can reset the module between cases.
 */
export function clearPendingThemeInstall(): void {
  pendingSignal = null;
}

/**
 * Route one incoming URL: latch it AND announce it. Unknown `myne://` actions
 * (the mobile client's `open` / `capture`) and junk are ignored silently.
 *
 * Both paths always run: the latch covers "nothing is listening yet" (cold
 * launch, locked vault) and the event covers "the editor is already mounted".
 * The editor consumes the latch when it handles the event, so exactly one
 * dialog appears either way.
 *
 * Exported for unit coverage of the latch; {@link initThemeDeepLinks} is the
 * production caller.
 */
export function handleThemeDeepLinkUrl(raw: string): void {
  const result = parseThemeInstallUrl(raw);
  if (!result.ok && result.reason === "not-a-theme-link") return;
  pendingSignal = result;
  // A bare notification, deliberately: the LATCH is the payload, and it is what
  // enforces consume-exactly-once. An event carrying the signal too would let a
  // future listener act on it while the latch still held it — two dialogs, one
  // link.
  window.dispatchEvent(new Event(THEME_INSTALL_EVENT));
}

/**
 * Subscribe to the launch URL + runtime opens. Called once at boot.
 *
 * `getCurrent()` is the COLD-START arm: on Windows/Linux the OS launches the app
 * with the URL as its only argv (the Rust `setup` hook seeds the plugin from it);
 * on macOS the URL arrives as an Apple event the plugin captures. `onOpenUrl` is
 * the WARM arm — on Windows/Linux a second process's argv relayed through the
 * single-instance callback, on macOS a further `RunEvent::Opened`.
 *
 * No-op outside Tauri (browser dev) and inert if the plugin is unavailable, so a
 * host without deep-link support degrades to "links simply do nothing".
 */
export async function initThemeDeepLinks(): Promise<void> {
  if (!HAS_TAURI) return;
  try {
    const { onOpenUrl, getCurrent } = await loadDeepLink();
    const current = await getCurrent().catch(() => null);
    current?.forEach(handleThemeDeepLinkUrl);
    await onOpenUrl((urls: string[]) => urls.forEach(handleThemeDeepLinkUrl));
  } catch {
    // Plugin missing / older host — deep links are simply inert.
  }
}
