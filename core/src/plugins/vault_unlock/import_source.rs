// SPDX-License-Identifier: AGPL-3.0
//! Opening a SOURCE vault for reading, while a different vault stays unlocked.
//!
//! This is the key-lifetime half of vault import (myne-md/myne#464). The
//! commands that use it are registered under the desktop `importer:` plugin
//! namespace, not under `vault-unlock:`, so the whole feature inherits the web
//! dispatcher's single `Class::Unsupported` row for that plugin and neither the
//! web nor the mobile client grows a command surface. The core lives HERE
//! because it reuses this plugin's derivation steps verbatim rather than
//! re-deriving keys a second way, which is the discipline
//! `protocol/AGENTS.md` states for subkeys and which applies just as much to
//! the wrap-open path above them.
//!
//! ## Why this is not an unlock
//!
//! SYNC-1's invariant is **at most one `Slot::Unlocked`**, not at most one
//! key-holding entry. [`super::state::Slot::ImportSource`] is the second
//! key-holding state, exactly as `Slot::Recovering` is the first, and the slot
//! map has always been documented as permitting one `Unlocked` and one
//! other-state entry for distinct `VaultId`s side by side. Editor commands
//! pattern-match `Slot::Unlocked(uv)`, so nothing here can be mistaken for an
//! unlocked vault; the compiler made that concrete when the variant landed, by
//! failing twenty exhaustive matches that each had to say what they do with it.
//!
//! ## Why the TTL is not the auto-lock timer
//!
//! `import_set_hold` (myne-md/myne#223) DEFERS idle auto-lock for the length of
//! an import. So during exactly the window when a second vault's key material
//! is resident, the reclaimer that would otherwise drop it is switched off. A
//! hung or abandoned import would leave both vaults resident indefinitely.
//! [`super::state::VaultRuntimeState::take_import_source_if_expired`] is the
//! independent bound that closes that, and `threat-model.md` A6 states the
//! window it leaves.
//!
//! ## Credential
//!
//! Master password or recovery phrase. The phrase path reuses
//! `vault_recover`'s derivation but lands here rather than in
//! `Slot::Recovering`, which means it grants READ access without committing a
//! new password. That is a stated exception to `recovery-flow.md` §4.3's
//! soft-unlock rule and is argued in its own decision entry: §4.3 bans a
//! session that grants EDITOR access without a password commit, and this grants
//! none. The alternative, sending the user through recovery first, makes the
//! price of reading an archived vault a write to it.

use crate::host::HostCtx;
use crate::plugins::vault_unlock::error::VaultUnlockError;
use crate::plugins::vault_unlock::state::{
    ImportSourceMaterial, ImportSourceRefused, Slot, SlotKind, VaultRuntimeState,
};
use crate::vault_id::VaultId;
use crate::vault_io::VaultIo;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// Which credential the caller is presenting for the source vault.
///
/// Modelled as a closed enum rather than two commands so the slot-peek, the
/// permit acquire and the `vault.meta` read are written once. The two arms
/// differ only in which wrap they open.
pub enum SourceCredential {
    Password(Zeroizing<String>),
    /// The 24 words as the user typed them. Normalisation is
    /// `protocol::normalize_user_phrase`'s job, inside the derivation.
    RecoveryPhrase(Zeroizing<String>),
}

impl SourceCredential {
    /// Build from the raw IPC pair, wrapping on the way in.
    ///
    /// `src-tauri/AGENTS.md`'s Zeroizing pattern says the wrap happens on the
    /// first non-doc statement, and names exactly the paths that make it
    /// matter: "Every early-return path (slot guard, permit guard, IO failure,
    /// parse failure) drops the wrapper and zeroes the bytes." `open()` has
    /// five such returns before it reaches a derivation, so a plain `String`
    /// here means a master password or a 24-word recovery phrase dropping
    /// unwiped on any of them.
    ///
    /// Exactly one of the two, and both-or-neither is refused rather than
    /// resolved: guessing which one the caller meant is how a phrase gets
    /// Argon2id'd under the password's salt domain.
    pub fn from_ipc(password: Option<String>, recovery_phrase: Option<String>) -> Option<Self> {
        match (password, recovery_phrase) {
            (Some(p), None) => Some(Self::Password(Zeroizing::new(p))),
            (None, Some(phrase)) => Some(Self::RecoveryPhrase(Zeroizing::new(phrase))),
            _ => None,
        }
    }
}

/// Open `source_id` as a read-only import source.
///
/// Refuses when the vault is the one already unlocked, when its slot is
/// occupied by anything, and when another Argon2id-bound auth operation holds
/// the shared permit. On success the slot holds `root_key` + `items_key` until
/// [`close`] takes it, the TTL sweep drops it, or vault teardown drops it.
pub async fn open(
    source_id: VaultId,
    credential: SourceCredential,
    state: &VaultRuntimeState,
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<(), VaultUnlockError> {
    let vault_root = crate::paths::vault_root_for_id_from_host(host, source_id).map_err(|_| {
        tracing::error!(
            stage = "resolve_root",
            error_kind = "VaultNotFound",
            "could not resolve the source vault's root directory"
        );
        VaultUnlockError::VaultNotFound
    })?;
    open_at_root(source_id, vault_root, credential, state, host, io).await
}

/// Open a source vault at an EXPLICIT root (myne-md/myne#816). The local-vault
/// path resolves `vaults/<id>/` in [`open`] above; a `.myne-backup` import
/// passes the temporary directory its container members were extracted into.
/// Everything else (the slot guards, the permit, the meta read, the
/// derivation, the population) is identical, which is the point of the split:
/// a backup source is read through exactly the same path as a local one.
pub async fn open_at_root(
    source_id: VaultId,
    vault_root: PathBuf,
    credential: SourceCredential,
    state: &VaultRuntimeState,
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<(), VaultUnlockError> {
    // A target vault MUST be unlocked, and this runs before every other guard.
    //
    // The window this closes is the one A6's amendment does not describe. With
    // no target, `is_vault_switch(None, target)` is false, so the `close_all`
    // on the unlock path had nothing to fire against and the slot survived into
    // the first unlock: a second vault's keys resident across a session
    // boundary, bounded only by the 30-minute TTL, when the amendment says "no
    // longer than the target vault's own session". `reseal_attachment` also
    // resolves its destination from `active_vault_id()` at call time, so a
    // source opened before any unlock has no destination and would acquire one
    // the user never named. That call site's comment already says this is the
    // hazard `close_all` exists to prevent; the precondition is the other half.
    //
    // Belt and braces with the unconditional `close_all` in `unlock_from_host`:
    // this refuses the state and that one clears it. Either alone leaves a
    // path, and the review that found this named both.
    //
    // WHAT THIS PAIR DOES NOT CLOSE, stated because the sentence above reads
    // stronger than it is. This check reads a SPECIFIC `active_vault_id()`, and
    // the write guard inside `set_import_source` asserts only that SOME vault
    // is unlocked. The two are not the same claim: the derivation below spends
    // a `read_meta` and a 256 MiB Argon2id between them holding no lock, so a
    // target that changed underneath in that window satisfies the write guard.
    // What actually closes it is the capacity-1 auth permit, which is held
    // across the whole derivation and which `unlock_with_path` `try_acquire`s,
    // so no unlock can land inside the window at all. That is a discipline in a
    // different module rather than a property of these two lines, and it is
    // named here so a later change to the permit does not silently take this
    // guarantee with it.
    let active = state.active_vault_id().await;
    if active.is_none() {
        tracing::error!(
            stage = "slot_check",
            error_kind = "NoActiveVaultToImportInto",
            "import source rejected: nothing is unlocked to import into"
        );
        return Err(VaultUnlockError::NoActiveVaultToImportInto);
    }

    // The source may not be the vault we are importing INTO. Not a paranoid
    // check: the picker excludes it, so reaching here means the UI and the host
    // disagree, and importing a vault into itself would rename every note
    // against its own titles.
    if active == Some(source_id) {
        tracing::error!(
            stage = "slot_check",
            error_kind = "VaultAlreadyUnlocked",
            "import source rejected: that vault is the one currently unlocked"
        );
        return Err(VaultUnlockError::VaultAlreadyUnlocked);
    }

    // Slot peek before the permit acquire, so an occupied slot never waits on
    // the semaphore. Same ordering, and the same reason, as `unlock_with_path`.
    match state.slot_kind(source_id).await {
        SlotKind::Empty => {}
        SlotKind::Unlocked => return Err(VaultUnlockError::VaultAlreadyUnlocked),
        SlotKind::Recovering => return Err(VaultUnlockError::VaultRecoveryInProgress),
        SlotKind::ImportSource => {
            tracing::error!(
                stage = "slot_check",
                error_kind = "VaultOpenAsImportSource",
                "import source rejected: that vault is already open as an import source"
            );
            return Err(VaultUnlockError::VaultOpenAsImportSource);
        }
    }

    // `try_acquire`, never `acquire().await`. Queueing here would reintroduce
    // exactly what `decisions.md` 2026-05-02 removed: N clicks linearised into
    // N sequential Argon2id runs at m=256 MiB. The RAII guard releases on every
    // return path, and holding it across the derivation is what keeps the peak
    // at one Argon2id rather than two.
    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::error!(
                stage = "permit_acquire",
                error_kind = "UnlockInProgress",
                "import source rejected: another auth op in flight"
            );
            return Err(VaultUnlockError::UnlockInProgress);
        }
    };

    let meta_path = vault_root.join("vault.meta");

    let (meta_preview, meta_version, bytes) = read_meta(io, &meta_path).await?;

    let opened_at = host.monotonic_millis();

    let material = match credential {
        SourceCredential::Password(password) => {
            let keys = super::commands::derive_keys_from_meta_candidate(
                host,
                &meta_preview,
                bytes,
                password,
            )
            .await?;
            ImportSourceMaterial {
                root_key: keys.root_key,
                items_key: keys.items_key,
                items_key_id: keys.items_key_id,
                opened_at,
                vault_root: vault_root.clone(),
            }
        }
        SourceCredential::RecoveryPhrase(phrase) => {
            // Through `run_blocking`, like `recover_with_phrase_with_path` and
            // like the password arm above. Argon2id at m=256 MiB, t=3 on a
            // tokio worker starves every other task scheduled there for the
            // duration, including the auto-lock tick and in-flight note IO.
            let meta = meta_preview.clone();
            crate::task::run_blocking(move || {
                derive_from_phrase(&meta, meta_version, phrase, opened_at, vault_root)
            })
            .await
            .map_err(|_| VaultUnlockError::JoinFailure)??
        }
    };

    // Populate LAST, and the population is what CHECKS. Every failure above
    // returns with the slot untouched and the derived bytes dropped, so there
    // is no half-open state to clean up.
    //
    // The precondition read at the top of this function is an early, readable
    // refusal that saves a 256 MiB Argon2id; it is not the guarantee. Between
    // it and here sit `read_meta` and that derivation, with no lock held, so a
    // lock or an idle auto-lock landing in the window found no slot to clear
    // and this line then minted one into a locked process. `set_import_source`
    // re-checks under the write guard it inserts with, which makes the two one
    // operation; its doc carries the full reasoning and the second precondition
    // (at most one source open) that the same guard now enforces.
    match state.set_import_source(source_id, material).await {
        Ok(_) => {}
        Err(ImportSourceRefused::NoActiveVault) => {
            tracing::error!(
                stage = "slot_write",
                error_kind = "NoActiveVaultToImportInto",
                "import source refused at the write: the target vault was locked while this \
                 source was being opened"
            );
            return Err(VaultUnlockError::NoActiveVaultToImportInto);
        }
        Err(ImportSourceRefused::SourceAlreadyOpen) => {
            tracing::error!(
                stage = "slot_write",
                error_kind = "VaultOpenAsImportSource",
                "import source refused at the write: another vault is already open as a source"
            );
            return Err(VaultUnlockError::VaultOpenAsImportSource);
        }
    }

    tracing::info!(
        event = "import_source_opened",
        "a source vault was opened for reading; the target vault is unchanged"
    );
    Ok(())
}

/// Close the import slot for `source_id` and wipe its keys at a known program
/// point. Idempotent: closing a slot that is absent, or that holds any other
/// variant, is a no-op rather than an error, because the TTL sweep and vault
/// teardown can both have got there first and neither is a failure.
pub async fn close(source_id: VaultId, state: &VaultRuntimeState) {
    if let Some(material) = state.take_import_source(source_id).await {
        // Explicit drop rather than letting it fall out of scope, so the wipe
        // happens here and the tracing line below cannot be read as preceding
        // it.
        drop(material);
        tracing::info!(
            event = "import_source_closed",
            "the source vault's key material was dropped and zeroized"
        );
    }
}

/// Drop every import-source slot and wipe it. Called from vault teardown: a
/// source opened for reading has no reason to outlive the target vault's
/// session, and leaving it resident past a lock would put a second vault's keys
/// on the wrong side of the guarantee A6 rests on.
///
/// Also removes each source's staging directory when it lives under
/// `import-staging/` (myne-md/myne#827). Without this a backup import leaves its
/// ciphertext extraction on disk until a later open happens to sweep it (24h+),
/// or forever if none does. The path test is deliberate: a LOCAL vault source's
/// root is the user's real `vaults/<id>/`, which this must never delete.
pub async fn close_all(state: &VaultRuntimeState) {
    let dropped = state.drop_import_sources().await;
    if !dropped.is_empty() {
        let n = dropped.len();
        for slot in &dropped {
            if let Slot::ImportSource { vault_root, .. } = slot {
                remove_staging_for(vault_root);
            }
        }
        drop(dropped);
        tracing::info!(
            event = "import_sources_closed_on_teardown",
            count = n,
            "import source slots dropped and zeroized with the vault session"
        );
    }
}

/// Remove a backup source's extraction directory, identified by its
/// `…/import-staging/<id>/` shape. A local vault root fails the test and is left
/// alone. Best-effort: a failure is a swept-later directory, not a correctness
/// problem.
///
/// The `std::fs` is gated to native, the same way every other staging path is:
/// the importer is a desktop-only capability (the web client classifies the
/// whole `importer` plugin `Class::Unsupported`), so there is no browser arm to
/// port this to, and the wasm build must still compile the surrounding
/// `close_all` / `sweep_expired` (which the `#[cfg]` leaves as a no-op there).
#[cfg(not(target_arch = "wasm32"))]
fn remove_staging_for(vault_root: &std::path::Path) {
    let under_staging = vault_root
        .parent()
        .and_then(|p| p.file_name())
        .map(|name| name == "import-staging")
        .unwrap_or(false);
    if under_staging {
        let _ = std::fs::remove_dir_all(vault_root);
    }
}

/// Non-wasm no-op twin so the native-only call sites compile everywhere.
#[cfg(target_arch = "wasm32")]
fn remove_staging_for(_vault_root: &std::path::Path) {}

/// Sweep an expired import slot. Returns whether one was dropped, so a caller
/// driving this on a timer can log the transition rather than the tick. Like
/// `close_all`, it removes a backup source's staging directory as well.
pub async fn sweep_expired(
    state: &VaultRuntimeState,
    ttl: core::time::Duration,
    host: &dyn HostCtx,
) -> bool {
    let now = host.monotonic_millis();
    let dropped = state
        .take_import_source_if_expired(ttl, |opened_at| {
            core::time::Duration::from_millis(now.saturating_sub(opened_at))
        })
        .await;
    match dropped {
        Some(slot) => {
            if let Slot::ImportSource { vault_root, .. } = &slot {
                remove_staging_for(vault_root);
            }
            drop(slot);
            tracing::info!(
                event = "import_source_expired",
                "an import source outlived its TTL; its key material was dropped and zeroized"
            );
            true
        }
        None => false,
    }
}

/// The phrase arm, kept out of [`open`] so the two credential paths read as one
/// line each there. Reuses `vault_recover`'s derivation rather than repeating
/// it, and maps its error enum onto this one's: the recovery wrap and the
/// password wrap fail indistinguishably by design (`protocol.md` §7.3), so both
/// arms surface `InvalidCredentialOrVault`.
fn derive_from_phrase(
    meta: &protocol::VaultMeta,
    version: protocol::MetaVersion,
    phrase: Zeroizing<String>,
    opened_at: u64,
    vault_root: PathBuf,
) -> Result<ImportSourceMaterial, VaultUnlockError> {
    use crate::plugins::vault_recover::commands::{derive_items_key, derive_root_key_from_phrase};
    use crate::plugins::vault_recover::error::VaultRecoveryError;

    let map = |e: VaultRecoveryError| match e {
        VaultRecoveryError::InvalidCredentialOrVault => VaultUnlockError::InvalidCredentialOrVault,
        _ => VaultUnlockError::InvalidVaultMeta,
    };

    let root_key = derive_root_key_from_phrase(version, &phrase, meta).map_err(map)?;
    let items_key = derive_items_key(version, &root_key, meta).map_err(map)?;

    Ok(ImportSourceMaterial {
        root_key,
        items_key,
        items_key_id: meta.items_key_id,
        opened_at,
        vault_root,
    })
}

/// Read + parse the source vault's `vault.meta` through the IO seam.
///
/// Deliberately the plain single-copy read rather than
/// `crate::singleton::open_newest`'s staged-meta walk: a staged newer-generation
/// meta belongs to a MIGRATION of that vault, and adopting one here would be
/// this flow silently advancing a vault it has no business writing to. An
/// import reads; if the source needs migrating, its own unlock does that.
async fn read_meta(
    io: &dyn VaultIo,
    meta_path: &Path,
) -> Result<(protocol::VaultMeta, protocol::MetaVersion, Vec<u8>), VaultUnlockError> {
    let bytes = io.read(meta_path).await.map_err(|io_error_kind| {
        tracing::error!(
            stage = "read_meta",
            error_kind = "IoError",
            io_failure_kind = ?io_error_kind,
            "source vault.meta read failed"
        );
        VaultUnlockError::IoError { io_error_kind }
    })?;
    // The version byte decides which salt domain and AAD the phrase arm derives
    // under (`protocol.md` §3.4 registries; the v0.2 pair is a DIFFERENT domain,
    // not a variant of the v0.1 one). Defaulting to v0.1 matches what
    // `vault_recover` does at its own two read sites, so a meta this helper
    // cannot version-sniff fails at the AEAD tag rather than here.
    let meta_version = protocol::meta_version_of(&bytes).unwrap_or(protocol::MetaVersion::V0_1);
    let meta = protocol::parse_vault_meta_any(&bytes).map_err(|e| {
        tracing::error!(
            stage = "parse_meta",
            error_kind = "InvalidVaultMeta",
            protocol_error_kind = crate::protocol_error_kind::protocol_error_kind(&e),
            "source vault.meta parse rejected"
        );
        VaultUnlockError::InvalidVaultMeta
    })?;
    Ok((meta, meta_version, bytes))
}

/// Borrow the source vault's keys for one read.
///
/// The shape every reader in this feature uses: it cannot hand the keys out,
/// only lend them, so no caller can hold them past its own statement. Returns
/// `None` when the slot is absent or holds another variant, which every caller
/// maps to its own "the import session ended" error rather than to a crash.
pub async fn with_keys<T>(
    state: &VaultRuntimeState,
    source_id: VaultId,
    f: impl FnOnce(
        &Zeroizing<[u8; protocol::AEAD_KEY_LEN]>,
        &Zeroizing<[u8; protocol::AEAD_KEY_LEN]>,
        &[u8; 16],
    ) -> T,
) -> Option<T> {
    let slot = state.slot_read(source_id).await;
    match &*slot {
        Slot::ImportSource {
            root_key,
            items_key,
            items_key_id,
            ..
        } => Some(f(root_key, items_key, items_key_id)),
        _ => None,
    }
}

// ── IPC wrappers (layer 2) ──────────────────────────────────────────────────
//
// Registered under the desktop `importer` plugin's `generate_handler!`, NOT
// this plugin's, so they land in the `importer:` ACL namespace. That placement
// is the whole reason the feature costs the web dispatcher nothing: it already
// classifies the `importer` plugin `Class::Unsupported` wholesale, so no new
// command needs a `capability.rs` row and `check-web-command-coverage.mjs`
// stays green by construction rather than by an added entry.

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Runtime, State};

/// Open a source vault for reading. Exactly one of `password` / `recovery_phrase`
/// must be present; both or neither is a caller bug and is refused as an
/// invalid credential rather than silently preferring one.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn import_source_open<R: Runtime>(
    source_vault_id: String,
    password: Option<String>,
    recovery_phrase: Option<String>,
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<(), VaultUnlockError> {
    let source_id = VaultId::parse_optional(Some(source_vault_id.as_str()))
        .ok_or(VaultUnlockError::VaultNotFound)?;
    // Not a real user state: the credential step submits one field. Both or
    // neither means the caller is wrong about its own form.
    let credential = SourceCredential::from_ipc(password, recovery_phrase)
        .ok_or(VaultUnlockError::InvalidCredentialOrVault)?;
    open(
        source_id,
        credential,
        state.inner(),
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Close a source vault's read context and wipe its keys. Idempotent, so the
/// frontend can call it on every exit path (finish, cancel, unmount) without
/// tracking whether one is open.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn import_source_close(
    source_vault_id: String,
    state: State<'_, VaultRuntimeState>,
) -> Result<(), VaultUnlockError> {
    if let Some(source_id) = VaultId::parse_optional(Some(source_vault_id.as_str())) {
        close(source_id, state.inner()).await;
    }
    Ok(())
}

// ── Reading the source vault (task 2) ───────────────────────────────────────

/// Error surface for the two source-read commands.
///
/// A separate enum from `NoteReadError` on purpose: that one's `VaultNotUnlocked`
/// means "no vault is open", and here the vault the caller means is one that was
/// never unlocked and never will be. Collapsing the two would make a stale
/// import session indistinguishable from a locked vault at the IPC boundary,
/// and the frontend's response to each is different (reopen the import versus
/// unlock the app).
#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum ImportSourceReadError {
    /// No import slot is open for that vault: it was closed, it expired, or the
    /// vault was locked underneath the import.
    #[error("no import source is open for that vault")]
    SessionClosed,
    /// The note id did not parse. Kept distinct from `NoteNotFound` for the same
    /// reason `note_read` keeps them distinct: one is a caller bug, the other is
    /// a vault that changed under the walk.
    #[error("invalid note id")]
    InvalidNoteId,
    #[error("note not found")]
    NoteNotFound,
    /// AEAD verification failed. Non-distinguishing per `protocol.md` §6.4: a
    /// wrong key, a tampered blob and a truncated one are one tag here, and the
    /// sub-cause went to `tracing::debug!` inside the codec.
    #[error("cannot decrypt")]
    CannotDecrypt,
    #[error("io error")]
    Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind,
    },
    #[error("join failure")]
    JoinFailure,
}

/// List the source vault's note ids.
///
/// Ids only, and no decryption: the walk is a directory listing, so a source
/// vault with ten thousand notes costs one `read_dir` here rather than ten
/// thousand AEAD opens. What the adapter does with them, including reading each
/// one to build the source's own link graph, is its business and is where the
/// per-note cost is actually paid.
///
/// A file whose name does not parse as a note UUID is skipped rather than
/// failing the listing: `notes/` is the user's directory and a stray file in it
/// is not a reason to make their vault unimportable.
pub async fn list_note_ids(
    source_id: VaultId,
    state: &VaultRuntimeState,
    _host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<Vec<String>, ImportSourceReadError> {
    // The slot is not used for the listing itself, only as the authorisation:
    // without an open import session this command answers nothing, so a caller
    // cannot enumerate an arbitrary vault's note ids by guessing a `VaultId`.
    if state.slot_kind(source_id).await != SlotKind::ImportSource {
        return Err(ImportSourceReadError::SessionClosed);
    }

    // The root comes from the OPEN SLOT, not from the id: a local vault and a
    // `.myne-backup` extraction both satisfy this, and only the slot knows
    // which (myne-md/myne#816).
    let vault_root = state
        .import_source_root(source_id)
        .await
        .ok_or(ImportSourceReadError::SessionClosed)?;
    let notes_dir = vault_root.join("notes");

    let entries = match io.read_dir(&notes_dir).await {
        Ok(entries) => entries,
        // A backup of a vault with ZERO notes carries no `notes/` member at all
        // (the writer only emits members that exist), so a missing directory is
        // an empty vault, not a failure (myne-md/myne#827). Any other IO error
        // is still an error.
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => return Ok(Vec::new()),
        Err(io_error_kind) => {
            tracing::error!(
                stage = "read_dir",
                error_kind = "Io",
                io_failure_kind = ?io_error_kind,
                "source notes directory listing failed"
            );
            return Err(ImportSourceReadError::Io { io_error_kind });
        }
    };

    let mut ids: Vec<String> = entries
        .into_iter()
        .filter(|e| !e.is_dir)
        .filter_map(|e| e.name.strip_suffix(".myn").map(str::to_owned))
        // Match the container allowlist's UUID shape, NOT `NoteId::parse`
        // (v7-strict). The allowlist accepts any RFC-4122 version (§9.11.3's
        // grammar carries no version constraint), so a stricter filter here
        // would extract a member and then silently drop it from the listing,
        // importing nothing with no report row (myne-md/myne#827).
        .filter(|stem| myne_format::disk_uuid::is_disk_uuid(stem))
        .collect();
    // Sorted so a run is reproducible and a progress bar advances in a stable
    // order across re-imports; UUIDv7 sorts by creation time, so this is also
    // oldest-first, which is the order a user reading the report expects.
    ids.sort();
    Ok(ids)
}

/// Decrypt ONE note from the source vault and return its plaintext markdown.
///
/// Follows `note_read_with_dir`'s shape rather than inventing a second one: the
/// `NC05` magic is branched on BEFORE the `MY01` decode, so a migrated source
/// vault reads through the CRDT bridge and an unmigrated one through the v0.1
/// codec. Reaching for `decode_note` without that branch is exactly what
/// `check-version-routing.mjs` exists to stop, and the failure it would produce
/// is silent on a migrated vault rather than loud.
///
/// The plaintext crosses IPC, which is the Plaintext-IPC pattern
/// (`src-tauri/AGENTS.md`): one note's body at a time, wrapped while it is on
/// this side, never written to disk.
pub async fn read_note(
    source_id: VaultId,
    note_id: String,
    state: &VaultRuntimeState,
    _host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<String, ImportSourceReadError> {
    use crate::plugins::notes::note_id::NoteId;

    let note_id = NoteId::parse(&note_id).map_err(|cause| {
        tracing::debug!(stage = ?cause, "import source read: note_id strict-parse failed");
        ImportSourceReadError::InvalidNoteId
    })?;

    // Clone the keys out under the read guard and hold the guard across the
    // read + decode, the same fair-queue pattern `note_read_with_dir` uses so a
    // concurrent close waits for an in-flight decrypt rather than pulling the
    // keys out from under it.
    let slot = state.slot_read(source_id).await;
    let (items_key, items_key_id) = match &*slot {
        Slot::ImportSource {
            items_key,
            items_key_id,
            ..
        } => (items_key.clone(), *items_key_id),
        _ => {
            tracing::debug!(
                stage = "slot_check",
                outcome = "session_closed",
                "import source read rejected: no import slot for that vault"
            );
            return Err(ImportSourceReadError::SessionClosed);
        }
    };

    // Root from the open slot: works for a local vault and a `.myne-backup`
    // extraction alike (myne-md/myne#816).
    let vault_root = state
        .import_source_root(source_id)
        .await
        .ok_or(ImportSourceReadError::SessionClosed)?;
    let path = vault_root
        .join("notes")
        .join(format!("{}.myn", note_id.as_uuid()));
    let note_uuid_bytes = *note_id.as_uuid().as_bytes();

    let blob = match io.read(&path).await {
        Ok(bytes) => bytes,
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => {
            return Err(ImportSourceReadError::NoteNotFound)
        }
        Err(io_error_kind) => {
            tracing::error!(
                stage = "read_blob",
                error_kind = "Io",
                "import source blob read failed"
            );
            return Err(ImportSourceReadError::Io { io_error_kind });
        }
    };

    // ONE call, and the dispatch is inside it. `decode_note_any` is the shared
    // reader that branches on the `NC05` magic before falling through to the
    // v0.1 codec, and it is what `check-version-routing.mjs` exists to make
    // every reader use.
    //
    // This site had the branch written out by hand, which was correct and still
    // wrong to keep: the guard flags `protocol::decode_note` wherever it
    // appears, because the failure it prevents is invisible on an unmigrated
    // vault and silent on a migrated one. A third hand-written copy of a
    // two-arm dispatch is exactly how the arms drift apart.
    let join = crate::task::run_blocking(move || {
        crate::plugins::notes::decode::decode_note_any(
            &blob,
            &note_uuid_bytes,
            &items_key,
            &items_key_id,
        )
    })
    .await;
    drop(slot);
    match join {
        Err(_) => Err(ImportSourceReadError::JoinFailure),
        // One tag for every decode failure, per §6.4's non-distinguishing rule:
        // `NoteDecodeError` has a single variant for the same reason.
        Ok(Err(_)) => Err(ImportSourceReadError::CannotDecrypt),
        Ok(Ok(plaintext)) => {
            let bytes = plaintext.to_vec();
            // Explicit drop before the `String` is built, so the `Zeroizing`
            // wrapper and the outgoing `String` coexist for as short a window
            // as possible: the same minimisation `note_read_with_dir` does.
            drop(plaintext);
            String::from_utf8(bytes).map_err(|_| ImportSourceReadError::CannotDecrypt)
        }
    }
}

/// IPC wrapper for [`list_note_ids`].
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn import_source_list_notes<R: Runtime>(
    source_vault_id: String,
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<Vec<String>, ImportSourceReadError> {
    let source_id = VaultId::parse_optional(Some(source_vault_id.as_str()))
        .ok_or(ImportSourceReadError::SessionClosed)?;
    list_note_ids(
        source_id,
        state.inner(),
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// IPC wrapper for [`read_note`].
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn import_source_read_note<R: Runtime>(
    source_vault_id: String,
    note_id: String,
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<String, ImportSourceReadError> {
    let source_id = VaultId::parse_optional(Some(source_vault_id.as_str()))
        .ok_or(ImportSourceReadError::SessionClosed)?;
    read_note(
        source_id,
        note_id,
        state.inner(),
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
    )
    .await
}

#[cfg(test)]
mod import_source_read_tests {
    use super::*;
    use crate::plugins::vault_unlock::state::{
        fixture_import_source, fixture_unlocked_with_keys, test_vault_id, test_vault_id_b,
    };
    use crate::test_support::{block_on, ScopedTempDir};

    const ITEMS_KEY: [u8; protocol::AEAD_KEY_LEN] = [0x5A; protocol::AEAD_KEY_LEN];
    const ITEMS_KEY_ID: [u8; 16] = [0x66; 16];

    /// A host whose `app_data_dir` is a temp directory, so `vault_root_for_id`
    /// resolves under it and the whole read path runs against real bytes on a
    /// real filesystem rather than a fake seam.
    struct TempHost {
        base: std::path::PathBuf,
    }

    impl crate::host::HostCtx for TempHost {
        fn app_data_dir(&self) -> Result<std::path::PathBuf, crate::host::HostPathError> {
            Ok(self.base.clone())
        }
        fn app_config_dir(&self) -> Result<std::path::PathBuf, crate::host::HostPathError> {
            Ok(self.base.clone())
        }
        fn now_unix_millis(&self) -> u64 {
            0
        }
        fn monotonic_millis(&self) -> u64 {
            0
        }
        fn emit(&self, _event: &'static str, _payload: crate::host::EventPayload) {}
    }

    /// Write one real `MY01` note into `vaults/<id>/notes/` under `base`,
    /// encrypted with [`ITEMS_KEY`]. Returns its note id.
    fn seed_note(base: &std::path::Path, id: VaultId, body: &str) -> String {
        let notes = crate::paths::vault_root_for_id_from_base(base, id).join("notes");
        std::fs::create_dir_all(&notes).expect("notes dir");
        let uuid = uuid::Uuid::now_v7();
        let blob =
            protocol::encode_new_note(&ITEMS_KEY, &ITEMS_KEY_ID, uuid.as_bytes(), body.as_bytes())
                .expect("encode");
        std::fs::write(notes.join(format!("{uuid}.myn")), blob).expect("write blob");
        uuid.to_string()
    }

    /// Unlock a TARGET vault, which `open()` now requires.
    ///
    /// `test_vault_id()` rather than the source's id, and they must differ: a
    /// vault cannot be its own import source, and the guard that says so is one
    /// of the four under test below.
    fn unlock_target(state: &VaultRuntimeState) -> VaultId {
        let target = crate::plugins::vault_unlock::state::test_vault_id();
        block_on(async {
            state
                .set_unlocked(
                    target,
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;
        });
        target
    }

    /// Open a source slot the way production can: with a target vault unlocked.
    ///
    /// `set_import_source` refuses when nothing is unlocked, because the
    /// source's residency is bounded by the target vault's own session
    /// (`myne-agents/docs/threat-model.md` A6). These read tests care about what comes back
    /// through the slot, not about how it was created, so the target is set up
    /// here once rather than in each of them.
    ///
    /// The target is `test_vault_id()` and the source is whatever the caller
    /// names, so a caller passing `test_vault_id()` itself would be asking for a
    /// vault that is its own import source. That is refused by the `Unlocked`
    /// slot kind before it reaches here, and no caller does it.
    fn open_slot(state: &VaultRuntimeState, id: VaultId, base: &std::path::Path) {
        block_on(async {
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0x11, 0x22, 0x33),
                )
                .await;
            // The slot now carries the source ROOT (myne-md/myne#816), and the
            // readers resolve from it rather than from `vaults/<id>`. A fixture
            // slot with no root would resolve nothing.
            let mut material = fixture_import_source(0x44, 0x5A, 0x66, 0);
            material.vault_root = crate::paths::vault_root_for_id_from_base(base, id);
            state
                .set_import_source(id, material)
                .await
                .expect("a target vault is unlocked in this fixture");
        });
    }

    // ── `open()`'s four refusals ─────────────────────────────────────────
    //
    // The read side had both directions pinned and the side that CREATES the
    // slot had neither. Every one of these guards is one `if` away from being
    // deleted with the whole tree still green, and three of them are the reason
    // the feature does not violate SYNC-1.
    //
    // The success path is NOT here, deliberately: it runs Argon2id at
    // m=256 MiB against a real `vault.meta`, which is a `cargo test` this repo
    // pays for once per unlock test and does not need a second time. What it
    // WOULD prove past these four (that the derived keys open the source's
    // notes) is proved by `a_note_round_trips_through_the_import_slot` above,
    // through the same slot, and end to end by `e2e/import-myne-vault.e2e.ts`,
    // which drives a real password through the real UI.

    /// A target vault MUST be unlocked, and this guard runs before every other
    /// one.
    ///
    /// Without it a slot holding a SECOND vault's keys can exist with no
    /// session: `is_vault_switch(None, target)` is false, so the `close_all` on
    /// the unlock path had nothing to fire against and the slot survived into
    /// the first unlock. `threat-model.md` A6's amendment bounds that residency
    /// as "no longer than the target vault's own session", which a slot
    /// predating the session is simply outside of.
    #[test]
    fn an_import_source_needs_a_vault_to_import_into() {
        let tmp = ScopedTempDir::new("import-src-notarget").expect("temp");
        let state = VaultRuntimeState::default();
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let err = block_on(open(
            test_vault_id_b(),
            SourceCredential::Password(Zeroizing::new("pw".into())),
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect_err("nothing is unlocked");
        assert!(matches!(err, VaultUnlockError::NoActiveVaultToImportInto));
        // No slot was minted. The refusal that matters is the one that leaves
        // no key material behind, not the one that returns the right enum.
        assert_eq!(
            block_on(state.slot_kind(test_vault_id_b())),
            SlotKind::Empty
        );
    }

    /// A vault may not be its own import source. Reaching this means the UI and
    /// the host disagree, and the cost of not refusing is silent: the run
    /// renames every note against its own titles.
    #[test]
    fn a_vault_cannot_be_its_own_import_source() {
        let tmp = ScopedTempDir::new("import-src-self").expect("temp");
        let id = test_vault_id_b();
        let state = VaultRuntimeState::default();
        block_on(async {
            state
                .set_unlocked(
                    id,
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;
        });
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let err = block_on(open(
            id,
            SourceCredential::Password(Zeroizing::new("pw".into())),
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect_err("the active vault is refused as a source");
        assert!(matches!(err, VaultUnlockError::VaultAlreadyUnlocked));
        // And the refusal left the slot alone: it is still the UNLOCKED entry
        // it was, not an import source that quietly replaced it.
        assert_eq!(
            block_on(state.slot_kind(id)),
            SlotKind::Unlocked,
            "the refusal must not have disturbed the existing slot"
        );
    }

    /// A vault already open AS an import source is refused, with the variant
    /// that says so rather than one of the two the enum already had. Both of
    /// those are documented "not user-facing", so reusing either would have put
    /// developer copy in front of a user.
    #[test]
    fn a_second_open_of_the_same_source_is_refused() {
        let tmp = ScopedTempDir::new("import-src-twice").expect("temp");
        let id = test_vault_id_b();
        let state = VaultRuntimeState::default();
        unlock_target(&state);
        open_slot(&state, id, tmp.path());
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let err = block_on(open(
            id,
            SourceCredential::Password(Zeroizing::new("pw".into())),
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect_err("the slot is occupied");
        assert!(matches!(err, VaultUnlockError::VaultOpenAsImportSource));
    }

    /// A vault mid-recovery is refused too, and with its own variant. The
    /// `Recovering` slot holds keys derived from a phrase and is waiting for a
    /// password commit; overwriting it with an import source would strand that
    /// recovery with no way to finish.
    #[test]
    fn a_recovering_vault_is_refused_as_a_source() {
        let tmp = ScopedTempDir::new("import-src-recovering").expect("temp");
        let id = test_vault_id_b();
        let state = VaultRuntimeState::default();
        unlock_target(&state);
        block_on(async {
            state
                .set_recovering(
                    id,
                    crate::plugins::vault_unlock::state::fixture_recovering_with_keys(
                        0x11, 0x22, 0x33,
                    ),
                )
                .await;
        });
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let err = block_on(open(
            id,
            SourceCredential::Password(Zeroizing::new("pw".into())),
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect_err("the slot is recovering");
        assert!(matches!(err, VaultUnlockError::VaultRecoveryInProgress));
        assert_eq!(block_on(state.slot_kind(id)), SlotKind::Recovering);
    }

    /// The shared capacity-1 auth permit is REJECTED, never queued
    /// (`decisions.md` 2026-05-02). Queueing would linearise N clicks into N
    /// sequential Argon2id runs at m=256 MiB, which is the DoS shape that
    /// decision removed; an import source running its derivation alongside an
    /// unlock would also put two of them in flight at once.
    #[test]
    fn a_held_auth_permit_rejects_rather_than_queues() {
        let tmp = ScopedTempDir::new("import-src-permit").expect("temp");
        let id = test_vault_id_b();
        let state = VaultRuntimeState::default();
        unlock_target(&state);
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let held = state
            .auth_permits()
            .try_acquire()
            .expect("the permit is free to start with");
        let err = block_on(open(
            id,
            SourceCredential::Password(Zeroizing::new("pw".into())),
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect_err("another auth op holds the permit");
        assert!(matches!(err, VaultUnlockError::UnlockInProgress));
        drop(held);

        // The rejection is about the PERMIT and not about the vault: with the
        // permit free the same call gets past the guard and fails later, on the
        // missing `vault.meta`. Without this half the test would also pass if
        // `open` had simply started refusing everything.
        let err = block_on(open(
            id,
            SourceCredential::Password(Zeroizing::new("pw".into())),
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect_err("there is no vault on disk");
        assert!(
            !matches!(err, VaultUnlockError::UnlockInProgress),
            "the permit guard must not still be the thing refusing: got {err:?}"
        );
    }

    /// Both-or-neither is refused rather than resolved. Guessing which
    /// credential the caller meant is how a recovery phrase gets Argon2id'd
    /// under the password's salt domain, which fails the tag with an error that
    /// reads exactly like a wrong password.
    #[test]
    fn a_credential_must_be_exactly_one_of_the_two() {
        assert!(SourceCredential::from_ipc(Some("pw".into()), Some("a b c".into())).is_none());
        assert!(SourceCredential::from_ipc(None, None).is_none());
        assert!(matches!(
            SourceCredential::from_ipc(Some("pw".into()), None),
            Some(SourceCredential::Password(_))
        ));
        assert!(matches!(
            SourceCredential::from_ipc(None, Some("a b c".into())),
            Some(SourceCredential::RecoveryPhrase(_))
        ));
    }

    /// The end-to-end claim: bytes written by the real encoder come back
    /// byte-identical through the import slot's keys. Asserted on the STATE
    /// (the returned markdown) rather than on "it did not error", because a
    /// decrypt that returns the wrong plaintext also does not error.
    #[test]
    fn a_note_round_trips_through_the_import_slot() {
        let tmp = ScopedTempDir::new("import-src-read").expect("temp");
        let id = test_vault_id_b();
        let body = "---\ntitle: Project\n---\n\nBody with a [[Link]].\n";
        let note_id = seed_note(tmp.path(), id, body);
        let state = VaultRuntimeState::default();
        open_slot(&state, id, tmp.path());
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let got = block_on(read_note(
            id,
            note_id,
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect("the note decrypts");
        assert_eq!(got, body);
    }

    /// A **v0.2** source note round-trips through the import slot.
    ///
    /// This is the version-routing half, and it is here rather than in the E2E
    /// suite because this is where the encoders are. `e2e/fixture-gen` writes
    /// through `protocol`'s public API alone, deliberately, and an `NC05` blob
    /// is sealed by `crate::plugins::notes::crdt::encode_note_blob`, which is
    /// `myne-core`'s. Pulling `myne-core` into that crate to reach it would
    /// move a dependency boundary to buy a fixture.
    ///
    /// The gap it closes was the largest one the review of myne-md/myne#636
    /// left open, and the reason it mattered is not hypothetical:
    /// `protocol.md` §10.3.1 makes v0.2 the BIRTH format, so importing from a
    /// vault created today is the common case, and every automated lane
    /// exercised only v0.1. `write_import_source_suite` hard-asserts
    /// `MetaVersion::V0_1` in its own signature.
    ///
    /// What it proves is narrow and stated as such: `read_note` reaches
    /// `decode_note_any`, which dispatches on the `NC05` magic rather than
    /// assuming the v0.1 codec. It does not exercise a v0.2 `vault.meta`, a
    /// v0.2 KDF salt domain, or the `MYA5`/`MYC5` attachment pair, each of
    /// which is routed by `MetaVersion` read from the source's own
    /// `vault.meta` and covered by its own tests one layer down.
    #[test]
    fn a_v0_2_note_round_trips_through_the_import_slot() {
        let tmp = ScopedTempDir::new("import-src-v02").expect("temp");
        let id = test_vault_id_b();
        let body = "---\ntitle: Project\n---\n\nBody with a [[Link]].\n";

        // Sealed with the SAME `items_key` the fixture slot holds, so a failure
        // here is about the format and not about the keys.
        let notes = crate::paths::vault_root_for_id_from_base(tmp.path(), id).join("notes");
        std::fs::create_dir_all(&notes).expect("notes dir");
        let uuid = uuid::Uuid::now_v7();
        let blob = crate::plugins::notes::crdt::encode_note_blob_at_millis(
            body,
            &ITEMS_KEY,
            &ITEMS_KEY_ID,
            uuid.as_bytes(),
            b"import-source-test-actor",
            1_700_000_000_000,
        )
        .expect("NC05 seal");
        // The blob really is the v0.2 family, not a v0.1 one that happened to
        // decode. Without this the test passes for an encoder that silently
        // fell back, which is the exact wrong answer it exists to rule out.
        assert_eq!(&blob[..4], b"NC05", "the fixture must be an NC05 blob");
        std::fs::write(notes.join(format!("{uuid}.myn")), blob).expect("write blob");

        let state = VaultRuntimeState::default();
        open_slot(&state, id, tmp.path());
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let got = block_on(read_note(
            id,
            uuid.to_string(),
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect("the v0.2 note decodes through the import slot");
        assert_eq!(got, body);
    }

    /// The gate, asserted in the direction that matters: with no import slot the
    /// command answers nothing, even though the blob is sitting right there and
    /// the caller named a real vault and a real note.
    #[test]
    fn reading_without_an_open_import_slot_is_refused() {
        let tmp = ScopedTempDir::new("import-src-gate").expect("temp");
        let id = test_vault_id_b();
        let note_id = seed_note(tmp.path(), id, "body\n");
        let state = VaultRuntimeState::default();
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let err = block_on(read_note(
            id,
            note_id,
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect_err("no slot is open");
        assert!(matches!(err, ImportSourceReadError::SessionClosed));
    }

    /// Closing the slot must end the session for reads already, not merely stop
    /// new ones from starting. Pins that `read_note` re-checks the slot rather
    /// than caching keys anywhere.
    #[test]
    fn closing_the_slot_ends_reading() {
        let tmp = ScopedTempDir::new("import-src-close").expect("temp");
        let id = test_vault_id_b();
        let note_id = seed_note(tmp.path(), id, "body\n");
        let state = VaultRuntimeState::default();
        open_slot(&state, id, tmp.path());
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        block_on(close(id, &state));
        let err = block_on(read_note(
            id,
            note_id,
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect_err("the session was closed");
        assert!(matches!(err, ImportSourceReadError::SessionClosed));
    }

    #[test]
    fn listing_returns_only_parseable_note_ids_sorted() {
        let tmp = ScopedTempDir::new("import-src-list").expect("temp");
        let id = test_vault_id_b();
        let a = seed_note(tmp.path(), id, "a\n");
        let b = seed_note(tmp.path(), id, "b\n");
        // A stray file in the user's own notes directory must not make their
        // vault unimportable, which is why the listing filters rather than
        // erroring.
        let notes = crate::paths::vault_root_for_id_from_base(tmp.path(), id).join("notes");
        std::fs::write(notes.join("not-a-uuid.myn"), b"junk").expect("stray");
        std::fs::write(notes.join("README.txt"), b"junk").expect("stray");
        let state = VaultRuntimeState::default();
        open_slot(&state, id, tmp.path());
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let mut expected = vec![a, b];
        expected.sort();
        let got = block_on(list_note_ids(
            id,
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect("listing succeeds");
        assert_eq!(got, expected);
    }

    #[test]
    fn listing_without_an_open_import_slot_is_refused() {
        let tmp = ScopedTempDir::new("import-src-list-gate").expect("temp");
        let id = test_vault_id_b();
        seed_note(tmp.path(), id, "a\n");
        let state = VaultRuntimeState::default();
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let err = block_on(list_note_ids(
            id,
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect_err("no slot is open");
        assert!(matches!(err, ImportSourceReadError::SessionClosed));
    }

    /// A blob sealed under a DIFFERENT items_key must fail the AEAD tag rather
    /// than returning anything. The wrong-key case is the one a cross-vault bug
    /// would produce, and it has to be indistinguishable from tamper per §6.4.
    #[test]
    fn a_note_from_another_vaults_key_cannot_be_decrypted() {
        let tmp = ScopedTempDir::new("import-src-wrongkey").expect("temp");
        let id = test_vault_id_b();
        let notes = crate::paths::vault_root_for_id_from_base(tmp.path(), id).join("notes");
        std::fs::create_dir_all(&notes).expect("notes dir");
        let uuid = uuid::Uuid::now_v7();
        // Sealed under a key the slot will NOT hold.
        let other_key = [0x11u8; protocol::AEAD_KEY_LEN];
        let blob =
            protocol::encode_new_note(&other_key, &ITEMS_KEY_ID, uuid.as_bytes(), b"secret\n")
                .expect("encode");
        std::fs::write(notes.join(format!("{uuid}.myn")), blob).expect("write");

        let state = VaultRuntimeState::default();
        open_slot(&state, id, tmp.path());
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let err = block_on(read_note(
            id,
            uuid.to_string(),
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect_err("the AEAD tag must refuse");
        assert!(matches!(err, ImportSourceReadError::CannotDecrypt));
    }
}

// ── Re-sealing an attachment into the target vault (task 3) ─────────────────

/// Error surface for the attachment re-seal.
#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum ImportSourceAttachmentError {
    #[error("no import source is open for that vault")]
    SessionClosed,
    /// The id was not 64 lowercase hex characters.
    #[error("invalid attachment id")]
    InvalidAttachmentId,
    /// The source catalog has no live entry for that id. A TOMBSTONE lands here
    /// too: the source deleted it, so there are no bytes to carry.
    #[error("attachment not found in the source vault")]
    NotFound,
    #[error("cannot decrypt")]
    CannotDecrypt,
    #[error("source vault.meta is invalid")]
    InvalidSourceVaultMeta,
    /// The source's `vault.attachments` exists and no copy decoded.
    ///
    /// Distinct from "no attachments", and the distinction is load-bearing:
    /// treating an unreadable catalog as empty would bake a permanent tombstone
    /// into every imported note that embeds anything, and would report it as
    /// the TARGET refusing the file.
    #[error("the source vault's attachment catalog could not be read")]
    SourceCatalogUnreadable,
    #[error("io error")]
    Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind,
    },
    /// The target vault refused the bytes. Carries the ingest's own reason so a
    /// content type the allowlist has since narrowed away is a REPORTED
    /// rejection rather than a silent drop, which is the whole reason the
    /// re-seal keeps the sniff instead of bypassing it.
    #[error("the target vault refused the attachment")]
    TargetRefused {
        reason: crate::plugins::attachments::error::AttachmentImportError,
    },
}

/// What the re-seal produced in the target vault.
#[derive(Debug, serde::Serialize)]
pub struct ResealedAttachment {
    /// The id the bytes have in the TARGET vault, hex. Different from the
    /// source's by construction: the id is `HMAC-SHA-256` keyed under the
    /// vault's own `root_key` (`protocol.md` §9.9), so a fresh id falls out of
    /// the re-seal rather than needing to be minted.
    pub target_id: String,
    /// `true` when the target vault already held these exact bytes. Free dedup,
    /// for the same keying reason: identical plaintext under the same target
    /// `root_key` is the same id, so no second blob is written.
    pub deduplicated: bool,
}

/// Decrypt one attachment from the source vault and re-seal it into the target.
///
/// The whole operation runs host-side: the plaintext never crosses IPC. That is
/// not a performance note, it is the design. The alternative shape, handing the
/// decrypted bytes to the WebView so it could call the ordinary
/// `attachments:attachment_import`, would marshal up to 64 MiB of decrypted file
/// per attachment through a JSON byte array into V8 and back, for a transfer
/// whose bytes never had to leave Rust.
///
/// Three properties the ordinary ingest path does NOT give for free, and which
/// this function arranges:
///
/// - `filename` and `created_at` come from the SOURCE catalog row. The ordinary
///   path stamps "now", which would make every imported file look freshly added
///   and would also reset the unused-cleanup grace window.
/// - Ingest re-compression is skipped ([`IngestCompression::SkipAlreadyCanonical`]).
///   These bytes are already a Myne vault's stored bytes and have been past that
///   gate once under their own vault's preference; re-encoding them is
///   generation loss on a copy nobody asked to have re-processed.
/// - The MIME allowlist re-sniff is KEPT. A type the allowlist has since
///   narrowed away must be a reported rejection, not a silent drop, so the sniff
///   stays exactly where it is and its refusal is surfaced as
///   [`ImportSourceAttachmentError::TargetRefused`].
pub async fn reseal_attachment(
    source_id: VaultId,
    attachment_id_hex: String,
    target_vault_dir: &Path,
    state: &VaultRuntimeState,
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<ResealedAttachment, ImportSourceAttachmentError> {
    use crate::plugins::attachments::commands::{
        attachment_import_with_dir_ext, read_account_number_hash, ImportSource, IngestCompression,
        IngestPolicy,
    };

    let raw_id = decode_attachment_id_hex(&attachment_id_hex)
        .ok_or(ImportSourceAttachmentError::InvalidAttachmentId)?;

    // Clone the source key material out under the read guard. Held only for the
    // clone: the target-side ingest below takes the slots lock itself, and
    // holding this guard across that would be the reentrant-lock hazard
    // `vault_unlock/state.rs` documents.
    let (source_root_key, source_items_key, source_items_key_id) = {
        let slot = state.slot_read(source_id).await;
        match &*slot {
            Slot::ImportSource {
                root_key,
                items_key,
                items_key_id,
                ..
            } => (root_key.clone(), items_key.clone(), *items_key_id),
            _ => return Err(ImportSourceAttachmentError::SessionClosed),
        }
    };

    // Source root from the open slot, so a `.myne-backup` import re-seals from
    // its extraction directory too (myne-md/myne#816).
    let source_root = state
        .import_source_root(source_id)
        .await
        .ok_or(ImportSourceAttachmentError::SessionClosed)?;

    // The source's own generation and account hash. Both are the SOURCE's:
    // deriving the catalog KEK under the target's generation, or binding the
    // target's account hash into the source catalog's AAD, fails the tag rather
    // than reading the wrong thing, but it fails for a reason nobody could read
    // off the error. Keeping them explicitly source-side is what makes the two
    // vaults' key material impossible to confuse at this call site.
    let (source_meta_version, source_account_hash) =
        match read_account_number_hash(io, &source_root.join("vault.meta"))
            .await
            .map_err(|io_error_kind| ImportSourceAttachmentError::Io { io_error_kind })?
        {
            Ok(pair) => pair,
            Err(_) => return Err(ImportSourceAttachmentError::InvalidSourceVaultMeta),
        };

    let source_catalog_key = protocol::derive_subkey_versioned(
        source_meta_version,
        &source_root_key,
        protocol::SubkeyRole::AttachmentsCatalogKey,
    );
    // `read_catalog_for_write`, NOT `read_catalog`, and the distinction is the
    // whole finding.
    //
    // `read_catalog` maps a present-but-undecodable catalog to the EMPTY one,
    // per §9.10.4's fall-back. That is right for a reader: the library shows
    // empty until the file is repaired and nothing is lost. It is wrong here,
    // because the very next thing this flow does is WRITE, into the target: an
    // empty catalog makes every id miss, every `![[att:…]]` keeps its source id,
    // and `note_create` persists those bodies. The user gets a vault full of
    // permanent tombstones, is told "attachments this vault would not accept"
    // (naming the wrong vault and the wrong cause), and a re-import does not
    // repair it, because a colliding-but-unlinked note takes the skip arm.
    //
    // This function never writes the SOURCE catalog, so `_for_write` is not
    // about the write target. It is about needing the distinction the reader
    // deliberately throws away: absent means "no attachments", undecodable
    // means "we could not read this", and only the second must stop the import.
    let catalog = crate::plugins::attachments::commands::read_catalog_for_write(
        io,
        &source_root.join("vault.attachments"),
        &source_catalog_key,
        &source_account_hash,
    )
    .await
    .map_err(|e| match e {
        crate::plugins::attachments::commands::CatalogWriteRefusal::Io(io_error_kind) => {
            ImportSourceAttachmentError::Io { io_error_kind }
        }
        crate::plugins::attachments::commands::CatalogWriteRefusal::Undecodable => {
            ImportSourceAttachmentError::SourceCatalogUnreadable
        }
    })?;
    let _ = source_meta_version;

    let entry = catalog
        .entries
        .get(&attachment_id_hex)
        .filter(|e| e.deleted_at.is_none())
        .ok_or(ImportSourceAttachmentError::NotFound)?;
    let filename = entry.filename.clone();
    let created_at = entry.created_at;
    let content_type = entry.content_type.clone();
    // **The placement travels with the file** (myne-md/myne#913, review round
    // eight): re-importing a chat-scoped row as a library row would list a file
    // its author filed into one conversation, and would make it sweepable once
    // that conversation's turns moved on. The row already carries the answer.
    let source_scope = entry.scope;

    let blob = io
        .read(&source_root.join("attachments").join(&attachment_id_hex))
        .await
        .map_err(|io_error_kind| match io_error_kind {
            crate::io_failure_kind::IoFailureKind::NotFound => {
                ImportSourceAttachmentError::NotFound
            }
            other => ImportSourceAttachmentError::Io {
                io_error_kind: other,
            },
        })?;

    // `decode_attachment_blob` is magic-dispatching (`MYA1` vs a migrated
    // vault's `MYA5`), so this is version-routed without a branch here.
    let plaintext = crate::task::run_blocking(move || {
        protocol::decode_attachment_blob(
            &blob,
            &raw_id,
            content_type.as_bytes(),
            &source_items_key,
            &source_items_key_id,
        )
    })
    .await
    .map_err(|_| ImportSourceAttachmentError::CannotDecrypt)?
    .map_err(|_| ImportSourceAttachmentError::CannotDecrypt)?;

    // Into the TARGET vault through the ordinary ingest, so the blob framing,
    // the catalog write, the dedup check and the sync-dirty marking are the one
    // implementation rather than a second copy of them here.
    let imported = attachment_import_with_dir_ext(
        io,
        host,
        target_vault_dir,
        state,
        ImportSource::Bytes {
            bytes: plaintext.to_vec(),
            filename: Some(filename),
        },
        IngestPolicy {
            created_at_override: Some(created_at),
            compression: IngestCompression::SkipAlreadyCanonical,
            scope: source_scope,
        },
        |_ct: &str, _fn_: &str, _b: &[u8]| {
            crate::plugins::attachments::extract_types::ExtractedText::negative(
                crate::plugins::attachments::extract_types::ExtractStatus::Unsupported,
                crate::plugins::attachments::extract_types::SourceFormat::Other,
            )
        },
    )
    .await
    .map_err(|reason| ImportSourceAttachmentError::TargetRefused { reason })?;

    Ok(ResealedAttachment {
        target_id: imported.id,
        deduplicated: imported.deduplicated,
    })
}

/// Parse a 64-character lowercase-hex attachment id.
///
/// Strict on case as well as length: the id is a filename in `attachments/`,
/// and accepting uppercase here would let two spellings of the same id name one
/// file on a case-insensitive filesystem and two on a case-sensitive one.
fn decode_attachment_id_hex(s: &str) -> Option<[u8; 32]> {
    protocol::hex::decode_lower(s)
}

/// IPC wrapper for [`reseal_attachment`].
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn import_source_reseal_attachment<R: Runtime>(
    source_vault_id: String,
    attachment_id: String,
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<ResealedAttachment, ImportSourceAttachmentError> {
    let source_id = VaultId::parse_optional(Some(source_vault_id.as_str()))
        .ok_or(ImportSourceAttachmentError::SessionClosed)?;
    let host = TauriHost::new(app);
    let target_dir =
        crate::paths::active_vault_root_from_host(&host, state.active_vault_id().await)
            .map_err(|_| ImportSourceAttachmentError::SessionClosed)?;
    reseal_attachment(
        source_id,
        attachment_id,
        &target_dir,
        state.inner(),
        &host,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

#[cfg(test)]
mod import_source_reseal_tests {
    use super::*;
    use crate::plugins::vault_unlock::state::{
        fixture_import_source, fixture_unlocked_with_keys, test_vault_id, test_vault_id_b,
    };
    use crate::test_support::{block_on, seed_real_vault_meta, ScopedTempDir};

    const SRC_ROOT: [u8; protocol::AEAD_KEY_LEN] = [0xA1; protocol::AEAD_KEY_LEN];
    const SRC_ITEMS: [u8; protocol::AEAD_KEY_LEN] = [0xA2; protocol::AEAD_KEY_LEN];
    const SRC_ITEMS_ID: [u8; 16] = [0xA3; 16];
    const TGT_ROOT: [u8; protocol::AEAD_KEY_LEN] = [0xB1; protocol::AEAD_KEY_LEN];
    const TGT_ITEMS: [u8; protocol::AEAD_KEY_LEN] = [0xB2; protocol::AEAD_KEY_LEN];
    const TGT_ITEMS_ID: [u8; 16] = [0xB3; 16];
    /// The byte `seed_real_vault_meta` fills `account_number_hash` with.
    const SRC_SEED: u8 = 0x0A;
    const TGT_SEED: u8 = 0x0B;

    struct TempHost {
        base: std::path::PathBuf,
    }

    impl crate::host::HostCtx for TempHost {
        fn app_data_dir(&self) -> Result<std::path::PathBuf, crate::host::HostPathError> {
            Ok(self.base.clone())
        }
        fn app_config_dir(&self) -> Result<std::path::PathBuf, crate::host::HostPathError> {
            Ok(self.base.clone())
        }
        fn now_unix_millis(&self) -> u64 {
            1_700_000_000_000
        }
        fn monotonic_millis(&self) -> u64 {
            0
        }
        fn emit(&self, _event: &'static str, _payload: crate::host::EventPayload) {}
    }

    /// Lay down a source vault holding one real attachment: a `MYA1` blob under
    /// `SRC_ITEMS`, plus a `MYC1` catalog naming it. Returns the source-side id.
    fn seed_source_attachment(
        base: &std::path::Path,
        bytes: &[u8],
        filename: &str,
        content_type: &str,
        created_at: u64,
    ) -> String {
        let root = crate::paths::vault_root_for_id_from_base(base, test_vault_id_b());
        std::fs::create_dir_all(root.join("attachments")).expect("attachments dir");
        seed_real_vault_meta(&root, SRC_SEED);

        let id = protocol::compute_attachment_id(&SRC_ROOT, bytes);
        let id_hex: String = id.iter().map(|b| format!("{b:02x}")).collect();

        let blob = protocol::encode_attachment_blob(
            &SRC_ITEMS,
            &SRC_ITEMS_ID,
            &id,
            content_type.as_bytes(),
            bytes,
        )
        .expect("seal source attachment");
        std::fs::write(root.join("attachments").join(&id_hex), blob).expect("write blob");

        let mut catalog = protocol::AttachmentsCatalog::default();
        catalog.entries.insert(
            id_hex.clone(),
            protocol::AttachmentMeta::live(
                content_type.to_string(),
                created_at,
                filename.to_string(),
                bytes.len() as u64,
            ),
        );
        let catalog_key =
            protocol::derive_subkey(&SRC_ROOT, protocol::SubkeyRole::AttachmentsCatalogKey);
        let catalog_blob =
            protocol::encode_attachments_catalog(&catalog_key, &[SRC_SEED; 16], &catalog)
                .expect("seal source catalog");
        std::fs::write(root.join("vault.attachments"), catalog_blob).expect("write catalog");
        id_hex
    }

    fn seed_target(base: &std::path::Path) -> std::path::PathBuf {
        let root = crate::paths::vault_root_for_id_from_base(base, test_vault_id());
        std::fs::create_dir_all(root.join("attachments")).expect("attachments dir");
        seed_real_vault_meta(&root, TGT_SEED);
        root
    }

    fn open_both(state: &VaultRuntimeState, base: &std::path::Path) {
        block_on(async {
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0xB1, 0xB2, 0xB3),
                )
                .await;
            let mut material = fixture_import_source(0xA1, 0xA2, 0xA3, 0);
            material.vault_root =
                crate::paths::vault_root_for_id_from_base(base, test_vault_id_b());
            state
                .set_import_source(test_vault_id_b(), material)
                .await
                .expect("a target vault is unlocked in this fixture");
        });
    }

    /// The end-to-end claim, asserted on the TARGET vault's own state rather
    /// than on the call returning `Ok`: the bytes are readable back out under
    /// the target's keys, at an id the target derived for itself.
    #[test]
    fn an_attachment_crosses_and_is_readable_under_the_target_keys() {
        let tmp = ScopedTempDir::new("reseal-roundtrip").expect("temp");
        let bytes = b"\x89PNG\r\n\x1a\nnot-really-a-png-but-opaque-bytes";
        let src_id = seed_source_attachment(tmp.path(), bytes, "diagram.png", "image/png", 1234);
        let target_dir = seed_target(tmp.path());
        let state = VaultRuntimeState::default();
        open_both(&state, tmp.path());
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let out = block_on(reseal_attachment(
            test_vault_id_b(),
            src_id.clone(),
            &target_dir,
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect("the attachment crosses");

        // The id is the TARGET's, derived under the target's own root_key.
        // Different from the source's by construction (§9.9), which is also why
        // no id has to be minted.
        assert_ne!(out.target_id, src_id);
        assert!(!out.deduplicated);
        let expected_target_id: String = protocol::compute_attachment_id(&TGT_ROOT, bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(out.target_id, expected_target_id);

        // And the bytes really are there, under the target's keys.
        let stored =
            std::fs::read(target_dir.join("attachments").join(&out.target_id)).expect("blob");
        let back = protocol::decode_attachment_blob(
            &stored,
            &protocol::compute_attachment_id(&TGT_ROOT, bytes),
            b"image/png",
            &TGT_ITEMS,
            &TGT_ITEMS_ID,
        )
        .expect("the target can open it");
        assert_eq!(&back[..], bytes);
    }

    /// `created_at` and `filename` come from the SOURCE row. The ordinary ingest
    /// path stamps "now", which would make every imported file look freshly
    /// added and would restart the unused-cleanup grace window.
    #[test]
    fn the_source_filename_and_created_at_survive() {
        let tmp = ScopedTempDir::new("reseal-meta").expect("temp");
        let bytes = b"opaque bytes for the metadata test";
        let src_id = seed_source_attachment(
            tmp.path(),
            bytes,
            "notes-2019.pdf",
            "application/pdf",
            1_555_000_000,
        );
        let target_dir = seed_target(tmp.path());
        let state = VaultRuntimeState::default();
        open_both(&state, tmp.path());
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let out = block_on(reseal_attachment(
            test_vault_id_b(),
            src_id,
            &target_dir,
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect("the attachment crosses");

        let catalog_key =
            protocol::derive_subkey(&TGT_ROOT, protocol::SubkeyRole::AttachmentsCatalogKey);
        let catalog_bytes = std::fs::read(target_dir.join("vault.attachments")).expect("catalog");
        let catalog =
            protocol::decode_attachments_catalog(&catalog_key, &[TGT_SEED; 16], &catalog_bytes)
                .expect("target catalog decodes");
        let entry = catalog.entries.get(&out.target_id).expect("entry present");
        assert_eq!(entry.filename, "notes-2019.pdf");
        assert_eq!(
            entry.created_at, 1_555_000_000,
            "the source's creation time must survive; stamping now would make \
             every imported file look freshly added"
        );
    }

    /// Re-sealing the same bytes twice writes one blob. Free, because the id is
    /// content-derived under the target's key, but worth pinning: a regression
    /// here doubles the disk cost of every re-import.
    #[test]
    fn re_sealing_the_same_bytes_dedups() {
        let tmp = ScopedTempDir::new("reseal-dedup").expect("temp");
        let bytes = b"the very same bytes, twice";
        let src_id = seed_source_attachment(
            tmp.path(),
            bytes,
            "twice.bin",
            "application/octet-stream",
            42,
        );
        let target_dir = seed_target(tmp.path());
        let state = VaultRuntimeState::default();
        open_both(&state, tmp.path());
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let first = block_on(reseal_attachment(
            test_vault_id_b(),
            src_id.clone(),
            &target_dir,
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect("first crossing");
        let second = block_on(reseal_attachment(
            test_vault_id_b(),
            src_id,
            &target_dir,
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect("second crossing");

        assert_eq!(first.target_id, second.target_id);
        assert!(!first.deduplicated);
        assert!(second.deduplicated, "the second crossing must dedup");
    }

    #[test]
    fn re_sealing_without_an_open_import_slot_is_refused() {
        let tmp = ScopedTempDir::new("reseal-gate").expect("temp");
        let bytes = b"gated bytes";
        let src_id =
            seed_source_attachment(tmp.path(), bytes, "x.bin", "application/octet-stream", 1);
        let target_dir = seed_target(tmp.path());
        let state = VaultRuntimeState::default();
        // Target unlocked, but no import source open.
        block_on(async {
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0xB1, 0xB2, 0xB3),
                )
                .await;
        });
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let err = block_on(reseal_attachment(
            test_vault_id_b(),
            src_id,
            &target_dir,
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect_err("no import slot is open");
        assert!(matches!(err, ImportSourceAttachmentError::SessionClosed));
    }

    /// An id the source catalog does not carry is `NotFound`, not a panic and
    /// not an empty success. This is the tombstoned / stale-reference case the
    /// adapter has to be able to report.
    #[test]
    fn an_unknown_attachment_id_is_reported_not_found() {
        let tmp = ScopedTempDir::new("reseal-missing").expect("temp");
        seed_source_attachment(
            tmp.path(),
            b"present",
            "p.bin",
            "application/octet-stream",
            1,
        );
        let target_dir = seed_target(tmp.path());
        let state = VaultRuntimeState::default();
        open_both(&state, tmp.path());
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        let err = block_on(reseal_attachment(
            test_vault_id_b(),
            "f".repeat(64),
            &target_dir,
            &state,
            &host,
            &crate::vault_io::StdVaultIo,
        ))
        .expect_err("that id is not in the source catalog");
        assert!(matches!(err, ImportSourceAttachmentError::NotFound));
    }

    #[test]
    fn a_malformed_attachment_id_is_rejected_before_any_io() {
        let tmp = ScopedTempDir::new("reseal-badid").expect("temp");
        let target_dir = seed_target(tmp.path());
        let state = VaultRuntimeState::default();
        open_both(&state, tmp.path());
        let host = TempHost {
            base: tmp.path().to_path_buf(),
        };

        for bad in ["", "abc", &"F".repeat(64), &"g".repeat(64)] {
            let err = block_on(reseal_attachment(
                test_vault_id_b(),
                bad.to_string(),
                &target_dir,
                &state,
                &host,
                &crate::vault_io::StdVaultIo,
            ))
            .expect_err("malformed ids are refused");
            assert!(
                matches!(err, ImportSourceAttachmentError::InvalidAttachmentId),
                "expected InvalidAttachmentId for {bad:?}"
            );
        }
    }
}
