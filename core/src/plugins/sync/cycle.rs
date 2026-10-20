// SPDX-License-Identifier: AGPL-3.0
//! One orchestrated sync cycle: gathering its inputs, running it, and the side
//! effects that follow (MYND-424).
//!
//! **Lifted out of the host-gated `commands.rs`** (phase3-web-client task 84).
//! Almost nothing here was host-shaped — the gather reads the endpoint config,
//! the enrolment identity, the unlocked keys and the device token, all of which
//! are already on seams — and what little was is now expressed through them:
//!
//! * `AppHandle` → [`crate::host::HostCtx`] + the runtime state, passed in.
//! * `app.emit(...)` → `host.emit(...)`. The four events this fires
//!   (`sync://reconcile-started` / `-finished`, `sync://integrity-alert`,
//!   `sync://changed`) are exactly the shape the seam's `EventPayload` models:
//!   unit or a count, never a title or a path.
//! * `spawn_blocking` + `Handle::current().block_on` →
//!   [`crate::task::run_blocking`], which is `spawn_blocking` natively and
//!   INLINE on wasm. **Desktop scheduling is preserved rather than
//!   approximated**: the transport is blocking by design (task 35), so the
//!   native arm still parks a blocking thread on the round trip instead of an
//!   executor worker, and the browser still blocks the Worker it is supposed to
//!   block.
//!
//! The process-wide cycle mutex moved with it, and that matters more than it
//! looks: `run_sync_cycle` is a read-modify-write over `sync-state.json`,
//! staging and tombstones with no other guard, so two overlapping cycles
//! lost-update each other's cursor and baseline — and a dropped tombstone
//! revives a deleted note on another device. One serializer, shared by both
//! clients, is the only way that property holds on either.

use super::config::read_config;
use super::devices::hex16;
use super::enroll::{self, EnrollPath};
use super::token_store::TokenStore as _;
use crate::host::{EventPayload, HostCtx};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{derive_subkey, parse_vault_meta_any, SubkeyRole, AEAD_KEY_LEN};
use std::sync::OnceLock;
use tokio::sync::Mutex;
use zeroize::Zeroizing;

/// Outcome of one orchestrated sync cycle, shared by `sync_now` (manual) and the
/// background loop (`loop_control`). Honest "not ready" states (locked /
/// unenrolled) are distinct from a genuine transport/protocol failure.
pub enum CycleOutcome {
    /// No endpoint configured — sync is off.
    Disabled,
    /// Configured, but the vault is locked or this device is not enrolled.
    NotReady,
    /// One cycle ran; carries what it moved (pulled / pushed counts).
    Ran(super::orchestrator::SyncSummary),
    /// A transport / protocol failure, coarsened to the class the scheduler's
    /// retry policy needs (429 / 401 / socket / other).
    Failed(super::loop_control::FailureClass),
}

/// Coarsen a cycle error to its scheduler-facing retry class. Lives at this
/// boundary (not in `loop_control`) because it is the one place that still
/// holds the full `SyncCycleError` before it crosses to the loop.
pub(crate) fn classify_cycle_error(
    e: &super::orchestrator::SyncCycleError,
) -> super::loop_control::FailureClass {
    use super::engine::{PullError, PushError};
    use super::loop_control::FailureClass;
    use super::orchestrator::SyncCycleError;
    use super::transport::TransportError;
    match e {
        SyncCycleError::Pull(PullError::RateLimited)
        | SyncCycleError::Push(PushError::RateLimited) => FailureClass::RateLimited,
        SyncCycleError::Pull(PullError::Unauthenticated)
        | SyncCycleError::Push(PushError::Unauthenticated) => FailureClass::Unauthenticated,
        // Task 94. Same park on every client; a DIFFERENT thing to say, and on
        // web a different thing to do — which is why it does not fold into the
        // arm above even though its retry delay is identical.
        SyncCycleError::Pull(PullError::DeviceRevoked)
        | SyncCycleError::Push(PushError::DeviceRevoked) => FailureClass::DeviceRevoked,
        // Refusal classes that must reach the UI as themselves, never as the
        // generic "sync failed" (MYND-570). Push-only by construction: a frozen
        // or over-quota account still PULLS ("frozen is minimal").
        SyncCycleError::Push(PushError::QuotaExceeded) => FailureClass::QuotaExceeded,
        SyncCycleError::Push(PushError::PayloadTooLarge) => FailureClass::PayloadTooLarge,
        SyncCycleError::Push(PushError::Frozen) => FailureClass::Frozen,
        // Before the catch-all below, because this arm is the reason the payload
        // is matched at all rather than discarded with `_`. A refused
        // certificate is a transport error by mechanism and an auth-shaped park
        // by behaviour: repeating the handshake reaches the same certificate and
        // fails identically, and it is the only failure here a user can act on.
        SyncCycleError::Pull(PullError::Transport(TransportError::Tls))
        | SyncCycleError::Push(PushError::Transport(TransportError::Tls)) => {
            FailureClass::TlsFailure
        }
        SyncCycleError::Pull(PullError::Transport(_))
        | SyncCycleError::Push(PushError::Transport(_)) => FailureClass::Transport,
        // The LOCAL store, not the server's ceiling (task 91). Parks like a 507
        // because retrying cannot help until someone frees something — but the
        // sentence to the user is different, and only this one is fixable here.
        SyncCycleError::StorageFull => FailureClass::StorageFull,
        _ => FailureClass::Other,
    }
}

/// A still-`pending` device claims its token by re-running the SCRAM handshake
/// under the unlocked `root_key` (the verifier is already registered). Returns
/// the token once an existing device has approved this one, else `None` (still
/// pending / unreachable). Stores the token device-local on success.
pub(crate) async fn try_claim_token(
    io: &dyn crate::vault_io::VaultIo,
    url: String,
    dir: std::path::PathBuf,
    root_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    account_hash: [u8; 16],
    device_id: [u8; 16],
) -> Option<Vec<u8>> {
    let token = crate::task::run_blocking(move || {
        let transport = super::http_transport::build_transport(&url).ok()?;
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).ok()?;
        let mut client_nonce = String::with_capacity(32);
        for b in &nonce {
            client_nonce.push_str(&format!("{b:02x}"));
        }
        let out = enroll::enroll(
            transport.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Password,
            &client_nonce,
            device_id,
        )
        .ok()?;
        if out.approved && !out.token.is_empty() {
            Some(out.token)
        } else {
            None // still pending approval
        }
    })
    .await
    .ok()
    .flatten()?;
    // The token WRITE moved out of the blocking closure (phase3-web-client task
    // 86): `TokenStore` is async now, because a browser-backed store has no
    // synchronous implementation to write. The network handshake above is what
    // belongs on the blocking pool; persisting one short line does not, and the
    // seam's native arm dispatches its own blocking anyway.
    super::token_store::default_store()
        .store(io, &dir, &token)
        .await
        .ok()?;
    Some(token)
}

/// Process-wide async lock serializing EVERY sync-cycle entry against every
/// other cycle AND against [`sync_reset_local`]. Phase 1 has exactly one active
/// unlocked vault, so a single mutex is a correct per-vault serializer (a future
/// multi-vault design would key it by vault id). Same `OnceLock<Mutex<()>>` shape
/// as `attachments::catalog_write_mutex`.
pub(crate) fn sync_cycle_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// Why a cycle cannot bind an `account_number_hash`. Two diagnoses, kept apart
/// because they say different things about the vault: one is an unreadable file,
/// the other is an enrolment that belongs to a different account.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AccountHashRefusal {
    /// `vault.meta` could not be read, or no copy of it parsed.
    MetaUnavailable,
    /// `sync-state.json`'s enrolled hash is not the one `vault.meta` binds —
    /// the two describe different accounts.
    NotThisVault,
}

/// The `account_number_hash` this cycle may bind into the three `root_key`-derived
/// singleton AADs (`vault.attachments`, `vault.prefs`, `vault.themes`) and into the
/// head it authors.
///
/// **`vault.meta` is the authority, not `sync-state.json`.** The spec says so for
/// each of the three families (`protocol.md` §9.10.3 / §9.5.3 / §9.21.3 — "the same
/// 16-byte field stored in `vault.meta`"), and `vault.meta`'s copy is the only one
/// that is self-enforcing: it feeds `derive_password_wrap_key`'s salt, so a wrong
/// value there breaks unlock loudly. `sync-state.json`'s hex is documented as two
/// other roles entirely (head authoring identity + the SCRAM username, `state.rs`),
/// it is written from a different source — enrolment persists the hash of the
/// account number the user *typed*, while `root_key` comes from the meta's field —
/// and nothing re-validates it once a token is stored.
///
/// So the two can drift with nothing failing first, and the damage is silent: all
/// three families then fail their AEAD tag check on BOTH sides of the merge, read
/// as empty, and the adopt-the-server's-bytes branch wins every cycle — local
/// prefs / theme / catalog edits are overwritten forever, and no attachment ever
/// materialises. Sourcing the value here and refusing on disagreement is what
/// keeps that state from running.
///
/// **The generation travels with the hash, for the same reason.** A migrated
/// vault's `MYP5`/`MYC5`/`MYT5` singletons need a v0.2-derived KEK; deriving
/// v0.1 fails their tag check and lands in exactly the read-as-empty branch
/// described above. Both values come from ONE parse of one blob here, so they
/// cannot disagree about which vault, or which generation, the cycle is for.
pub(crate) async fn cycle_account_number_hash(
    io: &dyn crate::vault_io::VaultIo,
    dir: &std::path::Path,
    enrolled: &[u8; 16],
) -> Result<(protocol::MetaVersion, [u8; 16]), AccountHashRefusal> {
    // `vault.meta` is a double-buffered singleton on the web store, so "read it"
    // means "the newest copy that PARSES" — the same reader the attachments
    // catalog uses for the same field. Desktop and mobile are unchanged by
    // construction: `read_candidates` is a one-element list there.
    let (version, meta_hash) =
        crate::singleton::open_newest(io, &dir.join("vault.meta"), |candidate| {
            parse_vault_meta_any(candidate).map(|m| {
                (
                    protocol::meta_version_of(candidate).unwrap_or(protocol::MetaVersion::V0_1),
                    m.account_number_hash,
                )
            })
        })
        .await
        .map_err(|_| AccountHashRefusal::MetaUnavailable)?;
    if &meta_hash != enrolled {
        return Err(AccountHashRefusal::NotThisVault);
    }
    Ok((version, meta_hash))
}

/// Gather the active vault's sync inputs (endpoint, enrollment identity, token,
/// `root_key`) and run one [`run_sync_cycle`](super::orchestrator::run_sync_cycle)
/// off-thread. `allow_push=false` is a poll-driven pull-only cycle (coalescing —
/// see `loop_control`); `true` also pushes pending local changes. Used by both
/// the `sync_now` command and the background loop, so the gathering lives once.
/// `io` is `&'static` deliberately, and it is the one signature quirk here.
///
/// The cycle's IO has to cross into the closure `task::run_blocking_future`
/// hands to the blocking pool, which is `Send + 'static`; a borrowed
/// `&dyn VaultIo` cannot. Every implementation is a unit struct
/// (`StdVaultIo`, `OpfsVaultIo`), so `&'static` costs nothing real — and it is
/// far better than the alternative this replaced, which was hardcoding
/// `StdVaultIo` inside the closure. That compiled on both targets and would have
/// pointed a browser at a filesystem that is not there.
/// Feed every note the cycle wrote into the live indexes (myne#305).
///
/// The same side effects a local `note_update` performs (full-text body doc,
/// per-attachment docs, AI re-embed, and a removal for a tombstone), because a note arriving from another
/// device is, from this device's point of view, exactly a note that changed.
///
/// Best-effort per note: a body that will not decrypt (locked mid-cycle, or a
/// blob this device cannot read) is skipped rather than failing the cycle. The
/// omission is no longer permanent either way — `persist_search_index_core`
/// leaves an unindexed note out of the manifest, so the next unlock picks it up.
async fn reindex_pulled_notes(
    io: &dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    notes_dir: &std::path::Path,
    ids: &[String],
) {
    use crate::plugins::notes::drawing_text::{is_drawing, project_drawing_text};
    for id in ids {
        let Ok(plaintext) = crate::plugins::notes::commands::note_read_with_dir(
            notes_dir.to_path_buf(),
            state,
            id.clone(),
            io,
            &crate::host::NoopHost,
        )
        .await
        else {
            continue;
        };
        let title = crate::plugins::notes::title_extract::resolve_note_title(plaintext.as_bytes())
            .unwrap_or_default();
        // A pulled TOMBSTONE leaves the index rather than re-entering it, as in
        // `note_update` (test-audit #20): a peer's permanent delete arrives as a
        // `deleted:` frontmatter stamp, and upserting it put the purged body back
        // into search, where the lock sealed it into `vault.search`.
        let fm_bytes =
            crate::plugins::notes::title_extract::extract_title_slices(plaintext.as_bytes())
                .frontmatter_bytes;
        if fm_bytes
            .and_then(crate::plugins::notes::daily_match::fm_deleted_value_strict)
            .is_some()
        {
            hooks.search_remove(id);
            continue;
        }
        // The same drawing fold as the local writers: a `kind: drawing` body is
        // scene JSON, so the body doc is its projected text and it gets no
        // attachment docs (SF5 / SYNC-4).
        if is_drawing(plaintext.as_bytes()) {
            let body = project_drawing_text(plaintext.as_bytes()).unwrap_or_default();
            hooks.search_upsert(id, &title, &body);
        } else {
            hooks.search_upsert(id, &title, &plaintext);
            hooks
                .index_note_attachments(state, id, &title, &plaintext)
                .await;
        }
    }
}

/// Feed the live indexes a note a deferred-live-pull FALLBACK arm just wrote, and
/// only when it actually wrote one (myne-md/myne#867 review).
///
/// The deferred-pull loop's session flush is what normally indexes a merged peer
/// revision: the session is the note's single durable writer (`SYNC-33`), and its
/// flush carries the index side effects. **Both fallback arms bypass that flush**,
/// one because the flush failed and one because the session refused the blob or
/// was already gone, so in both the plain write is the note's content and nothing
/// else has indexed it. These ids are in `deferred_live_pulls` rather than
/// `pulled_note_ids`, so the loop's own `reindex_pulled_notes` never saw them
/// either. `reindex_pulled_notes` re-reads the blob rather than the session, so
/// the index describes what reached disk.
///
/// Gated on [`PulledNoteApply::Applied`] rather than on `is_ok()`:
/// `SkippedDirty` wrote nothing (a local edit won the race) and `StorageFull`
/// wrote nothing, so re-reading the disk in those arms would index a document
/// this fallback did not produce.
async fn index_fallback_written_note(
    io: &dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    notes_dir: &std::path::Path,
    note_id: &str,
    applied: &Result<
        crate::plugins::sync::orchestrator::PulledNoteApply,
        crate::plugins::sync::orchestrator::SyncCycleError,
    >,
) {
    if matches!(
        applied,
        Ok(crate::plugins::sync::orchestrator::PulledNoteApply::Applied)
    ) {
        reindex_pulled_notes(io, state, hooks, notes_dir, &[note_id.to_string()]).await;
    }
}

/// Build the signed (`0x02`) head context for an `NTV6` vault, or `None` for a
/// pre-B2B (`NTV5`) vault (decisions 0603, Q2 revised: the head format is keyed
/// off the vault generation). The live roster rows' public halves let a peer
/// resolve a head's signer.
///
/// A head is signed by the held person keypair (the owner's or a member's own)
/// and verified against the roster, so a member authors heads under its own
/// identity. The roster itself is **owner-signed**, so verifying it needs the
/// owner's public half: the owner holds it as their identity, a member holds only
/// the out-of-band identity code recorded at accept (`owner_identity_code`).
async fn signed_head_ctx(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &std::path::Path,
    state: &VaultRuntimeState,
    shared: &crate::plugins::vault_unlock::state::SharedSingletonKey,
    is_owner: bool,
) -> Option<super::head_authority::SignedHeadCtx> {
    let bytes = io.read(&vault_dir.join("vault.meta")).await.ok()?;
    if bytes.get(..4) != Some(protocol::VAULT_META_NTV6_MAGIC.as_slice()) {
        return None;
    }
    let b2b = protocol::parse_vault_meta_ntv6(&bytes).ok()?;
    let group_key = shared.group_bytes()?;
    let envelope = protocol::person_invite::open_group_roster(
        &group_key,
        &b2b.base.account_number_hash,
        b2b.group_key_epoch,
        &b2b.signed_roster_envelope,
    )?;
    let person = state.clone_person_identity().await?;
    let owner_public = if is_owner {
        person.public_half()
    } else {
        let code = super::state::read_sync_state(io, vault_dir)
            .await
            .ok()?
            .owner_identity_code?;
        super::invite::decode_person_identity_code(&code)
            .ok()?
            .public
    };
    let roster = protocol::person_invite::verify_group_roster(
        &owner_public,
        &envelope,
        &b2b.base.account_number_hash,
    )
    .ok()?;
    let roster_publics = roster
        .members
        .iter()
        .filter(|m| m.state == protocol::person_invite::GroupMemberState::Live)
        .filter_map(|m| {
            protocol::person_key::PersonPublicHalf::from_parts_hex(
                &m.member_kem_ek_hex,
                &m.member_ed_pk_hex,
                &m.member_mldsa_vk_hex,
            )
            .ok()
        })
        .collect();
    Some(super::head_authority::SignedHeadCtx::new(
        person,
        b2b.base.account_number_hash,
        roster_publics,
    ))
}

pub async fn run_active_cycle_from_host(
    host: &dyn HostCtx,
    io: &'static dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    // The live-session registry (`collab-editor-bridge` task 7). A pulled remote
    // revision of a note OPEN in a session is merged INTO it (remove-wins) rather
    // than written to disk, because the session is that note's single durable writer
    // (`SYNC-33`). The set of live blob ids is snapshotted before the cycle so the
    // orchestrator (which cannot hold the registry across its `'static` boundary)
    // sees a plain `HashSet`.
    live_registry: &crate::plugins::live::LiveSessionRegistry,
    allow_push: bool,
) -> CycleOutcome {
    // THE device-verification hold is read here, and here is the only place it
    // can be (myne#462).
    //
    // The obvious home would be the scheduler — and it has a mirror of this flag,
    // for a different job (not consuming the coalescing anchor). But the
    // scheduler is not on this path at all: `sync_now_from_host` calls this
    // function with `allow_push = true` directly, and the verify screens
    // themselves poll `sync_now` about once a second while they are open. A hold
    // that lived only in `loop_control` would therefore be pushed straight
    // through by the very screens it exists to protect — and by
    // `useConflictMaterializer`, which fires `sync_now` on every `sync://changed`,
    // i.e. exactly when a joining device's first pull lands.
    //
    // Serialize with any concurrent cycle + sync_reset_local: run_sync_cycle is a
    // read-modify-write on sync-state.json / staging / tombstones with no other
    // guard, so two overlapping cycles (a double "Sync now", or a click coinciding
    // with a poll tick) lost-update each other's cursor/baseline — and a dropped
    // tombstone revives a deleted note elsewhere. Held across the whole gather +
    // spawn_blocking so the token claim is serialized too.
    let _cycle_guard = sync_cycle_mutex().lock().await;
    // So the gate is resolved at the one point every cycle passes through, and
    // AFTER the serializer, which is load-bearing rather than tidy. The mutex is
    // held across the whole gather plus `spawn_blocking`, i.e. across network
    // round-trips, so a cycle that queues behind a long one waits minutes. Sampled
    // before the wait, such a cycle carried a stale `Allowed` and pushed content
    // under a compare that opened while it queued: the exact event this gate
    // exists to prevent. The waiters are not hypothetical either. The verify
    // screens fire `sync_now` about once a second and `useConflictMaterializer`
    // fires one on every `sync://changed`, which is precisely when a joining
    // device's first pull lands and the ceremony opens.
    let gate = if !allow_push {
        super::orchestrator::PushGate::PollOnly
    } else if super::verify_hold::verify_hold().is_held(host.now_unix_millis()) {
        super::orchestrator::PushGate::VerifyHold
    } else {
        super::orchestrator::PushGate::Allowed
    };
    let Ok(cfg) = async {
        let p = super::config::config_path_from_host(host, io).await?;
        read_config(io, &p).await
    }
    .await
    else {
        return CycleOutcome::Failed(super::loop_control::FailureClass::Other);
    };
    let Some(url) = cfg.endpoint_url else {
        return CycleOutcome::Disabled;
    };
    let Ok(dir) = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
    else {
        return CycleOutcome::NotReady;
    };
    // An unreadable state is NOT "not enrolled" (task 86). Both arms decline to
    // run a cycle, so the immediate behaviour matches — but `NotReady` is the
    // quiet, expected answer the loop sees on every tick before enrolment, and
    // reporting it here would bury a corrupt file under normal traffic. A device
    // whose sync silently stopped, with nothing in the log saying why, is the
    // failure this distinction exists to prevent.
    let st = match super::state::read_sync_state(io, &dir).await {
        Ok(st) => st,
        Err(_) => {
            tracing::error!(
                stage = "read_sync_state",
                "sync-state.json unreadable; cycle refused (this is NOT the pre-enrolment path)"
            );
            return CycleOutcome::Failed(super::loop_control::FailureClass::Other);
        }
    };
    let (Some(acct_hex), Some(dev_hex)) = (st.account_hash_hex.clone(), st.device_id_hex.clone())
    else {
        return CycleOutcome::NotReady; // not enrolled
    };
    let (Some(account_hash), Some(device_id)) = (hex16(&acct_hex), hex16(&dev_hex)) else {
        return CycleOutcome::Failed(super::loop_control::FailureClass::Other);
    };
    // Attachment sync (MYND-468) verifies downloaded MYA1 blobs end-to-end, so
    // the cycle needs the itemsKey material. The OWNER root key is optional: a
    // MEMBER holds no `root_key` (that is the point of sharing) and the shared
    // families it may sync derive their ids from the group tier instead. Cloned
    // out of the slot and the guard dropped immediately (holding the read guard
    // across the network cycle would block lock/auto-lock).
    let Some((items_key, items_key_id, is_owner, root_key, shared)) = ({
        let slot = state.slot_read_active().await;
        match &*slot {
            crate::plugins::vault_unlock::state::Slot::Unlocked(uv) => Some((
                uv.items_key.clone(),
                uv.items_key_id,
                uv.authority() == crate::plugins::vault_unlock::state::VaultAuthority::Owner,
                uv.owner_root_key()
                    .map(|root| zeroize::Zeroizing::new(**root)),
                uv.shared_singleton_key(),
            )),
            _ => None,
        }
    }) else {
        return CycleOutcome::NotReady; // vault locked
    };
    // The AAD identity, sourced from `vault.meta` rather than from the enrolment
    // cache (see [`cycle_account_number_hash`]). Checked BEFORE the token block:
    // a device whose enrolment names another account must not go on to claim a
    // token under that account's SCRAM username either.
    let (meta_version, account_number_hash) =
        match cycle_account_number_hash(io, &dir, &account_hash).await {
            Ok(hash) => hash,
            Err(AccountHashRefusal::MetaUnavailable) => {
                tracing::error!(
                    stage = "read_vault_meta",
                    "no parsable vault.meta beside the enrolled state; cycle refused"
                );
                return CycleOutcome::Failed(super::loop_control::FailureClass::Other);
            }
            Err(AccountHashRefusal::NotThisVault) => {
                // Fail closed. The alternative — run the cycle on the meta's hash and
                // keep authenticating as the enrolled one — would leave this vault's
                // blobs sitting in another account's server namespace, which is worse
                // than a stalled device that says so. The repair is re-enrolment.
                tracing::error!(
                    stage = "account_hash_provenance",
                    "the enrolled account is not this vault's; cycle refused"
                );
                return CycleOutcome::Failed(super::loop_control::FailureClass::Other);
            }
        };
    // Token: the stored per-vault token. For an owner's still-pending device,
    // claim one now if an existing device approved it (re-handshake under the
    // unlocked root key). A member's per-vault token was stored at invite accept,
    // so a missing one means the membership is not materialised here.
    let token = match super::token_store::default_store().read(io, &dir).await {
        Ok(Some(t)) => t,
        _ => match &root_key {
            Some(root_key) => {
                match try_claim_token(
                    io,
                    url.clone(),
                    dir.clone(),
                    root_key.clone(),
                    account_hash,
                    device_id,
                )
                .await
                {
                    Some(t) => t,
                    None => return CycleOutcome::NotReady, // still pending approval
                }
            }
            None => return CycleOutcome::NotReady, // member with no stored token
        },
    };

    let mut token_hex = String::with_capacity(token.len() * 2);
    for b in &token {
        token_hex.push_str(&format!("{b:02x}"));
    }
    let notes_dir = dir.join("notes");
    let notes_dir_for_reindex = notes_dir.clone();
    // Cloned for the same reason `notes_dir` is: `dir` moves into the blocking
    // closure below, and the success stamp is written after it returns.
    let vault_root_for_stamp = dir.clone();
    let dir_for_prefs = dir.clone();
    // Snapshot the live-session note ids BEFORE the `'static` closure (task 7):
    // the registry itself cannot cross that boundary, but a plain `HashSet` can.
    let live_note_ids = live_registry.live_note_blob_ids();
    // `items_key`/`items_key_id` are needed both by the cycle (as `AttachmentKeys`,
    // which move into the `'static` closure) and by the post-cycle merge of a
    // deferred live pull, so the merge keeps its own clone of the key.
    let live_merge_keys = (items_key.clone(), items_key_id);

    // Signed `0x02` head authority for an `NTV6` vault (`None` keeps the `NTV5`
    // HMAC head). Built before the blocking closure so the person keypair and the
    // roster are gathered on the executor, not the blocking thread.
    let signed_ctx = signed_head_ctx(io, &dir, state, &shared, is_owner).await;
    // An `NTV6` vault's head is signature-authenticated. If no person identity is
    // held, the cycle must NOT silently fall back to the `NTV5` HMAC: that
    // authors a `0x01` head the `0x02` server refuses and wedges sync until the
    // user runs the person unlock. Refuse loudly instead of downgrading.
    {
        let is_ntv6 = io
            .read(&dir.join("vault.meta"))
            .await
            .map(|b| b.get(..4) == Some(protocol::VAULT_META_NTV6_MAGIC.as_slice()))
            .unwrap_or(false);
        if is_ntv6 && signed_ctx.is_none() {
            // A missing person identity is the one cause of `signed_ctx == None`
            // the user can fix in place (unlock the identity), so it gets its own
            // class and the UI its own sentence. Any OTHER
            // reason the head context could not be built (roster, group key)
            // stays a generic failure — that fix is not something to ask of them.
            let has_person = state.clone_person_identity().await.is_some();
            let class = if has_person {
                super::loop_control::FailureClass::Other
            } else {
                super::loop_control::FailureClass::IdentityLocked
            };
            tracing::warn!(
                stage = "sync_cycle",
                event = "ntv6_head_unsigned",
                person_identity_held = has_person,
                "NTV6 vault whose signed head context could not be built; refusing to author a downgraded head"
            );
            return CycleOutcome::Failed(class);
        }
    }

    let res = crate::task::run_blocking_future(move || async move {
        // A transport that cannot even be built is a Transport-class failure
        // (same retry posture as an unreachable socket).
        let transport = super::http_transport::build_transport(&url).map_err(|e| {
            super::orchestrator::SyncCycleError::Pull(super::engine::PullError::Transport(e))
        })?;
        // The full `SyncCycleError` crosses the spawn_blocking boundary intact —
        // the integrity verdict (SYNC-10) and the scheduler's retry class are
        // both derived from it on the other side.
        // `run_sync_cycle` became `async` with phase3-web-client task 86 (its
        // sidecar IO is on the storage seam, and the seam is async because OPFS
        // handle acquisition is). It is driven HERE, on the blocking thread,
        // rather than awaited on an executor worker — and that is a deliberate
        // preservation rather than a workaround.
        //
        // The cycle's transport is BLOCKING by design (task 35: `SyncTransport`
        // is a synchronous trait, and the browser satisfies it with synchronous
        // XHR in a dedicated Worker). Awaiting the cycle on an async worker would
        // therefore park a tokio worker thread on a network round trip — up to
        // the transport's 60 s deadline — where today it parks a blocking thread
        // that exists for exactly that. `block_on` inside `spawn_blocking` is the
        // documented way to run async work from a blocking context, and it keeps
        // the desktop's scheduling property byte-identical across this port.
        // `account_number_hash`, NOT the enrolment cache's `account_hash`: inside
        // the cycle this value is AAD and head material only, and `vault.meta` is
        // where the spec says both come from. The cached hex keeps its own two
        // roles above (the SCRAM username in the claim, the enrolment identity).
        super::orchestrator::run_sync_cycle(
            io,
            transport.as_ref(),
            root_key.as_deref(),
            &shared,
            account_number_hash,
            device_id,
            &token_hex,
            &notes_dir,
            &dir,
            gate,
            meta_version,
            Some(super::orchestrator::AttachmentKeys {
                items_key: &items_key,
                items_key_id: &items_key_id,
            }),
            // Signed `0x02` heads when the vault is `NTV6` and a person identity
            // is held; `None` keeps the `NTV5` `root_key` HMAC head.
            signed_ctx.as_ref(),
            // The live-session snapshot captured above (task 7).
            &live_note_ids,
        )
        .await
    })
    .await;

    // Emit the alert/reconcile events here (both `sync_now` and the loop call
    // this) — the orchestrator stays AppHandle-free (sim.rs drives it without a
    // Tauri app), so the emit lives at this boundary off the summary/error.
    let outcome = match res {
        Ok(Ok(summary)) => {
            // Index what the cycle wrote (myne#305). Every LOCAL note writer
            // does this through the hooks seam; the pull path could not, because
            // the orchestrator holds no `Hooks`, so the note went to disk and
            // nothing told the index — and the next persist then certified it as
            // covered. Doing it here, at the boundary that does hold them, is
            // the same choice the prefs/themes refresh below already makes.
            reindex_pulled_notes(
                io,
                state,
                hooks,
                &notes_dir_for_reindex,
                &summary.pulled_note_ids,
            )
            .await;
            // Merge any pulled live-session revisions into their OPEN sessions
            // (`collab-editor-bridge` task 7): the orchestrator DEFERRED these
            // instead of writing, so the session stays the single durable writer and
            // the peer's durable revision lands in the session's document (remove-wins
            // for tombstones) rather than clobbering in-flight typing.
            for (id, bytes, baseline_nonce) in &summary.deferred_live_pulls {
                let note_id = uuid::Uuid::from_bytes(*id).to_string();
                // Merge, and queue the merge's body diff for the pane to dispatch as
                // ONE `ChangeSet` (`live_session_take_remote_splices`), so its buffer
                // catches up WITHOUT a reload and its next whole-markdown save cannot
                // delete the merged-in peer text. Both run under one hold of the
                // registry's session lock (`apply_and_queue`), so a live peer change
                // routed by the awareness supervisor cannot queue between them and
                // compose the two lists in the wrong order (myne-md/myne#849).
                let merged = live_registry.apply_and_queue(&note_id, |s| {
                    s.merge_pulled(bytes, &live_merge_keys.0, &live_merge_keys.1)
                        .map(|splices| (splices, ()))
                });
                if let Some(Ok(())) = merged {
                    // Persist the merged document so the on-disk blob carries the
                    // peer's revision too, then raise the calm "updated from another
                    // device" signal (the same one the durable merge path uses).
                    // The flush feeds the live indexes itself (myne-md/myne#867),
                    // so a peer revision merged into an open session is indexed
                    // here and NOT via `reindex_pulled_notes` above: these ids are
                    // in `deferred_live_pulls`, not `pulled_note_ids`, and the
                    // session is the single writer for the note (`SYNC-33`).
                    // **Both fallback arms below re-index explicitly**, because they
                    // are the two paths where that flush does NOT feed the indexes:
                    // one where it failed, and one where the session refused the
                    // blob or was already gone.
                    let flushed = crate::plugins::live::commands::flush_live_session_to_dir(
                        io,
                        &notes_dir_for_reindex,
                        live_registry,
                        crate::plugins::live::commands::LiveIndexCtx { state, hooks },
                        &live_merge_keys.0,
                        &live_merge_keys.1,
                        &note_id,
                    )
                    .await;
                    // A failed session flush must NOT be swallowed: the merge lives in
                    // RAM, and while the session's next autosave would heal it, a
                    // process death between here and then would leave the on-disk blob
                    // without the peer's revision. Fall back to the plain write the
                    // non-deferred path makes (the bytes were content_nonce-verified
                    // before the deferral, and the merged document is a superset, so
                    // either write carries the peer's revision).
                    if flushed.is_err() {
                        let applied = crate::plugins::sync::orchestrator::apply_pulled_note_blob(
                            io,
                            &notes_dir_for_reindex,
                            id,
                            bytes,
                            baseline_nonce.as_deref(),
                        )
                        .await;
                        // The flush was the path that feeds the live indexes, and it
                        // failed, so nothing indexed the revision this write put on
                        // disk.
                        index_fallback_written_note(
                            io,
                            state,
                            hooks,
                            &notes_dir_for_reindex,
                            &note_id,
                            &applied,
                        )
                        .await;
                    }
                    // The pull landed in a note that is OPEN in a live session, so the
                    // user is watching the change arrive: the live event, which the
                    // hint does NOT listen to, not the durable one (myne-md/myne#857).
                    host.emit("sync://live-remote-merged", EventPayload::Text(note_id));
                } else {
                    // The session could not take the pulled revision (a blob the CRDT
                    // refuses), or it was closed between the orchestrator's scan and
                    // here. The orchestrator SKIPPED the disk write for a deferred pull,
                    // so dropping it would lose the peer's revision with nothing said.
                    // Fall back to the plain write the non-deferred path makes (the
                    // bytes were already content_nonce-verified before the deferral).
                    let applied = crate::plugins::sync::orchestrator::apply_pulled_note_blob(
                        io,
                        &notes_dir_for_reindex,
                        id,
                        bytes,
                        // The SAME dirty-disk check the non-deferred path applies: an
                        // unconditional write here could discard a local edit that
                        // landed between the scan and this fallback.
                        baseline_nonce.as_deref(),
                    )
                    .await;
                    // The flush above feeds the live indexes for a merge it took, and
                    // this arm is the one where it could NOT: the session is gone or
                    // refused the blob, so this write is the note's content now and
                    // nothing else has indexed it. These ids are in
                    // `deferred_live_pulls` rather than `pulled_note_ids`, so the
                    // `reindex_pulled_notes` at the top of this block never saw them
                    // either.
                    index_fallback_written_note(
                        io,
                        state,
                        hooks,
                        &notes_dir_for_reindex,
                        &note_id,
                        &applied,
                    )
                    .await;
                    if applied.is_ok() {
                        host.emit("sync://remote-merged", EventPayload::Text(note_id));
                    }
                }
            }
            // ASM-6→B / #422: an NC05 note whose local copy an automatic CRDT
            // merge reconciled with a concurrent remote edit this cycle. Emit ONE
            // `sync://remote-merged` per affected note (`Text(note_id)`), so the
            // product surface can fire the calm "updated from another device" hint
            // only when the OPEN note is among them — and stay silent for a plain
            // server-wins pull, a local-only edit, or a MY01 keep-both. The reindex
            // above has already re-read the merged content into the editor.
            for id in &summary.remote_merged_note_ids {
                host.emit("sync://remote-merged", EventPayload::Text(id.clone()));
            }
            if summary.reconcile_ran {
                // A 410-beyond-horizon full reconcile ran this cycle — bracket it
                // so the reconcile banner (reassuring, "caught up") can show.
                host.emit("sync://reconcile-started", EventPayload::Unit);
                host.emit("sync://reconcile-finished", EventPayload::Unit);
            }
            if summary.credential_ambiguous {
                // The meta phase refused to adopt because the two `vault.meta`
                // copies disagree on the password-side wrap and nothing says
                // which side moved (task 88). Published as an ERROR status even
                // though the cycle itself succeeded, and that is the point:
                // refusing is a permanent stall — every later cycle re-refuses —
                // so a user who is told nothing has no way to act, and the
                // silence would trade a silent password revert for a silent
                // freeze.
                //
                // A bounded detail tag, like every other status detail, so the
                // UI keys off a label rather than parsing prose.
                // The `emit` seam, matching the reconcile bracket above rather
                // than the status CELL — the cell is `Manager`-shaped and the
                // browser passes `None` for it, so a status-cell write would be
                // silent on exactly the client that most needs the warning.
                host.emit("sync://credential-ambiguous", EventPayload::Unit);
            }
            if summary.prefs_applied_remote {
                // A remote prefs change was merged onto disk this cycle
                // (MYND-478): refresh the switcher-facing RAM caches, then tell
                // the WebView to re-read (the same disk→cache→event choreography
                // as a local setter; the orchestrator stays AppHandle-free so
                // the side effects live at this boundary).
                if let Ok(view) =
                    crate::plugins::prefs::commands::prefs_read_with_dir(&dir_for_prefs, state, io)
                        .await
                {
                    if let Some(active) = state.active_vault_id().await {
                        state.set_cached_label(active, view.label.clone()).await;
                        state.set_cached_icon(active, view.icon.clone()).await;
                        // ...and persist it, not only in RAM. A MEMBER vault gets its
                        // name from a prefs blob that arrives BY SYNC after accept,
                        // so without this the durable `vault.label` the LOCKED picker
                        // reads was never written and every relaunch kept showing the
                        // "Vault N" fallback (myne-md/myne#856). Best-effort, like
                        // every other label writeback.
                        crate::vault_label::writeback::persist_label_from_host(
                            host,
                            io,
                            &dir_for_prefs,
                            active,
                            view.label.as_deref(),
                            crate::vault_label::key::platform_keychain(),
                        )
                        .await;
                    }
                }
                host.emit(
                    crate::plugins::prefs::commands::PREFS_CHANGED_EVENT,
                    EventPayload::Unit,
                );
            }
            if summary.dictionary_applied_remote {
                // A remote dictionary change was merged onto disk this cycle
                // (myne-md/myne#640). The desktop holds the personal/ignore sets
                // in RAM for spell-checking, so the on-disk merge is invisible
                // until they are re-read: without this, a word added on a peer
                // stays a squiggle on this device until the next unlock, and the
                // next local add would persist the stale RAM view (the spell
                // write path re-reads and merges, so nothing is LOST, but the
                // user would not see the peer's words). Desktop's hook hydrates
                // the sets; mobile and web have no spell state and no-op it.
                hooks.hydrate_spell(state).await;
            }
            // The cycle reached the server and finished (myne#583). Stamp it,
            // coalesced, so the staleness banner has a clock to measure from —
            // this is the only place that knows a cycle SUCCEEDED, and until it
            // existed nothing on disk did.
            super::state::record_sync_success(io, &vault_root_for_stamp, host.now_unix_millis())
                .await;
            CycleOutcome::Ran(summary)
        }
        Ok(Err(e)) => {
            if matches!(&e, super::orchestrator::SyncCycleError::Pull(pe)
                if super::integrity::pull_error_is_integrity_failure(pe))
            {
                // Hard, honest integrity alert (rollback / non-extending head).
                // Copy is the pinned `SYNC_INTEGRITY_ALERT` literal on the UI side.
                host.emit("sync://integrity-alert", EventPayload::Unit);
            }
            if matches!(&e, super::orchestrator::SyncCycleError::RekeyedElsewhere) {
                // The vault was migrated on ANOTHER device (#429). This session's
                // `root_key` is the previous generation's, so every note it pulls
                // from here is undecryptable — and the keys it holds are not the
                // ones the vault has. Lock, and say why: the remedy is the user
                // unlocking again (which re-derives the v0.2 root from the meta
                // the meta phase adopts), not a retry.
                //
                // The emit comes FIRST: a lock can drop the surface the message
                // would have appeared on, and the ordering is the difference
                // between an explained lock and a mysterious one.
                host.emit("sync://vault-rekeyed", EventPayload::Unit);
                let _ = crate::plugins::vault_unlock::commands::lock_from_host(state, hooks).await;
            }
            CycleOutcome::Failed(classify_cycle_error(&e))
        }
        // Join error — no class information survives a panicked task.
        Err(_) => CycleOutcome::Failed(super::loop_control::FailureClass::Other),
    };

    // The person-private AI store's sync plane (myne-md/myne#711 task 29,
    // `decisions/protocol/0608`). Best-effort and member-only: it merges the
    // remote `MYY5` profile into the local cache at the family layer and pushes
    // the result. Runs after the content cycle so a profile-route hiccup never
    // fails content sync. Host-only (the profile route drives the rustls
    // transport), so it stands down on wasm32 where B2B is capability-absent.
    #[cfg(not(target_arch = "wasm32"))]
    if let Err(e) =
        crate::plugins::sync::person_ai_sync::person_ai_sync_from_host(host, io, state).await
    {
        // Stale server state, not data loss: the local cache is already written.
        tracing::warn!(
            stage = "person_ai_sync",
            error = ?e,
            "the person-private AI profile did not sync this cycle"
        );
    }

    // A member's adoption of an owner group-key rotation (`collab-b2b-sessions`
    // task 1). Best-effort and member-only: the function is a no-op unless
    // `vault.meta` has advanced past the epoch this device's member-key store
    // holds, in which case it fetches the member's delivered package, verifies
    // it against the pinned owner half, and installs the new group + items keys on
    // the live slot so this session re-keys. Runs after the content cycle so a
    // delivery hiccup never fails content sync. Host-only (the delivery route
    // drives the rustls transport), so it stands down on wasm32 where B2B is
    // capability-absent.
    #[cfg(not(target_arch = "wasm32"))]
    if !is_owner {
        if let Err(e) =
            crate::plugins::sync::person_account::member_adopt_rotation_from_host(host, io, state)
                .await
        {
            // The next cycle retries; a member with a pending rotation simply
            // keeps the old tier until its package lands.
            tracing::warn!(
                stage = "member_rotation_adopt",
                error = ?e,
                "a member group-key rotation was not adopted this cycle"
            );
        }
    }

    // An owner's unfinished rotation-package delivery (myne-md/myne#797). The
    // rotation writes the sealed packages to a device-local outbox before it
    // touches the network, so a crash between the two leaves the recipients on
    // the retired epoch with nothing to retry: unless this drains it. Best
    // effort: a no-op when the outbox is absent, and a failure here never fails
    // the content cycle.
    #[cfg(not(target_arch = "wasm32"))]
    if is_owner {
        match crate::plugins::sync::rotation_outbox::drain_rotation_outbox_from_host(
            host, io, state,
        )
        .await
        {
            // A drain that actually delivered means the rotation's re-keyed blobs
            // are the ones the server must serve: arm the push window, or a
            // poll-only tick never sends them. `Ok(false)` is the common "no
            // outbox" answer and must NOT arm it, or every owner cycle becomes a
            // push (myne-md/myne#797).
            Ok(true) => hooks.bump_local_change(),
            Ok(false) => {}
            Err(e) => tracing::warn!(
                stage = "rotation_outbox_drain",
                error = ?e,
                "an owner rotation-package delivery is still pending"
            ),
        }
    }

    outcome
}

/// Run one cycle NOW (the manual "Sync now" button) and report the resulting
/// status.
///
/// Moved here with the cycle (task 84) because the mapping from a
/// [`CycleOutcome`] to a status is a correctness rule rather than glue: a
/// `NotReady` outcome must NOT collapse into `Idle`. Reporting "Synced" for a
/// device that cannot sync is the exact dishonesty the status derivation exists
/// to prevent, and clicking "Sync now" on an unenrolled device would otherwise
/// flip the dot to green. Only a genuine `Ran` is `Idle`.
pub async fn sync_now_from_host(
    host: &dyn HostCtx,
    io: &'static dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    live_registry: &crate::plugins::live::LiveSessionRegistry,
) -> super::status::SyncRuntimeStatus {
    use super::status::SyncRuntimeStatus;
    match run_active_cycle_from_host(host, io, state, hooks, live_registry, true).await {
        CycleOutcome::Disabled => SyncRuntimeStatus::Disabled,
        // `NotReady` is one outcome covering three situations — locked vault,
        // never enrolled, and enrolled-but-awaiting-approval. Answering
        // `NotEnrolled` for all three made this command contradict
        // `sync_status`, which reports `Pending` for the third (MYND-635). Ask
        // the one derivation instead of hard-coding a second opinion; it can
        // only return `Pending` or `NotEnrolled`, so the `Ran`-only-`Idle` rule
        // above still holds.
        CycleOutcome::NotReady => super::status::not_ready_reason(host, io, state).await,
        CycleOutcome::Ran(summary) => {
            if summary.pulled > 0 || summary.dropped > 0 {
                // A manual sync pulled notes to disk (or reconcile quarantined
                // absentees) — mirror the loop's refresh nudge so the UI
                // reloads. The loop emits the same event on its own cycles;
                // this covers the manual path on top of it.
                host.emit("sync://changed", EventPayload::Count(summary.pulled as u32));
            }
            SyncRuntimeStatus::Idle
        }
        CycleOutcome::Failed(class) => {
            // The manual button's answer carries the same clock the polled
            // status does, so a "Sync now" that fails does not blank out a
            // staleness warning the poll had already raised.
            let last_success_at = match crate::paths::active_vault_root_io_from_host(
                host,
                state.active_vault_id().await,
            ) {
                Ok(dir) => super::state::read_sync_state(io, &dir)
                    .await
                    .ok()
                    .and_then(|s| s.last_success_at_ms),
                Err(_) => None,
            };
            SyncRuntimeStatus::Error {
                detail: class.status_detail().into(),
                last_success_at,
            }
        }
    }
}

/// Push the on-disk `vault.meta` to the server right now (F1; the io-seam
/// version, phase3-web-client task 41).
///
/// # Why this moved out of the host-gated `commands` module
///
/// `commands.rs` does not compile for `wasm32`, so this function — the one that
/// makes a credential change reach the server — was unreachable from the browser.
/// That is precisely the failure task 88 describes: a web password change that
/// stays local, whose evidence (`vault.meta-dirty` + `meta_baseline_hex`) then
/// evaporates with the OPFS container, after which the meta phase adopts the
/// server's older copy and the new password silently stops working.
///
/// # Best-effort, and the two "false" cases are different
///
/// A not-ready state (sync disabled, no token, no vault) is a silent `false`
/// with **no dirty marker** — nothing changed, so there is nothing to remember.
/// A transport failure is a `false` **with** the marker, so the meta phase
/// retries. Callers that need "the server has it" must use the return value;
/// `true` means the `PUT` was accepted.
pub async fn push_vault_meta_now_via_io(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> bool {
    // Serialize with cycles / reset — same guard run_active_cycle uses, so a push
    // never races the loop's own meta read-modify-write.
    let _cycle_guard = super::cycle::sync_cycle_mutex().lock().await;
    let Ok(cfg) = async {
        let p = crate::plugins::sync::config::config_path_from_host(host, io).await?;
        crate::plugins::sync::config::read_config(io, &p).await
    }
    .await
    else {
        return false;
    };
    let Some(url) = cfg.endpoint_url else {
        return false; // sync disabled
    };
    let Ok(dir) = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
    else {
        return false;
    };
    // Stored per-device token. A still-pending device no-ops (its meta is
    // seeded when enrollment completes), and does NOT get marked dirty.
    let device_token = match crate::plugins::sync::token_store::default_store()
        .read(io, &dir)
        .await
    {
        Ok(Some(t)) => t,
        _ => return false,
    };
    // The meta PUT is owner-authorized on a B2B vault (the server's
    // `vaultMetaWriteAccount` refuses a device token with 403 `owner_required`),
    // so prefer the owner's per-vault membership token when this device holds
    // one — otherwise a credential change or roster update never reaches the
    // server on a shared vault. A pre-B2B vault has no owner binding and keeps
    // the device token.
    let owner_token_hex = crate::plugins::sync::state::read_sync_state(io, &dir)
        .await
        .ok()
        .and_then(|s| s.owner_member_token_hex)
        .filter(|t| !t.is_empty());
    let token_hex = match owner_token_hex {
        Some(t) => t,
        None => {
            let mut hex = String::with_capacity(device_token.len() * 2);
            for b in &device_token {
                hex.push_str(&format!("{b:02x}"));
            }
            hex
        }
    };
    // Through the seam, like every other read on this path (task 87). It was the
    // last `std::fs` call in the production half of this file — and it sat on the
    // meta-push path, which a browser reaches whenever a credential changes.
    let meta_read = { io.read(&dir.join("vault.meta")).await };
    let Ok(meta_bytes) = meta_read else {
        return false;
    };
    let url_moved = url.clone();
    // `run_blocking`, not `spawn_blocking`: the native arm dispatches to a tokio
    // worker so a round trip does not park one, and the wasm arm runs inline —
    // which IS the design there, since the browser transport is synchronous XHR
    // in a dedicated Worker (task 35).
    let res = crate::task::run_blocking(move || {
        let transport =
            crate::plugins::sync::http_transport::build_transport(&url_moved).map_err(|_| ())?;
        crate::plugins::sync::enroll::put_vault_meta(transport.as_ref(), &token_hex, &meta_bytes)
            .map_err(|_| ())
    })
    .await;
    match res {
        Ok(Ok(())) => {
            // Pushed — the local change reached the server; clear any prior dirt.
            let _ = crate::plugins::sync::state::clear_vault_meta_dirty(io, &dir).await;
            true
        }
        _ => {
            // Offline / transport / join error: remember to push later (Faz B).
            let _ = crate::plugins::sync::state::mark_vault_meta_dirty(io, &dir).await;
            false
        }
    }
}

#[cfg(test)]
mod tests {
    //! The AAD identity the cycle binds. Driven at [`cycle_account_number_hash`]
    //! rather than through `run_active_cycle_from_host`, because everything the
    //! rule is about — which file the hash comes from, and what happens when the
    //! two disagree — is decided here, and the rest of the gather is a host, a
    //! runtime slot and a live server.

    use super::*;
    use crate::test_support::{block_on, seed_real_vault_meta, ScopedTempDir};
    // Method resolution for `IO`'s inherent-looking calls (`create_dir_all`,
    // `write`): the trait is the only place they exist.
    use crate::vault_io::VaultIo as _;

    const IO: crate::vault_io::StdVaultIo = crate::vault_io::StdVaultIo;

    /// The account hash `seed_real_vault_meta` writes for `seed_byte`.
    fn seeded(seed_byte: u8) -> [u8; 16] {
        [seed_byte; 16]
    }

    /// `classify_cycle_error` keeps the pin mismatch out of the transport
    /// catch-all, in both directions.
    ///
    /// The arm it has to beat is `Transport(_)`, which discarded the payload
    /// and was the second of three places the diagnosis died on its way to the
    /// user. The negative half matters as much: every OTHER transport failure
    /// must still classify as `Transport`, because they are the ones that do
    /// clear on their own and must keep backing off rather than parking.
    #[test]
    fn tls_failures_are_classified_apart_from_network_errors() {
        use super::super::engine::{PullError, PushError};
        use super::super::loop_control::FailureClass;
        use super::super::orchestrator::SyncCycleError;
        use super::super::transport::TransportError;

        assert_eq!(
            classify_cycle_error(&SyncCycleError::Pull(PullError::Transport(
                TransportError::Tls
            ))),
            FailureClass::TlsFailure
        );
        assert_eq!(
            classify_cycle_error(&SyncCycleError::Push(PushError::Transport(
                TransportError::Tls
            ))),
            FailureClass::TlsFailure,
            "push and pull use the same certificate validation"
        );

        for other in [
            TransportError::Network,
            TransportError::NotConfigured,
            TransportError::BadRequest,
        ] {
            assert_eq!(
                classify_cycle_error(&SyncCycleError::Pull(PullError::Transport(other.clone()))),
                FailureClass::Transport,
                "{other:?} is not a pin mismatch and must keep the backoff ladder"
            );
        }
    }

    #[test]
    fn the_bound_hash_is_the_one_vault_meta_carries() {
        block_on(async {
            let tmp = ScopedTempDir::new("cycle-account-hash-agrees").unwrap();
            seed_real_vault_meta(tmp.path(), 0x2A);

            assert_eq!(
                cycle_account_number_hash(&IO, tmp.path(), &seeded(0x2A)).await,
                Ok((protocol::MetaVersion::V0_1, seeded(0x2A)))
            );
        });
    }

    /// The drift case, and the reason this function exists: an enrolment that
    /// names a different account must stop the cycle instead of handing that hash
    /// to the catalog / prefs / themes AADs, where a wrong value is silent — every
    /// local edit reverted on every cycle, and no attachment ever downloaded.
    #[test]
    fn an_enrolment_naming_another_account_is_refused() {
        block_on(async {
            let tmp = ScopedTempDir::new("cycle-account-hash-drift").unwrap();
            seed_real_vault_meta(tmp.path(), 0x2A);

            assert_eq!(
                cycle_account_number_hash(&IO, tmp.path(), &seeded(0x99)).await,
                Err(AccountHashRefusal::NotThisVault)
            );
        });
    }

    #[test]
    fn a_missing_vault_meta_refuses_rather_than_trusting_the_cache() {
        block_on(async {
            let tmp = ScopedTempDir::new("cycle-account-hash-absent").unwrap();

            assert_eq!(
                cycle_account_number_hash(&IO, tmp.path(), &seeded(0x2A)).await,
                Err(AccountHashRefusal::MetaUnavailable)
            );
        });
    }

    #[test]
    fn an_unparsable_vault_meta_refuses_rather_than_trusting_the_cache() {
        block_on(async {
            let tmp = ScopedTempDir::new("cycle-account-hash-garbage").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"not a vault.meta").unwrap();

            assert_eq!(
                cycle_account_number_hash(&IO, tmp.path(), &seeded(0x2A)).await,
                Err(AccountHashRefusal::MetaUnavailable)
            );
        });
    }

    /// A deferred live pull's FALLBACK write must feed the live indexes, and a
    /// write that did not happen must not (myne-md/myne#867 review).
    ///
    /// The session flush indexes a merged peer revision, and BOTH fallback arms
    /// bypass it, so this helper is the only thing that indexes what they wrote.
    /// The gate is `Applied` rather than `is_ok()`: `SkippedDirty` and
    /// `StorageFull` wrote nothing, so re-reading the disk there would index a
    /// document the arm did not produce.
    #[test]
    fn a_fallback_write_is_indexed_only_when_it_wrote() {
        use crate::plugins::sync::orchestrator::{PulledNoteApply, SyncCycleError};
        use crate::plugins::vault_unlock::state::{fixture_unlocked_with_keys, test_vault_id};
        use crate::test_support::{IndexCall, RecordingHooks};

        block_on(async {
            let tmp = ScopedTempDir::new("cycle-fallback-index").unwrap();
            let notes_dir = tmp.path().join("notes");
            IO.create_dir_all(&notes_dir).await.unwrap();

            let uuid = *crate::plugins::notes::note_id::NoteId::new_v7()
                .as_uuid()
                .as_bytes();
            let note_id = uuid::Uuid::from_bytes(uuid).to_string();
            let (ik, ikid) = ([0x11u8; 32], [0x22u8; 16]);
            let host = crate::host::test_host::TestHost::new("/base");
            let blob = crate::plugins::notes::crdt::encode_note_blob(
                "---\ntitle: Peer\n---\npeer revision\n",
                &ik,
                &ikid,
                &uuid,
                &[0xAAu8; 16],
                &host,
            )
            .expect("seal");
            IO.write(
                &notes_dir.join(format!("{note_id}.myn")),
                &blob,
                crate::vault_io::WriteOpts::default(),
            )
            .await
            .expect("write");

            // An UNLOCKED slot holding the key the blob was sealed under, so
            // `reindex_pulled_notes` can actually decrypt what is on disk.
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0x33, 0x11, 0x22),
                )
                .await;
            let rec = RecordingHooks::new();
            let hooks: crate::hooks::Hooks = rec.clone();

            for (label, applied) in [
                ("SkippedDirty", Ok(PulledNoteApply::SkippedDirty)),
                ("StorageFull", Ok(PulledNoteApply::StorageFull)),
                ("Err(Io)", Err(SyncCycleError::Io)),
            ] {
                index_fallback_written_note(&IO, &state, &hooks, &notes_dir, &note_id, &applied)
                    .await;
                assert_eq!(
                    rec.index_calls().len(),
                    0,
                    "{label} wrote nothing, so it must not index"
                );
            }

            // Written: the index must describe the blob on disk.
            index_fallback_written_note(
                &IO,
                &state,
                &hooks,
                &notes_dir,
                &note_id,
                &Ok(PulledNoteApply::Applied),
            )
            .await;
            let calls = rec.index_calls();
            assert_eq!(
                calls.len(),
                2,
                "an applied write owes search_upsert + index_note_attachments, got {calls:?}"
            );
            match &calls[0] {
                IndexCall::SearchUpsert {
                    note_id: id, body, ..
                } => {
                    assert_eq!(id, &note_id, "the body doc is keyed by the note id");
                    assert!(
                        body.contains("peer revision"),
                        "the indexed body is the blob that reached disk, got {body:?}"
                    );
                }
                other => panic!("first call must be search_upsert, got {other:?}"),
            }

            // A peer TOMBSTONE written by the same arm leaves the index.
            let tomb = crate::plugins::notes::crdt::encode_note_blob(
                "---\ntitle: Peer\ndeleted: 2026-10-16T12:00:00Z\n---\npeer revision\n",
                &ik,
                &ikid,
                &uuid,
                &[0xBBu8; 16],
                &host,
            )
            .expect("seal tombstone");
            IO.write(
                &notes_dir.join(format!("{note_id}.myn")),
                &tomb,
                crate::vault_io::WriteOpts::default(),
            )
            .await
            .expect("write tombstone");
            let before = rec.index_calls().len();
            index_fallback_written_note(
                &IO,
                &state,
                &hooks,
                &notes_dir,
                &note_id,
                &Ok(PulledNoteApply::Applied),
            )
            .await;
            let after = rec.index_calls();
            let tail = &after[before..];
            assert!(
                tail.iter().any(
                    |c| matches!(c, IndexCall::SearchRemove { note_id: id } if id == &note_id)
                ),
                "a pulled tombstone must leave the search index, got {tail:?}"
            );
            assert!(
                !tail.iter().any(|c| matches!(
                    c,
                    IndexCall::SearchUpsert { .. } | IndexCall::IndexAttachments { .. }
                )),
                "a pulled tombstone must not be re-indexed, got {tail:?}"
            );
        });
    }
}
