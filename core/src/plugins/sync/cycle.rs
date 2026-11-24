// SPDX-License-Identifier: AGPL-3.0-only
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
///
/// `large_enum_variant` is allowed rather than boxed: this value is returned once per
/// cycle from one function and destructured immediately, so the size is one stack slot and
/// never a collection of them, which is the shape the lint exists for. `SyncSummary` crossed
/// clippy's 200-byte heuristic when the binding-conflict field became the list of tied
/// devices (myne-md/myne#976), and the two alternatives both cost more than the bytes: a
/// `Box` allocates for a value about to be moved out, and a single flag would leave the
/// repair unable to tell the pair it can separate from one between two other members.
#[allow(clippy::large_enum_variant)]
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
        // `approved_token` is the one spelling of "approved AND a token arrived"; None here is
        // still pending approval, not a failure.
        out.approved_token().map(<[u8]>::to_vec)
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
/// What one cycle's authority resolution produced.
///
/// The context and the reason sit together because they are one answer: `ctx` is what the
/// engine signs and verifies with, and `device` is why it cannot sign when it cannot. Before
/// myne-md/myne#983 the reason was recomputed at the guard from two booleans, so five causes
/// collapsed into one sentence.
///
/// `pub(crate)` for the vault doctor (myne-md/myne#1003), which reports this decision as five
/// facts instead of resolving a second time: one builder, one answer, so the report cannot
/// disagree with the cycle it describes.
pub(crate) struct HeadAuthority {
    pub(crate) ctx: Option<super::head_authority::SignedHeadCtx>,
    pub(crate) device: super::authority::DeviceResolution,
    pub(crate) person_held: bool,
}

impl HeadAuthority {
    fn no_context(person_held: bool) -> Self {
        Self {
            ctx: None,
            device: super::authority::DeviceResolution::Unbound {
                cause: super::authority::AuthorityMissing::NoHeadContext,
                signers: Vec::new(),
            },
            person_held,
        }
    }

    fn can_author(&self) -> bool {
        self.ctx
            .as_ref()
            .is_some_and(super::head_authority::SignedHeadCtx::can_author)
    }

    /// A context that can VERIFY a head but not sign one (myne-md/myne#1000).
    ///
    /// Built when the roster or its signer cannot be resolved from local state, which is the
    /// state of every device that has just joined a vault: the roster's signer lives in
    /// `vault.device-bindings`, and the only thing that downloads that file is the cycle this
    /// context lets run. The head it can still verify is the owner's person-signed one, against
    /// a half this device derived from the phrase or pinned out of band.
    fn person_reader(
        person: Option<protocol::PersonKeyPair>,
        account_number_hash: [u8; protocol::vault_head::VAULT_HEAD_ACCOUNT_HASH_LEN],
        owner_public: protocol::person_key::PersonPublicHalf,
        person_held: bool,
    ) -> Self {
        Self {
            ctx: Some(super::head_authority::SignedHeadCtx::person_only_reader(
                person,
                account_number_hash,
                owner_public,
            )),
            device: super::authority::DeviceResolution::Unbound {
                cause: super::authority::AuthorityMissing::NoHeadContext,
                signers: Vec::new(),
            },
            person_held,
        }
    }

    /// Whether this device can OPEN a head at all, which is a weaker question than
    /// [`Self::can_author`] and the one the cycle's guard asks before refusing to run.
    fn can_read(&self) -> bool {
        self.ctx.is_some()
    }

    fn missing(&self) -> super::authority::AuthorityMissing {
        super::authority::missing_for_cycle(self.ctx.is_some(), self.person_held, &self.device)
    }
}

/// Build the signed head context for a vault that carries the B2B tail, and resolve the
/// device half through `sync::authority` (myne-md/myne#983).
///
/// A head is signed by the held person keypair (the owner's or a member's own) and verified
/// against the roster, so a member authors heads under its own identity. The roster itself is
/// **owner-signed**, so verifying it needs the owner's public half: the owner holds it as
/// their identity, a member holds only the out-of-band identity code recorded at accept.
///
/// Every early exit is `HeadAuthority::no_context`, which reports `NoHeadContext` rather than
/// a credential cause: an unreadable meta, a missing group key or an unverifiable roster is
/// not something a user can fix by opening their identity, and saying so was part of the
/// defect this function was rewritten for.
pub(crate) async fn signed_head_ctx(
    // The device id is read through `sync::device_actor`, which needs the host for the
    // person credential's path (myne-md/myne#958). Before that reader, this function
    // consulted the vault's enrolment record ONLY and bailed to the `0x02` phrase path
    // on a person-born vault, where that record is legitimately empty.
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &std::path::Path,
    state: &VaultRuntimeState,
    shared: &crate::plugins::vault_unlock::state::SharedSingletonKey,
    is_owner: bool,
) -> HeadAuthority {
    // The held identity is NOT required to build this context any more. It is required to
    // author a `0x02` head, and `SignedHeadCtx::sign` refuses that arm without it, but a
    // cold start has to be able to VERIFY heads and the roster it is verified through, and a
    // device key authors `0x03` without the phrase at all (`0731` stage 1).
    let person = state.clone_person_identity().await;
    let person_held = person.is_some();

    let Ok(bytes) = io.read(&vault_dir.join("vault.meta")).await else {
        return HeadAuthority::no_context(person_held);
    };
    // EVERY generation that carries the tail, asked through the classifier rather than by
    // magic: this match used to list `NTV6` and `NTV7` by hand, so an `NTV8` vault got NO
    // head context at all and the cycle stopped authoring heads instead of signing them.
    let Some(b2b) = super::meta_kind::b2b_tail(&bytes) else {
        return HeadAuthority::no_context(person_held);
    };
    // The OWNER's public half is resolved BEFORE the roster, because it is the one thing
    // every later failure can still verify a head against. A device that has just joined
    // has no copy of `vault.device-bindings`, so the roster's signer cannot be resolved and
    // the whole cycle used to be refused before the pull that would deliver that file
    // (myne-md/myne#1000). The person half is derived from the phrase or from the pinned
    // identity code, so it is available in exactly that state.
    let Ok(sync_state) = super::state::read_sync_state(io, vault_dir).await else {
        return HeadAuthority::no_context(person_held);
    };
    let owner_public = match (&person, is_owner) {
        (Some(held), true) => held.public_half(),
        // An OWNER's cold start: this device cached its own code the last time the phrase was
        // entered (public material only, refreshed on every unlock).
        (None, true) => {
            let Some(code) = sync_state
                .own_identity_code
                .as_deref()
                .and_then(|code| super::invite::decode_person_identity_code(code).ok())
            else {
                return HeadAuthority::no_context(person_held);
            };
            code.public
        }
        // A member holds the owner's half only as the code pinned out of band at accept.
        (_, false) => {
            let Some(code) = sync_state
                .owner_identity_code
                .as_deref()
                .and_then(|code| super::invite::decode_person_identity_code(code).ok())
            else {
                return HeadAuthority::no_context(person_held);
            };
            code.public
        }
    };
    // The group key and the roster, which is where a joined device runs out of state: the
    // envelope is sealed under the group key and its SIGNER is resolved from the binding
    // store below. Both failures build a READ-ONLY context instead of refusing, so the pull
    // that delivers the missing file can run (myne-md/myne#1000).
    let Some(group_key) = shared.group_bytes() else {
        return HeadAuthority::person_reader(
            person,
            b2b.base.account_number_hash,
            owner_public,
            person_held,
        );
    };
    let Some(envelope) = protocol::person_invite::open_group_roster(
        &group_key,
        &b2b.base.account_number_hash,
        b2b.group_key_epoch,
        &b2b.signed_roster_envelope,
    ) else {
        return HeadAuthority::person_reader(
            person,
            b2b.base.account_number_hash,
            owner_public,
            person_held,
        );
    };
    // ONE read of the key at rest, whose public half the roster verification needs below. It
    // used to be two reads with two error policies (`load_for_fallback` here, `load` further
    // down), which is how a store refusal could read as "no key" at one site and as a fault
    // at the other.
    let key_at_rest = super::authority::load_key("signed_head_ctx");
    // The roster may have been signed by the owner's PERSON key or by one of the owner's
    // DEVICES (`decisions/protocol/0731` stage 2). Candidates come from the pinned
    // attestation (a member), this device's own key (the owner) and the verified rows of
    // the binding store.
    let owner_devices = super::roster_trust::device_halves_for_owner(
        io,
        vault_dir,
        Some(
            &crate::plugins::device_binding::bindings_key_for_group(
                &group_key,
                b2b.base.account_number_hash,
                b2b.group_key_epoch,
            )
            .borrow(),
        ),
        sync_state.owner_device.as_ref(),
        &owner_public,
    )
    .await;
    let Some(roster) = protocol::person_invite::verify_group_roster(
        super::roster_trust::trust(&owner_public, &owner_devices),
        &envelope,
        &b2b.base.account_number_hash,
    )
    .ok() else {
        return HeadAuthority::person_reader(
            person,
            b2b.base.account_number_hash,
            owner_public,
            person_held,
        );
    };
    let roster_publics: Vec<protocol::person_key::PersonPublicHalf> = roster
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

    // The device half, resolved in ONE place (myne-md/myne#983): a key at rest, a VERIFIED
    // binding row for this device, and that row publishing exactly this key. Any other state
    // is `Unbound(cause)`, and the cause is what the caller reports.
    let device = super::authority::resolve_device(
        io,
        vault_dir,
        b2b.base.account_number_hash,
        b2b.group_key_epoch,
        &group_key,
        &roster_publics,
        super::device_actor::durable_device_id(host, io, vault_dir).await,
        &key_at_rest,
    )
    .await;
    // Not bound still builds the context: the phrase path (`0x02`) is a head every peer
    // accepts, and a cold start has to be able to READ heads it cannot author.
    let ctx = match &device {
        super::authority::DeviceResolution::Bound(bound) => {
            super::head_authority::SignedHeadCtx::new(
                person,
                b2b.base.account_number_hash,
                roster_publics,
            )
            .with_device(
                super::head_authority::DeviceSigner {
                    device_id: bound.device_id,
                    key: bound.key.clone(),
                },
                bound.signers.clone(),
            )
        }
        // An unbound device still READS: the verified rows are what a peer's `0x03` head is
        // checked against, and those belong to the vault rather than to this device's
        // binding. Dropping them here made `accepts_format` claim `0x03` while every
        // verification answered `AuthorUnknown` (myne-md/myne#983 review, D4).
        super::authority::DeviceResolution::Unbound { signers, .. } => {
            super::head_authority::SignedHeadCtx::new(
                person,
                b2b.base.account_number_hash,
                roster_publics,
            )
            .with_readers(signers.clone())
        }
    };
    HeadAuthority {
        ctx: Some(ctx),
        device,
        person_held,
    }
}

/// The person session's device token, as raw bytes (myne-md/myne#911 task 8).
///
/// Read per cycle rather than cached: the token is rotated by re-enrolment and by
/// a person-key rotation, and a cached copy would outlive the credential it
/// names. `None` on an absent file (no identity on this device), an all-zero or
/// unparseable one, or an empty token (an identity that never registered).
/// What a cycle does about a B2B vault whose head this device may not author.
///
/// The refusal this replaced was one boolean, and it cost the only route out of
/// `myne-md/myne#1000`: a device that had just joined could not resolve the roster's signer,
/// so the whole cycle was refused BEFORE the pull — and the pull is the only thing that
/// downloads `vault.device-bindings`, which is what resolves that signer. The state could not
/// repair itself, and the user met an approval screen whose code never arrives.
///
/// `ReadOnly` is the arm that breaks the loop, and it is safe because the property the refusal
/// protects is "never AUTHOR the downgraded `0x01` HMAC head": `PushGate::PollOnly` denies both
/// the content push and the genesis head, so no head is authored at all. What the device may
/// still do is verify and adopt a head its peer signed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HeadAuthorityVerdict {
    /// Authoring works, or this vault needs no signed head: an ordinary cycle.
    Author,
    /// A head can be READ but not signed: run pull-only and report nothing as broken.
    ReadOnly,
    /// No head context at all, so not even a signature can be checked: refuse.
    Refuse,
}

/// The one decision the cycle makes about a missing authoring authority.
///
/// A function rather than three lines in the middle of a 700-line builder because the three
/// answers are the whole of `myne-md/myne#1000`, and a caller would otherwise have to stand up
/// a server to see which arm it took.
fn head_authority_verdict(
    needs_signed_head: bool,
    authority: &HeadAuthority,
) -> HeadAuthorityVerdict {
    if !needs_signed_head || authority.can_author() {
        return HeadAuthorityVerdict::Author;
    }
    if authority.can_read() {
        HeadAuthorityVerdict::ReadOnly
    } else {
        HeadAuthorityVerdict::Refuse
    }
}

/// One line per CHANGE of the head-authority verdict (myne-md/myne#1033).
///
/// Change-gated rather than per-cycle: the question is answered every thirty seconds, and
/// what a reader needs is the EDGE — when this device stopped being able to sign, and when it
/// started again. A verdict that repeats is the state the previous line already described.
fn note_authority_verdict(
    verdict: HeadAuthorityVerdict,
    cause: Option<super::authority::AuthorityMissing>,
) {
    // Bounded tokens only (`check-tracing-discipline.mjs` R1/R2 read this line).
    let verdict_token = match verdict {
        HeadAuthorityVerdict::Author => "author",
        HeadAuthorityVerdict::ReadOnly => "read_only",
        HeadAuthorityVerdict::Refuse => "refuse",
    };
    let cause_token = cause.map_or("none", super::authority::AuthorityMissing::as_str);
    if !super::change_gate::first_sighting(
        "authority_verdict",
        super::change_gate::fold(verdict_token, cause_token),
    ) {
        return;
    }
    tracing::info!(
        stage = "sync_cycle",
        event = "head_authority_verdict",
        verdict = verdict_token,
        cause = cause_token,
        "the head-authority verdict for this cycle changed"
    );
}

/// Which `FailureClass` a missing authority becomes, in one place.
///
/// The mapping is the whole point of myne-md/myne#983: the class, the log and the UI sentence
/// must not disagree, and before this the choice was an inline expression nothing could assert.
/// `KeyMissingWhileBound` gets its own class because the repair IS the identity entry but the
/// sentence has to name what is actually missing; every other cause either parks as `Other` or
/// asks for the identity.
fn class_for_missing_authority(
    cause: super::authority::AuthorityMissing,
    person_held: bool,
) -> super::loop_control::FailureClass {
    if !cause.identity_unlock_would_fix() || person_held {
        return super::loop_control::FailureClass::Other;
    }
    match cause {
        super::authority::AuthorityMissing::KeyMissingWhileBound => {
            super::loop_control::FailureClass::DeviceKeyMissing
        }
        _ => super::loop_control::FailureClass::IdentityLocked,
    }
}

async fn person_token_bytes(
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Option<Vec<u8>> {
    let path = super::person_auth::person_auth_path_for_read(host).ok()?;
    let auth = super::person_auth::read_person_auth(io, &path)
        .await
        .ok()??;
    if auth.token_hex.is_empty() {
        return None;
    }
    // One lowercase-hex contract (audit T6.10(c)); a hand-rolled copy here was
    // the third one in the crate.
    let out = protocol::hex::decode_lower_vec(&auth.token_hex)?;
    (!out.is_empty()).then_some(out)
}

/// The person session's 16-byte device id (myne-md/myne#911 task 8).
///
/// A person-born vault has no enrolment record, so this is the only device actor
/// its heads can be authored under. Read per cycle for the same reason the token
/// is: re-enrolment rotates it, and a cached copy would outlive the credential it
/// names. `None` on an absent file or an unparseable id, which parks the cycle
/// rather than authoring a head under a made-up actor.
///
/// **Why not [`super::device_actor::durable_device_id`], which reads this same record
/// first?** Because the version vector is the PERSON plane's statement, signed with the
/// person session's token, so it names the person credential's device and nothing else.
/// The merged reader answers with the vault's enrolled id when one exists, and swapping
/// a long-lived version vector's device id mid-life would present this device to the
/// server as a new one (the same class of change `state.rs` refuses for the actor). The
/// READ still lives in `device_actor`, so anything about how the credential is parsed or
/// where it lives is decided in one place.
async fn person_device_id(
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Option<[u8; 16]> {
    super::device_actor::from_person_auth(host, io).await
}

/// The contentless "re-read it" events a finished cycle owes the WebView, one per
/// store whose only reader re-reads the blob over IPC (myne#943).
///
/// A pure function of the summary, called from the cycle tail, because that tail
/// is not reachable from a test: it sits in the `Ok(summary)` arm of a real
/// cycle, which needs a live server, an enrolment and an unlocked vault before it
/// can be reached at all. Deciding WHICH stores owe a signal is the whole content
/// of that step, so it is the part that can be asserted, and a sibling store
/// added later joins this table rather than a fifth shape in the tail.
///
/// **Only stores with no other refresh route belong here.** `vault.prefs` keeps
/// its emit inline: that arm awaits a blob re-read and persists the durable
/// `vault.label` before it emits, so it is IO rather than a gate on the summary.
fn remote_apply_events(summary: &super::orchestrator::SyncSummary) -> Vec<&'static str> {
    let mut events = Vec::new();
    if summary.themes_applied_remote {
        // A peer's `vault.themes` change was merged onto disk. The Appearance
        // panel's list reads the store once and then subscribes to the store
        // nonce, so without this an open panel keeps advertising the pre-sync set
        // until it is remounted. (`vault.prefs.custom_theme` is a DeviceLocal
        // field, so it cannot arrive from a peer: what the refresh exposes is a
        // store the panel no longer agrees with, not a pref that just landed.)
        events.push(crate::plugins::themes::commands::THEMES_CHANGED_EVENT);
    }
    events
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
    let mut gate = if !allow_push {
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
    let mut st = match super::state::read_sync_state(io, &dir).await {
        Ok(st) => st,
        Err(_) => {
            tracing::error!(
                stage = "read_sync_state",
                "sync-state.json unreadable; cycle refused (this is NOT the pre-enrolment path)"
            );
            return CycleOutcome::Failed(super::loop_control::FailureClass::Other);
        }
    };
    // Publishing is automatic (myne-md/myne#974), and this is the only place it
    // happens: the first cycle that has an endpoint, a registered identity and a
    // person session publishes the vault, so "is this vault on my server" no longer
    // depends on the user finding a control in Settings. `publish_if_due` answers
    // "not due" for every missing precondition, so this arm is silent on a legacy
    // vault, on an unpublished vault with no endpoint, and on a device whose
    // identity is locked or was never registered.
    //
    // **`allow_push` is what keeps this off the ambient tick.** A poll cycle is
    // pull-only, and a vault must not be uploaded because thirty seconds passed:
    // the preconditions were supplied by user acts (connecting a server,
    // registering the identity, connecting a device) and the acts themselves ask
    // (`person_register_with_path` publishes the moment the identity registers),
    // while a PUSH cycle is one the user caused by editing, by pressing Sync now or
    // by opening a verify screen. Without the gate a device left running with a
    // configured server would publish an hour after the user last touched it, which
    // is exactly the ambient behaviour this feature was told not to have.
    //
    // The re-read is what carries the namespace into the resolution below, and it is
    // a read rather than an assumption because `publish_vault` is the writer: the
    // namespace, the meta baseline and the timestamp land in one state write, and
    // duplicating that here would be a second opinion about the same record.
    let st = if st.namespace_hex.is_none() && allow_push {
        match super::publish::publish_if_due(host, io, &dir).await {
            Ok(Some(outcome)) => match super::state::read_sync_state(io, &dir).await {
                Ok(fresh) => fresh,
                Err(_) => {
                    // The publish DID land; only the read-back failed. Falling back
                    // to the pre-publish state would hide the namespace and make the
                    // next tick publish again, so the outcome is carried instead.
                    tracing::warn!(
                        stage = "publish_if_due",
                        "published, but sync-state.json could not be re-read; \
                         carrying the outcome's namespace"
                    );
                    let mut carried = st;
                    carried.namespace_hex = Some(outcome.namespace_hex.clone());
                    carried
                }
            },
            Ok(None) => st,
            Err(e) => {
                tracing::warn!(
                    stage = "publish_if_due",
                    error = ?e,
                    "an unpublished person-born vault could not be published"
                );
                st
            }
        }
    } else {
        // Already published: the only thing left is the REPAIR case, which nothing
        // local can see. The server may have lost the vault (an account reset, a
        // restored server), leaving every scoped request addressing a namespace it
        // has never heard of, with no control left to press now that publishing is
        // automatic. `repair_if_unbound` asks the account's binding list and
        // re-publishes only when this vault is missing from it. Gated on
        // `allow_push` and stamped on disk, so the poll path does not pay a request
        // per tick, and neither does a verification screen calling `sync_now` once a
        // second.
        if allow_push {
            match super::publish::repair_if_unbound(host, io, &dir).await {
                Ok(Some(outcome)) => {
                    st = match super::state::read_sync_state(io, &dir).await {
                        Ok(fresh) => fresh,
                        Err(_) => {
                            let mut carried = st;
                            carried.namespace_hex = Some(outcome.namespace_hex.clone());
                            carried
                        }
                    };
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(
                        stage = "repair_if_unbound",
                        error = ?e,
                        "a published vault could not be re-published after a server-side loss"
                    );
                }
            }
        }
        st
    };
    // A PUBLISHED person-born vault (myne-md/myne#911 task 8). Its namespace is
    // `vault.meta`'s random binding and its credential is the person session, so
    // the request names the vault (`?account=`) and the recorded
    // `account_hash_hex` is the PERSON's id, deliberately not the namespace.
    // Absent on every pre-existing vault: there the credential names the
    // namespace and nothing below changes.
    //
    // Only a person-born vault ever records one (`publish_vault` says why), so
    // its presence here can stand in for the generation: a legacy vault that has
    // been enrolled must NOT take the branch below.
    //
    // The record is a CACHE and the frame is the authority (myne-md/myne#911
    // review): `sync-state.json` is evictable device-local state, so losing it
    // used to leave a vault that opens, lists and then parks at `NotReady`
    // forever with nothing saying why. §9.3 offset 6 carries the same value in
    // `vault.meta`, so an absent record is read from there.
    let published_namespace = match st.namespace_hex.as_deref().and_then(hex16) {
        Some(namespace) => Some(namespace),
        None => {
            // **Only a person-wrapped frame answers here.** A legacy vault's
            // offset-6 bytes are its account hash, which its own credential already
            // names; reading those as a namespace would switch an enrolled legacy
            // vault onto a credential it does not have.
            let root =
                crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
                    .ok();
            match root {
                Some(root) => {
                    crate::plugins::sync::person_discovery::person_frame_namespace(io, &root).await
                }
                None => None,
            }
        }
    };
    // The cycle's identity: the namespace it addresses and the device actor it
    // authors heads under.
    let (account_hash, device_id) = match published_namespace {
        Some(namespace) => {
            // A person-born vault has no enrolment record at all. Creation writes
            // neither an account hash nor a device id, because there is no vault
            // account to enrol on; the namespace stands in for the account, and
            // the person session is the only place a device id exists. Without a
            // session the cycle parks exactly as a still-pending device does,
            // because nothing it could do would fix that.
            let Some(device_id) = person_device_id(io, host).await else {
                return CycleOutcome::NotReady;
            };
            (namespace, device_id)
        }
        None => {
            let (Some(acct_hex), Some(dev_hex)) =
                (st.account_hash_hex.clone(), st.device_id_hex.clone())
            else {
                return CycleOutcome::NotReady; // not enrolled
            };
            let (Some(account_hash), Some(device_id)) = (hex16(&acct_hex), hex16(&dev_hex)) else {
                return CycleOutcome::Failed(super::loop_control::FailureClass::Other);
            };
            (account_hash, device_id)
        }
    };
    let published_ns_hex: Option<String> =
        published_namespace.map(|ns| protocol::hex::encode_lower(&ns));
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
    let expected_identity = published_namespace.unwrap_or(account_hash);
    let (meta_version, account_number_hash) =
        match cycle_account_number_hash(io, &dir, &expected_identity).await {
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
    let token = match published_namespace {
        // No vault account exists to claim a token against, so the person token
        // is the only credential; without a session the cycle parks exactly as a
        // pending device does, because nothing it can do would fix that.
        Some(_) => match person_token_bytes(io, host).await {
            Some(t) => t,
            None => return CycleOutcome::NotReady,
        },
        None => match super::token_store::default_store().read(io, &dir).await {
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
    // Cloned for the conflict repair below: `dir` moves into the blocking closure.
    let dir_for_bindings = dir.clone();
    // The vault this cycle was started for. The repair below writes AFTER the whole cycle
    // has run, so it re-reads the id and declines when the user has locked this vault and
    // opened another in that window: the row's group key comes from the SESSION and its
    // account hash from THIS vault's `vault.meta`, so a mismatch would seal this vault's
    // store under another vault's key and every later read would refuse the file.
    let cycle_vault_id = state.active_vault_id().await;
    // Snapshot the live-session note ids BEFORE the `'static` closure (task 7):
    // the registry itself cannot cross that boundary, but a plain `HashSet` can.
    let live_note_ids = live_registry.live_note_blob_ids();
    // `items_key`/`items_key_id` are needed both by the cycle (as `AttachmentKeys`,
    // which move into the `'static` closure) and by the post-cycle merge of a
    // deferred live pull, so the merge keeps its own clone of the key.
    let live_merge_keys = (items_key.clone(), items_key_id);

    // The head authority for a vault that carries the B2B tail: the context to sign with,
    // and the cause when this device cannot. Built before the blocking closure so the person
    // keypair, the roster and the binding store are gathered on the executor, not the blocking
    // thread. A vault with no tail keeps the `NTV5` HMAC head and resolves to `no_context`
    // here, which the guard never consults because it only fires on a tail-carrying vault.
    let authority = signed_head_ctx(host, io, &dir, state, &shared, is_owner).await;
    // Why this cycle could not upload, when it could not (myne-md/myne#1027). Declared here so
    // the ReadOnly arm can record it and the success arm can carry it back on the summary: the
    // arm already LOGGED this and then dropped it, which is how a device that uploaded nothing
    // for a day reported `Ran` with no caveat and the UI printed "Synced".
    let mut upload_blocked: Option<&'static str> = None;
    // An `NTV6` vault's head is signature-authenticated. If no person identity is
    // held, the cycle must NOT silently fall back to the `NTV5` HMAC: that
    // authors a `0x01` head the `0x02` server refuses and wedges sync until the
    // user runs the person unlock. Refuse loudly instead of downgrading.
    {
        // BOTH B2B generations, not just the first one: a head that a roster
        // vouches for is what an `NTV7` vault needs exactly as much as an `NTV6`
        // one, and checking one magic would let the newer generation author the
        // downgraded head this guard exists to refuse (myne-md/myne#911 task 8).
        let needs_signed_head = match io.read(&dir.join("vault.meta")).await {
            // Through the classifier, not a magic list: `NTV8` carries the same tail and
            // needs the same refusal, and a list that named only the older two let the
            // newest generation author the downgraded head this guard exists to prevent.
            Ok(b) => super::meta_kind::carries_b2b_tail(&b),
            // An ABSENT meta is not a B2B vault, and that is the only read failure
            // that means so. Collapsing every error into `false` was a default-on-
            // error feeding a write: a transient IO failure made an `NTV7` vault look
            // single-user, and the cycle then authored a `0x01` HMAC head the server
            // refuses, wedging sync in exactly the shape this guard exists to prevent.
            // An unreadable meta is a failure to classify, so the cycle stops and says
            // so rather than guessing a generation.
            Err(crate::io_failure_kind::IoFailureKind::NotFound) => false,
            Err(err) => {
                tracing::warn!(
                    stage = "sync_cycle",
                    event = "vault_meta_unreadable",
                    reason = ?err,
                    "cannot classify the vault generation, so the cycle will not author a head"
                );
                return CycleOutcome::Failed(super::loop_control::FailureClass::Other);
            }
        };
        let verdict = head_authority_verdict(needs_signed_head, &authority);
        // One line per CHANGE of the answer to "may this device sign right now", at every
        // verdict including `Author` (myne-md/myne#1033). The two refusals already warn, but
        // nothing said when the state RECOVERED, so a repair that worked and a repaired screen
        // that never refreshed looked identical, and the log could not answer which had
        // happened.
        note_authority_verdict(
            verdict,
            // `Author` has no missing cause, and `missing()` would answer one anyway (on a
            // device-key device it reports `NoPersonSession`, which is not a fault at all). A
            // recovery line reading `verdict=author cause=no_person_session` is the same class of
            // lie as the stuck status this branch fixes (review of myne-md/myne#1033).
            (verdict != HeadAuthorityVerdict::Author).then(|| authority.missing()),
        );
        if verdict != HeadAuthorityVerdict::Author {
            // The cause comes from `sync::authority`, which is the only place that knows
            // which half is missing (myne-md/myne#983). The class is derived from whether
            // opening the identity would FIX it, not from whether an identity happens to be
            // held: a vault whose row publishes a key nothing can load reported
            // `identity_locked` for exactly as long as the two were conflated, and the
            // sentence sent the user to a fix that only sometimes applied.
            let cause = authority.missing();
            match verdict {
                HeadAuthorityVerdict::ReadOnly => {
                    tracing::warn!(
                        stage = "sync_cycle",
                        event = "b2b_head_authority_missing",
                        cause = cause.as_str(),
                        person_identity_held = authority.person_held,
                        identity_unlock_would_fix = cause.identity_unlock_would_fix(),
                        "this device cannot sign the vault head; running a pull-only cycle to \
                         fetch the state that would let it"
                    );
                    gate = super::orchestrator::PushGate::PollOnly;
                    upload_blocked = blocked_token(cause);
                }
                HeadAuthorityVerdict::Refuse => {
                    let class = class_for_missing_authority(cause, authority.person_held);
                    tracing::warn!(
                        stage = "sync_cycle",
                        event = "b2b_head_authority_missing",
                        cause = cause.as_str(),
                        person_identity_held = authority.person_held,
                        identity_unlock_would_fix = cause.identity_unlock_would_fix(),
                        "this device has no head context at all; refusing to run the cycle"
                    );
                    return CycleOutcome::Failed(class);
                }
                HeadAuthorityVerdict::Author => {}
            }
        }
    }

    let res = crate::task::run_blocking_future(move || async move {
        // A transport that cannot even be built is a Transport-class failure
        // (same retry posture as an unreachable socket).
        let transport = super::http_transport::build_transport(&url).map_err(|e| {
            super::orchestrator::SyncCycleError::Pull(super::engine::PullError::Transport(e))
        })?;
        // A published person vault names itself on every sync request; the
        // wrapper rewrites only `/sync/*` and `/vault.meta`, so the SCRAM and
        // attachment paths are untouched (see `NamespacedTransport`).
        let scoped_transport = published_ns_hex
            .as_deref()
            .map(|ns| super::transport::NamespacedTransport::new(transport.as_ref(), ns));
        let transport_ref: &dyn super::transport::SyncTransport = match &scoped_transport {
            Some(t) => t,
            None => transport.as_ref(),
        };
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
            transport_ref,
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
            authority.ctx.as_ref(),
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
            // A REFUSED device-binding merge is repaired here, once, because this is the
            // only frame that can (myne-md/myne#976). The merge refuses the WHOLE map when
            // two copies bind one device to two people at the same version, so one such row
            // froze the store for every member on every later cycle, silently. The phase
            // cannot sign the repair (it holds no session); this boundary holds the session
            // and `write_mutex`, so it re-writes THIS device's own row at a strictly higher
            // version and the next cycle's ordinary merge resolves the pair.
            //
            // What this does NOT do, stated because the log line has to be narrower than
            // "fixed": it cannot stop a peer holding the group key from writing a row naming
            // someone else, and it does not make that row verify. Attribution stays
            // legibility rather than proof (§9.30.4). What it stops is a forged row ALSO
            // being a permanent denial of the store.
            repair_device_binding_conflict(
                host,
                io,
                state,
                &dir_for_bindings,
                &cycle_vault_id,
                &summary.device_bindings_conflict,
            )
            .await;
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
            for event in remote_apply_events(&summary) {
                host.emit(event, EventPayload::Unit);
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
            // The OTHER clock (myne-md/myne#1027): "last success" is reachability, and a
            // pull-only cycle stamps it, so a device that had uploaded nothing for a day still
            // reported a success two minutes old. This one moves only when something went UP.
            if pushed_anything(&summary) {
                super::state::record_upload_success(
                    io,
                    &vault_root_for_stamp,
                    host.now_unix_millis(),
                )
                .await;
            }
            let mut summary = summary;
            summary.upload_blocked = upload_blocked;
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
    // `vault.meta` has advanced past the epoch this device's member credential
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

/// The cause token a pull-only cycle publishes.
///
/// The class is asked as if no identity were held: `class_for_missing_authority` answers `Other`
/// whenever one IS held, on the reasoning that the user has nothing to do, which is true for the
/// retry ladder and useless as a sentence. What the UI needs is what is missing, and
/// `status_detail` is the one vocabulary every client already maps.
///
/// `Other` means no user action repairs it, and "Sync failed" would be a lie about a cycle that
/// just succeeded, so it becomes the neutral token instead.
///
/// Split out because this is the branch's headline production decision and a test cannot drive
/// `run_active_cycle_from_host` (it needs a host, a server and a live session). What a test at
/// this seam buys is the vocabulary: the mapping from a cause to the token a user reads. It does
/// not cover the assignment that publishes the token, and `0787` records that gap rather than
/// pretending the seam closes it.
fn blocked_token(cause: crate::plugins::sync::authority::AuthorityMissing) -> Option<&'static str> {
    Some(
        match class_for_missing_authority(cause, false).status_detail() {
            "sync_failed" => "uploads_blocked",
            detail => detail,
        },
    )
}

/// Whether a summary advanced anything on the server, which is what the upload clock records.
///
/// Split out with `blocked_token` for the same reason and with the same limit: the predicate is
/// proved, the `if` around it is not.
fn pushed_anything(summary: &super::orchestrator::SyncSummary) -> bool {
    summary.pushed > 0
        || summary.head_advanced
        || summary.attachments_pushed > 0
        || summary.tombstones_pushed > 0
}

/// The manual button's answer for a cycle that RAN.
///
/// Split out from the async shell so the rule is testable without a host, because the
/// shell had this wrong: it answered `Idle` for every `Ran` and dropped the verdict the
/// cycle had just computed, so one click of "Sync now" on a device that cannot sign
/// painted "Synced". That is the same collapse the function's own doc comment forbids,
/// reached through the one path the background loop does not cover (myne-md/myne#1027).
fn ran_status(
    upload_blocked: Option<&'static str>,
    last_upload_at: Option<u64>,
) -> super::status::SyncRuntimeStatus {
    match upload_blocked {
        Some(detail) => super::status::SyncRuntimeStatus::UploadsBlocked {
            detail: detail.into(),
            last_upload_at,
        },
        None => super::status::SyncRuntimeStatus::Idle,
    }
}

/// Read the two persisted clocks. One place, because both arms of the manual
/// button's answer need them and a second copy of the path resolution is a second
/// place to get the vault root wrong.
async fn read_clocks(
    host: &dyn HostCtx,
    io: &'static dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
) -> super::status::SyncClocks {
    let none = super::status::SyncClocks {
        last_success_at: None,
        last_upload_at: None,
    };
    let Ok(dir) = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
    else {
        return none;
    };
    match super::state::read_sync_state(io, &dir).await {
        // The STRUCT, not a positional pair: `SyncClocks`' own doc says the two Option<u64> are
        // kept together so a caller cannot pass one where the other belongs, and a tuple
        // undoes exactly that in the two call sites below (the upload clock would land in
        // `Error.last_success_at`, the staleness number a user reads).
        Ok(s) => super::status::SyncClocks {
            last_success_at: s.last_success_at_ms,
            last_upload_at: s.last_upload_at_ms,
        },
        Err(_) => none,
    }
}

/// Run one cycle NOW (the manual "Sync now" button) and report the resulting
/// status.
///
/// Moved here with the cycle (task 84) because the mapping from a
/// [`CycleOutcome`] to a status is a correctness rule rather than glue: a
/// `NotReady` outcome must NOT collapse into `Idle`. Reporting "Synced" for a
/// device that cannot sync is the exact dishonesty the status derivation exists
/// to prevent, and clicking "Sync now" on an unenrolled device would otherwise
/// flip the dot to green.
///
/// A `Ran` is `Idle` only when the cycle could upload. It used to mean "the cycle
/// ran, therefore all is well", which is how one click on a device that cannot
/// sign a head painted "Synced" over a day of dropped uploads (myne-md/myne#1027);
/// `ran_status` is the one place that decides, and `UploadsBlocked` carries the
/// cause.
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
            // A `Ran` that could not upload is NOT `Idle`: the cycle's own verdict travels
            // on the summary, and answering "Synced" here would hide the very state this
            // button has to be able to show (myne-md/myne#1027).
            let clocks = read_clocks(host, io, state).await;
            ran_status(summary.upload_blocked, clocks.last_upload_at)
        }
        CycleOutcome::Failed(class) => {
            // The manual button's answer carries the same clock the polled
            // status does, so a "Sync now" that fails does not blank out a
            // staleness warning the poll had already raised.
            SyncRuntimeStatus::Error {
                detail: class.status_detail().into(),
                last_success_at: read_clocks(host, io, state).await.last_success_at,
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

/// Repair a refused `vault.device-bindings` pair, from the one frame that can sign
/// (myne-md/myne#976).
///
/// **Why here and not in the phase.** `merge_device_bindings` refuses the WHOLE map when
/// two copies bind one device to two people at the same version, so a single such row froze
/// the store for every member on every later cycle, in silence. Ending it needs a SIGNED
/// write, and the phase is deliberately both `AppHandle`-free and session-free (it cannot
/// hold the person identity). The cycle boundary holds the session, the host and the
/// family's `write_mutex`, so the repair is a call, not a new mechanism.
///
/// **Only a pair this device is in.** `reclaim_self_in_dir` moves THIS device's key, so a
/// bump fixes a tie on its own row and does nothing at all to a tie between two other
/// members. Repairing the second case anyway would re-seal the whole map, never push it
/// (this path records no baseline) and log a repair that repaired nothing, every cycle,
/// with the row's version climbing. So the summary names the tied devices and the two cases
/// are told apart rather than assumed equal.
///
/// **What it does not do**, stated because the log line has to be narrower than "fixed": it
/// cannot stop a peer holding the group key from writing a row naming someone else, and it
/// does not make that row verify. Attribution stays legibility rather than proof
/// (`protocol.md` §9.30.4). It stops a forged row also being a permanent denial of the
/// store. Quarantining the row itself instead of refusing the map is the real fix and needs
/// a format generation (`0770` records it as the follow-up).
///
/// Native-only, and that is not a convenience: the whole repair signs with a person identity
/// the web client never has, and `device_binding::commands` does not exist on `wasm32`. The
/// call site stays unconditional so neither platform carries a `cfg` in the middle of the
/// cycle.
#[cfg(not(target_arch = "wasm32"))]
async fn repair_device_binding_conflict(
    host: &dyn HostCtx,
    io: &'static dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &std::path::Path,
    started_for: &Option<crate::vault_id::VaultId>,
    conflicts: &[String],
) {
    if conflicts.is_empty() {
        return;
    }
    if state.active_vault_id().await != *started_for {
        tracing::warn!(
            stage = "device_bindings",
            event = "conflict_vault_switched",
            conflicts = conflicts.len(),
            "the active vault changed while this cycle ran; the binding conflict is left to the next cycle rather than signed against a store this session no longer holds the key for"
        );
        return;
    }
    let own = match crate::plugins::device_binding::session_device_id(host, io, vault_dir).await {
        Ok(id) => protocol::hex::encode_lower(&id),
        Err(error) => {
            // A never-enrolled vault has no row to re-write, so this is the quiet case as
            // much as the loud one; either way the store stays as it was.
            tracing::warn!(
                stage = "device_bindings",
                event = "conflict_unrepairable",
                error = ?error,
                "no device id to re-write, so the binding conflict was not repaired on this device"
            );
            return;
        }
    };
    if !conflict_is_ours(conflicts, &own) {
        tracing::warn!(
            stage = "device_bindings",
            event = "conflict_not_ours",
            conflicts = conflicts.len(),
            "a device-binding pair this device is not party to was refused; re-writing this device's row cannot separate it, so nothing was written"
        );
        return;
    }
    match crate::plugins::device_binding::reclaim_own_binding_with_dir(host, io, state, vault_dir)
        .await
    {
        Ok(outcome) => tracing::info!(
            stage = "device_bindings",
            event = "conflict_reclaimed",
            outcome = ?outcome,
            "this device re-wrote its own binding row at a higher version; the next cycle's merge resolves the pair"
        ),
        Err(error) => tracing::warn!(
            stage = "device_bindings",
            event = "conflict_unrepaired",
            error = ?error,
            "the binding conflict could not be repaired on this device; the store stays frozen for now"
        ),
    }
}

/// Whether the refused pair includes THIS device, which is the only pair re-writing a row
/// can separate ([`repair_device_binding_conflict`] states why the other case writes
/// nothing).
///
/// An exact comparison, deliberately: `conflicts` holds the store's own map keys and
/// `own_hex` comes from [`protocol::hex::encode_lower`] over the same 16 bytes, so the two
/// are the same string by construction. A case-insensitive or prefix-shaped comparison here
/// would repair rows that are not in dispute.
fn conflict_is_ours(conflicts: &[String], own_hex: &str) -> bool {
    conflicts.iter().any(|device| device == own_hex)
}

/// The `wasm32` arm of [`repair_device_binding_conflict`]: a browser tab holds no person
/// identity and no device binding to re-write, so this is a decision rather than a gap.
#[cfg(target_arch = "wasm32")]
async fn repair_device_binding_conflict(
    _host: &dyn HostCtx,
    _io: &'static dyn crate::vault_io::VaultIo,
    _state: &VaultRuntimeState,
    _vault_dir: &std::path::Path,
    _started_for: &Option<crate::vault_id::VaultId>,
    _conflicts: &[String],
) {
}

#[cfg(test)]
mod tests {
    //! The AAD identity the cycle binds. Driven at [`cycle_account_number_hash`]
    //! rather than through `run_active_cycle_from_host`, because everything the
    //! rule is about — which file the hash comes from, and what happens when the
    //! two disagree — is decided here, and the rest of the gather is a host, a
    //! runtime slot and a live server.

    /// A pull-only cycle publishes a token, and the token is the sentence a user reads.
    ///
    /// **What this proves and what it does not.** It proves the VOCABULARY: which cause becomes
    /// which token, including the `sync_failed` rewrite that exists because "Sync failed" would
    /// slander a cycle that just succeeded. It does NOT prove the assignment that publishes it,
    /// because that sits inside a cycle that needs a host, a server and a live session, and
    /// deleting the assignment together with the `mut` it needs compiles and leaves this test
    /// green. Measured rather than assumed: that injection was run. The missing call-site test is
    /// a named residual in `decisions/sync/0787`, not a claim this comment makes.
    #[test]
    fn a_pull_only_cycle_names_what_is_missing() {
        use super::blocked_token;
        use crate::plugins::sync::authority::AuthorityMissing;

        assert_eq!(
            blocked_token(AuthorityMissing::KeyMissingWhileBound),
            Some("device_key_missing"),
            "a key this device published and no longer holds is the repairable cause"
        );
        assert_eq!(
            blocked_token(AuthorityMissing::NoPersonSession),
            Some("identity_locked"),
            "no session and no key is the cause the identity phrase fixes"
        );
        assert_eq!(
            blocked_token(AuthorityMissing::KeyUnreadable),
            Some("uploads_blocked"),
            "a store fault is the neutral token, because 'Sync failed' would slander a cycle \
             that just succeeded"
        );
    }

    /// Only a summary that actually advanced something stamps the upload clock.
    ///
    /// The predicate is proved here; its CALL SITE is not, for the same reason as above (the same
    /// undrivable cycle). Deleting the `if` leaves `last_upload_at` absent for ever with every
    /// test green, which was measured. `0787` carries it as a residual rather than this comment
    /// claiming a deletion test it does not have.
    #[test]
    fn only_a_pushing_cycle_counts_as_an_upload() {
        use super::pushed_anything;
        use crate::plugins::sync::orchestrator::SyncSummary;

        assert!(
            !pushed_anything(&SyncSummary::default()),
            "a cycle that moved nothing is not an upload, which is the whole defect: idle and \
             unreachable-for-uploads looked identical"
        );
        assert!(
            pushed_anything(&SyncSummary {
                pushed: 1,
                ..Default::default()
            }),
            "a pushed note is an upload"
        );
        assert!(
            pushed_anything(&SyncSummary {
                head_advanced: true,
                ..Default::default()
            }),
            "a head that moved is an upload even with no blob of its own"
        );
        assert!(
            pushed_anything(&SyncSummary {
                attachments_pushed: 1,
                ..Default::default()
            }),
            "an attachment is an upload"
        );
        assert!(
            !pushed_anything(&SyncSummary {
                pulled: 7,
                ..Default::default()
            }),
            "a pure pull is NOT an upload, which is why this clock is separate from last_success_at"
        );
    }

    /// The manual "Sync now" button must not answer `Idle` for a cycle that could not upload.
    ///
    /// The exact regression: `sync_now_from_host` matched `Ran(_)` and returned `Idle`
    /// unconditionally, so the verdict the cycle had just computed was dropped on the one path
    /// the background loop does not cover, and a click on a blocked device painted "Synced".
    /// Removing the `upload_blocked` arm below compiles and leaves every other test green.
    #[test]
    fn a_manual_sync_that_cannot_upload_is_not_idle() {
        use super::ran_status;
        use crate::plugins::sync::status::SyncRuntimeStatus;

        assert_eq!(
            ran_status(None, Some(1)),
            SyncRuntimeStatus::Idle,
            "a clean cycle is still Idle, and carries no blocked cause"
        );
        match ran_status(Some("device_key_missing"), Some(1_700_000_000_000)) {
            SyncRuntimeStatus::UploadsBlocked {
                detail,
                last_upload_at,
            } => {
                assert_eq!(detail, "device_key_missing");
                assert_eq!(
                    last_upload_at,
                    Some(1_700_000_000_000),
                    "the blocked answer carries the upload clock, which is the whole reason \
                     the state exists"
                );
            }
            other => {
                panic!("a Ran cycle that could not upload answered {other:?}, not UploadsBlocked")
            }
        }
    }

    /// The failure class a missing authority becomes, asserted for the four shapes that matter.
    ///
    /// The regression this guards is exact: `KeyMissingWhileBound` used to fold into
    /// `IdentityLocked`, so the app said "unlock your identity" for a vault whose PUBLISHED key
    /// was gone, and typing the phrase helped for one session (myne-md/myne#983). A future edit
    /// that collapses the two again compiles and passes every other test in the crate.
    #[test]
    fn a_missing_authority_maps_to_one_failure_class() {
        use super::class_for_missing_authority;
        use crate::plugins::sync::authority::AuthorityMissing;
        use crate::plugins::sync::loop_control::FailureClass;

        assert_eq!(
            class_for_missing_authority(AuthorityMissing::KeyMissingWhileBound, false),
            FailureClass::DeviceKeyMissing,
            "a key this device published and no longer holds is its own class"
        );
        assert_eq!(
            class_for_missing_authority(AuthorityMissing::NoPersonSession, false),
            FailureClass::IdentityLocked,
            "no session and no key is the one cause the identity phrase fixes"
        );
        assert_eq!(
            class_for_missing_authority(AuthorityMissing::KeyUnreadable, false),
            FailureClass::Other,
            "a store fault is not something the user's identity entry repairs"
        );
        assert_eq!(
            class_for_missing_authority(AuthorityMissing::KeyMissingWhileBound, true),
            FailureClass::Other,
            "with the person held, opening the identity again is not the missing step"
        );
    }

    use super::*;

    /// A peer's `vault.themes` merge must reach the WebView (myne#943).
    ///
    /// The shipped bug is a silent one, which is why the assertion is on the event
    /// rather than on any return value: the blob merged on disk, the palette came
    /// out right, and the open Appearance panel went on listing the pre-sync set.
    /// Nothing failed anywhere and a surface simply did not change, so the emit is
    /// the only thing whose absence is observable.
    ///
    /// This asserts the decision, not the loop that publishes it: the call site is
    /// in the `Ok(summary)` arm of a real cycle and no test reaches it, which is
    /// recorded on myne-md/myne#943 rather than left to read as covered.
    #[test]
    fn a_remote_theme_apply_owes_the_themes_changed_event() {
        use crate::plugins::themes::commands::THEMES_CHANGED_EVENT;

        assert_eq!(
            remote_apply_events(&super::super::orchestrator::SyncSummary {
                themes_applied_remote: true,
                ..Default::default()
            }),
            vec![THEMES_CHANGED_EVENT],
            "a peer's theme store change is announced to the WebView"
        );
    }

    /// The other direction, and it is the one a wrong gate breaks: a cycle that
    /// applied nothing from a peer must owe no event, or every ordinary sync would
    /// re-read the theme store (and, on the paint path, re-apply the palette) for
    /// no change at all.
    #[test]
    fn a_cycle_with_no_remote_apply_owes_no_event() {
        assert!(
            remote_apply_events(&super::super::orchestrator::SyncSummary::default()).is_empty()
        );
    }

    /// The party-ness gate on the binding repair, tested for the ONE mistake that would
    /// make it dangerous rather than merely useless: matching a device that is not the
    /// one in the pair. `conflicts` holds the store's 32-char lowercase map keys and
    /// `own_hex` is `encode_lower` over the same 16 bytes, so the two agree exactly; a
    /// prefix, substring or case-insensitive comparison here would have the cycle re-sign
    /// a row nothing is disputing, every cycle, and the pair would stay refused.
    #[test]
    fn a_conflict_is_ours_only_on_an_exact_device_id() {
        let mine = "00112233445566778899aabbccddeeff";
        // A second id that SHARES a prefix with mine: the fixture a `starts_with` arm would
        // answer `true` on, which is why the pair is spelled out rather than using one id.
        let neighbour = "00112233445566778899aabbccddee00";

        assert!(super::conflict_is_ours(&[mine.to_string()], mine));
        assert!(
            super::conflict_is_ours(&[neighbour.to_string(), mine.to_string()], mine),
            "my id is in the pair, whatever else is"
        );
        assert!(
            !super::conflict_is_ours(&[neighbour.to_string()], mine),
            "a device that merely shares a prefix with mine is not mine"
        );
        assert!(
            !super::conflict_is_ours(&[mine.to_uppercase()], mine),
            "the store's keys are lowercase hex and so is `encode_lower`; a case-different \
             string is a different key, not the same one spelled differently"
        );
        assert!(
            !super::conflict_is_ours(&[], mine),
            "no conflict must never read as one on this device"
        );
    }
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

    /// `myne-md/myne#1000`'s three answers, asserted where they are decided.
    ///
    /// The defect was one boolean: a device that could not SIGN was refused a cycle, and the
    /// pull that would have given it the state to sign with never ran. The middle arm is the
    /// fix, and it is the one a future edit collapses by accident: `can_read` and `can_author`
    /// differ only for a context built without the roster, so an edit that asks the louder
    /// question here restores the deadlock while every other test in the crate stays green.
    #[test]
    fn a_cycle_reads_what_it_cannot_sign_and_refuses_only_without_a_context() {
        use super::{head_authority_verdict, HeadAuthority, HeadAuthorityVerdict};
        use protocol::PersonKeyPair;

        // No context at all: nothing can be verified, so the cycle must not run.
        assert_eq!(
            head_authority_verdict(true, &HeadAuthority::no_context(true)),
            HeadAuthorityVerdict::Refuse,
            "without a head context not even a signature can be checked"
        );

        // A context that reads but cannot sign: the joined device's state.
        let account = [0x61u8; 16];
        let owner = PersonKeyPair::generate_raw(&[0x71; 64], &[0x72; 32], &[0x73; 32]);
        let reader =
            HeadAuthority::person_reader(Some(owner.clone()), account, owner.public_half(), true);
        assert!(
            !reader.can_author(),
            "the fixture must be the state the arm exists for"
        );
        assert_eq!(
            head_authority_verdict(true, &reader),
            HeadAuthorityVerdict::ReadOnly,
            "a device that cannot sign still pulls the state that lets it"
        );

        // And the ordinary vault, where the whole block is skipped.
        let authoring = HeadAuthority {
            ctx: Some(super::super::head_authority::SignedHeadCtx::new(
                Some(owner.clone()),
                account,
                vec![owner.public_half()],
            )),
            device: super::super::authority::DeviceResolution::Unbound {
                cause: super::super::authority::AuthorityMissing::NoHeadContext,
                signers: Vec::new(),
            },
            person_held: true,
        };
        assert_eq!(
            head_authority_verdict(true, &authoring),
            HeadAuthorityVerdict::Author
        );
        assert_eq!(
            head_authority_verdict(false, &reader),
            HeadAuthorityVerdict::Author,
            "an NTV5 vault needs no signed head, so the authority is never consulted"
        );
    }
}
