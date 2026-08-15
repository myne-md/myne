// Deep-link bridge for the iOS home / lock-screen widgets + Control Center
// "New note" action (see `ios-widgets/`). The widget process lives OUTSIDE the
// plaintext trust boundary, so a widget can never carry vault content — all it
// does is hand the app a URL naming an intent:
//
//   myne://open              — WG-01 / lock-screen / StandBy launcher
//   myne://capture           — WG-02 quick capture → start a new note
//   myne://capture?mode=voice — voice capture (the widget mic button) → opens a
//                               fresh note AND the voice-recording sheet
//
// The route is resolved entirely app-side, INSIDE the trust boundary: `open`
// needs no work (launching already foregrounds the unlock screen), and `capture`
// drives the React new-note editor after unlock — `mode: "voice"` additionally
// opens the WebView recording sheet (`RecordingSheet.tsx`), which records audio
// with the Web Audio API and stores it as an encrypted `audio/wav` attachment.
// There is no second, unaudited native capture path (the design-only
// `CaptureSheet.swift` is not wired). Because a widget tap on a locked device
// cold-launches the app, the capture intent is LATCHED and replayed once the
// editor mounts post-unlock.

import { loadDeepLink } from "../platform/deepLink";
import { HAS_TAURI } from "./app-window";

export type CaptureMode = "text" | "voice";

/** Fired on the window whenever a `myne://capture` URL arrives while the app is
 *  already running (the editor listens and opens a new note). Cold-launch is
 *  covered by the latch below, not this event. */
export const CAPTURE_EVENT = "myne-deep-link-capture";

// A capture intent that arrived before the editor was mounted (cold launch on a
// locked device). Consumed once, when the editor mounts post-unlock.
let pendingCapture: CaptureMode | null = null;

/** Parse one incoming `myne://…` URL and dispatch/latch its intent. Unknown or
 *  non-`myne:` URLs are ignored. Exported for unit coverage of the cold-launch
 *  latch + `?mode=` parse (E2E-gap #39); `initDeepLinks` is the production
 *  caller. */
export function handleUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return;
  }
  if (u.protocol !== "myne:") return;
  // `myne://capture` parses the action into the host; fall back to the path for
  // parser quirks on non-special schemes.
  const action = (u.host || u.pathname.replace(/^\/+/, "")).toLowerCase();
  if (action !== "capture") return; // "open" needs no action beyond launching.
  const mode: CaptureMode = u.searchParams.get("mode") === "voice" ? "voice" : "text";
  pendingCapture = mode;
  window.dispatchEvent(new CustomEvent<{ mode: CaptureMode }>(CAPTURE_EVENT, { detail: { mode } }));
}

/** Take (and clear) a capture intent latched before the editor mounted. */
export function consumePendingCapture(): CaptureMode | null {
  const p = pendingCapture;
  pendingCapture = null;
  return p;
}

/** Subscribe to the launch URL + runtime opens. Called once at boot. No-op in
 *  browser dev (no Tauri host) and inert if the plugin is unavailable. */
export async function initDeepLinks(): Promise<void> {
  if (!HAS_TAURI) return;
  try {
    const { onOpenUrl, getCurrent } = await loadDeepLink();
    // Cold launch: the URL the widget tapped opened us with.
    const current = await getCurrent().catch(() => null);
    current?.forEach(handleUrl);
    // Warm: the app is already open and the user taps a widget again.
    await onOpenUrl((urls: string[]) => urls.forEach(handleUrl));
  } catch {
    // Plugin missing / older host — deep links are simply inert.
  }
}
