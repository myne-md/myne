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
//! Only the **production** half of each file: the scanner removes every
//! `#[cfg(test)]`-gated item, because test code legitimately dials fake
//! proxies, echo servers and probe listeners, and none of it is shipped.
//!
//! It removes each gated item *individually* rather than truncating at the
//! first one. The earlier rule — cut everything after the first
//! `#[cfg(test)]` — rested on "every test module sits at the end of its file",
//! which is not true of this directory: `enroll.rs` has test modules at three
//! points, the first about a quarter of the way in, and `conflict.rs`,
//! `socks5.rs` and `progress.rs` are the same shape. Under that rule the
//! scanner silently skipped the ~1100 production lines of `enroll.rs` that
//! follow its first test module — including, as of task 5, the join flow's
//! pin acquisition. A guard that reads a fraction of the tree and reports
//! "ok" is worse than no guard, because it is believed.
//!
//! A gated item is found by its attribute line and removed up to the line that
//! closes it at the same indentation (`<indent>}`), which is what this tree's
//! rustfmt output guarantees. Brace *counting* was rejected deliberately: the
//! test bodies are full of JSON and HTTP fixtures carrying `{` inside string
//! literals, and a miscount there would silently swallow production code —
//! the exact failure this replaces.
//!
//! Comment lines are stripped before counting, so prose that *names* one of
//! these tokens — `socks5`'s module doc explaining that it never calls
//! `to_socket_addrs` — is documentation rather than a violation. Modules
//! `mod.rs` declares under a `test` cfg are skipped entirely (the simulation
//! harness, and this file, which has to spell the tokens out to look for them).
//!
//! ## The second axis: socket *lifetime* (MYND-650 review)
//!
//! Counting connect *sites* answers "was this socket opened through the gate".
//! It structurally cannot answer "is it still allowed to be open" — a connect
//! that was correctly gated when it happened keeps carrying bytes after the
//! gate moves, and the guard sees nothing because no new site appeared. That
//! is not a hypothetical: the SSE poke stream held a direct connection open
//! indefinitely across a Tor toggle, because its read timeout deliberately sits
//! above the server's heartbeat cadence so a healthy stream never times out.
//!
//! So [`LONG_LIVED_SOCKETS`] lists every socket in this tree that outlives the
//! call that opened it, with what invalidates it, and
//! [`the_long_lived_sockets_are_invalidated_by_the_routing_gate`] asserts each
//! one still carries that invalidation. A request/response socket needs no
//! entry: it is gone before the gate can move under it.
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
        1,
        "`open_socket_via`'s `Route::Direct` arm — reachable only when the gate \
         says Tor mode is off, which is the whole fail-closed decision. Both \
         socket sites in that file (the transport's `open_socket` and the \
         one-shot enrollment handshake `tofu_fetch_pin_via`) share it, so there is \
         one arm rather than one per caller. Task 5 routed the enrollment \
         handshake and paired it with `pin_confirm`'s mandatory out-of-band \
         fingerprint compare, which is what makes an accept-any-certificate \
         handshake safe to send through an exit node.",
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

/// Every production socket in the sync tree that OUTLIVES the call that opened
/// it, and the tokens proving it is invalidated when the routing gate moves.
/// `(file, what keeps it open, tokens that must ALL appear, why)`.
///
/// Two tokens rather than one because the tie has two halves and either can be
/// removed on its own: the gate for *this endpoint* has to be resolved, and its
/// answer has to end up in the identity. A refactor that kept the first and
/// dropped the second would leave a stream whose route is decided once.
///
/// A file absent from this table opens no socket it keeps.
const LONG_LIVED_SOCKETS: &[(&str, &str, &[&str], &str)] = &[(
    "poke_listener.rs",
    "the `/sync/poke` SSE stream — one connection per unlocked enrolled vault, \
     held open for hours",
    &[
        "stream_identity_over(snap, &proxy::installed_for(&host))",
        "route: gate.route().ok()?",
    ],
    "The route the gate answers for this endpoint is part of the worker's \
     `StreamIdentity`, re-read every supervisor tick, so a Tor toggle (or a \
     bootstrap completing, or a sidecar dying) makes the live stream a \
     DIFFERENT identity and the supervisor tears it down. Without this term the \
     stream survives the toggle: `SSE_READ_TIMEOUT` is deliberately above the \
     server's heartbeat cadence, so a healthy direct connection never times out \
     and keeps exposing the source IP while the UI reports Tor is on.",
)];

/// The keep-alive request socket in `http_transport.rs` is deliberately NOT in
/// [`LONG_LIVED_SOCKETS`]: it is loopback-only by construction (see
/// [`DIRECT_CONNECT_SITES`]), so there is no source IP for a moved gate to
/// expose. `rustls_transport`'s sockets do not outlive their request.
#[test]
fn the_long_lived_sockets_are_invalidated_by_the_routing_gate() {
    for (file, what, tokens, why) in LONG_LIVED_SOCKETS {
        let source = sync_sources()
            .into_iter()
            .find(|(n, _)| n == file)
            .map(|(_, s)| s)
            .unwrap_or_else(|| panic!("{file}: listed as a long-lived socket but not scanned"));
        for token in *tokens {
            assert!(
                source.contains(token),
                "{file}: {what} no longer ties its lifetime to the routing gate.\n\
                 Expected to find: {token}\n\
                 Why it is load-bearing: {why}\n\
                 A socket opened before the gate moved is invisible to the \
                 connect-site count above — routing a NEW connection correctly is \
                 not the same as closing an old one."
            );
        }
    }
}

/// Tokens that would resolve a name on this device. The sync hostname must be
/// resolved **inside the circuit** in Tor mode (`socks5`'s domain-name
/// `CONNECT`), so a local lookup in this tree is a DNS leak even when the
/// socket that follows is correctly tunneled.
const LOCAL_RESOLUTION_TOKENS: &[&str] = &["to_socket_addrs", "ToSocketAddrs", "lookup_host"];

fn sync_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/plugins/sync")
}

/// The second scanned root: the shared HTTP codec, promoted out of this tree by
/// ai-ollama-local task 1.
///
/// It is scanned separately rather than folded into [`sync_sources`] for a dull
/// but load-bearing reason: both trees contain a `mod.rs`, and this table keys
/// on the bare file name. Merging them would have made one `mod.rs` shadow the
/// other — a collision that silently drops a file from the scan is exactly the
/// class of bug the "found no sources" assertion exists to catch, so it is not
/// worth introducing to save a loop.
fn http_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/http")
}

/// Is `line` a `#[cfg(…)]` attribute that gates its item OUT of a production
/// build because it is test-only?
///
/// `#[cfg(test)]` and `#[cfg(all(test, …))]`, but NOT
/// `#[cfg(feature = "test-support")]` (which ships when a consumer asks for it)
/// and not `#[cfg(not(test))]`.
fn is_test_cfg(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("#[cfg(")
        && !t.contains("not(test")
        && (t.contains("test)") || t.contains("test,"))
}

/// The scannable half of `source`: every `#[cfg(test)]`-gated item removed,
/// then comment lines dropped.
fn production_code(source: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut lines = source.lines().peekable();
    while let Some(line) = lines.next() {
        if !is_test_cfg(line) {
            if !line.trim_start().starts_with("//") {
                out.push(line);
            }
            continue;
        }
        // Skip any further attributes — and any comment — stacked on the same
        // item, then the item itself: a block (`… {`) runs to its own closing
        // brace at this indentation; anything else (`mod sim;`, a gated `use`)
        // is one line.
        let indent = &line[..line.len() - line.trim_start().len()];
        let mut header = lines.next();
        while header.is_some_and(|h| {
            let t = h.trim_start();
            t.starts_with("#[") || t.starts_with("//") || t.is_empty()
        }) {
            header = lines.next();
        }
        let Some(header) = header else { break };
        if !header.trim_end().ends_with('{') {
            continue;
        }
        let closer = format!("{indent}}}");
        for body in lines.by_ref() {
            if body == closer {
                break;
            }
        }
    }
    out.join("\n")
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

/// **The scanner's own test.** Every assertion below is only worth what this
/// function is worth: a scanner that quietly drops production code reports
/// "ok" forever, which is exactly how the truncate-at-the-first-`#[cfg(test)]`
/// version hid the whole back half of `enroll.rs`.
#[test]
fn the_scanner_drops_test_items_and_keeps_the_production_code_after_them() {
    let src = r#"
fn before() { TcpStream::connect(a) }

#[cfg(test)]
// A comment between the attribute and the item — rustfmt permits it, and the
// first version of this scanner was defeated by exactly this shape.
mod tests {
    fn helper() { TcpStream::connect("fake proxy") }
    // A brace inside a string literal, which is why this is not brace-counting.
    const BODY: &str = "{\"ok\":true}";
}

fn after() { TcpStream::connect(b) }

#[cfg(all(test, not(target_arch = "wasm32")))]
mod more_tests {
    fn another() { TcpStream::connect("echo server") }
}

#[cfg(feature = "test-support")]
pub fn ships_when_asked_for() { TcpStream::connect(c) }
"#;
    let out = production_code(src);
    assert!(
        out.contains("fn before"),
        "code before a test module is scanned"
    );
    assert!(
        out.contains("fn after"),
        "code AFTER a test module is scanned — the bug this replaces"
    );
    assert!(
        out.contains("ships_when_asked_for"),
        "`test-support` is a shipped feature, not a test gate"
    );
    assert!(!out.contains("fn helper"), "the test module is dropped");
    assert!(
        !out.contains("fn another"),
        "`cfg(all(test, …))` is dropped too"
    );
    assert_eq!(
        count(&out, "TcpStream::connect"),
        3,
        "exactly the three production sites, none of the test ones"
    );
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

/// Production sources of the shared HTTP codec, same stripping as
/// [`sync_sources`].
fn http_sources() -> Vec<(String, String)> {
    let dir = http_dir();
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| {
        panic!(
            "read {}: {e}. A root that cannot be read must FAIL, never skip — a \
             guard scanning nothing reports ok forever, which is worse than no \
             guard because it is believed.",
            dir.display()
        )
    }) {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .expect("file name")
            .to_string();
        let source = std::fs::read_to_string(&path).expect("read source");
        out.push((name, production_code(&source)));
    }
    assert!(
        !out.is_empty(),
        "the shared-HTTP root {} contributed no sources — the path is stale",
        http_dir().display()
    );
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

/// The shared HTTP codec opens no socket, and must not start.
///
/// It is pure over `BufRead`/`Write` by design — that purity is what made
/// promoting it out of this tree safe, and it is what keeps it out of the
/// routing gate's concern. A `TcpStream::connect` appearing here would be a
/// socket in a module every transport shares, reached from callers that never
/// consult `ProxyGate::route`.
///
/// **What this root does NOT cover, so no reader concludes otherwise from this
/// file alone:** the AI provider path in `src-tauri/src/plugins/local_inference/`
/// is watched by the call-site ratchet in `src-tauri/scripts/ai-no-network-check.sh`
/// (check 4, landed empty by #414). This module stays in-crate: it is test-only,
/// resolves from `CARGO_MANIFEST_DIR`, and also compiles for mobile and wasm, so
/// reaching across to a sibling crate's sources from here would be fragile in
/// three build configurations to watch a tree that already has an owner.
#[test]
fn the_shared_http_codec_opens_no_socket() {
    let sources = http_sources();
    assert!(
        sources.iter().any(|(n, _)| n == "codec.rs"),
        "the codec itself was not scanned — the root is live but wrong"
    );
    for (name, source) in sources {
        let found = count(&source, "TcpStream::connect");
        assert_eq!(
            found, 0,
            "core/src/http/{name}: found {found} production `TcpStream::connect` \
             site(s). The shared codec is pure over BufRead/Write; a socket here \
             is reachable from every transport that shares it, including callers \
             that never consult `ProxyGate::route`. Open it in a transport, not \
             in the codec."
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
        source.contains("proxy.route()"),
        "the socket site must consult a `ProxyGate` before opening a socket"
    );
    assert!(
        source.contains("connect_via_socks5"),
        "the socket site must have a tunneled arm, or Tor mode routes nothing"
    );
    // Task 5: the enrollment handshake is not a second socket site with its own
    // policy — it goes through the same function, so it cannot drift.
    assert!(
        source.contains("open_socket_via(proxy, host, port)"),
        "`tofu_fetch_pin_via` must open its socket through the shared gated site, \
         or an accept-any-certificate handshake goes out unrouted in Tor mode"
    );
    // The enrollment handshake takes its gate as a PARAMETER. A convenience
    // wrapper that resolved it here would be a second read of a cell the caller
    // has already consulted for the confirmation policy — see `pin_confirm`.
    assert_eq!(
        count(&source, "proxy::installed_for"),
        // `RustlsTransport::new` only — one gate resolved per transport built.
        1,
        "the only production read of the installed gate in this file is \
         `RustlsTransport::new`. A second one means the pin-capture handshake \
         resolves its own gate again, after `pin_confirm::capture_pin` already \
         consulted it for the confirmation policy — a TOCTOU between the policy \
         and the route it governs."
    );
}

/// The pin capture's gate is snapshotted once and used for both decisions.
///
/// Two reads of the same cell — one for "is a confirmation required", one
/// inside the handshake — is a window in which a user flipping the Tor toggle
/// gets the accept-any-certificate handshake routed through an exit node under
/// the no-confirmation-needed answer given a moment earlier.
#[test]
fn the_pin_capture_snapshots_one_gate_for_the_policy_and_the_route() {
    let source = sync_sources()
        .into_iter()
        .find(|(n, _)| n == "pin_confirm.rs")
        .map(|(_, s)| s)
        .expect("pin_confirm.rs");
    assert!(
        source.contains("let gate = proxy::installed_for(&host);")
            && source.contains("let required = gate.is_enabled();"),
        "`capture_pin` must read the routing gate ONCE and derive the \
         confirmation policy from that same value"
    );
    assert_eq!(
        count(&source, "proxy::installed_for"),
        // `capture_pin`'s snapshot, plus the standalone `confirmation_required`
        // query (which opens no socket).
        2,
        "each extra read of the installed gate is a TOCTOU window between the \
         policy decision and the handshake it governs"
    );
}

/// **The pin-capture handshake is reachable only through the compare.**
///
/// `tofu_fetch_pin_via` accepts ANY certificate — it is the one handshake in
/// the client that does. Over Tor that is the exit node's opportunity, so task
/// 5 made `pin_confirm::capture_pin` the single enforcement point: it refuses
/// to return a pin in Tor mode unless the user supplied the fingerprint they
/// obtained out-of-band and it matches what was served.
///
/// A second caller reaching for it directly would get the capture without the
/// compare, which compiles, passes every other test, and silently reinstates
/// the MitM. So the callers are counted, the same way the sockets are.
#[test]
fn the_tofu_capture_is_reached_only_through_the_fingerprint_compare() {
    for (name, source) in sync_sources() {
        let calls = count(&source, "tofu_fetch_pin");
        let allowed = match name.as_str() {
            // Its definition (`pub fn tofu_fetch_pin_via(`).
            "rustls_transport.rs" => 1,
            // The enforcement point itself.
            "pin_confirm.rs" => 1,
            _ => 0,
        };
        assert_eq!(
            calls, allowed,
            "{name}: expected {allowed} reference(s) to `tofu_fetch_pin_via`, found {calls}.\n\
             The accept-any-certificate enrollment handshake must be reached through \
             `pin_confirm::capture_pin`, which enforces the mandatory out-of-band \
             fingerprint compare in Tor mode. Calling it directly captures a pin an \
             exit node may have chosen."
        );
    }
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
