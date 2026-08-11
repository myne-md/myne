//! The device-local AI provider endpoint (ai-ollama-local task 3, SYNC-12).
//!
//! One JSON file under `<app_config_dir>`, sibling of `tor-routing.json`, and
//! the rule that it can only ever name **this machine**.
//!
//! **Its own file, not a field on an existing config struct.** The reason is
//! the one `core/src/plugins/sync/tor_config.rs` gives about itself: a struct
//! whose write path constructs a fresh value is one forgotten
//! read-modify-write away from silently resetting a co-resident field with a
//! different lifetime. And **not** a `vault.prefs` field — not even "a
//! `PrefsView` field classified DeviceLocal", which would still live in the
//! synced blob, one classification-table edit away from syncing. Network
//! posture is a property of a device, not of a vault.
//!
//! **Loopback-only, and the predicate is not re-implemented here.** Validation
//! goes through `myne_core::plugins::sync::config::validate_endpoint_url`:
//! `https` anywhere, `http` only for one of exactly three literal host names,
//! everything else refused. That predicate is `pub(crate)` in core and
//! deliberately not reachable from this crate — the validator is the door.
//! Its own doc says why: "three copies of a three-name `matches!` is three
//! chances for the rules to disagree." It matches **literal strings, never a
//! resolved address**, which is what closes the DNS-rebind hole a free-form URL
//! field would otherwise open: a name that resolves to `127.0.0.1` today is a
//! name somebody else's DNS answers tomorrow.
//!
//! **Which way each failure falls — and note it is the OPPOSITE of Tor's.**
//!   - *Absent* ⇒ no endpoint, so the arm is **unreachable**, not merely
//!     disabled. That is the default-state half of the invariant in
//!     `decisions.md` 2026-08-09, and it is the shipped state of every install
//!     that predates this feature.
//!   - *Unparseable, or a value the validator refuses* ⇒ **no endpoint, and the
//!     error is surfaced**. Never a silent fallback to a conventional address.
//!
//! `tor_config` resolves its corrupt case to *on*, because there the exposed
//! direction is the other one: failing to route is the exposure. Here, inventing
//! an egress nobody configured is the failure this feature must not have. The
//! asymmetry is deliberate, not an oversight in one of the two.
//!
//! **No conventional address appears as a stored or fallback value anywhere in
//! this file.** A default port would be a guess about someone else's software
//! that silently becomes an egress target; the user names the endpoint or there
//! is none.
//!
//! Errors are closed, `Serialize`, and carry no `String` and no path — a path in
//! an error message is a disclosure (`src-tauri/CLAUDE.md` DENY list).

// No production consumer until task 4 wires the get/set IPC commands. Annotated
// at module level, with the task that consumes it named, rather than left to a
// blanket allow somewhere up the tree — an unexplained `allow(dead_code)` is how
// inert wiring hides, and this module is the one that decides where AI traffic
// may go.
#![cfg_attr(not(test), allow(dead_code))]

use myne_core::io_failure_kind::IoFailureKind;
use myne_core::plugins::sync::config::{validate_endpoint_url, SyncConfigError};
use myne_core::plugins::sync::http_transport::parse_endpoint;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The file name under `<app_config_dir>`. Sibling of `tor-routing.json`.
const FILE_NAME: &str = "ai-endpoint.json";

/// The endpoint as persisted. One field, so a future second setting gets its
/// own file rather than a read-modify-write hazard here.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiEndpointConfig {
    /// The URL the user named, exactly as they gave it.
    #[serde(default)]
    pub url: String,
    /// The model the user named at that URL. **No default** (SYNC-24): a pinned
    /// tag rots, and on a metered API a default nobody chose is a bill nobody
    /// chose. Empty means the arm is configured but not usable — the endpoint is
    /// stored, and no engine is built from it.
    ///
    /// `#[serde(default)]` so a file written before this field existed reads as
    /// "URL set, no model" rather than failing to parse into a rebuild-less
    /// config the user would then have to re-enter.
    #[serde(default)]
    pub model: String,
}

/// Why a URL was refused. Closed, so the UI switches on it rather than reading
/// prose, and so a new refusal reason cannot be added without a compile error
/// at every reader.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointRejection {
    /// Not a URL this client will parse at all — a missing scheme, an empty
    /// authority, embedded credentials, or `http` with no explicit port.
    Malformed,
    /// A scheme other than `http` or `https`.
    UnsupportedScheme,
    /// A host that is not one of the three literal loopback names, under ANY
    /// scheme. Plain `http` is the case the DNS-rebind reasoning is about;
    /// `https` is refused for a different reason — this engine speaks no TLS,
    /// so an accepted `https://` URL is dialled in cleartext, and it would
    /// register as a loopback-CLASS backend, which the remote arm's consent
    /// gate and the ambient-surface bar are both keyed against.
    NotLoopback,
}

/// Failure surface for reading or writing the endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "detail")]
pub enum AiEndpointError {
    /// Filesystem error on `ai-endpoint.json`.
    #[error("filesystem error on the AI endpoint config")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
    /// The on-disk file failed to parse as JSON.
    #[error("the AI endpoint config failed to parse")]
    Parse,
    /// The stored or supplied URL is not one this client will use.
    #[error("the AI endpoint URL was refused")]
    Rejected {
        /// Which rule refused it.
        reason: EndpointRejection,
    },
}

/// A validated endpoint, split for a caller that needs to connect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedEndpoint {
    /// The URL as stored, for display and for re-validation on read.
    pub url: String,
    /// Host, guaranteed to be one of the three literal loopback names when the
    /// scheme is `http`.
    pub host: String,
    /// Port — always explicit for `http`; `parse_endpoint` requires it.
    pub port: u16,
    /// The model the user named, or empty. Not validated here — a model name is
    /// the runtime's namespace, not Myne's, and guessing at its grammar would
    /// reject names a future runtime accepts. Empty is the meaningful case: see
    /// [`ResolvedEndpoint::usable`].
    pub model: String,
}

/// `<app_config_dir>/ai-endpoint.json`.
pub fn endpoint_path_in(config_dir: &Path) -> PathBuf {
    config_dir.join(FILE_NAME)
}

fn io(e: std::io::Error) -> AiEndpointError {
    AiEndpointError::Io {
        io_error_kind: myne_core::io_failure_kind::from_io_error_kind(e.kind()),
    }
}

/// Validate a URL and split it, without touching the filesystem.
///
/// Two gates, in this order, because they answer different questions: the
/// validator decides whether this destination is *allowed*, and `parse_endpoint`
/// decides whether it is *usable* (it is also what rejects embedded credentials
/// and `http` with no explicit port).
pub fn validate(url: &str) -> Result<ResolvedEndpoint, AiEndpointError> {
    match validate_endpoint_url(url) {
        Ok(()) => {}
        Err(SyncConfigError::InsecureScheme) => {
            return Err(AiEndpointError::Rejected {
                reason: EndpointRejection::NotLoopback,
            })
        }
        Err(_) => {
            // `validate_endpoint_url` answers "not a URL I parse" and "scheme I
            // do not speak" with the same variant; separate them here so the UI
            // can say which, since they have different remedies.
            let scheme_ok = url.starts_with("http://") || url.starts_with("https://");
            return Err(AiEndpointError::Rejected {
                reason: if scheme_ok {
                    EndpointRejection::Malformed
                } else {
                    EndpointRejection::UnsupportedScheme
                },
            });
        }
    }
    let (_scheme, host, port) = parse_endpoint(url).ok_or(AiEndpointError::Rejected {
        reason: EndpointRejection::Malformed,
    })?;
    // The shared validator answers the SYNC policy, where `https` to a remote
    // host is the normal case (rustls + a TOFU pin). This endpoint has neither:
    // `engine_ollama` opens a bare `TcpStream`, so an `https://` URL it accepted
    // would carry note plaintext to that host IN THE CLEAR — and `resolve_backends`
    // would class it `LoopbackLocal`, which is the class both the remote-provider
    // consent gate and the ambient-surface bar are written against. So the
    // locality check is made here, scheme-independently, rather than by widening
    // a validator three sync call sites depend on.
    if !myne_core::plugins::sync::http_transport::is_loopback_host(&host) {
        return Err(AiEndpointError::Rejected {
            reason: EndpointRejection::NotLoopback,
        });
    }
    Ok(ResolvedEndpoint {
        url: url.to_string(),
        host,
        port,
        model: String::new(),
    })
}

impl ResolvedEndpoint {
    /// Whether an engine can be built from this. A URL with no model is stored
    /// and shown, but is NOT a backend — SYNC-24 leaves the model name to the
    /// user, so "half configured" must resolve to the in-process arm rather
    /// than to a runtime call naming nothing.
    pub fn usable(&self) -> bool {
        !self.model.trim().is_empty()
    }
}

/// Read the endpoint from `path`.
///
/// `Ok(None)` means **no endpoint is configured**, which is the unreachable
/// state rather than a disabled one. A stored value is re-validated on every
/// read, so a file edited by hand after the fact cannot smuggle a destination
/// past the setter.
///
/// Deliberately **not** memoised: callers read it when they need it, so a user
/// who changes the URL or the model in Settings does not have to restart the
/// app — [`super::engine_ollama::ConfiguredOllamaEngine`] re-reads this per
/// call for exactly that reason.
///
/// The one thing that IS decided once, at startup, is *which arm is active*:
/// switching between the in-process engine and a named runtime changes the
/// backend's class, and the registry is immutable after `init`. So a first-time
/// configuration takes effect on the next launch; edits to an already-active
/// endpoint take effect immediately.
pub fn read_endpoint(path: &Path) -> Result<Option<ResolvedEndpoint>, AiEndpointError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io(e)),
    };
    let cfg: AiEndpointConfig = serde_json::from_str(&raw).map_err(|_| AiEndpointError::Parse)?;
    if cfg.url.trim().is_empty() {
        return Ok(None);
    }
    let mut resolved = validate(&cfg.url)?;
    resolved.model = cfg.model.trim().to_string();
    Ok(Some(resolved))
}

/// Validate and persist. Refuses before writing, so the file can never hold a
/// destination the reader would reject.
pub fn write_endpoint(
    path: &Path,
    url: &str,
    model: &str,
) -> Result<ResolvedEndpoint, AiEndpointError> {
    let mut resolved = validate(url)?;
    resolved.model = model.trim().to_string();
    let body = serde_json::to_string_pretty(&AiEndpointConfig {
        url: resolved.url.clone(),
        model: resolved.model.clone(),
    })
    .map_err(|_| AiEndpointError::Parse)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    std::fs::write(path, body).map_err(io)?;
    Ok(resolved)
}

/// Clear the endpoint, returning the arm to unreachable.
pub fn clear_endpoint(path: &Path) -> Result<(), AiEndpointError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("myne-endpoint-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmp dir");
        endpoint_path_in(&dir)
    }

    fn rejection(url: &str) -> EndpointRejection {
        match validate(url) {
            Err(AiEndpointError::Rejected { reason }) => reason,
            other => panic!("{url} must be refused, got {other:?}"),
        }
    }

    #[test]
    fn absent_means_no_endpoint_not_a_default_one() {
        let p = tmp("absent");
        assert_eq!(read_endpoint(&p), Ok(None));
    }

    #[test]
    fn a_loopback_http_url_with_a_port_is_accepted_and_split() {
        let r = validate("http://127.0.0.1:11434").expect("loopback accepted");
        assert_eq!(r.host, "127.0.0.1");
        assert_eq!(r.port, 11434);
    }

    #[test]
    fn localhost_and_ipv6_loopback_are_accepted_too() {
        assert!(validate("http://localhost:11434").is_ok());
        assert!(validate("http://[::1]:11434").is_ok());
    }

    /// `https` buys this endpoint nothing, so it is refused like plain `http`.
    ///
    /// The shared `validate_endpoint_url` accepts `https` to any host, correctly,
    /// for the SYNC endpoint — which speaks rustls and pins the leaf. THIS engine
    /// has no TLS at all (`engine_ollama` opens a bare `TcpStream`), so an
    /// accepted `https://` URL is dialled in cleartext on port 443, and
    /// `resolve_backends` classes it `LoopbackLocal` — the class the remote-arm
    /// consent gate and the ambient-surface bar are both keyed against. The
    /// locality check therefore lives here, not in the shared validator.
    #[test]
    fn https_to_a_remote_host_is_refused_too() {
        assert_eq!(
            validate("https://example.com"),
            Err(AiEndpointError::Rejected {
                reason: EndpointRejection::NotLoopback
            })
        );
        assert_eq!(
            validate("https://ollama.my-vps.example:443"),
            Err(AiEndpointError::Rejected {
                reason: EndpointRejection::NotLoopback
            })
        );
    }

    /// `https` to loopback stays accepted: a runtime behind a local TLS
    /// terminator is still on this device, and refusing it would be a rule about
    /// the scheme rather than about where the bytes go.
    #[test]
    fn https_to_loopback_is_still_accepted() {
        assert!(validate("https://127.0.0.1:11434").is_ok());
        assert!(validate("https://localhost:11434").is_ok());
    }

    #[test]
    fn plain_http_to_a_remote_host_is_refused() {
        assert_eq!(
            rejection("http://evil.example:11434"),
            EndpointRejection::NotLoopback
        );
    }

    /// The DNS-rebind case, named so it is not mistaken for a duplicate of the
    /// one above. `myne.local` may resolve to `127.0.0.1` on this machine right
    /// now; the check is a **literal string match** precisely so that does not
    /// matter — the name is somebody else's DNS answer tomorrow.
    #[test]
    fn a_name_that_would_resolve_to_loopback_is_still_refused() {
        assert_eq!(
            rejection("http://myne.local:11434"),
            EndpointRejection::NotLoopback
        );
    }

    #[test]
    fn embedded_credentials_are_refused() {
        // `parse_endpoint` rejects an authority containing `@`; without that a
        // URL could carry credentials to a destination the user never read.
        assert!(matches!(
            validate("http://user:pw@127.0.0.1:11434"),
            Err(AiEndpointError::Rejected { .. })
        ));
    }

    #[test]
    fn a_non_http_scheme_is_refused() {
        assert_eq!(
            rejection("ftp://127.0.0.1:11434"),
            EndpointRejection::UnsupportedScheme
        );
    }

    #[test]
    fn http_without_an_explicit_port_is_refused() {
        assert_eq!(rejection("http://127.0.0.1"), EndpointRejection::Malformed);
    }

    #[test]
    fn corrupt_json_surfaces_an_error_and_never_a_fallback_address() {
        let p = tmp("corrupt");
        std::fs::write(&p, "{not json").expect("write");
        assert_eq!(read_endpoint(&p), Err(AiEndpointError::Parse));
    }

    /// A file edited by hand after the setter refused nothing must still be
    /// re-validated on read — the setter is not the only door.
    #[test]
    fn a_hand_edited_remote_url_is_refused_on_read() {
        let p = tmp("handedit");
        std::fs::write(&p, r#"{"url":"http://evil.example:11434"}"#).expect("write");
        assert_eq!(
            read_endpoint(&p),
            Err(AiEndpointError::Rejected {
                reason: EndpointRejection::NotLoopback
            })
        );
    }

    #[test]
    fn write_refuses_before_it_writes() {
        let p = tmp("refuse");
        assert!(write_endpoint(&p, "http://evil.example:11434", "any-model").is_err());
        assert!(!p.exists(), "a refused URL must not reach the disk");
    }

    #[test]
    fn a_written_endpoint_round_trips_and_clearing_returns_to_unreachable() {
        let p = tmp("roundtrip");
        write_endpoint(&p, "http://127.0.0.1:11434", " nomic-embed-text ").expect("write");
        let back = read_endpoint(&p).expect("read").expect("configured");
        assert_eq!(back.port, 11434);
        // The model round-trips trimmed, and the pair is what makes the arm
        // usable — a URL alone is not a backend (SYNC-24).
        assert_eq!(back.model, "nomic-embed-text");
        assert!(back.usable());
        clear_endpoint(&p).expect("clear");
        assert_eq!(read_endpoint(&p), Ok(None), "cleared means unreachable");
    }

    /// A stored URL with no model is configured-but-not-a-backend. It reads
    /// back (so the field shows what the user typed) and reports `usable()`
    /// false, which is what keeps `resolve_backends` on the in-process arm.
    /// SYNC-24: Myne does not pick a model on the user's behalf.
    #[test]
    fn a_url_with_no_model_reads_back_but_is_not_usable() {
        let p = tmp("nomodel");
        write_endpoint(&p, "http://127.0.0.1:11434", "").expect("write");
        let back = read_endpoint(&p).expect("read").expect("configured");
        assert_eq!(back.url, "http://127.0.0.1:11434");
        assert_eq!(back.model, "");
        assert!(
            !back.usable(),
            "a URL with no model must not build an engine"
        );
    }

    /// A config written before the model field existed must not fail to parse
    /// — it reads as "URL set, no model", i.e. exactly the case above.
    #[test]
    fn a_pre_model_config_file_reads_as_url_without_model() {
        let p = tmp("legacyfile");
        std::fs::write(&p, r#"{"url":"http://127.0.0.1:11434"}"#).expect("write");
        let back = read_endpoint(&p).expect("read").expect("configured");
        assert_eq!(back.model, "");
        assert!(!back.usable());
    }

    /// An empty string is "no endpoint", not a malformed one — it is what a
    /// settings field looks like after the user clears it.
    #[test]
    fn an_empty_stored_url_reads_as_unconfigured() {
        let p = tmp("empty");
        std::fs::write(&p, r#"{"url":""}"#).expect("write");
        assert_eq!(read_endpoint(&p), Ok(None));
    }
}
