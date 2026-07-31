//! The **no-bypass guard**: in Tor mode, the tunnel is total (MYND-650 task 4).
//!
//! `proxy::ProxyGate` makes the fail-closed decision and `rustls_transport`
//! obeys it — but only for the sockets that go through
//! `RustlsTransport::open_socket`. Nothing about the type system stops a future
//! change from opening one somewhere else: a retry helper that dials the host
//! itself, a "quick reachability check" before a sync cycle, a second transport
//! for one endpoint. Each of those compiles, passes every existing test, and
//! silently leaks the user's real source IP the moment Tor mode is on.
//!
//! So this module is a source-level ratchet over the sync tree, in the shape of
//! `src-tauri/src/no_egress.rs`: every place the sync code can open an outbound
//! socket is **listed here with the reason it is not a bypass**, and the count
//! is the assertion. Adding a socket site turns this test red and the fix is to
//! either route it through the gate or write down why it does not need to be —
//! which is exactly the moment that decision should be made rather than four
//! months later in review.
//!
//! ## What it scans, and what it deliberately does not
//!
//! Only the **production** half of each file: the scanner truncates at the
//! first `#[cfg(test)]`, because the test code below it legitimately dials fake
//! proxies, echo servers and probe listeners, and those are not shipped. Every
//! `#[cfg(test)]` module in this directory sits at the end of its file, which is
//! what makes that rule a clean cut rather than a guess.
//!
//! Comment lines are stripped before counting, so prose that *names* one of
//! these tokens — `socks5`'s module doc explaining that it never calls
//! `to_socket_addrs` — is documentation rather than a violation. Modules
//! `mod.rs` declares under a `test` cfg are skipped entirely (the simulation
//! harness, and this file, which has to spell the tokens out to look for them).
//!
//! It is a **string** scan, and that is a real limit worth stating: an alias
//! (`use std::net::TcpStream as S;`) or a socket opened through a helper crate
//! would slip past it. It catches the shape a bypass is actually written in —
//! someone reaching for `TcpStream::connect` because that is what the file next
//! door does — not an adversary evading the guard. The adversary in the threat
//! model is not the person editing this repo.

use std::path::PathBuf;

/// Every production outbound-socket site in the sync tree, and why it is not a
/// Tor bypass. `(file, expected `TcpStream::connect*` sites, reason)`.
///
/// A file absent from this table must have **zero**.
const DIRECT_CONNECT_SITES: &[(&str, usize, &str)] = &[
    (
        "rustls_transport.rs",
        2,
        "1. `open_socket`'s `Route::Direct` arm — reachable only when the gate \
         says Tor mode is off, which is the whole fail-closed decision. \
         2. `tofu_fetch_pin` — the one-shot enrollment handshake, still direct \
         and owed to task 5 (routing it needs the mandatory out-of-band \
         fingerprint compare that defends against a hostile exit node).",
    ),
    (
        "http_transport.rs",
        2,
        "`HttpTransport`'s request + SSE sockets. Loopback-only by construction: \
         `build_transport` reaches this transport solely through its \
         `is_loopback`-guarded arm, so these sockets never leave the device and \
         there is no source IP to expose. Same predicate `proxy::host_is_tor_exempt` \
         uses.",
    ),
    (
        "socks5.rs",
        1,
        "The connection to the loopback SOCKS5 proxy itself — i.e. the tunnel, \
         not a way around it. It dials a literal `Ipv4Addr::LOCALHOST`, so not \
         even the proxy's own address goes near a resolver.",
    ),
];

/// Tokens that would resolve a name on this device. The sync hostname must be
/// resolved **inside the circuit** in Tor mode (`socks5`'s domain-name
/// `CONNECT`), so a local lookup in this tree is a DNS leak even when the
/// socket that follows is correctly tunneled.
const LOCAL_RESOLUTION_TOKENS: &[&str] = &["to_socket_addrs", "ToSocketAddrs", "lookup_host"];

fn sync_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/plugins/sync")
}

/// The scannable half of `source`: everything before the first `#[cfg(test)]`,
/// with comment lines dropped.
fn production_code(source: &str) -> String {
    let head = match source.find("#[cfg(test)]") {
        Some(at) => &source[..at],
        None => source,
    };
    head.lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Modules this directory's `mod.rs` declares under a `test` cfg — the
/// simulation harness, and this guard itself. They are not shipped, so their
/// sockets are not egress; and asking `mod.rs` beats a hardcoded list, which
/// would go stale the first time somebody adds a test-only module.
fn test_only_modules() -> Vec<String> {
    let mod_rs = std::fs::read_to_string(sync_dir().join("mod.rs")).expect("read mod.rs");
    let mut out = Vec::new();
    let mut gated = false;
    for line in mod_rs.lines() {
        let line = line.trim();
        if line.starts_with("#[cfg(") {
            // `#[cfg(test)]` and `#[cfg(all(test, …))]`, but NOT
            // `#[cfg(feature = "test-support")]`.
            gated = line.contains("test)") || line.contains("test,");
            continue;
        }
        if let Some(rest) = line
            .strip_prefix("mod ")
            .or_else(|| line.strip_prefix("pub mod "))
        {
            if gated {
                if let Some(name) = rest.strip_suffix(';') {
                    out.push(format!("{name}.rs"));
                }
            }
            gated = false;
        }
    }
    out
}

/// Every shipped `<name>.rs` directly under `core/src/plugins/sync/`, with its
/// production code.
fn sync_sources() -> Vec<(String, String)> {
    let skip = test_only_modules();
    let mut out = Vec::new();
    for entry in std::fs::read_dir(sync_dir()).expect("read sync dir") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .expect("file name")
            .to_string();
        if skip.contains(&name) {
            continue;
        }
        let source = std::fs::read_to_string(&path).expect("read source");
        out.push((name, production_code(&source)));
    }
    assert!(!out.is_empty(), "the scanner found no sources to scan");
    out
}

fn count(haystack: &str, needle: &str) -> usize {
    haystack.matches(needle).count()
}

/// No production socket site in the sync tree is unaccounted for.
#[test]
fn every_outbound_socket_site_is_listed_with_its_reason() {
    for (name, source) in sync_sources() {
        let found = count(&source, "TcpStream::connect");
        let (expected, reason) = DIRECT_CONNECT_SITES
            .iter()
            .find(|(f, _, _)| *f == name)
            .map(|(_, n, why)| (*n, *why))
            .unwrap_or((0, "not an outbound-socket site"));
        assert_eq!(
            found, expected,
            "{name}: expected {expected} production `TcpStream::connect` site(s), found {found}.\n\
             Recorded reason: {reason}\n\
             A NEW socket here is a Tor bypass unless it goes through \
             `RustlsTransport::open_socket` (which consults `ProxyGate::route`). \
             Route it, or add it to `DIRECT_CONNECT_SITES` with the reason it \
             cannot leak a source IP."
        );
    }
}

/// The gate is actually consulted where the socket is opened. Without this, the
/// site count above would still pass after someone deleted the `route()` call
/// and left the `TcpStream::connect` behind.
#[test]
fn the_transports_socket_site_consults_the_routing_gate() {
    let source = sync_sources()
        .into_iter()
        .find(|(n, _)| n == "rustls_transport.rs")
        .map(|(_, s)| s)
        .expect("rustls_transport.rs");
    assert!(
        source.contains("self.proxy.route()"),
        "`RustlsTransport` must consult its `ProxyGate` before opening a socket"
    );
    assert!(
        source.contains("connect_via_socks5"),
        "`RustlsTransport` must have a tunneled arm, or Tor mode routes nothing"
    );
}

/// No production code in the sync tree resolves a hostname locally.
///
/// This is the DNS half of the invariant, and it is separate from the socket
/// half on purpose: a correctly tunneled connection preceded by a local lookup
/// still tells the ISP, the local network and whoever runs the resolver exactly
/// which sync server this device talks to.
#[test]
fn no_production_sync_code_resolves_a_hostname_locally() {
    for (name, source) in sync_sources() {
        for token in LOCAL_RESOLUTION_TOKENS {
            assert!(
                !source.contains(token),
                "{name}: `{token}` resolves a name on this device. In Tor mode the \
                 sync hostname must be resolved inside the circuit — it travels as \
                 a SOCKS5 domain-name `CONNECT` (`socks5::encode_connect_request`), \
                 never as an address."
            );
        }
    }
}

/// The loopback exemption is exactly three names, and this guard would notice
/// it growing. Widening it is how "Tor mode is on" quietly stops meaning
/// anything for some host somebody added.
#[test]
fn the_tor_exemption_covers_only_loopback() {
    use super::proxy::host_is_tor_exempt;
    assert!(["127.0.0.1", "localhost", "::1"]
        .iter()
        .all(|h| host_is_tor_exempt(h)));
    for host in [
        "sync.myne.md",
        "0.0.0.0",
        "127.0.0.2",
        "10.0.0.1",
        "192.168.1.1",
        "example.onion",
        "localhost.attacker.example",
    ] {
        assert!(
            !host_is_tor_exempt(host),
            "{host} must be routed through Tor when Tor mode is on"
        );
    }
}
