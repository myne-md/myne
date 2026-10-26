// SPDX-License-Identifier: AGPL-3.0
//! Publishing a vault to the server (myne-md/myne#911 task 8).
//!
//! # What publishing is, and what it is not
//!
//! A vault created under an identity is **device-only** until the user says
//! otherwise: nothing is uploaded at creation, and the PRD forbids it. Publishing
//! is that explicit act, and it does exactly two things:
//!
//! 1. `PUT /vault.meta?account=<binding>` under the person token. The server
//!    stores the opaque metadata and, on the first write for a vault it has no
//!    owner for, records this person as the owner (owner-at-first-write,
//!    `server-protocol.md` §3.1a).
//! 2. Records the namespace on this device, which is what lets every later sync
//!    request address the vault: a person-born vault has no vault SCRAM account,
//!    so `?account=<binding>` plus the person token is the only way in. The first
//!    ordinary sync cycle then pushes the signed head and the notes.
//!
//! # Why the head is not pushed here
//!
//! The PRD says the publish "seeds the metadata and signs a head". Signing one
//! here would mean authoring a head with no version-vector baseline and no
//! manifest, i.e. a head that claims less than the vault holds, and then pushing
//! it into a CAS the next cycle has to recover from. The honest shape is the one
//! implemented: publish makes the vault REACHABLE and records who owns it, and
//! the first cycle authors the head from the same machinery every cycle uses.
//! A publish that succeeds and a cycle that has not run yet is a visible state
//! (`published_at_ms` set, cursor still 0), not a silent half-vault.
//!
//! # Retry, and why nothing rolls back
//!
//! Both steps are idempotent: the meta PUT is the same bytes to the same
//! namespace (and the server's bind is first-write only), and the state write is
//! a local atomic replace. A failure at either point therefore leaves a vault the
//! user can still open, with no server-side trace beyond a meta blob that the
//! owner also owns. There is deliberately no rollback: deleting the meta on a
//! failed publish would delete the one artefact a successful later retry needs.

use std::path::Path;

use crate::host::HostCtx;
use crate::plugins::sync::config::{config_path_from_host, read_config, SyncEndpointConfig};
use crate::plugins::sync::devices::SyncDeviceError;
use crate::plugins::sync::http_transport::build_transport;
use crate::plugins::sync::person_auth;
use crate::plugins::sync::state::{read_sync_state, write_sync_state};
use crate::plugins::sync::token_store::TokenStore as _;
use crate::plugins::sync::transport::{NamespacedTransport, SyncTransport as _};
use crate::vault_io::VaultIo;

/// Where a publish leaves the vault: the namespace it is reachable under.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PublishOutcome {
    /// The vault's server namespace, lowercase hex. The same value the vault's
    /// `vault.meta` carries at §9.3 offset 6.
    pub namespace_hex: String,
    /// `true` when this call did the work, `false` when the vault was already
    /// published (a retry, an idempotent second press, or any legacy vault, whose
    /// publication predates the action). The client uses it to say "already
    /// published" rather than claiming a fresh upload.
    pub newly_published: bool,
}

/// Publish `vault_root`'s metadata under the identity this device holds.
///
/// Refusals are typed and each names a different remedy:
///
/// - [`SyncDeviceError::NotConfigured`]: no sync endpoint, so there is nowhere to
///   publish to. The remedy is Settings → Sync.
/// - [`SyncDeviceError::NotEnrolled`]: the vault is legacy (`NTV5`/`NTV6`) and
///   this device holds no per-vault token, i.e. it was never enrolled on the
///   vault account. The remedy is enrolment, not publishing.
/// - [`SyncDeviceError::PersonSessionRequired`]: the vault is person-born and no
///   person session is installed. Unlocking the identity is the remedy, and the
///   refusal exists because publishing needs a credential that names the person.
/// - [`SyncDeviceError::Unauthenticated`] / [`SyncDeviceError::Transport`] /
///   [`SyncDeviceError::TlsFailure`]: the server refused the token or the request
///   did not get there. All three are retryable once the cause is fixed.
/// - [`SyncDeviceError::NotOwner`]: the server says this vault already has an
///   owner, and it is not this person.
pub async fn publish_vault(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    vault_root: &Path,
) -> Result<PublishOutcome, SyncDeviceError> {
    let meta_path = vault_root.join("vault.meta");
    let meta_bytes = io
        .read(&meta_path)
        .await
        .map_err(|_| SyncDeviceError::Transport)?;

    // The namespace is §9.3 offset 6 in every generation, and it is the value the
    // salts and the AADs bind: for a person-born vault it is the random binding,
    // for a legacy vault its own account hash. One read covers both.
    let base =
        protocol::parse_vault_meta_any(&meta_bytes).map_err(|_| SyncDeviceError::BadRequest)?;
    let namespace_hex = protocol::hex::encode_lower(&base.account_number_hash);
    let person_born =
        meta_bytes.get(..4) == Some(protocol::vault_meta_ntv7::VAULT_META_NTV7_MAGIC.as_slice());

    let cfg = endpoint_config(host, io).await?;
    let url = cfg
        .endpoint_url
        .clone()
        .ok_or(SyncDeviceError::NotConfigured)?;

    // One credential per generation, and the difference is not cosmetic: a person
    // vault authenticates as the PERSON and names the vault, a legacy vault
    // authenticates as the vault account and names nothing.
    let token_hex = if person_born {
        let path =
            person_auth::person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Transport)?;
        let stored = person_auth::read_person_auth(io, &path)
            .await
            .map_err(|_| SyncDeviceError::Transport)?;
        person_publish_token(stored.as_ref())?
    } else {
        let stored = crate::plugins::sync::token_store::default_store()
            .read(io, vault_root)
            .await
            .map_err(|_| SyncDeviceError::NotEnrolled)?;
        protocol::hex::encode_lower(&stored.ok_or(SyncDeviceError::NotEnrolled)?)
    };

    // The PUT itself. `NamespacedTransport` appends `?account=` for the person
    // case (and for `/vault.meta` in the legacy case, which the server answers
    // exactly as it always did because the vault session already IS that
    // namespace).
    //
    // Both the transport build and the request are BLOCKING (a TLS handshake plus
    // a network round trip), so they run inside `run_blocking` like every other
    // sync call in this plugin. Issuing them straight from the async task stalls
    // an executor thread for the whole round trip, and neither clippy nor the
    // `Send` bound can see it.
    let published_meta_hash = crate::plugins::sync::orchestrator::sha256_hex(&meta_bytes);
    let response = {
        let namespace_hex = namespace_hex.clone();
        let token_hex = token_hex.clone();
        crate::task::run_blocking(
            move || -> Result<crate::plugins::sync::transport::TransportResponse, SyncDeviceError> {
            let transport = build_transport(&url).map_err(|e| {
                if matches!(e, crate::http::TransportError::Tls) {
                    SyncDeviceError::TlsFailure
                } else {
                    SyncDeviceError::Transport
                }
            })?;
            let scoped = NamespacedTransport::new(transport.as_ref(), &namespace_hex);
            // **Reconcile before overwriting (myne-md/myne#911 review).** A blind
            // PUT makes a stale local frame look like a concurrent change, and the
            // meta phase's tiebreak is then a coin flip over which password
            // survives. The concrete lockout: device A changes the vault password
            // and pushes; device B, holding the pre-change frame, presses the
            // "Republish" control the panel offers for an already-published vault;
            // the server now holds B's old wrap, and A's next cycle sees
            // `server_changed`, "simply adopts the server's copy", and A's new
            // password silently stops working.
            //
            // A newer generation is worse: a legacy device publishing its
            // `NTV5`/`NTV6` frame over a server that holds `NTV7` deletes the only
            // person wrap server-side. So: refuse a newer generation, refuse a
            // strictly greater epoch, and put only what this device still owns.
            let current = scoped
                .request(crate::http::HttpMethod::Get, "/vault.meta", &[], Some(&token_hex))
                .map_err(|_| SyncDeviceError::Transport)?;
            if current.status == 200 {
                let local_gen = protocol::vault_meta_generation(&meta_bytes);
                let server_gen = protocol::vault_meta_generation(&current.body);
                if server_gen > local_gen {
                    return Err(SyncDeviceError::NotOwner);
                }
                if server_gen == local_gen {
                    let local_epoch = protocol::parse_b2b_tail_any(&meta_bytes)
                        .map(|t| t.group_key_epoch)
                        .unwrap_or(0);
                    let server_epoch = protocol::parse_b2b_tail_any(&current.body)
                        .map(|t| t.group_key_epoch)
                        .unwrap_or(0);
                    if server_epoch > local_epoch {
                        return Err(SyncDeviceError::NotOwner);
                    }
                }
            }
            scoped
                .request(
                    crate::http::HttpMethod::Put,
                    "/vault.meta",
                    &meta_bytes,
                    Some(&token_hex),
                )
                .map_err(|_| SyncDeviceError::Transport)
        },
        )
        .await
        .map_err(|_| SyncDeviceError::Transport)??
    };

    match response.status {
        200 => {}
        401 => return Err(SyncDeviceError::Unauthenticated),
        403 => return Err(SyncDeviceError::NotOwner),
        404 => return Err(SyncDeviceError::NotConfigured),
        _ => return Err(SyncDeviceError::Transport),
    }

    // Record it, so every later sync request names the vault. Read-modify-write
    // rather than default: the cycle owns the cursor and the CAS baselines, and
    // collapsing an unreadable state to a default here would destroy them (see
    // `read_sync_state`'s own warning).
    //
    // **Only a person-born vault records a namespace, and the asymmetry is
    // load-bearing.** The cycle reads the recorded namespace as "address
    // `?account=` and authenticate with the person token", which is true of a
    // vault that has no account of its own and false of a legacy vault whose
    // credential already names its namespace. Recording one there would switch a
    // legacy vault onto a credential it does not have, and its next cycle would
    // park at `NotReady` with nothing saying why. The legacy arm therefore
    // records the ACT and leaves the addressing exactly as it was.
    let mut state = read_sync_state(io, vault_root)
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    // A legacy vault is published BEFORE this call (the token read above is what
    // makes its account exist on the server), so this act can never claim to have
    // published it for the first time. Only a person-born vault has a first time,
    // and it is the moment the namespace stops being absent.
    let newly_published =
        person_born && state.namespace_hex.as_deref() != Some(namespace_hex.as_str());
    if person_born {
        state.namespace_hex = Some(namespace_hex.clone());
    }
    state.published_at_ms = Some(now_unix_millis(host));
    // The baseline must name what was just published, or the next meta phase reads
    // this device's own write as a remote change and re-argues the frame it just
    // sent. The unpublish/republish arms read it the same way.
    state.meta_baseline_hex = Some(published_meta_hash);
    write_sync_state(io, vault_root, &state)
        .await
        .map_err(|_| SyncDeviceError::Transport)?;

    // Nudge the status indicator and the device roster. Publishing changes what
    // the indicator should say (a person-born vault goes from "not enrolled" to
    // enrolled, because its credential is the session), and both poll on their
    // own beats, so without this the panel a user just clicked in can sit on the
    // old answer for a whole interval.
    host.emit("sync://enrollment-changed", crate::host::EventPayload::Unit);

    Ok(PublishOutcome {
        namespace_hex,
        newly_published,
    })
}

/// Where a vault stands with respect to the server, as a DURABLE fact.
///
/// "Device only" and "published" have to survive a restart, because the answer
/// is what tells a user whether their notes exist anywhere but this machine.
/// Before this existed the state was the Sync panel's own last click, so a
/// published vault looked device-only again on the next launch, and a vault row
/// could not carry the fact at all.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct PublishState {
    /// `true` when this vault is reachable on a server: a person-born vault has a
    /// recorded namespace, and a legacy vault holds its own device token (its
    /// credential names the namespace, so enrolment IS publication for it).
    pub published: bool,
    /// The namespace publish recorded, lowercase hex. `None` for a legacy vault,
    /// whose namespace is its own account and is never recorded separately.
    pub namespace_hex: Option<String>,
    /// Epoch-ms of the publish that recorded the namespace, when the user
    /// performed one on this device.
    pub published_at_ms: Option<u64>,
    /// `true` for a vault born under a person identity (`NTV7`). Its credential
    /// is the PERSON session rather than a vault account, which is why publishing
    /// it is the only way it can reach a server at all, and why the legacy
    /// "add this device" enrolment form does not apply to it.
    pub person_born: bool,
}

/// Read [`PublishState`] for `vault_root`.
///
/// Infallible by construction: an unreadable state file and a missing one both
/// answer "not published", which is the truthful reading (nothing on this device
/// says otherwise) and the one a surface listing vaults can render.
pub async fn published_state(io: &dyn VaultIo, vault_root: &Path) -> PublishState {
    // The generation decides which fact counts as publication, so it is read
    // rather than inferred. Four bytes, no allocation, no key material.
    let person_born = io
        .read(&vault_root.join("vault.meta"))
        .await
        .ok()
        .and_then(|bytes| bytes.get(..4).map(<[u8]>::to_vec))
        .map(|magic| magic == protocol::vault_meta_ntv7::VAULT_META_NTV7_MAGIC.as_slice())
        .unwrap_or(false);

    let Ok(state) = read_sync_state(io, vault_root).await else {
        return PublishState {
            published: false,
            namespace_hex: None,
            published_at_ms: None,
            person_born,
        };
    };

    // A person-born vault: the recorded namespace IS the marker, and it is the
    // only one its generation can have (it holds no vault token to read).
    if let Some(namespace_hex) = state.namespace_hex.clone() {
        return PublishState {
            published: true,
            namespace_hex: Some(namespace_hex),
            published_at_ms: state.published_at_ms,
            person_born,
        };
    }

    // A legacy vault lives on a server from the moment it enrolled: the
    // device-local token is the fact that its account exists there, and it is
    // what every sync request authenticates with.
    let enrolled = crate::plugins::sync::token_store::default_store()
        .read(io, vault_root)
        .await
        .map(|token| token.is_some())
        .unwrap_or(false);

    PublishState {
        published: enrolled,
        namespace_hex: None,
        published_at_ms: state.published_at_ms,
        person_born,
    }
}

/// The credential a person-born vault publishes with, or the refusal naming the
/// remedy.
///
/// Split out as a pure mapping because the two refusals differ only in which
/// remedy they name, and that difference is the whole point: an ABSENT identity
/// is fixed by unlocking, a RESERVED one by registering, and a surface that says
/// "unlock" to a device whose identity is already unlocked sends the user to a
/// control that will not change anything (myne-md/myne#911 task 8).
fn person_publish_token(auth: Option<&person_auth::PersonAuth>) -> Result<String, SyncDeviceError> {
    match auth {
        Some(a) if !a.token_hex.is_empty() => Ok(a.token_hex.clone()),
        Some(_) => Err(SyncDeviceError::PersonNotRegistered),
        None => Err(SyncDeviceError::PersonSessionRequired),
    }
}

/// The endpoint configuration, read through the one config path helper so the
/// command and the cycle cannot disagree about which file holds it.
async fn endpoint_config(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<SyncEndpointConfig, SyncDeviceError> {
    let path = config_path_from_host(host, io)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?;
    read_config(io, &path)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)
}

/// Epoch milliseconds, floored to the same coarse granularity `sync-state.json`
/// uses for its other wall-clock field.
fn now_unix_millis(host: &dyn HostCtx) -> u64 {
    (host.now_unix_millis() / 60_000) * 60_000
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::sync::state::{write_sync_state, SyncState};
    use crate::test_support::ScopedTempDir;
    use crate::vault_io::StdVaultIo;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime")
    }

    /// `published_state` sniffs the first four bytes and nothing else, so a
    /// magic-prefixed stub is the whole fixture a generation test needs.
    fn seed_meta(root: &Path, magic: &[u8]) {
        std::fs::write(root.join("vault.meta"), magic).expect("seed vault.meta");
    }

    /// The two refusals carry opposite remedies and used to carry one sentence:
    /// a device whose identity has never been registered was told to unlock it,
    /// which it already was.
    #[test]
    fn a_reserved_identity_is_told_to_register_not_to_unlock() {
        use crate::plugins::sync::person_auth::PersonAuth;

        assert!(matches!(
            person_publish_token(None),
            Err(SyncDeviceError::PersonSessionRequired)
        ));

        let reserved = PersonAuth::default();
        assert!(matches!(
            person_publish_token(Some(&reserved)),
            Err(SyncDeviceError::PersonNotRegistered)
        ));

        let enrolled = PersonAuth {
            token_hex: "ab".repeat(32),
            ..PersonAuth::default()
        };
        assert_eq!(
            person_publish_token(Some(&enrolled)).expect("a token publishes"),
            "ab".repeat(32)
        );
    }

    #[test]
    fn a_fresh_legacy_vault_is_device_only() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("publish-state-fresh").unwrap();
            seed_meta(tmp.path(), protocol::VAULT_META_V0_2_MAGIC.as_slice());

            let state = published_state(&StdVaultIo, tmp.path()).await;

            assert!(
                !state.published,
                "no token, no namespace: nothing is on a server"
            );
            assert!(!state.person_born);
            assert_eq!(state.namespace_hex, None);
        });
    }

    /// A legacy vault enrolled long before this feature shipped IS published:
    /// its own device token is what makes its account exist on the server, and
    /// reporting "device only" for it would be a lie about where the notes live.
    #[test]
    fn a_legacy_vault_with_a_token_is_published() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("publish-state-legacy").unwrap();
            seed_meta(tmp.path(), protocol::VAULT_META_V0_2_MAGIC.as_slice());
            crate::plugins::sync::token_store::default_store()
                .store(&StdVaultIo, tmp.path(), &[7u8; 32])
                .await
                .expect("store a device token");

            let state = published_state(&StdVaultIo, tmp.path()).await;

            assert!(state.published);
            assert!(!state.person_born);
            assert_eq!(
                state.namespace_hex, None,
                "a legacy vault's namespace is its own account, never recorded separately"
            );
        });
    }

    /// The person-born arm: the RECORDED namespace is the marker, which is the
    /// only one that generation can have (it holds no vault token to read).
    #[test]
    fn a_person_born_vault_is_published_once_its_namespace_is_recorded() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("publish-state-person").unwrap();
            seed_meta(
                tmp.path(),
                protocol::vault_meta_ntv7::VAULT_META_NTV7_MAGIC.as_slice(),
            );

            let before = published_state(&StdVaultIo, tmp.path()).await;
            assert!(!before.published, "not published until the user says so");
            assert!(before.person_born, "the generation is read, not assumed");

            let st = SyncState {
                namespace_hex: Some("ab".repeat(16)),
                published_at_ms: Some(1_700_000_000_000),
                ..SyncState::default()
            };
            write_sync_state(&StdVaultIo, tmp.path(), &st)
                .await
                .expect("record the namespace");

            let after = published_state(&StdVaultIo, tmp.path()).await;
            assert!(after.published);
            assert!(after.person_born);
            assert_eq!(
                after.namespace_hex.as_deref(),
                Some("abababababababababababababababab")
            );
            assert_eq!(after.published_at_ms, Some(1_700_000_000_000));
        });
    }
}
