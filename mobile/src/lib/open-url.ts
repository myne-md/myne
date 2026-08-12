// Opening a URL in the phone's browser (operations#15).
//
// The plugin was already here — `tauri-plugin-opener` is in `src-tauri/Cargo.toml`
// and `opener:default` is granted in `src-tauri/capabilities/default.json`,
// which resolves to `allow-open-url` for `https:`/`http:`/`mailto:`/`tel:`.
// What was missing was a way to call it: the npm binding
// (`@tauri-apps/plugin-opener`) is not a dependency of this app, so the only
// external-open in the tree was `editor-host.ts`'s `window.open` fallback,
// which its own comment marks as best-effort.
//
// Rather than add the npm package for one call, this goes through `invoke`
// like every other plugin on this client (`commands.ts`) — the binding is a
// one-line wrapper over exactly that, and skipping it keeps the dependency
// surface where it is (`decisions.md` 2026-04-26: adding a dependency is a
// security decision).
//
// `window.open` inside a WebView is not a substitute. Depending on the platform
// it opens an in-app view, is swallowed by the popup blocker, or does nothing;
// the plugin hands the URL to the OS, which is what "open in the browser"
// means to the person tapping it.

import { invoke } from "@tauri-apps/api/core";

/**
 * Hand a URL to the operating system's default handler.
 *
 * Rejects if the plugin refuses the scheme — the capability grants `https`,
 * `http`, `mailto` and `tel`, and nothing else. Callers that are decorating a
 * link should treat a rejection as "the link did not open" rather than
 * retrying: there is no second door.
 */
export async function openUrl(url: string): Promise<void> {
  await invoke<void>("plugin:opener|open_url", { url, with: null });
}
