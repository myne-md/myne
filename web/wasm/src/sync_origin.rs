// SPDX-License-Identifier: AGPL-3.0-only
//! The origin string the browser transport sends to (phase3-web-client tasks
//! 35 + 84).
//!
//! Split out of [`crate::sync_transport`] for the same reason
//! [`crate::kdf_ceiling`] and [`myne_core::double_buffer`] are host-compiled:
//! the transport itself is `wasm32`-only JS glue and is beyond every gate that
//! runs in `pre-push`, while this is pure string arithmetic — and it is the part
//! with a wrong answer that is easy to miss.
//!
//! The default-port case is that answer. `https://sync.myne.md:443` and
//! `https://sync.myne.md` are **the same origin** to a browser, but not to a
//! string comparison — and a CORS allow-list, a server log and a
//! `check-web-third-party` scan are all string comparisons. Emitting the
//! explicit `:443` would work in the browser and then read as a different origin
//! everywhere a human or a config file looks.

/// The two schemes a browser transport can be built for.
///
/// Mirrors `myne_core::plugins::sync::http_transport::BrowserScheme` rather than
/// taking a `&str`: the plaintext case is not "http", it is
/// **loopback** http, and the type is where that precondition lives. Core
/// constructs the loopback variant only inside its `is_loopback`-guarded arm, so
/// this side never has to re-check — and could not weaken the rule if it wanted
/// to, because there is no other way to reach the variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    /// `https` — production, any host.
    Https,
    /// `http` to a loopback host — the dev server and the web E2E harness.
    LoopbackHttp,
}

impl Scheme {
    fn as_str(self) -> &'static str {
        match self {
            Scheme::Https => "https",
            Scheme::LoopbackHttp => "http",
        }
    }

    /// The port omitted from an origin for this scheme — a browser treats
    /// `https://h:443` and `https://h` (and `http://h:80` / `http://h`) as one
    /// origin, so emitting the explicit port would make the client's own URL
    /// disagree with every allow-list and log line written against it.
    fn default_port(self) -> u16 {
        match self {
            Scheme::Https => 443,
            Scheme::LoopbackHttp => 80,
        }
    }
}

/// `<scheme>://host` — with `:port` only when it is not the scheme's default.
pub fn origin_for(scheme: Scheme, host: &str, port: u16) -> String {
    let s = scheme.as_str();
    if port == scheme.default_port() {
        format!("{s}://{host}")
    } else {
        format!("{s}://{host}:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_port_is_omitted() {
        // The case that matters: a browser treats these as one origin, so
        // emitting the explicit port would make the client's own URL disagree
        // with every allow-list and log line written against the origin.
        assert_eq!(
            origin_for(Scheme::Https, "sync.myne.md", 443),
            "https://sync.myne.md"
        );
        assert_eq!(
            origin_for(Scheme::LoopbackHttp, "localhost", 80),
            "http://localhost"
        );
    }

    #[test]
    fn a_non_default_port_is_kept() {
        assert_eq!(
            origin_for(Scheme::Https, "sync.myne.md", 8443),
            "https://sync.myne.md:8443"
        );
        assert_eq!(
            origin_for(Scheme::Https, "localhost", 8080),
            "https://localhost:8080"
        );
        // The harness shape: `parse_endpoint` requires an explicit port for
        // http, so this is the case that actually occurs.
        assert_eq!(
            origin_for(Scheme::LoopbackHttp, "127.0.0.1", 8453),
            "http://127.0.0.1:8453"
        );
    }

    #[test]
    fn each_schemes_default_port_belongs_to_that_scheme() {
        // The trap this pins: 443 is not a default for `http` and 80 is not one
        // for `https`. Sharing one `DEFAULT_PORT` constant across both — the
        // shape this file had while it was https-only — would silently drop the
        // port from `http://host:443`, producing an origin that points at a
        // different server than the one configured.
        assert_eq!(
            origin_for(Scheme::LoopbackHttp, "localhost", 443),
            "http://localhost:443"
        );
        assert_eq!(
            origin_for(Scheme::Https, "localhost", 80),
            "https://localhost:80"
        );
    }

    #[test]
    fn plaintext_is_reachable_only_through_the_loopback_variant() {
        // There is no `Scheme` value that yields plain `http` for an arbitrary
        // host: the only plaintext variant is named for its precondition, and
        // core constructs it exclusively inside its `is_loopback` arm. So this
        // asserts the naming rather than a runtime check — the runtime check
        // lives one layer up, where it can see the host.
        assert!(origin_for(Scheme::Https, "example.test", 8443).starts_with("https://"));
        assert_eq!(Scheme::LoopbackHttp.as_str(), "http");
    }

    #[test]
    fn the_origin_carries_no_path() {
        // Paths are appended per request. An origin with a trailing slash would
        // produce `https://host//v1/pull`, which some servers 404 and others
        // silently normalise — the kind of difference that shows up only against
        // one deployment.
        let origin = origin_for(Scheme::Https, "sync.myne.md", 443);
        assert!(!origin.ends_with('/'));
        assert_eq!(format!("{origin}/v1/pull"), "https://sync.myne.md/v1/pull");
    }
}
