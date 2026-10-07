//! HTTPS to a **compiled-in** remote AI provider host (ai-remote-providers
//! task 4, ledger SYNC-23).
//!
//! This is the socket note plaintext leaves the device through. Three things
//! about it are load-bearing, and two of them are properties of the *types*
//! rather than rules a reader has to remember.
//!
//! **1. No new HTTP client.** The wire framing is
//! `crate::http::codec`, the first-party HTTP/1.1 codec promoted out of the
//! sync plugin. `docs/dependency-policy.md` fast-rejects "adding an HTTP client
//! when one already exists in the tree", and an HTTP crate is the one thing
//! that genuinely trips the AI denylist gate.
//!
//! **2. The destination cannot be chosen by data.** A [`ProviderHost`] wraps a
//! `&'static str` in a private field and is minted only by
//! [`ProviderHost::resolve`] from the compiled-in table. There is no
//! constructor taking an arbitrary host, so a tampered `vault.prefs`, a
//! compromised WebView, or a future careless caller can select *among* the
//! providers this build knows and cannot invent one. The shape is
//! `BrowserScheme::LoopbackHttp`'s: a property of the type rather than a rule
//! someone has to remember.
//!
//! **3. Verification failure is a refusal with no fallback.** The trust anchor
//! is the static `webpki-roots` Mozilla bundle, the same one native sync uses
//! (`decisions/sync/0620`), so a provider and a sync server are both verified by
//! public CA plus hostname and neither can be pinned around. There is no "try
//! again without verification" path here, and adding one would be the whole of
//! the security of this module.
//!
//! The costs of the static bundle are real and recorded rather than discovered
//! later: a revoked CA stays trusted until Myne ships an update, and roots the
//! user's own machine trusts (corporate MITM, private CAs) are ignored. Both
//! are acceptable *because* this path talks to a small closed set of named
//! hosts rather than the open web — see the `dependency-policy.md` row.
//!
//! Logging: nothing here logs. No prompt, note body, API key, response, host or
//! path reaches an error value or a panic message (`src-tauri/AGENTS.md` DENY
//! list); [`ProviderTransportError`] variants are unit and content-free.

// The consumers land in tasks 5 (registry + codec) and 9 (the consent gate).
// Named here rather than left as a bare allow — this is the file that opens the
// off-device socket, so "why is nothing using it" deserves an answer in place.
//
// UNCONDITIONAL, unlike the loopback arm's `cfg_attr(not(test), …)`, and the
// difference is not laziness: driving `post_json` end to end would mean a real
// TLS exchange with a real provider from a unit test, which is exactly the
// egress this tree exists to not do. The request path is therefore covered by
// the E2E lane (task 16) rather than here, and the tests below cover what CAN
// be checked offline — the compiled-in host table, the constant values, and the
// absence of any verification bypass.
#![allow(dead_code)]

use std::io::{BufReader, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use super::cancellable_io::{CancellableStream, CancelledFn, POLL_INTERVAL};
use crate::http::codec::{build_http_request_ext, read_http_response};
use crate::http::HttpMethod;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};

/// Ceiling on a response body from a provider. Supplied explicitly rather than
/// inherited: sync's 64 MiB is paired with its batch-blob fetch window and
/// means nothing here.
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

/// How long to wait for the TCP connect. Longer than the loopback arm's 2 s —
/// this one crosses the internet, and "your network is slow" must not read as
/// "the provider is down".
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to tolerate **silence** — no byte received — before giving up.
///
/// **This bounds the silence, not the length**, and the distinction is the
/// whole design. Sync's rule (`http_transport.rs::SOCKET_TIMEOUT`, myne#222) is
/// that a deadline "has to cover the server's WORK, not just the transfer" —
/// written for a request/response API. Here the work *is* the transfer: a long
/// completion is a stream of tokens arriving steadily, and a total-duration cap
/// would kill the successful case that takes longest, which is exactly the case
/// a user is most invested in.
///
/// 120 s rather than the loopback arm's 90 s: a remote provider queues behind
/// other tenants, and "the provider is busy" must not be reported as "the
/// provider is broken".
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// The failure surface. Closed, unit-only, and content-free by construction —
/// a provider's error body is attacker-influenceable and has no place in a
/// Myne error value. Task 7 maps these onto user-facing states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProviderTransportError {
    /// DNS or routing failed; nothing was reached.
    #[error("the provider host could not be reached")]
    Unreachable,
    /// Something is listening and refused the connection.
    #[error("the provider refused the connection")]
    Refused,
    /// The connect or the exchange exceeded its deadline.
    #[error("the provider did not answer in time")]
    Timeout,
    /// **Certificate verification failed.** Distinct from every other variant
    /// on purpose: it is the one that must never be retried, softened, or
    /// fallen back from, and a caller that cannot tell it apart from
    /// `Unreachable` will eventually be tempted to.
    #[error("the provider's certificate was not trusted")]
    TlsNotTrusted,
    /// The exchange failed after the connection was established.
    #[error("the provider exchange failed")]
    Exchange,
    /// The provider rejected the credential (401/403).
    #[error("the provider rejected the credential")]
    Unauthorized,
    /// The provider declined the work on cost grounds (402/429).
    #[error("the provider's quota or credit is exhausted")]
    QuotaExhausted,
    /// The provider rejected the REQUEST as one it will not accept (400).
    ///
    /// Split out of [`ProviderTransportError::Exchange`] because it blames the
    /// wrong side otherwise, and the chain downstream turned that into a wrong
    /// sentence: 400 fell to `Exchange`, `Exchange` to `InferenceFailed`, and
    /// `agent_error_of`'s catch-all to `AgentError::ReadFailed`, so a request
    /// the provider would not take was reported to the user as a failure to
    /// read one of their notes (myne-md/myne#547).
    ///
    /// Content-free like its siblings: the body explaining the rejection is
    /// deliberately never read, since a provider's error text is
    /// attacker-influenceable.
    #[error("the provider rejected the request")]
    RequestRejected,
    /// The caller stood the request down before it finished. **Not a failure**
    /// — the UI shows nothing for this, which is why it cannot share a variant
    /// with [`ProviderTransportError::Exchange`].
    #[error("the request was cancelled")]
    Cancelled,
}

impl ProviderTransportError {
    /// The cause's name, as a compile-time string, for logging. Every variant
    /// is a unit and content-free by construction (see the type's own note), so
    /// this adds no new exposure — it only avoids a `Debug` format drifting
    /// into a field one day.
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Unreachable => "unreachable",
            Self::Refused => "refused",
            Self::Timeout => "timeout",
            Self::TlsNotTrusted => "tls_not_trusted",
            Self::Exchange => "exchange",
            Self::Unauthorized => "unauthorized",
            Self::QuotaExhausted => "quota_exhausted",
            Self::RequestRejected => "request_rejected",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Map an HTTP status onto the transport's own cause.
///
/// The three that are worth separating, and why each is its own fix:
///   - **401 / 403** — the request arrived and was understood, and the
///     credential was declined. The fix is a new key.
///   - **402 / 429** — the credential was accepted and the *work* was declined
///     on cost grounds. The fix is on the provider's side; telling the user to
///     retry would be wrong, and telling them to check their key would be
///     wrong twice.
///   - **anything else** — a generic exchange failure. Nothing is claimed
///     about it, because nothing is known.
///
/// 429 sits with 402 rather than with "retry later" deliberately: on a metered
/// API a rate limit and an exhausted balance are the same conversation with the
/// provider, and Myne cannot tell them apart without reading a body it refuses
/// to read.
pub fn status_cause(status: u16) -> ProviderTransportError {
    match status {
        400 => ProviderTransportError::RequestRejected,
        401 | 403 => ProviderTransportError::Unauthorized,
        402 | 429 => ProviderTransportError::QuotaExhausted,
        _ => ProviderTransportError::Exchange,
    }
}

/// A provider host this build knows how to reach.
///
/// The private field is the point: there is no way to construct one from
/// caller-supplied text, so the set of destinations is fixed at compile time.
/// [`ProviderHost::resolve`] is the only mint, and it answers `None` for
/// anything not in [`PROVIDER_HOSTS`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderHost {
    /// Deliberately private. Adding a `pub fn new(host: String)` here would
    /// undo this module's second invariant in one line.
    host: &'static str,
}

/// `(provider wire name, host)` — the compiled-in table, and the reason a
/// stored provider name cannot redirect traffic. The wire names match the
/// closed set `prefs::commands::KNOWN_AI_PROVIDERS` validates against; the
/// hosts appear **nowhere else** and are never read from configuration.
pub const PROVIDER_HOSTS: &[(&str, &str)] = &[
    ("ollama-cloud", "ollama.com"),
    ("openrouter", "openrouter.ai"),
];

impl ProviderHost {
    /// The only mint. `None` for a name this build does not know — which is
    /// the same answer the prefs setter gives, so an unknown name cannot reach
    /// a socket from either direction.
    pub fn resolve(provider: &str) -> Option<Self> {
        PROVIDER_HOSTS
            .iter()
            .find(|(name, _)| *name == provider)
            .map(|(_, host)| Self { host })
    }

    pub fn host(&self) -> &'static str {
        self.host
    }
}

/// The one place this module opens a socket, and therefore the one place the
/// Tor routing gate has to be consulted.
///
/// Mirrors `model_download::open_socket_via` (myne-md/myne#805) so the two AI
/// egress transports obey the same rule: with Tor mode on, only a `Ready` proxy
/// yields a route and everything else refuses WITHOUT opening a socket. There is
/// no direct-connect fallback, because falling back would leak the device's real
/// source IP at exactly the moment the user believes they are protected. Before
/// this (myne-md/myne#607) the provider chat/list arm dialed directly and ignored
/// the setting the rest of the app honours, so sync went through Tor while
/// provider traffic told the provider (and the local network) where the device
/// was.
///
/// Free rather than a `ProviderTransport` method so the routing decision is
/// unit-testable against a controlled gate and a loopback host. That is the same
/// seam `model_download.rs` exposes, and the reason its two Tor tests can exist.
/// It is module-private and its sole PRODUCTION caller passes `self.host.host()`,
/// a compiled-in [`ProviderHost`]; the only other callers are the two tests
/// below. The `&str` parameter is what makes those tests possible, so the older
/// claim that the direct dial is reachable only through a `ProviderHost` no
/// longer holds of the helper itself, and the AI egress record says so.
fn open_socket_via(
    proxy: &crate::plugins::sync::proxy::ProxyGate,
    host: &str,
    port: u16,
) -> Result<TcpStream, ProviderTransportError> {
    use crate::plugins::sync::proxy::Route;
    use crate::plugins::sync::socks5::{connect_via_socks5, Socks5Error};

    match proxy.route() {
        Ok(Route::Direct) => {
            // The direct arm resolves the name here, because the connecting
            // helper takes a resolved address. The `Socks5` arm below must NOT:
            // it hands the name to the proxy, which resolves it inside the
            // circuit rather than on this device.
            let addr = (host, port)
                .to_socket_addrs()
                .map_err(|_| ProviderTransportError::Unreachable)?
                .next()
                .ok_or(ProviderTransportError::Unreachable)?;
            TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| match e.kind() {
                std::io::ErrorKind::ConnectionRefused => ProviderTransportError::Refused,
                std::io::ErrorKind::TimedOut => ProviderTransportError::Timeout,
                _ => ProviderTransportError::Unreachable,
            })
        }
        Ok(Route::Socks5 { socks_port }) => {
            // The SOCKS5 error's two families are kept distinct rather than
            // collapsed, matching what each means: `ProxyUnreachable` is the
            // loopback proxy not answering (our side, so `Unreachable`), while
            // `Refused(_)` is the proxy reporting the TARGET refused the connect
            // (so `Refused`). Returning `Refused` for a dead sidecar, as an
            // earlier revision of this arm did, reported a provider refusal that
            // never happened.
            connect_via_socks5(socks_port, host, port).map_err(|e| match e {
                Socks5Error::ProxyUnreachable => ProviderTransportError::Unreachable,
                Socks5Error::Refused(_) => ProviderTransportError::Refused,
                _ => ProviderTransportError::Unreachable,
            })
        }
        Err(denied) => {
            // The bare denial reason only: never the host, the port or the proxy
            // port (`src-tauri/AGENTS.md` secret-handling discipline, because the
            // provider hostname is the thing Tor mode keeps off this device's
            // resolver). A closed enum, like the connect-failed tag.
            tracing::warn!(
                target: "myne::ai",
                event = "provider_tor_fail_closed",
                reason = ?denied,
                "Tor routing is on and the proxy is not ready; refusing to reach the provider"
            );
            Err(ProviderTransportError::Unreachable)
        }
    }
}

/// An HTTPS request path to one [`ProviderHost`].
pub struct ProviderTransport {
    host: ProviderHost,
    config: Arc<ClientConfig>,
    /// Polled between socket waits. A remote request has **no emit seam until
    /// the provider answers**, so without this "Stop" does nothing and — worse
    /// on a metered API — the request keeps running and keeps billing.
    cancelled: CancelledFn,
}

impl ProviderTransport {
    /// Build the arm. Takes a [`ProviderHost`], not a string — so this
    /// signature is what makes "the destination is compiled in" checkable by
    /// the compiler rather than by review.
    pub fn new(host: ProviderHost) -> Self {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        // The static Mozilla bundle. `webpki_roots::TLS_SERVER_ROOTS` is data
        // compiled into the binary — no platform store is consulted, which is
        // the property that makes this identical on every machine.
        let roots = RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        // NOTE the absence: no `.dangerous()`, no custom verifier, no
        // `with_no_client_auth()` variant that skips the chain. rustls's
        // default verifier does full CA-chain + hostname validation, and a
        // handshake that fails it produces an error rather than a connection.
        let config = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("the ring provider supports the default protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        Self {
            host,
            config: Arc::new(config),
            cancelled: Arc::new(|| false),
        }
    }

    /// The same arm with a cancellation predicate. The command layer supplies
    /// one closing over the request's own token (#188 made tokens per-request,
    /// so this arm consumes that rather than re-inventing it).
    pub fn with_cancel(host: ProviderHost, cancelled: CancelledFn) -> Self {
        Self {
            cancelled,
            ..Self::new(host)
        }
    }

    /// Test-only: what this transport's cancel predicate answers right now.
    ///
    /// It exists so a test can assert **which** predicate an engine handed over
    /// (myne-md/myne#445) without opening a socket. Driving a real request to
    /// count polls would make the assertion depend on reaching the provider —
    /// and then a poll count of zero means "this machine is offline", not
    /// "the wrong predicate was wired", which is the failure mode that makes a
    /// test worse than none.
    #[cfg(test)]
    pub(super) fn cancelled_now(&self) -> bool {
        (self.cancelled)()
    }

    /// Open a verified TLS connection. There is exactly one of these, and it
    /// has no unverified sibling — the only way to get bytes to a provider is
    /// through a handshake the root store accepted.
    fn connect(
        &self,
    ) -> Result<StreamOwned<ClientConnection, CancellableStream<TcpStream>>, ProviderTransportError>
    {
        let name = ServerName::try_from(self.host.host())
            .map_err(|_| ProviderTransportError::Unreachable)?;
        let conn = ClientConnection::new(self.config.clone(), name)
            .map_err(|_| ProviderTransportError::TlsNotTrusted)?;
        let sock = self.open_socket()?;
        // A SHORT socket deadline so a wait is interruptible; the wrapper
        // turns repeated short waits into one long wait that observes
        // cancellation between them. Set on the raw socket, UNDER rustls, so a
        // cancel lands during the TLS handshake too — not only after it.
        let _ = sock.set_read_timeout(Some(POLL_INTERVAL));
        let _ = sock.set_write_timeout(Some(POLL_INTERVAL));
        let guarded = CancellableStream::new(sock, Arc::clone(&self.cancelled), IDLE_TIMEOUT);
        Ok(StreamOwned::new(conn, guarded))
    }

    /// Open the provider socket, obeying the Tor routing gate. Delegates the
    /// decision to [`open_socket_via`], which carries the rationale.
    fn open_socket(&self) -> Result<TcpStream, ProviderTransportError> {
        open_socket_via(
            &crate::plugins::sync::proxy::installed_for(self.host.host()),
            self.host.host(),
            443,
        )
    }

    /// One request/response round trip. `bearer` is the provider API key and is
    /// **never** logged, echoed into an error, or retained past this call.
    pub fn post_json(
        &self,
        path: &str,
        body: &[u8],
        bearer: &str,
    ) -> Result<Vec<u8>, ProviderTransportError> {
        self.exchange(HttpMethod::Post, path, body, bearer)
    }

    /// The read-side round trip — today exactly one caller, the model list
    /// (SYNC-24). Same connection, same root store, same deadlines, same cap;
    /// only the method and the empty body differ.
    ///
    /// It is a **separate method rather than a `method` parameter on
    /// `post_json`** so that every egress from this module is named at its call
    /// site. The call-site egress ratchet
    /// (`src-tauri/scripts/ai-no-network-check.sh`) records sites, and a
    /// parameterised verb would hide a second kind of request behind a name
    /// that says "post".
    pub fn get_json(&self, path: &str, bearer: &str) -> Result<Vec<u8>, ProviderTransportError> {
        self.exchange(HttpMethod::Get, path, &[], bearer)
    }

    /// Distinguish "the user stood this down" from "the far side broke". The
    /// caller shows nothing for the first and an error for the second, and a
    /// single `Exchange` for both would put a failure banner in front of
    /// someone who pressed Stop.
    fn exchange_cause(&self) -> ProviderTransportError {
        if (self.cancelled)() {
            ProviderTransportError::Cancelled
        } else {
            ProviderTransportError::Exchange
        }
    }

    /// The same distinction drawn from the `io::Error` itself, for a caller
    /// holding the error rather than the predicate — the flag can flip between
    /// the read failing and the question being asked, and then a cancelled
    /// request reports as a broken provider.
    fn cause_from_io(&self, e: &std::io::Error) -> ProviderTransportError {
        if CancellableStream::<TcpStream>::is_cancelled_error(e) {
            ProviderTransportError::Cancelled
        } else if e.kind() == std::io::ErrorKind::TimedOut {
            ProviderTransportError::Timeout
        } else {
            self.exchange_cause()
        }
    }

    fn exchange(
        &self,
        method: HttpMethod,
        path: &str,
        body: &[u8],
        bearer: &str,
    ) -> Result<Vec<u8>, ProviderTransportError> {
        let req = build_http_request_ext(
            method,
            path,
            self.host.host(),
            &[("content-type", "application/json")],
            body,
            Some(bearer),
        );
        // **How long the exchange took and how it ended** (myne-md/myne#546).
        // Without it, a request that is still in flight and a request that
        // completed are the same observation from outside the process: an
        // afternoon went into telling those two apart with a stack sample while
        // the provider's own dashboard showed every request finishing in under
        // seven seconds. Timings, a status integer and a closed error tag; the
        // request body and the reply are never touched here.
        let started = std::time::Instant::now();
        let mut tls = self.connect().inspect_err(|e| {
            tracing::debug!(
                target: "myne::ai",
                event = "provider_connect_failed",
                error_kind = e.tag(),
                elapsed_ms = started.elapsed().as_millis() as u64,
            );
        })?;
        tls.write_all(&req).map_err(|e| self.cause_from_io(&e))?;
        tls.flush().map_err(|e| self.cause_from_io(&e))?;
        let mut reader = BufReader::new(tls);
        let (resp, _reuse) =
            read_http_response(&mut reader, false, MAX_RESPONSE_BYTES).map_err(|_| {
                let cause = self.exchange_cause();
                tracing::debug!(
                    target: "myne::ai",
                    event = "provider_read_failed",
                    error_kind = cause.tag(),
                    elapsed_ms = started.elapsed().as_millis() as u64,
                );
                cause
            })?;
        tracing::debug!(
            target: "myne::ai",
            event = "provider_exchange",
            status = resp.status,
            body_bytes = resp.body.len(),
            elapsed_ms = started.elapsed().as_millis() as u64,
        );
        if resp.status != 200 {
            // The body of a non-200 is NOT read. A provider's error text is
            // attacker-influenceable and has no place in a Myne value — the
            // STATUS is the only thing taken from a failed response, and it is
            // an integer.
            return Err(status_cause(resp.status));
        }
        Ok(resp.body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three tunables, pinned. `MAX_RESPONSE_BYTES` in particular: the
    /// codec takes it as a parameter precisely so this arm does not silently
    /// inherit sync's 64 MiB, which is paired with the batch-blob fetch window
    /// and means nothing for a completion.
    #[test]
    fn the_deadlines_and_the_cap_are_this_arms_own() {
        assert_eq!(MAX_RESPONSE_BYTES, 8 * 1024 * 1024);
        assert_ne!(MAX_RESPONSE_BYTES, 64 * 1024 * 1024, "not sync's cap");
        // Longer than the loopback arm's 2 s: this one crosses the internet,
        // and "your network is slow" must not read as "the provider is down".
        assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(10));
        assert!(CONNECT_TIMEOUT > Duration::from_secs(2));
        // Bounds SILENCE, not total duration — a long completion is a stream
        // of tokens arriving steadily, and capping the length would kill the
        // successful case that takes longest.
        assert_eq!(IDLE_TIMEOUT, Duration::from_secs(120));
        // Longer than the loopback arm's 90 s: a remote provider queues behind
        // other tenants, and "busy" must not be reported as "broken".
        assert!(IDLE_TIMEOUT > Duration::from_secs(90));
        // The socket wakes far more often than the deadline, which is what
        // makes a cancel observable while the provider is still thinking.
        assert!(POLL_INTERVAL < Duration::from_secs(1));
    }

    /// A provider that accepts and then never answers must fail **within the
    /// deadline**, asserted on elapsed time rather than on the variant alone —
    /// a variant-only assertion passes just as well against a call that hung
    /// for an hour first.
    #[test]
    fn a_never_responding_provider_fails_within_the_idle_deadline() {
        use std::io::Read as _;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            // Accept and hold. Never write a byte.
            let held: Vec<_> = listener.incoming().take(1).filter_map(Result::ok).collect();
            std::thread::sleep(Duration::from_secs(30));
            drop(held);
        });

        let never = Arc::new(|| false) as CancelledFn;
        let sock = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        sock.set_read_timeout(Some(POLL_INTERVAL))
            .expect("deadline");
        // A short deadline for the test; the production value is pinned above.
        let mut guarded = CancellableStream::new(sock, never, Duration::from_millis(300));
        let started = std::time::Instant::now();
        let err = guarded.read(&mut [0u8; 16]).expect_err("must give up");
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "the deadline must bound the wait; took {:?}",
            started.elapsed()
        );
    }

    /// Cancel reaches a call that has produced **no byte**, and the socket is
    /// closed on the way out — the property the emit-seam check could not have.
    #[test]
    fn a_cancel_before_the_first_byte_returns_promptly_and_drops_the_socket() {
        use std::io::Read as _;
        use std::sync::atomic::{AtomicBool, Ordering};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            if let Some(Ok(mut peer)) = listener.incoming().next() {
                // Never answer. Block on a read: it returns 0 exactly when the
                // client's socket is dropped, which is the closure signal.
                let mut sink = [0u8; 1];
                loop {
                    match peer.read(&mut sink) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => continue,
                    }
                }
                let _ = tx.send(());
            }
        });

        let flag = Arc::new(AtomicBool::new(false));
        let f = Arc::clone(&flag);
        let cancelled = Arc::new(move || f.load(Ordering::SeqCst)) as CancelledFn;
        std::thread::spawn({
            let flag = Arc::clone(&flag);
            move || {
                std::thread::sleep(Duration::from_millis(80));
                flag.store(true, Ordering::SeqCst);
            }
        });

        let sock = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        sock.set_read_timeout(Some(POLL_INTERVAL))
            .expect("deadline");
        let started = std::time::Instant::now();
        {
            // A 30 s idle budget, so a pass cannot be the deadline firing.
            let mut guarded = CancellableStream::new(sock, cancelled, Duration::from_secs(30));
            let err = guarded.read(&mut [0u8; 16]).expect_err("must abort");
            assert!(CancellableStream::<TcpStream>::is_cancelled_error(&err));
        } // guarded drops → the socket closes.
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "cancel must be prompt; took {:?}",
            started.elapsed()
        );
        // The socket really closed: the peer's blocking read returned.
        rx.recv_timeout(Duration::from_secs(5))
            .expect("the peer must observe the socket close");
    }

    /// The task's central requirement: **five outcomes, five distinct
    /// variants**, asserted pairwise rather than one-by-one — a per-case
    /// assertion passes even when two cases return the same thing.
    #[test]
    fn five_provider_outcomes_map_to_five_distinct_causes() {
        use crate::inference::error::EngineError;

        // (what happened, the transport cause, the engine cause the UI sees)
        let table: &[(&str, ProviderTransportError, EngineError)] = &[
            (
                "401 — the credential was declined",
                status_cause(401),
                EngineError::Unauthorized,
            ),
            (
                "429 — out of credit or over a rate limit",
                status_cause(429),
                EngineError::QuotaExhausted,
            ),
            (
                "connection refused — something is there and said no",
                ProviderTransportError::Refused,
                EngineError::Refused,
            ),
            (
                "no answer within the deadline",
                ProviderTransportError::Timeout,
                EngineError::Timeout,
            ),
            (
                "nothing is listening",
                ProviderTransportError::Unreachable,
                EngineError::Unreachable,
            ),
        ];

        for (i, (what_a, tcause_a, ecause_a)) in table.iter().enumerate() {
            for (j, (what_b, tcause_b, ecause_b)) in table.iter().enumerate() {
                if i == j {
                    continue;
                }
                assert_ne!(
                    tcause_a, tcause_b,
                    "{what_a:?} and {what_b:?} must not share a transport cause"
                );
                assert_ne!(
                    ecause_a.kind(),
                    ecause_b.kind(),
                    "{what_a:?} and {what_b:?} must not share an engine cause"
                );
            }
        }

        // The fifth state the issue names — "a key is missing" — is not a
        // transport outcome at all: it is decided before a socket opens, which
        // is why it has its own variant rather than a status mapping.
        assert_ne!(
            EngineError::NoCredential.kind(),
            EngineError::Unauthorized.kind(),
            "\"paste a key\" and \"that key is wrong\" are different instructions"
        );

        // 403 joins 401 and 402 joins 429 — same conversation, same fix.
        assert_eq!(status_cause(403), status_cause(401));
        assert_eq!(status_cause(402), status_cause(429));
        // …and a status nobody classified stays generic rather than being
        // guessed into one of the actionable buckets.
        assert_eq!(status_cause(500), ProviderTransportError::Exchange);
    }

    /// No variant may carry a provider body, a prompt, or note content. The
    /// enum is unit-only, so this is checked where it could actually regress:
    /// the `Display` strings, which is what reaches a log line.
    #[test]
    fn no_cause_can_carry_provider_content() {
        use ProviderTransportError::*;
        for e in [
            Unreachable,
            Refused,
            Timeout,
            TlsNotTrusted,
            Exchange,
            Cancelled,
            Unauthorized,
            QuotaExhausted,
        ] {
            let msg = e.to_string();
            // Fixed, human-written text: no interpolation site exists, so no
            // caller can put a body in one.
            assert!(!msg.contains('{'), "{msg:?} looks interpolated");
            assert!(msg.is_ascii(), "{msg:?}");
        }
    }

    /// The Candle `compute` mutex is a **Metal crash-safety invariant, not a
    /// perf knob** — and holding it across a network round trip would let one
    /// slow provider wedge every local AI surface in the app. Asserted
    /// structurally, the same way the loopback arm asserts it.
    #[test]
    fn the_compute_lock_is_never_held_across_a_remote_round_trip() {
        let src = include_str!("provider_transport.rs");
        let production = &src[..src.find("#[cfg(test)]").expect("test block")];
        let code: String = production
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !code.contains("compute"),
            "this arm must not touch the Candle compute lock"
        );
    }

    /// The error surface is closed and every variant is distinguishable —
    /// `TlsNotTrusted` above all, because a caller that cannot tell it from
    /// `Unreachable` will eventually retry it.
    #[test]
    fn the_failure_surface_is_closed_and_distinguishable() {
        use ProviderTransportError::*;
        let all = [
            Unreachable,
            Refused,
            Timeout,
            TlsNotTrusted,
            Exchange,
            Cancelled,
        ];
        for (i, a) in all.iter().enumerate() {
            for (j, b) in all.iter().enumerate() {
                assert_eq!(i == j, a == b, "variants must be distinguishable");
            }
            // Content-free: no variant can carry a host, a path or a body.
            assert!(!a.to_string().is_empty());
        }
    }

    #[test]
    fn only_a_compiled_in_name_resolves_to_a_host() {
        assert_eq!(
            ProviderHost::resolve("openrouter").map(|h| h.host()),
            Some("openrouter.ai")
        );
        assert_eq!(
            ProviderHost::resolve("ollama-cloud").map(|h| h.host()),
            Some("ollama.com")
        );
        // The whole point: a name the build does not know yields no host, so
        // there is nothing to construct a transport from.
        assert_eq!(ProviderHost::resolve("evil.example.com"), None);
        assert_eq!(ProviderHost::resolve(""), None);
        assert_eq!(ProviderHost::resolve("OpenRouter"), None);
    }

    /// The two closed sets that must not drift: the provider names the prefs
    /// setter accepts and the ones that resolve to a host. A name accepted by
    /// one and unknown to the other is either a stored selection with no
    /// destination or a destination nothing can select.
    #[test]
    fn the_host_table_and_the_accepted_provider_names_agree() {
        use crate::plugins::prefs::commands::KNOWN_AI_PROVIDERS;
        let mut known: Vec<&str> = KNOWN_AI_PROVIDERS.to_vec();
        let mut hosted: Vec<&str> = PROVIDER_HOSTS.iter().map(|(n, _)| *n).collect();
        known.sort_unstable();
        hosted.sort_unstable();
        assert_eq!(known, hosted);
        assert!(!hosted.is_empty(), "an empty table would pass vacuously");
    }

    /// A certificate the static root store does not trust must produce a
    /// **refusal**, not a connection — asserted as the refusal it is, with the
    /// distinguishable `TlsNotTrusted` cause, rather than as "no response".
    ///
    /// Driven against a real local TLS listener presenting a self-signed
    /// certificate: `ServerName::try_from` accepts the name, the socket
    /// connects, and the handshake is where it must die.
    #[test]
    fn an_untrusted_certificate_is_refused_with_no_fallback() {
        // A self-signed cert for a name the bundle cannot chain to any root.
        // The listener is real so the failure is a handshake outcome rather
        // than a connect error dressed up as one.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let accepted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let a2 = std::sync::Arc::clone(&accepted);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                a2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // Answer the ClientHello with bytes that are not a valid
                // ServerHello, so the handshake fails on the client side.
                if let Ok(mut s) = stream {
                    use std::io::Write as _;
                    let _ = s.write_all(&[0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28]);
                }
            }
        });

        // Reach the local listener while keeping the compiled-in host name in
        // the TLS handshake, which is the configuration under test: the name
        // is what the verifier checks, and it can never match a self-signed
        // local certificate.
        let host = ProviderHost::resolve("openrouter").expect("known provider");
        let transport = ProviderTransport::new(host);
        let name = ServerName::try_from(host.host()).expect("valid dns name");
        let conn = ClientConnection::new(transport.config.clone(), name).expect("client conn");
        let sock = TcpStream::connect(("127.0.0.1", port)).expect("connect to fixture");
        let mut tls = StreamOwned::new(conn, sock);
        let err = tls
            .write_all(b"GET / HTTP/1.1\r\n\r\n")
            .and_then(|_| tls.flush());
        assert!(
            err.is_err(),
            "a handshake against an untrusted certificate must fail, not proceed"
        );
        assert!(
            accepted.load(std::sync::atomic::Ordering::SeqCst) > 0,
            "the probe must actually have reached the listener, or it proves nothing"
        );
    }

    /// The config carries no escape hatch. Asserted structurally — the module
    /// must not contain a `dangerous()` call or a custom verifier, which is
    /// what "no fallback" means in practice and what a future edit would most
    /// plausibly add.
    #[test]
    fn there_is_no_verification_bypass_in_this_module() {
        let src = include_str!("provider_transport.rs");
        // Read PRODUCTION code only: drop the test block, then drop every
        // comment line. The comments matter — this module's own doc says
        // "no `.dangerous()`", and a naive substring scan would fail on the
        // sentence explaining why the thing is absent. (Caught on the first
        // run, which is the argument for writing the check before trusting it.)
        let body = &src[..src
            .find("#[cfg(test)]")
            .expect("this module has a test block")];
        let production: String = body
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for banned in [
            ".dangerous()",
            "with_custom_certificate_verifier",
            "danger_accept_invalid",
        ] {
            assert!(
                !production.contains(banned),
                "provider_transport must not carry {banned:?}: the whole security of this \
                 module is that a verification failure has no fallback"
            );
        }
    }

    /// With Tor mode on and the proxy not `Ready`, opening the provider socket
    /// fails AND dials nothing, the fail-closed half of myne-md/myne#607.
    #[test]
    fn tor_on_with_no_ready_proxy_fails_closed_and_dials_nothing() {
        use crate::plugins::sync::proxy::{ProxyGate, TorProxyState};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe");
        let port = listener.local_addr().expect("addr").port();
        let accepts = Arc::new(AtomicUsize::new(0));
        let counter = accepts.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stream.is_err() {
                    return;
                }
                counter.fetch_add(1, Ordering::SeqCst);
            }
        });

        // Tor mode on, sidecar still bootstrapping. The host is loopback only
        // so the probe is reachable and the control arm below can prove the
        // probe can SEE a connection; the gate is injected, so the loopback
        // exemption in `installed_for` is bypassed and the injected gate is
        // obeyed.
        let gate = ProxyGate::new();
        gate.set_enabled(true);
        gate.set_state(TorProxyState::Starting);
        assert_eq!(
            open_socket_via(&gate, "127.0.0.1", port).map(|_| ()),
            Err(ProviderTransportError::Unreachable),
            "Tor on with a non-ready proxy must refuse"
        );
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(
            accepts.load(Ordering::SeqCst),
            0,
            "fail-closed means ZERO direct connections to the provider"
        );

        // Control: with a direct gate the probe DOES see a connection, or the
        // zero above would be compatible with a probe that can never see one.
        assert!(
            open_socket_via(&ProxyGate::new(), "127.0.0.1", port).is_ok(),
            "the control arm must be able to reach the probe"
        );
        std::thread::sleep(Duration::from_millis(150));
        assert!(
            accepts.load(Ordering::SeqCst) >= 1,
            "the probe must be able to observe a direct connection, or the zero proves nothing"
        );
    }

    /// With the proxy `Ready`, the provider socket is tunnelled and the target
    /// reaches the proxy as a **hostname** (remote DNS), never a locally
    /// resolved address, the positive half of myne-md/myne#607.
    #[test]
    fn a_tor_ready_gate_routes_the_provider_socket_through_the_proxy() {
        use crate::plugins::sync::proxy::{ProxyGate, TorProxyState};
        use crate::plugins::sync::socks5::fake::{Behavior, FakeSocks5, SeenTarget};
        use std::net::TcpListener;

        let target = TcpListener::bind("127.0.0.1:0").expect("bind target");
        let target_port = target.local_addr().expect("addr").port();
        let proxy = FakeSocks5::spawn(1, Behavior::Splice(target_port));

        let gate = ProxyGate::new();
        gate.set_enabled(true);
        gate.set_state(TorProxyState::Ready {
            socks_port: proxy.port,
        });
        let stream = open_socket_via(&gate, "openrouter.ai", 443)
            .expect("a ready proxy yields a tunnelled socket");
        drop(stream);

        assert_eq!(
            proxy.seen(),
            vec![SeenTarget {
                atyp: 0x03,
                host: "openrouter.ai".to_string(),
                port: 443,
            }],
            "the provider request must travel as a hostname CONNECT through the sidecar"
        );
    }
}
