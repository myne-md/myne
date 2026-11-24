// SPDX-License-Identifier: AGPL-3.0-only
//! Publishing a vault to the server (myne-md/myne#911 task 8).
//!
//! # What publishing is, and what it is not
//!
//! A vault created under an identity is **device-only** until it can be published:
//! nothing is uploaded at creation. Publishing (myne-md/myne#974) is then done by
//! [`publish_if_due`], from the sync cycle, the moment the three things it needs
//! are present: an endpoint, a registered identity and a person session. It used
//! to be a row in Settings, and the row was the ONLY way a person-born vault could
//! reach a server at all, so a user who never found it sat on a vault their other
//! devices could not see. Publishing does exactly two things:
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
use crate::plugins::sync::state::{read_sync_state, update_sync_state, Persist};
use crate::plugins::sync::token_store::TokenStore as _;
use crate::plugins::sync::transport::{
    HttpMethod, NamespacedTransport, SyncTransport, TransportResponse,
};
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

/// Decide whether this device writes `vault.meta`, and do it if so.
///
/// Split out of [`publish_vault`] so a test can drive every answer a server may
/// give without a network: the whole safety claim of this branch is the status
/// table below, and it was the one thing no test could reach while the requests
/// were built inside the blocking closure. Takes the transport rather than
/// building one, exactly like `enroll`'s `put_vault_meta`.
///
/// Returns the final response plus, when the server held a frame to ADOPT, that
/// frame's hash. `Some` therefore means "the server already had this vault" and
/// `None` means "this device wrote it".
fn reconcile_remote_meta(
    transport: &dyn SyncTransport,
    namespace_hex: &str,
    token_hex: &str,
    meta_bytes: &[u8],
) -> Result<(TransportResponse, Option<String>), SyncDeviceError> {
    let scoped = NamespacedTransport::new(transport, namespace_hex);
    // **Never overwrite a frame the server already holds (myne#974).** This used
    // to PUT regardless of what the server held, after a generation/epoch check
    // that is not enough: a vault password change bumps NEITHER, so a device
    // holding the pre-change frame could replace the server's newer wrap, and the
    // next cycle on the device that made the change would "simply adopt the
    // server's copy" and the new password would silently stop working. Installing
    // that write path on a background trigger is what makes it unacceptable: no
    // button press can be blamed for it.
    //
    // The two facts are therefore separated. An ABSENT remote frame (404) is the
    // only case where this device has something to establish, and it is exactly
    // the case the automatic repair needs: after a server-side reset the vault has
    // no owner, and this is the write that binds it again. A PRESENT remote frame
    // is adopted rather than argued with: the namespace is recorded, the baseline
    // is left to the meta phase, and that phase decides which frame wins with its
    // own evidence.
    //
    // The generation and epoch refusals stay, because they answer a different
    // question: a LOCAL frame older than the server's own generation
    // (`NTV5`/`NTV6` against `NTV7`) must not be recorded as this device's
    // namespace at all.
    let current = scoped
        .request(HttpMethod::Get, "/vault.meta", &[], Some(token_hex))
        .map_err(|_| SyncDeviceError::Transport)?;
    match current.status {
        200 => {
            remote_frame_is_adoptable(
                protocol::vault_meta_generation(meta_bytes),
                protocol::parse_b2b_tail_any(meta_bytes)
                    .map(|t| t.group_key_epoch)
                    .unwrap_or(0),
                protocol::vault_meta_generation(&current.body),
                protocol::parse_b2b_tail_any(&current.body)
                    .map(|t| t.group_key_epoch)
                    .unwrap_or(0),
            )?;
            let server_hash = crate::plugins::sync::orchestrator::sha256_hex(&current.body);
            Ok((current, Some(server_hash)))
        }
        // No frame, so there is nothing to protect: this is the write that makes
        // the vault exist on the server.
        //
        // **403 on the READ is the same case, and treating it as a refusal made
        // the first publish impossible.** `server-protocol.md` §3.1a serves a
        // vault's `vault.meta` only to a caller bound to that vault, and an
        // unpublished person-born vault is bound to nothing by definition, so the
        // GET is refused until the PUT creates the binding. `publish_if_due` then
        // swallowed `NotOwner` as "not due", and the vault stayed device-only
        // forever with nothing saying why.
        //
        // The 403 that DOES mean "not mine" is the PUT's own, and it is still a
        // refusal: `vaultMetaPublishAccount` resolves the owner before storing a
        // byte (owner-at-first-write), so a vault owned by someone else answers
        // `403` and nothing is written. The caller's response match keeps that as
        // `NotOwner`.
        404 | 403 => {
            let put = scoped
                .request(HttpMethod::Put, "/vault.meta", meta_bytes, Some(token_hex))
                .map_err(|_| SyncDeviceError::Transport)?;
            Ok((put, None))
        }
        401 => Err(SyncDeviceError::Unauthenticated),
        _ => Err(SyncDeviceError::Transport),
    }
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
    // Both person generations: `NTV8` is the same vault with the person wrap truncated
    // away, so it authenticates as the PERSON and names its namespace like `NTV7` does.
    let person_born = super::meta_kind::is_person_born(&meta_bytes);

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

    // One GET decides whether there is a PUT at all, and both run in the same
    // blocking task. `NamespacedTransport` appends `?account=` for the person case
    // (and for `/vault.meta` in the legacy case, which the server answers exactly
    // as it always did because the vault session already IS that namespace).
    //
    // The transport build and both requests are BLOCKING (a TLS handshake plus
    // network round trips), so they run inside `run_blocking` like every other sync
    // call in this plugin. Issuing them straight from the async task stalls an
    // executor thread for the whole round trip, and neither clippy nor the `Send`
    // bound can see it.
    let local_meta_hash = crate::plugins::sync::orchestrator::sha256_hex(&meta_bytes);
    let (response, server_meta_hash) = {
        let namespace_hex = namespace_hex.clone();
        let token_hex = token_hex.clone();
        let meta_bytes = meta_bytes.clone();
        crate::task::run_blocking(
            move || -> Result<
                (crate::plugins::sync::transport::TransportResponse, Option<String>),
                SyncDeviceError,
            > {
            let transport = build_transport(&url).map_err(|e| {
                if matches!(e, crate::http::TransportError::Tls) {
                    SyncDeviceError::TlsFailure
                } else {
                    SyncDeviceError::Transport
                }
            })?;
            reconcile_remote_meta(transport.as_ref(), &namespace_hex, &token_hex, &meta_bytes)
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
    let now_ms = now_unix_millis(host);
    let newly_published = update_sync_state(io, vault_root, |state| {
        let newly = record_publish(
            state,
            person_born,
            &namespace_hex,
            server_meta_hash.as_deref(),
            &local_meta_hash,
            now_ms,
        );
        (newly, Persist::Yes)
    })
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

/// What a publish records on this device, and what it refuses to claim.
///
/// Pure, so the three rules below are testable without a server. Each one is a
/// fact a user reads back from a different surface, which is why a wrong value
/// here is a lie rather than a cosmetic bug:
///
/// - **Only a person-born vault records a namespace.** The cycle reads a recorded
///   namespace as "address `?account=` and authenticate with the person token",
///   which is true of a vault with no account of its own and false of a legacy
///   vault whose credential already names its namespace. Recording one there
///   would switch that vault onto a credential it does not have, and its next
///   cycle would park at `NotReady` with nothing saying why. A legacy vault
///   therefore records the ACT and leaves the addressing alone.
/// - **Only a write this device performed is a publish it performed.** The adopt
///   arm (the server already held a frame) records the namespace, because that
///   much is now known, and leaves `published_at_ms` alone: claiming a publish
///   that happened elsewhere is the same class of lie as claiming a write that
///   never landed.
/// - **The baseline names what this device last PUT, so the adopt arm leaves it
///   untouched.** Recording the server's hash there while the local frame holds
///   different bytes is the lockout this module exists to prevent, one step
///   removed: the meta phase computes `local_changed = baseline != local_hash`
///   (true) and `server_changed = baseline != server_hash` (false), takes its
///   "push the local frame" arm, and uploads the stale wrap the adopt arm just
///   declined to write.
///
/// Returns `newly_published`: a legacy vault is published before this call (the
/// token read is what makes its account exist on the server), so only a
/// person-born vault has a first time, and it is the moment its namespace stops
/// being absent on a server that held no frame for it.
fn record_publish(
    state: &mut crate::plugins::sync::state::SyncState,
    person_born: bool,
    namespace_hex: &str,
    server_meta_hash: Option<&str>,
    local_meta_hash: &str,
    now_ms: u64,
) -> bool {
    let newly_published = person_born
        && server_meta_hash.is_none()
        && state.namespace_hex.as_deref() != Some(namespace_hex);
    if person_born {
        state.namespace_hex = Some(namespace_hex.to_string());
    }
    if server_meta_hash.is_none() {
        state.published_at_ms = Some(now_ms);
        state.meta_baseline_hex = Some(local_meta_hash.to_string());
    }
    newly_published
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
        .is_some_and(|bytes| super::meta_kind::is_person_born(&bytes));

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

/// The refusals a publish must make about a frame the server already holds.
///
/// Split out so a test can hold the rule without a transport: refuse a newer
/// server GENERATION (a legacy device recording `NTV5`/`NTV6` against a server
/// holding `NTV7` would drop the only person wrap server-side) and refuse a
/// strictly greater group epoch (a re-keyed row older than the server's).
///
/// **What this function does NOT decide is whether to write at all**, and that is
/// deliberate: a vault password change moves neither value, so no comparison here
/// could protect it. The caller writes only when the server holds NO frame; a
/// present frame is adopted, and this only says whether adopting is legitimate.
fn remote_frame_is_adoptable(
    local_gen: protocol::VaultMetaGeneration,
    local_epoch: u64,
    server_gen: protocol::VaultMetaGeneration,
    server_epoch: u64,
) -> Result<(), SyncDeviceError> {
    if server_gen > local_gen {
        return Err(SyncDeviceError::NotOwner);
    }
    if server_gen == local_gen && server_epoch > local_epoch {
        return Err(SyncDeviceError::NotOwner);
    }
    Ok(())
}

/// Publish this vault if it has never been published and everything publishing
/// needs is present (myne-md/myne#974).
///
/// `Ok(None)` means **not due**, and every arm of it is a precondition rather
/// than a failure: the vault is already published, it is a legacy vault (whose
/// enrolment IS its publication), there is no endpoint to publish to, no identity
/// session, or an identity that was minted but never registered. A caller
/// therefore never has to turn a refusal nobody can act on into an error, which
/// is what makes this safe to call from the sync cycle.
///
/// The caller is responsible for ordering: this writes `sync-state.json` and does
/// one network round trip, so it belongs where a cycle already serializes its own
/// state writes, never beside one.
pub async fn publish_if_due(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    vault_root: &Path,
) -> Result<Option<PublishOutcome>, SyncDeviceError> {
    let state = published_state(io, vault_root).await;
    if state.published || !state.person_born {
        return Ok(None);
    }
    // Nowhere to publish TO. The vault stays exactly as usable as it was.
    if endpoint_config(host, io)
        .await
        .ok()
        .and_then(|cfg| cfg.endpoint_url)
        .is_none()
    {
        return Ok(None);
    }
    // The identity has to be both PRESENT (a session) and REGISTERED (a token).
    // Neither is this call's failure: an unregistered identity is a step the user
    // has not taken yet, and the sync status row names it in its own words.
    let path =
        person_auth::person_auth_path_for_read(host).map_err(|_| SyncDeviceError::Transport)?;
    let stored = person_auth::read_person_auth(io, &path)
        .await
        .map_err(|_| SyncDeviceError::Transport)?;
    if person_publish_token(stored.as_ref()).is_err() {
        return Ok(None);
    }
    match publish_vault(host, io, vault_root).await {
        Ok(outcome) => Ok(Some(outcome)),
        // The vault is bound to another person. Calling that "not due" rather than
        // an error keeps a shared vault from logging a warning on every cycle: the
        // ordinary cycle surfaces the refusal with its own status detail.
        Err(SyncDeviceError::NotOwner) => Ok(None),
        Err(e) => Err(e),
    }
}

/// How often the binding probe may run on one device (myne-md/myne#974).
///
/// `sync_now` is the repair's trigger, and it is not rare: the verify screens call
/// it about once a second and every local edit fires it once. Ten minutes is
/// frequent enough that a vault lost by an operator is back before the user
/// notices, and rare enough that a healthy vault pays six round trips an hour
/// instead of three thousand.
const BINDINGS_PROBE_INTERVAL_MS: u64 = 600_000;

/// Whether a published vault is missing from the account's own binding list.
///
/// Pure, so the table beside it is testable without a server.
///
/// **The binding list is the only witness, and the reason is a refusal rather than
/// a gap.** Once a namespace is recorded the cycle addresses this vault with
/// `?account=<hex>`, and `server-protocol.md` §3.1a serves `vault.meta` only to a
/// caller bound to that vault. So a vault the server has forgotten answers the
/// meta phase with `403` (`MetaPhaseOutcome::Skipped`, not a repair arm it could
/// take), and a vault the server still holds answers `200`. `GET /b2b/vaults`
/// names the bindings, and that is a different question from any the cycle asks.
fn needs_repair(recorded: Option<&str>, bindings: &[(String, String)]) -> bool {
    let Some(namespace) = recorded else {
        return false;
    };
    !bindings
        .iter()
        .any(|(hash, _)| hash.eq_ignore_ascii_case(namespace))
}

/// Re-publish a vault whose server record vanished, or answer "nothing to do".
///
/// Deliberately the same safe write as [`publish_if_due`]: it calls
/// [`publish_vault`], which writes only when the server holds no frame for the
/// namespace and adopts what is there otherwise. A repair therefore cannot turn
/// into the overwrite this module exists to prevent.
///
/// Three properties the caller relies on:
///
/// - **It is cheap enough to call on any push.** The probe and the state write are
///   gated by [`BINDINGS_PROBE_INTERVAL_MS`], so a healthy vault pays nothing on
///   almost every call.
/// - **`Ok(None)` covers "nothing to repair" and "not this device's to repair"**,
///   never a transport failure: an unreachable server is returned as an error, so
///   the cycle reports it instead of reading a failed request as a healthy vault.
/// - **A repair that does not repair says so once per probe.** The server can hold
///   a frame for a namespace whose binding is gone (an operator dropping rows
///   rather than the vault), and the adopt arm then legitimately writes nothing.
///   Repeating "publishing it again" forever with no terminal state would turn a
///   visible failure into an invisible one, so that case is a warning naming the
///   account reset as its remedy, not a claim of success.
pub async fn repair_if_unbound(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    vault_root: &Path,
) -> Result<Option<PublishOutcome>, SyncDeviceError> {
    // A recorded namespace is the whole precondition: only a person-born vault
    // records one (`publish_vault` above), and a legacy vault is published by the
    // enrolment that created its server account, which no re-publish can redo.
    let Ok(state) = read_sync_state(io, vault_root).await else {
        return Ok(None);
    };
    let Some(namespace) = state.namespace_hex.clone() else {
        return Ok(None);
    };
    let now = now_unix_millis(host);
    let due = state
        .last_bindings_check_ms
        .map(|last| now.saturating_sub(last) >= BINDINGS_PROBE_INTERVAL_MS)
        .unwrap_or(true);
    if !due {
        return Ok(None);
    }
    // Stamp BEFORE the request: a server that answers with an error is exactly the
    // one that must not be asked again on the next `sync_now` a second later.
    update_sync_state(io, vault_root, |state| {
        state.last_bindings_check_ms = Some(now);
        ((), Persist::Yes)
    })
    .await
    .map_err(|_| SyncDeviceError::Transport)?;

    let bindings = super::person_discovery::discover_bindings(host, io).await?;
    if !needs_repair(Some(namespace.as_str()), &bindings) {
        return Ok(None);
    }
    let outcome = publish_vault(host, io, vault_root).await?;
    if outcome.newly_published {
        tracing::info!(
            namespace = namespace.as_str(),
            "the server no longer listed this vault: published it again"
        );
        return Ok(Some(outcome));
    }
    tracing::warn!(
        namespace = namespace.as_str(),
        "the server still does not list this vault and holds a frame for it, so publishing          cannot restore the binding; resetting the account (or being invited again) is the          only remedy"
    );
    Ok(None)
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
    use crate::plugins::sync::transport::FakeTransport;
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

    /// **`NTV8` is person-born too**, and reading it as a legacy vault would offer the
    /// publish action again on a vault that is already published, under the wrong
    /// credential, since a person-born vault has no vault token to read.
    ///
    /// The four magic bytes are the whole input `published_state` takes from the frame
    /// (`is_person_born` reads the generation, nothing else), so a four-byte fixture is
    /// the unit here rather than a shortcut: the generation classifier it delegates to is
    /// driven over real frames of all five generations in `sync::meta_kind`.
    #[test]
    fn an_ntv8_vault_is_person_born_for_the_publish_marker() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("publish-state-ntv8").unwrap();
            seed_meta(
                tmp.path(),
                protocol::vault_meta_ntv8::VAULT_META_NTV8_MAGIC.as_slice(),
            );
            let state = published_state(&StdVaultIo, tmp.path()).await;
            assert!(
                state.person_born,
                "an upgraded person-born vault must keep the person credential"
            );
            assert!(
                !state.published,
                "not published until the cycle can publish it"
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
            assert!(
                !before.published,
                "not published until the cycle can publish it"
            );
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

    /// The repair table, which is the whole decision: the network call in
    /// `repair_if_unbound` only fetches the bindings it reads.
    ///
    /// Teeth check: invert the `!` in `needs_repair` and BOTH of the first two
    /// assertions fail, which is the only mutation this function has.
    #[test]
    fn a_vault_missing_from_the_accounts_bindings_is_the_one_repaired() {
        let ns = "ab".repeat(16);
        let other = "cd".repeat(16);
        let bound = vec![(ns.clone(), "owner".to_string())];
        let unbound = vec![(other, "owner".to_string())];

        assert!(!needs_repair(Some(&ns), &bound), "present: nothing to do");
        assert!(needs_repair(Some(&ns), &unbound), "absent: publish again");
        assert!(
            needs_repair(Some(&ns), &[]),
            "an account bound to nothing still owns nothing: repair"
        );
        assert!(
            !needs_repair(None, &unbound),
            "a vault with no recorded namespace was never published by this device"
        );
        assert!(
            !needs_repair(Some(&"AB".repeat(16)), &bound),
            "the comparison is case-insensitive: the wire is lowercase hex and the \
             record is lowercase hex, and a case difference is not a lost vault"
        );
    }

    /// An unreachable server is REPORTED, not read as a healthy binding list.
    ///
    /// Swallowing it into `Ok(None)` was the tolerant-wiring shape: a failed call
    /// reporting success, which is how a broken wire reaches production wearing
    /// the appearance of working software. The probe is stamped before the
    /// request, so the report costs one warning per `BINDINGS_PROBE_INTERVAL_MS`
    /// rather than one per push.
    #[test]
    fn repair_reports_an_unreachable_server_instead_of_claiming_a_healthy_vault() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("publish-repair-unreachable").unwrap();
            seed_person_meta(tmp.path());
            let host = host_with_endpoint(tmp.path()).await;
            seed_session(&host).await;
            // Published by this device, so the early gate passes and the binding
            // list is what the call is actually about.
            let st = SyncState {
                namespace_hex: Some("ab".repeat(16)),
                published_at_ms: Some(1_700_000_000_000),
                ..SyncState::default()
            };
            write_sync_state(&StdVaultIo, tmp.path(), &st)
                .await
                .expect("record the namespace");

            let out = repair_if_unbound(&host, &StdVaultIo, tmp.path()).await;

            assert!(
                out.is_err(),
                "an unreachable server must not read as a healthy binding list, got {out:?}"
            );

            // And the failed probe is stamped, so the next push does not pay for
            // the same answer: this is what keeps a 1 Hz `sync_now` cheap.
            let after = read_sync_state(&StdVaultIo, tmp.path())
                .await
                .expect("state readable");
            assert!(
                after.last_bindings_check_ms.is_some(),
                "the probe stamp is written BEFORE the request, so a failure is throttled too"
            );
            assert!(
                matches!(
                    repair_if_unbound(&host, &StdVaultIo, tmp.path()).await,
                    Ok(None)
                ),
                "the second call inside the interval does not probe at all"
            );
        });
    }

    /// A legacy vault is never repaired through the person plane: its own
    /// credential names its namespace, and it records none locally.
    #[test]
    fn repair_never_runs_for_a_legacy_vault() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("publish-repair-legacy").unwrap();
            seed_meta(tmp.path(), protocol::VAULT_META_V0_2_MAGIC.as_slice());
            let host = host_with_endpoint(tmp.path()).await;
            seed_session(&host).await;

            let out = repair_if_unbound(&host, &StdVaultIo, tmp.path()).await;

            assert!(matches!(out, Ok(None)), "got {out:?}");
        });
    }

    /// A host whose config directory exists AND holds an endpoint, so
    /// `publish_if_due`'s endpoint arm is actually passed: `NoopHost` resolves no
    /// config directory at all, and every assertion written against it would pass
    /// for that reason instead of the one the test names.
    async fn host_with_endpoint(root: &Path) -> crate::host::test_host::TestHost {
        use crate::plugins::sync::config::{
            config_path_from_host, write_config, SyncEndpointConfig,
        };

        let host = crate::host::test_host::TestHost::new(root);
        let path = config_path_from_host(&host, &StdVaultIo)
            .await
            .expect("config path resolves on a test host");
        write_config(
            &StdVaultIo,
            &path,
            &SyncEndpointConfig {
                endpoint_url: Some("http://127.0.0.1:1".into()),
                cert_pin_hex: None,
                invite_code: None,
            },
        )
        .await
        .expect("write sync config");
        host
    }

    /// A registered identity on this device. `token_hex` is what makes it
    /// registered rather than reserved, and it is the last precondition
    /// `publish_if_due` checks.
    async fn seed_session(host: &crate::host::test_host::TestHost) {
        let path = person_auth::person_auth_path_for_read(host).expect("auth path");
        person_auth::write_person_auth(
            &StdVaultIo,
            &path,
            &person_auth::PersonAuth {
                token_hex: "ab".repeat(32),
                registered: true,
                ..person_auth::PersonAuth::default()
            },
        )
        .await
        .expect("store a person session");
    }

    fn seed_person_meta(root: &Path) {
        seed_meta(
            root,
            protocol::vault_meta_ntv7::VAULT_META_NTV7_MAGIC.as_slice(),
        );
    }

    /// **Every test below isolates ONE gate**, which is the only way it can have
    /// teeth: each fixture satisfies every OTHER precondition, so an injection that
    /// removes the gate under test makes the call reach `publish_vault` and answer
    /// `BadRequest` (four magic bytes are not a frame) instead of `Ok(None)`. The
    /// first version of these tests seeded nothing but the frame, so removing the
    /// generation gate still passed, from the session arm.
    ///
    /// A legacy vault is never due: its enrolment IS its publication.
    #[test]
    fn publish_is_not_due_for_a_legacy_vault() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("publish-due-legacy").unwrap();
            seed_meta(tmp.path(), protocol::VAULT_META_V0_2_MAGIC.as_slice());
            let host = host_with_endpoint(tmp.path()).await;
            seed_session(&host).await;

            let due = publish_if_due(&host, &StdVaultIo, tmp.path()).await;

            assert!(matches!(due, Ok(None)));
        });
    }

    /// A person-born vault that has recorded its namespace is not due: the cycle
    /// calls this on every tick, and a published vault must not re-PUT its frame
    /// once per tick.
    #[test]
    fn publish_is_not_due_once_the_namespace_is_recorded() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("publish-due-recorded").unwrap();
            seed_person_meta(tmp.path());
            write_sync_state(
                &StdVaultIo,
                tmp.path(),
                &SyncState {
                    namespace_hex: Some("ab".repeat(16)),
                    ..SyncState::default()
                },
            )
            .await
            .expect("record the namespace");
            let host = host_with_endpoint(tmp.path()).await;
            seed_session(&host).await;

            let due = publish_if_due(&host, &StdVaultIo, tmp.path()).await;

            assert!(matches!(due, Ok(None)));
        });
    }

    /// No endpoint is nowhere to publish TO, and the vault stays as usable as it
    /// was. The config DIRECTORY is created and left empty on purpose: the file
    /// exists as a concept and holds no endpoint, which is what an unconfigured
    /// device looks like, and it is also what lets the session fixture be written.
    #[test]
    fn publish_is_not_due_without_an_endpoint() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("publish-due-no-endpoint").unwrap();
            seed_person_meta(tmp.path());
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let _ = crate::plugins::sync::config::config_path_from_host(&host, &StdVaultIo)
                .await
                .expect("config path");
            seed_session(&host).await;

            let due = publish_if_due(&host, &StdVaultIo, tmp.path()).await;

            assert!(matches!(due, Ok(None)));
        });
    }

    /// No identity session is "not due" rather than an error: the cycle runs this on
    /// every tick for every vault, and a device that has not unlocked an identity
    /// would otherwise log a refusal forever.
    #[test]
    fn publish_is_not_due_without_an_identity_session() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("publish-due-no-session").unwrap();
            seed_person_meta(tmp.path());
            let host = host_with_endpoint(tmp.path()).await;

            let due = publish_if_due(&host, &StdVaultIo, tmp.path()).await;

            assert!(matches!(due, Ok(None)));
        });
    }

    /// **The other direction, and without it every test above would pass on a
    /// function that always answers "not due".** With an endpoint, a person-born
    /// vault and a registered session, the gate opens and `publish_vault` runs: the
    /// fixture frame is four magic bytes rather than a real one, so the outcome is
    /// its `BadRequest` refusal. Reaching `BadRequest` at all is the assertion.
    #[test]
    fn publish_is_due_once_the_endpoint_and_the_session_are_both_there() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("publish-due-session").unwrap();
            seed_person_meta(tmp.path());
            let host = host_with_endpoint(tmp.path()).await;
            seed_session(&host).await;

            let due = publish_if_due(&host, &StdVaultIo, tmp.path()).await;

            assert!(
                matches!(due, Err(SyncDeviceError::BadRequest)),
                "a due vault must reach publish_vault, whose first refusal here is the four-byte fixture frame"
            );
        });
    }

    /// The refusals about a frame the server already holds, held without a
    /// transport. What they do NOT cover is the write itself: no comparison here can
    /// protect a rotated password, which is why the caller writes only when the
    /// server holds no frame at all.
    #[test]
    fn an_older_local_frame_is_adoptable_but_a_newer_server_one_is_not() {
        use protocol::VaultMetaGeneration::{B2b, Person, PersonNoWrap};

        assert!(
            remote_frame_is_adoptable(Person, 3, Person, 3).is_ok(),
            "equal: adopt"
        );
        assert!(
            remote_frame_is_adoptable(Person, 3, PersonNoWrap, 3).is_err(),
            "a frame older than the server's own generation must not record itself at all"
        );
        assert!(
            remote_frame_is_adoptable(PersonNoWrap, 3, PersonNoWrap, 4).is_err(),
            "a greater group epoch server-side is a re-key this device has not seen"
        );
        assert!(
            remote_frame_is_adoptable(B2b, 9, Person, 9).is_err(),
            "a legacy frame recording itself over a person-wrap frame deletes the wrap"
        );
        assert!(
            remote_frame_is_adoptable(PersonNoWrap, 9, B2b, 9).is_ok(),
            "a server frame one generation behind is still adopted; the meta phase moves it forward"
        );
    }

    /// Every answer a server may give to the publish GET, pinned.
    ///
    /// This is the branch's whole safety claim and it had no test while the
    /// requests were built inside `publish_vault`'s blocking closure, because a
    /// real transport cannot be faked there. It cost a CRITICAL review finding:
    /// the `403` arm read "not mine" where it means "you are not bound yet", so
    /// the FIRST publish of every person-born vault was refused and swallowed as
    /// "not due". Four bytes of fixture and this test would have caught it.
    #[test]
    fn a_refused_read_is_what_a_first_publish_looks_like() {
        let ns = "ab".repeat(16);
        let scoped = format!("/vault.meta?account={ns}");
        let t = FakeTransport::new();
        // §3.1a: a vault's meta is served only to a caller BOUND to it, and an
        // unpublished vault is bound to nothing, so the read is refused until the
        // write creates the binding.
        t.on(HttpMethod::Get, &scoped, 403, Vec::new());
        t.on(HttpMethod::Put, &scoped, 200, Vec::new());

        let (resp, adopted) =
            reconcile_remote_meta(&t, &ns, "tok", b"local-frame").expect("first publish");
        assert_eq!(resp.status, 200, "the PUT's answer is the one that counts");
        assert!(adopted.is_none(), "this device wrote the frame");

        let reqs = t.requests();
        let puts: Vec<_> = reqs.iter().filter(|r| r.0 == HttpMethod::Put).collect();
        assert_eq!(puts.len(), 1, "exactly one PUT, got {reqs:?}");
        assert_eq!(
            puts[0].2,
            b"local-frame".to_vec(),
            "the local bytes, verbatim"
        );
        assert_eq!(
            puts[0].3.as_deref(),
            Some("tok"),
            "authed with the person token"
        );
    }

    /// A frame the server already holds is never overwritten, and the caller is
    /// told its hash so the publish can be recorded as an adoption rather than a
    /// write.
    #[test]
    fn a_present_frame_is_adopted_and_never_overwritten() {
        let ns = "ab".repeat(16);
        let scoped = format!("/vault.meta?account={ns}");
        let local = protocol::vault_meta_ntv7::VAULT_META_NTV7_MAGIC
            .as_slice()
            .to_vec();
        let mut server = local.clone();
        server.extend_from_slice(b"a-divergent-wrap");
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, &scoped, 200, server.clone());

        let (resp, adopted) = reconcile_remote_meta(&t, &ns, "tok", &local).expect("adopt");
        assert_eq!(resp.status, 200);
        assert_eq!(
            adopted.as_deref(),
            Some(crate::plugins::sync::orchestrator::sha256_hex(&server).as_str()),
            "the hash names the SERVER's bytes, which is what makes the record honest"
        );
        assert!(
            !t.requests().iter().any(|r| r.0 == HttpMethod::Put),
            "no PUT: the server's frame wins, so a stale local wrap cannot replace it"
        );
    }

    /// An absent frame is the one case with something to establish.
    #[test]
    fn a_missing_frame_is_written() {
        let ns = "ab".repeat(16);
        let scoped = format!("/vault.meta?account={ns}");
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, &scoped, 404, Vec::new());
        t.on(HttpMethod::Put, &scoped, 200, Vec::new());

        let (resp, adopted) = reconcile_remote_meta(&t, &ns, "tok", b"local-frame").expect("write");
        assert_eq!(resp.status, 200);
        assert!(adopted.is_none(), "a 404 means this device wrote it");
        assert_eq!(
            t.requests()
                .iter()
                .filter(|r| r.0 == HttpMethod::Put)
                .count(),
            1
        );
    }

    /// The refusal that DOES mean "not mine" is the write's own, and a caller
    /// reads it from the final response: `publish_vault` maps a `403` there to
    /// `NotOwner`. Reading it from the GET instead is the bug above.
    #[test]
    fn a_refused_write_is_the_owners_refusal() {
        let ns = "ab".repeat(16);
        let scoped = format!("/vault.meta?account={ns}");
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, &scoped, 403, Vec::new());
        t.on(HttpMethod::Put, &scoped, 403, Vec::new());

        let (resp, adopted) =
            reconcile_remote_meta(&t, &ns, "tok", b"local-frame").expect("the PUT ran");
        assert_eq!(
            resp.status, 403,
            "the owner check happens on the write, before a byte is stored"
        );
        assert!(adopted.is_none());
    }

    /// A refused credential is a refusal on the READ too, and it is the one arm
    /// where nothing should be written.
    #[test]
    fn an_unauthenticated_read_is_a_refusal() {
        let ns = "ab".repeat(16);
        let scoped = format!("/vault.meta?account={ns}");
        let t = FakeTransport::new();
        t.on(HttpMethod::Get, &scoped, 401, Vec::new());

        assert!(matches!(
            reconcile_remote_meta(&t, &ns, "tok", b"local-frame"),
            Err(SyncDeviceError::Unauthenticated)
        ));
        assert!(
            !t.requests().iter().any(|r| r.0 == HttpMethod::Put),
            "a refused token must not be retried as a write"
        );
    }

    /// What a publish records, and the three claims it must not make.
    ///
    /// The adopt arm's baseline is the expensive one: recording the SERVER's hash
    /// while the local frame holds different bytes makes the meta phase compute
    /// `local_changed` and push the stale wrap the adopt arm just declined to
    /// write, which is the password-change lockout this whole change exists to
    /// close. Teeth check: set the baseline on both arms and the first assertion
    /// fails; set `published_at_ms` on both and the second fails.
    #[test]
    fn record_publish_claims_only_what_this_device_did() {
        let ns = "ab".repeat(16);
        let local = "11".repeat(32);
        let prior = "cc".repeat(32);

        let mut adopted = SyncState {
            meta_baseline_hex: Some(prior.clone()),
            ..SyncState::default()
        };
        let newly = record_publish(
            &mut adopted,
            true,
            &ns,
            Some(&"dd".repeat(32)),
            &local,
            1_700_000_000_000,
        );
        assert!(
            !newly,
            "the server already had it, so this was not a publish"
        );
        assert_eq!(adopted.namespace_hex.as_deref(), Some(ns.as_str()));
        assert_eq!(
            adopted.meta_baseline_hex.as_deref(),
            Some(prior.as_str()),
            "the adopt arm writes no baseline: this device has synced nothing"
        );
        assert_eq!(
            adopted.published_at_ms, None,
            "a publish that happened elsewhere is not this device's to claim"
        );

        let mut written = SyncState::default();
        let newly = record_publish(&mut written, true, &ns, None, &local, 1_700_000_000_000);
        assert!(
            newly,
            "a person-born vault's first write IS its first publish"
        );
        assert_eq!(written.namespace_hex.as_deref(), Some(ns.as_str()));
        assert_eq!(
            written.meta_baseline_hex.as_deref(),
            Some(local.as_str()),
            "the baseline names the bytes this device just PUT"
        );
        assert_eq!(written.published_at_ms, Some(1_700_000_000_000));

        let mut legacy = SyncState::default();
        let newly = record_publish(&mut legacy, false, &ns, None, &local, 1_700_000_000_000);
        assert!(!newly, "a legacy vault's publication predates this act");
        assert_eq!(
            legacy.namespace_hex, None,
            "a legacy vault's credential already names its own namespace"
        );
        assert_eq!(
            legacy.meta_baseline_hex.as_deref(),
            Some(local.as_str()),
            "the legacy PUT still establishes the baseline"
        );
    }
}
