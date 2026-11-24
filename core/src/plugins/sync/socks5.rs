// SPDX-License-Identifier: AGPL-3.0-only
//! A minimal SOCKS5 client for the sync transport (desktop Tor routing,
//! MYND-650 task 3).
//!
//! Given the loopback port of the arti sidecar's SOCKS5 listener
//! (`proxy::Route::Socks5`), this opens a TCP connection to the proxy, performs
//! RFC 1928 method negotiation, issues a `CONNECT`, and hands back the tunneled
//! [`TcpStream`]. Everything above it — pinned rustls, the HTTP/1.1 codec, the
//! SSE reader — runs on that stream **unchanged**: a SOCKS5 tunnel is a byte
//! pipe, and the TLS session inside it is end-to-end between this device and
//! the sync server, so the exit node sees only ciphertext to a hostname.
//!
//! ## Remote DNS is the point, not a detail
//!
//! The `CONNECT` carries address type **`0x03` (domain name)** with the sync
//! hostname as a string. It never carries a pre-resolved address, and this
//! module never calls `to_socket_addrs` on the target: a local DNS lookup would
//! send the sync hostname to the device's resolver in the clear — to the ISP,
//! to the local network, to whoever runs that resolver — which is precisely the
//! observer Tor mode exists to blind (PRD story 9). The name is resolved by the
//! Tor exit, inside the circuit.
//!
//! The only address this module resolves is the proxy's own, and it does not
//! resolve it either: it is `127.0.0.1` as a literal [`Ipv4Addr::LOCALHOST`].
//!
//! ## No new crate
//!
//! SOCKS5's client half is a fixed-shape greeting, a request and a reply. It is
//! hand-rolled here for the same reason the HTTP/1.1 codec next door is:
//! adding a dependency is a security decision (root `AGENTS.md`), and a crate
//! that speaks the whole protocol — server side, authentication methods, UDP
//! `ASSOCIATE`, `BIND` — is a much larger surface than the ~60 bytes of framing
//! this path actually needs.
//!
//! ## What this module does NOT decide
//!
//! Whether to use a tunnel at all. That is [`super::proxy::ProxyGate`]'s
//! fail-closed decision (task 2), consulted at the transport's connect sites by
//! task 4. Calling into this module already means "Tor mode is on and the proxy
//! is ready".

use super::http_transport::SOCKET_TIMEOUT;
use super::transport::TransportError;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

/// SOCKS protocol version (RFC 1928 is 5, and this client speaks only 5).
const VER: u8 = 0x05;
/// Method `0x00`: no authentication.
///
/// **Not a judgement that the channel needs none** (myne#380). The previous
/// wording here — "a credential between two processes under the same user would
/// be theatre" — described a unix socket, and this is a TCP port. A loopback
/// TCP port carries no uid restriction by default on any desktop platform, so
/// the listener answers *any* local peer that knocks, including one running as
/// a different local user; it is materially weaker than this crate's other two
/// local ingresses (`cli.sock`, `clipper.sock`, both `0600` via
/// `src-tauri/src/uds.rs`). That sentence was the one a reviewer would read
/// when deciding whether this door is already fenced, and it answered yes.
///
/// `0x00` is nonetheless the only method the listener accepts: arti's `proxy`
/// offers no SOCKS authentication at all — it consumes RFC 1929's
/// username/password field as a **stream-isolation token**, never as a
/// credential — so there is nothing else to send and nothing would check it.
/// The residual that leaves is recorded in `docs/threat-model.md` §7 under Tor
/// routing mode.
const METHOD_NO_AUTH: u8 = 0x00;
/// The method the proxy returns when it accepts none of the ones offered.
const METHOD_NONE_ACCEPTABLE: u8 = 0xFF;
/// Command `0x01`: establish a TCP stream to the target. The only one used —
/// `BIND` and `UDP ASSOCIATE` have no meaning for this transport.
const CMD_CONNECT: u8 = 0x01;
/// Address type `0x01`: IPv4. Parsed in replies, never sent in requests.
const ATYP_IPV4: u8 = 0x01;
/// Address type `0x03`: domain name — what every request this client sends
/// carries, so the name resolves at the far end of the circuit.
const ATYP_DOMAIN: u8 = 0x03;
/// Address type `0x04`: IPv6. Parsed in replies, never sent in requests.
const ATYP_IPV6: u8 = 0x04;
/// Reply code `0x00`: succeeded.
const REP_SUCCEEDED: u8 = 0x00;

/// The method-negotiation greeting this client opens every exchange with:
/// `VER | NMETHODS=1 | NO-AUTH`.
///
/// Public because the desktop supervisor's liveness probe
/// (`src-tauri/src/tor_sidecar/supervisor.rs`) speaks exactly this much SOCKS5
/// and nothing more — it asks "is the listener alive" without a `CONNECT`, so
/// no circuit is built and no hostname is disclosed. Sharing the bytes and
/// [`read_method_selection`] is what keeps the probe's idea of a healthy
/// listener the same as the transport's.
pub const METHOD_NEGOTIATION_GREETING: [u8; 3] = [VER, 1, METHOD_NO_AUTH];

/// How long to wait for the loopback proxy to accept a TCP connection. Short
/// on purpose: this is a process on this machine, so anything slow here is a
/// dead or wedged sidecar, and the honest answer is an error the gate can turn
/// into the fail-closed banner rather than a stalled sync cycle.
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Failures of the SOCKS5 leg, below TLS and below HTTP.
///
/// Every variant means the tunnel does not exist. None of them is a signal to
/// try again directly — with Tor mode on there is no direct path (task 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Socks5Error {
    /// The loopback proxy did not accept a connection (not listening, or gone).
    ProxyUnreachable,
    /// The proxy is not speaking SOCKS5, or truncated the exchange.
    Protocol,
    /// The proxy accepted none of the methods offered — i.e. it wants
    /// authentication. arti's listener does not; a proxy that does is not ours.
    AuthRequired,
    /// The proxy refused the `CONNECT`, carrying RFC 1928's reply code (`0x03`
    /// network unreachable, `0x04` host unreachable, `0x05` connection refused,
    /// …). The byte is carried for diagnosis and for the tests that pin the
    /// decoding; it is deliberately NOT surfaced — [`TransportError`] collapses
    /// every refusal to `Network`, because "Tor could not reach the sync server"
    /// and "the circuit is broken" have the same remedy from the UI's side, and
    /// a per-code message would be reporting the exit relay's opinion.
    Refused(u8),
    /// The target hostname is empty, longer than SOCKS5's 255-byte field, or
    /// carries bytes that have no business in a hostname.
    BadHostname,
}

impl From<Socks5Error> for TransportError {
    fn from(e: Socks5Error) -> Self {
        match e {
            // A malformed hostname is a caller bug (a bad configured endpoint),
            // not a network condition — the same split the direct path makes
            // when `ServerName::try_from` fails.
            Socks5Error::BadHostname => TransportError::BadRequest,
            _ => TransportError::Network,
        }
    }
}

/// Open a tunneled TCP stream to `host:port` through the loopback SOCKS5 proxy
/// on `socks_port`.
///
/// `host` is sent as a **name**; it is never resolved on this device. The
/// returned stream carries application bytes only — the caller layers pinned
/// TLS on it exactly as it would on a direct socket.
///
/// Blocking. Called from the same `spawn_blocking` context as the rest of the
/// transport.
pub fn connect_via_socks5(
    socks_port: u16,
    host: &str,
    port: u16,
) -> Result<TcpStream, Socks5Error> {
    // Built before the socket, so a bad hostname never opens one.
    let request = encode_connect_request(host, port)?;

    // A literal loopback address: `SocketAddr`, not `(&str, u16)`, so there is
    // no name for a resolver to see even for the proxy's own address.
    let proxy = SocketAddr::from((Ipv4Addr::LOCALHOST, socks_port));
    let mut sock = TcpStream::connect_timeout(&proxy, PROXY_CONNECT_TIMEOUT)
        .map_err(|_| Socks5Error::ProxyUnreachable)?;
    // The handshake's read deadline has to tolerate circuit construction (the
    // proxy answers `CONNECT` only once Tor has a working circuit to the
    // target), so it is the transport's full socket timeout rather than the
    // short one used to reach the proxy itself.
    let _ = sock.set_read_timeout(Some(SOCKET_TIMEOUT));
    let _ = sock.set_write_timeout(Some(SOCKET_TIMEOUT));

    sock.write_all(&METHOD_NEGOTIATION_GREETING)
        .map_err(|_| Socks5Error::Protocol)?;
    read_method_selection(&mut sock)?;

    sock.write_all(&request)
        .map_err(|_| Socks5Error::Protocol)?;
    sock.flush().map_err(|_| Socks5Error::Protocol)?;
    read_connect_reply(&mut sock)?;

    Ok(sock)
}

/// Encode a SOCKS5 `CONNECT` request for a **named** target.
///
/// `VER | CMD | RSV | ATYP=0x03 | LEN | hostname | port(BE)`.
///
/// The hostname is validated here rather than at the socket, because this is
/// the frame that leaves the device: a name carrying CR/LF or NUL could be read
/// by a non-arti proxy as more than one instruction, and a name longer than 255
/// bytes has no representation in the length field at all.
pub fn encode_connect_request(host: &str, port: u16) -> Result<Vec<u8>, Socks5Error> {
    let name = host.as_bytes();
    let len = u8::try_from(name.len()).map_err(|_| Socks5Error::BadHostname)?;
    if len == 0 || !name.iter().all(|b| b.is_ascii_graphic()) {
        return Err(Socks5Error::BadHostname);
    }
    let mut out = Vec::with_capacity(7 + name.len());
    out.extend_from_slice(&[VER, CMD_CONNECT, 0x00, ATYP_DOMAIN, len]);
    out.extend_from_slice(name);
    out.extend_from_slice(&port.to_be_bytes());
    Ok(out)
}

/// Read the proxy's 2-byte method selection and accept only `NO AUTH`.
///
/// Public for the same reason [`METHOD_NEGOTIATION_GREETING`] is: the
/// supervisor's liveness probe reads the same reply and must agree with the
/// transport about what counts as a listener worth handing traffic to.
pub fn read_method_selection(r: &mut impl Read) -> Result<(), Socks5Error> {
    let mut reply = [0u8; 2];
    r.read_exact(&mut reply)
        .map_err(|_| Socks5Error::Protocol)?;
    match reply {
        [VER, METHOD_NO_AUTH] => Ok(()),
        [VER, METHOD_NONE_ACCEPTABLE] => Err(Socks5Error::AuthRequired),
        // A selected method we never offered, or a version that is not 5.
        _ => Err(Socks5Error::Protocol),
    }
}

/// Read the `CONNECT` reply and consume its bound address.
///
/// The bound address is variable-length and its bytes must be drained even
/// though nothing uses them: whatever is left unread is the first thing the TLS
/// handshake would see, and a stray byte there turns a working tunnel into an
/// unexplainable handshake failure.
fn read_connect_reply(r: &mut impl Read) -> Result<(), Socks5Error> {
    let mut head = [0u8; 4];
    r.read_exact(&mut head).map_err(|_| Socks5Error::Protocol)?;
    let [ver, rep, _rsv, atyp] = head;
    if ver != VER {
        return Err(Socks5Error::Protocol);
    }
    if rep != REP_SUCCEEDED {
        return Err(Socks5Error::Refused(rep));
    }
    let addr_len = match atyp {
        ATYP_IPV4 => 4,
        ATYP_IPV6 => 16,
        ATYP_DOMAIN => {
            let mut n = [0u8; 1];
            r.read_exact(&mut n).map_err(|_| Socks5Error::Protocol)?;
            usize::from(n[0])
        }
        _ => return Err(Socks5Error::Protocol),
    };
    // Address + the 2-byte bound port.
    let mut rest = vec![0u8; addr_len + 2];
    r.read_exact(&mut rest).map_err(|_| Socks5Error::Protocol)?;
    Ok(())
}

/// A fake SOCKS5 proxy, for tests that need a tunnel without needing Tor.
///
/// Real Tor never runs in CI (PRD; task 12 documents the manual real-Tor
/// procedure that CI deliberately cannot replace). This listener is what makes
/// the tunneled paths testable: it records the `CONNECT` target it was asked
/// for — which is how a test proves the hostname travelled as a *name* — and
/// then either splices the connection to a local target or refuses it.
///
/// Lives beside the client rather than in a test file because tasks 4 and 10
/// need the same fixture, and two hand-written fake proxies would eventually
/// disagree about the protocol they are both pretending to speak.
#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// What the fake proxy does after it has read a `CONNECT`.
    #[derive(Debug, Clone, Copy)]
    pub(crate) enum Behavior {
        /// Answer success and splice the tunnel to `127.0.0.1:<port>` — the
        /// stand-in for "Tor reached the target".
        Splice(u16),
        /// Answer the given RFC 1928 failure code (`0x05` = connection
        /// refused): the target is unreachable through the circuit.
        Refuse(u8),
        /// Reject method negotiation with `0xFF` before any `CONNECT` — a proxy
        /// that demands authentication.
        NoAcceptableMethods,
    }

    /// A `CONNECT` target as the proxy saw it on the wire.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct SeenTarget {
        /// The address-type byte. `0x03` here is the remote-DNS proof: an
        /// `0x01` would mean the client resolved the name locally first.
        pub(crate) atyp: u8,
        /// The target as sent — a hostname for `0x03`, dotted/colon form
        /// otherwise.
        pub(crate) host: String,
        /// The target port as sent.
        pub(crate) port: u16,
    }

    /// A running fake proxy. Serves `n` connections then stops; the handle
    /// carries the loopback port and what it saw.
    pub(crate) struct FakeSocks5 {
        /// Loopback port the fake proxy is listening on.
        pub(crate) port: u16,
        seen: Arc<Mutex<Vec<SeenTarget>>>,
    }

    impl FakeSocks5 {
        /// Bind an ephemeral loopback port and serve `n` connections.
        pub(crate) fn spawn(n: usize, behavior: Behavior) -> Self {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind fake proxy");
            let port = listener.local_addr().expect("local addr").port();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let recorder = seen.clone();
            std::thread::spawn(move || {
                for _ in 0..n {
                    let Ok((sock, _)) = listener.accept() else {
                        return;
                    };
                    let recorder = recorder.clone();
                    std::thread::spawn(move || serve(sock, behavior, recorder));
                }
            });
            Self { port, seen }
        }

        /// The `CONNECT` targets this proxy has been asked for so far.
        pub(crate) fn seen(&self) -> Vec<SeenTarget> {
            self.seen.lock().expect("seen lock").clone()
        }
    }

    fn serve(mut sock: TcpStream, behavior: Behavior, seen: Arc<Mutex<Vec<SeenTarget>>>) {
        // Greeting: VER, NMETHODS, then that many method bytes.
        let mut head = [0u8; 2];
        if sock.read_exact(&mut head).is_err() || head[0] != VER {
            return;
        }
        let mut methods = vec![0u8; usize::from(head[1])];
        if sock.read_exact(&mut methods).is_err() {
            return;
        }
        if let Behavior::NoAcceptableMethods = behavior {
            let _ = sock.write_all(&[VER, METHOD_NONE_ACCEPTABLE]);
            return;
        }
        if sock.write_all(&[VER, METHOD_NO_AUTH]).is_err() {
            return;
        }

        let Some(target) = read_request(&mut sock) else {
            return;
        };
        seen.lock().expect("seen lock").push(target);

        match behavior {
            Behavior::Refuse(rep) => {
                let _ = sock.write_all(&reply(rep));
            }
            Behavior::NoAcceptableMethods => unreachable!("handled above"),
            Behavior::Splice(target_port) => {
                let Ok(upstream) =
                    TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, target_port)))
                else {
                    let _ = sock.write_all(&reply(0x05));
                    return;
                };
                if sock.write_all(&reply(REP_SUCCEEDED)).is_err() {
                    return;
                }
                splice(sock, upstream);
            }
        }
    }

    /// Read a `CONNECT` request and return the target it names.
    fn read_request(sock: &mut TcpStream) -> Option<SeenTarget> {
        let mut head = [0u8; 4];
        sock.read_exact(&mut head).ok()?;
        let [ver, cmd, _rsv, atyp] = head;
        if ver != VER || cmd != CMD_CONNECT {
            return None;
        }
        let host = match atyp {
            ATYP_DOMAIN => {
                let mut n = [0u8; 1];
                sock.read_exact(&mut n).ok()?;
                let mut name = vec![0u8; usize::from(n[0])];
                sock.read_exact(&mut name).ok()?;
                String::from_utf8(name).ok()?
            }
            ATYP_IPV4 => {
                let mut a = [0u8; 4];
                sock.read_exact(&mut a).ok()?;
                Ipv4Addr::from(a).to_string()
            }
            ATYP_IPV6 => {
                let mut a = [0u8; 16];
                sock.read_exact(&mut a).ok()?;
                std::net::Ipv6Addr::from(a).to_string()
            }
            _ => return None,
        };
        let mut p = [0u8; 2];
        sock.read_exact(&mut p).ok()?;
        Some(SeenTarget {
            atyp,
            host,
            port: u16::from_be_bytes(p),
        })
    }

    /// A reply with an IPv4 `0.0.0.0:0` bound address — what a proxy that has
    /// nothing meaningful to report sends, arti included.
    fn reply(rep: u8) -> [u8; 10] {
        [VER, rep, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]
    }

    /// Copy bytes both ways until either side closes.
    fn splice(client: TcpStream, upstream: TcpStream) {
        let (mut c_read, mut c_write) = (
            client.try_clone().expect("clone client"),
            client.try_clone().expect("clone client"),
        );
        let (mut u_read, mut u_write) = (
            upstream.try_clone().expect("clone upstream"),
            upstream.try_clone().expect("clone upstream"),
        );
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut c_read, &mut u_write);
            let _ = u_write.shutdown(std::net::Shutdown::Write);
        });
        let _ = std::io::copy(&mut u_read, &mut c_write);
        let _ = c_write.shutdown(std::net::Shutdown::Write);
    }
}

#[cfg(test)]
mod tests {
    use super::fake::{Behavior, FakeSocks5, SeenTarget};
    use super::*;
    use std::io::Cursor;
    use std::net::TcpListener;

    // ── the request frame ───────────────────────────────────────────────────

    /// The whole point of the module in one assertion: the target travels as a
    /// name under address type `0x03`, so DNS happens at the exit and not here.
    #[test]
    fn connect_request_carries_the_hostname_under_the_domain_name_address_type() {
        let mut expect = vec![
            0x05, // VER
            0x01, // CMD = CONNECT
            0x00, // RSV
            0x03, // ATYP = domain name  ← never 0x01/0x04 on this path
            12,   // LEN
        ];
        expect.extend_from_slice(b"sync.myne.md");
        expect.extend_from_slice(&[0x01, 0xbb]); // port 443, big-endian

        let req = encode_connect_request("sync.myne.md", 443).expect("encode");
        assert_eq!(req, expect);
    }

    #[test]
    fn connect_request_encodes_a_non_default_port_big_endian() {
        let req = encode_connect_request("h", 8443).expect("encode");
        assert_eq!(&req[req.len() - 2..], &8443u16.to_be_bytes());
    }

    #[test]
    fn connect_request_rejects_hostnames_that_have_no_wire_representation() {
        let long = "a".repeat(256);
        for bad in ["", long.as_str()] {
            assert_eq!(
                encode_connect_request(bad, 443),
                Err(Socks5Error::BadHostname),
                "{} bytes must not be encodable",
                bad.len()
            );
        }
        // 255 is the boundary the length byte can still express.
        assert!(encode_connect_request(&"a".repeat(255), 443).is_ok());
    }

    /// A name is not a place to smuggle framing. CR/LF/NUL/space would be read
    /// by some proxies as the end of one thing and the start of another.
    #[test]
    fn connect_request_rejects_control_characters_in_the_hostname() {
        for bad in ["sync.myne.md\r\nX", "sync\0.md", "sync .md", "sync\tmd"] {
            assert_eq!(
                encode_connect_request(bad, 443),
                Err(Socks5Error::BadHostname),
                "{bad:?} must be rejected"
            );
        }
    }

    // ── the reply frames ────────────────────────────────────────────────────

    #[test]
    fn method_selection_accepts_no_auth_and_rejects_everything_else() {
        assert_eq!(
            read_method_selection(&mut Cursor::new([0x05, 0x00])),
            Ok(())
        );
        assert_eq!(
            read_method_selection(&mut Cursor::new([0x05, 0xFF])),
            Err(Socks5Error::AuthRequired),
            "a proxy demanding auth is not our sidecar"
        );
        // A method we never offered (`0x02` = username/password), and a
        // non-SOCKS5 version byte.
        assert_eq!(
            read_method_selection(&mut Cursor::new([0x05, 0x02])),
            Err(Socks5Error::Protocol)
        );
        assert_eq!(
            read_method_selection(&mut Cursor::new([0x04, 0x00])),
            Err(Socks5Error::Protocol)
        );
        assert_eq!(
            read_method_selection(&mut Cursor::new([0x05])),
            Err(Socks5Error::Protocol),
            "a truncated reply is not a success"
        );
    }

    /// Each bound-address form must be drained exactly: a byte left behind is
    /// the first byte the TLS handshake reads.
    #[test]
    fn connect_reply_consumes_every_bound_address_form_and_nothing_more() {
        let cases: [(Vec<u8>, &str); 3] = [
            (vec![0x05, 0x00, 0x00, 0x01, 1, 2, 3, 4, 0x1f, 0x90], "ipv4"),
            (
                vec![0x05, 0x00, 0x00, 0x03, 3, b'a', b'b', b'c', 0x1f, 0x90],
                "domain",
            ),
            (
                vec![
                    0x05, 0x00, 0x00, 0x04, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
                    0x1f, 0x90,
                ],
                "ipv6",
            ),
        ];
        for (frame, label) in cases {
            // A trailing sentinel stands in for the first application byte.
            let mut wire = frame.clone();
            wire.push(0xAB);
            let mut cursor = Cursor::new(wire);
            assert_eq!(read_connect_reply(&mut cursor), Ok(()), "{label}");
            let mut rest = Vec::new();
            cursor.read_to_end(&mut rest).expect("read rest");
            assert_eq!(rest, vec![0xAB], "{label}: bound address must be drained");
        }
    }

    #[test]
    fn connect_reply_surfaces_the_refusal_code_and_rejects_malformed_frames() {
        assert_eq!(
            read_connect_reply(&mut Cursor::new([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])),
            Err(Socks5Error::Refused(0x05)),
            "connection refused must not be flattened into a generic error"
        );
        assert_eq!(
            read_connect_reply(&mut Cursor::new([0x04, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])),
            Err(Socks5Error::Protocol)
        );
        assert_eq!(
            read_connect_reply(&mut Cursor::new([0x05, 0x00, 0x00, 0x09])),
            Err(Socks5Error::Protocol),
            "an unknown address type leaves the stream unparseable"
        );
        assert_eq!(
            read_connect_reply(&mut Cursor::new([0x05, 0x00, 0x00, 0x01, 1, 2])),
            Err(Socks5Error::Protocol),
            "a truncated bound address is not a success"
        );
    }

    // ── the tunnel, against a fake proxy ────────────────────────────────────

    /// An echo listener: whatever it receives, it sends back.
    fn spawn_echo() -> u16 {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind echo");
        let port = listener.local_addr().expect("local addr").port();
        std::thread::spawn(move || {
            while let Ok((sock, _)) = listener.accept() {
                std::thread::spawn(move || {
                    let mut read = sock.try_clone().expect("clone");
                    let mut write = sock;
                    let _ = std::io::copy(&mut read, &mut write);
                });
            }
        });
        port
    }

    /// End-to-end: bytes cross the tunnel, and the proxy was asked for a
    /// **hostname that does not resolve on this machine** (`.invalid` is
    /// reserved by RFC 2606 precisely so it never resolves). Had the client
    /// resolved locally, this test could not even reach the `CONNECT`.
    #[test]
    fn a_tunnel_carries_bytes_and_the_proxy_is_asked_for_an_unresolvable_name() {
        let echo = spawn_echo();
        let proxy = FakeSocks5::spawn(1, Behavior::Splice(echo));

        let mut tunnel =
            connect_via_socks5(proxy.port, "sync.unresolvable.invalid", 443).expect("tunnel");
        tunnel.write_all(b"ping").expect("write");
        tunnel.flush().expect("flush");
        let mut got = [0u8; 4];
        tunnel.read_exact(&mut got).expect("read");
        assert_eq!(&got, b"ping");

        assert_eq!(
            proxy.seen(),
            vec![SeenTarget {
                atyp: 0x03,
                host: "sync.unresolvable.invalid".to_string(),
                port: 443,
            }],
            "the proxy must receive the NAME — resolving it is the exit's job"
        );
    }

    /// The port the proxy is asked to reach is the target's, not the local
    /// stand-in's: the client knows nothing about where the tunnel lands.
    #[test]
    fn the_connect_target_port_is_the_targets_not_the_proxys() {
        let echo = spawn_echo();
        let proxy = FakeSocks5::spawn(1, Behavior::Splice(echo));
        let _tunnel = connect_via_socks5(proxy.port, "sync.myne.md", 8443).expect("tunnel");
        let seen = proxy.seen();
        assert_eq!(seen[0].port, 8443);
        assert_ne!(seen[0].port, echo);
        assert_ne!(seen[0].port, proxy.port);
    }

    /// A dead proxy is an error — and, critically, an error is all it is. There
    /// is no direct-connect branch in this function for a caller to fall into.
    #[test]
    fn an_unreachable_proxy_is_an_error() {
        // Bind then drop, so the port is one nothing is listening on.
        let dead = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        assert_eq!(
            connect_via_socks5(dead, "sync.myne.md", 443).err(),
            Some(Socks5Error::ProxyUnreachable)
        );
    }

    #[test]
    fn a_proxy_that_refuses_the_connect_yields_its_reply_code() {
        let proxy = FakeSocks5::spawn(1, Behavior::Refuse(0x04));
        assert_eq!(
            connect_via_socks5(proxy.port, "sync.myne.md", 443).err(),
            Some(Socks5Error::Refused(0x04)),
            "0x04 = host unreachable"
        );
    }

    #[test]
    fn a_proxy_demanding_authentication_is_refused_before_any_connect() {
        let proxy = FakeSocks5::spawn(1, Behavior::NoAcceptableMethods);
        assert_eq!(
            connect_via_socks5(proxy.port, "sync.myne.md", 443).err(),
            Some(Socks5Error::AuthRequired)
        );
        assert!(
            proxy.seen().is_empty(),
            "the hostname must not be disclosed to a proxy that rejected the greeting"
        );
    }

    /// A bad hostname must fail before a socket exists — the proxy never even
    /// sees a connection.
    #[test]
    fn a_bad_hostname_fails_before_the_proxy_is_contacted() {
        let proxy = FakeSocks5::spawn(1, Behavior::Splice(1));
        assert_eq!(
            connect_via_socks5(proxy.port, "sync\r\n.md", 443).err(),
            Some(Socks5Error::BadHostname)
        );
        assert!(proxy.seen().is_empty());
    }

    #[test]
    fn errors_map_onto_the_transports_error_enum() {
        assert_eq!(
            TransportError::from(Socks5Error::BadHostname),
            TransportError::BadRequest
        );
        for e in [
            Socks5Error::ProxyUnreachable,
            Socks5Error::Protocol,
            Socks5Error::AuthRequired,
            Socks5Error::Refused(0x05),
        ] {
            assert_eq!(
                TransportError::from(e),
                TransportError::Network,
                "{e:?} is a network-layer failure"
            );
        }
    }
}
