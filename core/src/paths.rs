// SPDX-License-Identifier: AGPL-3.0
//! Filesystem path resolution for vault data.
//!
//! Spec / decisions: see
//! `agent-tooling/sessions/design/2026-04-28-vault-creation-flow.md` Q5 and
//! the superseding `vaults/<id>/` layout (SYNC-2, grill
//! vault-registry-and-disk-layout, 2026-06-08).
//!
//! ## Layout (multi-vault)
//!
//! Each vault lives under `<app_data_dir>/vaults/<VaultId>/`, where
//! `<VaultId>` is a random UUIDv7 directory name (see [`crate::vault_id`]):
//!
//! - macOS: `~/Library/Application Support/md.myne.desktop/vaults/<id>/`
//! - Linux: `~/.local/share/md.myne.desktop/vaults/<id>/`
//! - Windows: `%APPDATA%\md.myne.desktop\vaults\<id>\`
//!
//! The `vaults/` subdirectory keeps vault data separate from Tauri
//! logs / cache that share `app_data_dir`, and the per-`<id>/` nesting
//! lets a future multi-vault runtime hold several side by side.
//!
//! ## Resolver shape
//!
//! Every resolver takes the **vault root** `&Path` (`vaults/<id>/`) — never
//! `app_data_dir` directly — and the pure `*_under(parent)` helpers do the
//! actual `join` + `create_dir_all`. The `*_under` seam is preserved so
//! tests can pass a `ScopedTempDir` path without a Tauri runtime.
//!
//! The vault root itself is resolved — until the multi-slot runtime lands
//! (sub-feature 2) — via the transitional [`current_vault_root`] (the sole
//! on-disk vault). Sub-feature 2 introduces the per-`VaultId` resolver where
//! its first caller lands.

// Only the (host-gated) Tauri-taking resolvers return this error type.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::plugins::vault_creation::error::AppError;
use crate::vault_id::VaultId;
use std::path::{Path, PathBuf};
// The Tauri-taking resolvers below are host-only; their `*_from_host` and
// `*_from_base` siblings are what every target shares (task 79).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Manager, Runtime};

/// Top-level directory holding every `<VaultId>/` vault root.
pub const VAULTS_DIR_NAME: &str = "vaults";

/// Destination-parent predicate shared by the export-suite destination
/// checks (note / tree / PDF / attachment export): the path's parent must be
/// non-empty and an existing directory. The OS save dialog normally
/// guarantees this; it fails when the directory vanished between
/// confirm and write (the backup `export_phase_one` precedent).
///
/// Re-exported from `myne-format`'s [`dest_guard`](myne_format::dest_guard),
/// along with [`containment_refused`], so the export walk in that crate and the
/// command cores here share ONE copy rather than three that drift.
pub use myne_format::dest_guard::{
    containment_refused, parent_dir_ok, ContainmentRefusal, ResolvedRoot,
};

/// Legacy single-vault directory name (pre-`vaults/<id>/` layout). The
/// boot migration (sub-feature task 4) renames this into `vaults/<id>/`;
/// until then [`current_vault_root`] still accepts it so the app boots
/// pre-migration.
pub const LEGACY_VAULT_DIR_NAME: &str = "vault";

/// Fixed sentinel [`VaultId`] for the legacy single-vault directory (`vault/`,
/// pre-`vaults/<id>/` layout). Until the boot migration (sub-feature task 4)
/// renames `vault/` into `vaults/<minted-id>/`, the runtime slot map still
/// needs a deterministic key for the sole on-disk vault. A pre-migration boot
/// resolves to `vault/` (no UUID in the path), so [`current_vault_id_from_base`]
/// falls back to this constant — the same value every time, so unlock → read →
/// lock all key the same entry. It is a valid UUIDv7 string (passes
/// [`VaultId::parse`]); the all-`7` node bits make it visually recognizable as
/// the synthetic legacy key in a debugger.
///
/// TRANSITIONAL (sub-feature task 4): once the boot migration mints a real
/// `VaultId` and moves the data under `vaults/<id>/`, this sentinel is no
/// longer produced (the path then carries a real id parsed by
/// [`current_vault_id_from_base`]).
const LEGACY_VAULT_ID_STR: &str = "00000000-0000-7000-8000-777777777777";

/// The **single-vault sentinel** for a client that hosts exactly one vault
/// (phase3-web-client task 85).
///
/// A browser holds one account's vault per origin — `decisions.md` 2026-07-26,
/// and task 85's own out-of-scope line ("web is one account to one vault") — so
/// there is nothing to enumerate and nothing to choose between. This constant is
/// the **registry collapse made explicit**, which is the point: the alternative
/// was letting `mint_unique_vault_id`'s disk scan run over OPFS, where it would
/// have been both slower and meaningless.
///
/// Being a CONSTANT is what makes re-running the first-run bootstrap idempotent
/// — the criterion "never mints a second container" holds by construction rather
/// than by a check — and what makes the `VaultId` on the unlock stage payload
/// stable across reloads. It is non-secret by the same reasoning the legacy
/// sentinel is: it carries no account number, no hash bytes and no path. The
/// all-`eb` node bits read as "EB" ≈ web in a debugger, the same trick the
/// legacy sentinel plays with all-`7`.
const WEB_VAULT_ID_STR: &str = "00000000-0000-7000-8000-ebebebebebeb";

/// The fixed single-vault [`VaultId`] (see [`WEB_VAULT_ID_STR`]).
pub fn web_single_vault_id() -> VaultId {
    VaultId::parse(WEB_VAULT_ID_STR).expect("WEB_VAULT_ID_STR is a valid UUIDv7")
}

/// The fixed legacy-vault sentinel [`VaultId`] (see [`LEGACY_VAULT_ID_STR`]).
/// Used as a deterministic fallback key when no real `VaultId` is in play —
/// e.g. the active-vault read helpers when no vault is unlocked (the keyed
/// entry is absent → `Slot::Empty`). TRANSITIONAL (sub-feature task 4).
pub fn legacy_vault_id() -> VaultId {
    VaultId::parse(LEGACY_VAULT_ID_STR).expect("LEGACY_VAULT_ID_STR is a valid UUIDv7")
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Resolve `<app_data_dir>` for the running app, mapping a failure to
/// the `vault_creation` plugin's [`AppError`] shape.
///
/// `pub` so `vault_creation::begin` can resolve the base it needs to
/// mint a fresh, collision-free [`VaultId`] (`vault_registry::mint_unique_vault_id`)
/// into the creation session (SYNC-6 create targeting — every vault, first or
/// Nth, lands at a freshly-minted `vaults/<id>/`).
pub fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    app.path().app_data_dir().map_err(|_| AppError::Io {
        kind: crate::plugins::vault_creation::error::IoErrorKind::Other,
    })
}

/// Error-agnostic core of [`current_vault_root`]: resolve the sole current
/// vault root from an already-resolved `<app_data_dir>` base. Pure path
/// logic + a read-only `vaults/` scan; the only fallible step (the
/// `app_data_dir` lookup) is the caller's, so this is infallible.
///
/// `pub` so the various plugin helpers — each with its own error
/// type (`VaultUnlockError`, `std::io::Error`, `Option<PathBuf>`) — can map
/// their `app_data_dir` lookup as they already do and then layer this
/// resolution on top without an `AppError` cross-plugin conversion.
pub fn current_vault_root_from_base(base: &Path) -> PathBuf {
    let vaults_dir = base.join(VAULTS_DIR_NAME);

    // (1) Single well-formed `vaults/<id>/` child wins.
    if let Ok(entries) = std::fs::read_dir(&vaults_dir) {
        let mut found: Option<PathBuf> = None;
        let mut count = 0usize;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let names_a_vault = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| VaultId::parse(n).is_ok());
            if names_a_vault {
                count += 1;
                found = Some(path);
            }
        }
        // Exactly one → unambiguous. Zero or many → fall through (a fresh
        // install has none; the multi-vault runtime of sub-feature 2 owns
        // the disambiguation when several exist).
        if count == 1 {
            return found.expect("count==1 implies Some");
        }
    }

    // (2)/(3) Legacy single-vault directory — both the pre-migration boot
    // path and the fresh-install create destination.
    base.join(LEGACY_VAULT_DIR_NAME)
}

// ── host-taking siblings (phase3-web-client task 79, step 0) ─────────────────
//
// One-line wrappers over the SAME pure `*_from_base` / `*_under` helpers the
// Tauri-taking resolvers above use. The split is the point: the path
// *arithmetic* — which is all of the interesting logic, including the
// sole-vault disk heuristic and the `create_dir_all` in `notes_dir_under` —
// has exactly one implementation, shared by every host. Only the *base lookup*
// varies, and that is the single method these take.
//
// Nothing calls these yet. They land with the seam so the first plugin move is
// a one-line substitution rather than a resolver rewrite, and so a reviewer can
// see that the host arm and the Tauri arm compute the same path from the same
// helper.
//
// `HostPathError` collapses to the same opaque failures the Tauri arms already
// produce (`AppError::Io { Other }`, `io::Error::other(..)`), so a ported
// command's error behaviour is unchanged. That equivalence is asserted in the
// tests at the bottom of this file rather than assumed.

use crate::host::{HostCtx, HostPathError};

/// [`current_vault_root`] over a host. Same heuristic, same result.
pub fn current_vault_root_from_host(host: &dyn HostCtx) -> Result<PathBuf, HostPathError> {
    Ok(current_vault_root_from_base(&host.app_data_dir()?))
}

/// [`active_vault_root`] over a host.
///
/// When no vault is active the host gets to name its sole vault before the
/// `None` arm's disk scan runs ([`HostCtx::sole_vault_id`], `None` on desktop
/// and mobile so their behaviour is unchanged). The order matters and is not
/// arbitrary: an ACTIVE id always wins, because a host that can hold several
/// vaults and has one open must resolve to the open one. The fallback only
/// speaks when there is nothing to override — which is precisely the pre-unlock
/// window where the scan is both needed and, on `wasm32`, impossible.
pub fn active_vault_root_from_host(
    host: &dyn HostCtx,
    active_id: Option<VaultId>,
) -> Result<PathBuf, HostPathError> {
    Ok(active_vault_root_from_base(
        &host.app_data_dir()?,
        active_id.or_else(|| host.sole_vault_id()),
    ))
}

/// [`active_vault_root_io`] over a host — the `std::io` universe the
/// `notes` / `prefs` / `search` / `attachments` plugins match on.
pub fn active_vault_root_io_from_host(
    host: &dyn HostCtx,
    active_id: Option<VaultId>,
) -> std::io::Result<PathBuf> {
    active_vault_root_from_host(host, active_id)
        .map_err(|_| std::io::Error::other("vault root resolution failed"))
}

/// [`notes_dir_for`] over a host. Ensures the directory exists, like its twin.
///
/// **Not available on wasm32** (myne#299). It ends in `notes_dir_under` →
/// `require_vault_root`, a `Path::is_dir` stat, which on
/// wasm32-unknown-unknown is the unsupported-platform stub and answers `false`
/// for every path — so this compiled cleanly for the browser and then failed at
/// runtime with `NotFound` before touching a single note.
///
/// `note_write_batch_transactional` shipped that way: note rename and folder
/// rename/move were dead on every web client while the identical code worked on
/// desktop, which is exactly the divergence the seam exists to prevent. A
/// runtime `NotFound` is invisible to the compiler, to clippy and to every
/// guard in `scripts/`; a `cfg` is not. Use [`notes_dir_for_host_io`] on any
/// path a browser can reach.
#[cfg(not(target_arch = "wasm32"))]
pub fn notes_dir_for_host(
    host: &dyn HostCtx,
    active_id: Option<VaultId>,
) -> std::io::Result<PathBuf> {
    notes_dir_under(&active_vault_root_io_from_host(host, active_id)?)
}

/// [`notes_dir_for_host`] over the IO seam — the wasm-capable sibling
/// (phase3-web-client task 13).
///
/// Same two steps as [`notes_dir_under`], through [`crate::vault_io::VaultIo`]
/// instead of `std::fs`: confirm the vault root exists, then ensure
/// `<root>/notes/` does. The path arithmetic itself is pure and shared —
/// [`active_vault_root_io_from_host`] touches no filesystem — so the two arms
/// cannot resolve to different directories, which is the property that lets a
/// browser and a desktop client agree about where a note lives.
///
/// The root check is deliberately kept: `notes_dir_under` refuses to create a
/// `notes/` directory under a path that is not a vault root, and dropping that
/// on the web arm would let a mis-resolved root silently materialise an empty
/// vault instead of failing.
pub async fn notes_dir_for_host_io(
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    active_id: Option<VaultId>,
) -> std::io::Result<PathBuf> {
    notes_dir_under_io(io, &active_vault_root_io_from_host(host, active_id)?).await
}

/// [`snapshots_dir_for`] over a host. Ensures the directory exists.
pub fn snapshots_dir_for_host(
    host: &dyn HostCtx,
    active_id: Option<VaultId>,
) -> std::io::Result<PathBuf> {
    snapshots_dir_under(&active_vault_root_io_from_host(host, active_id)?)
}

/// [`vault_root_for_id`] over a host.
pub fn vault_root_for_id_from_host(
    host: &dyn HostCtx,
    id: VaultId,
) -> Result<PathBuf, HostPathError> {
    Ok(vault_root_for_id_from_base(&host.app_data_dir()?, id))
}

/// [`vault_dir_for_id`] over a host. Creates the directory for an explicit id,
/// exactly as the Tauri arm does; the `None` arm resolves a path only.
pub fn vault_dir_for_id_from_host(
    host: &dyn HostCtx,
    vault_id: Option<VaultId>,
) -> std::io::Result<PathBuf> {
    match vault_id {
        Some(id) => {
            let dir = vault_root_for_id_from_host(host, id)
                .map_err(|_| std::io::Error::other("vault root resolution failed"))?;
            std::fs::create_dir_all(&dir)?;
            Ok(dir)
        }
        None => current_vault_root_from_host(host)
            .map_err(|_| std::io::Error::other("vault root resolution failed")),
    }
}

/// [`vault_dir_for_id_from_host`] over the IO seam — the wasm-capable sibling
/// (phase3-web-client task 85).
///
/// Same resolution, same "ensure the directory exists" contract; only the
/// `create_dir_all` moves onto the seam, which is what a browser needs (OPFS
/// creates directories through handle acquisition, not a path call).
pub async fn vault_dir_for_id_from_host_io(
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    vault_id: Option<VaultId>,
) -> std::io::Result<PathBuf> {
    match vault_id {
        Some(id) => {
            let dir = vault_root_for_id_from_host(host, id)
                .map_err(|_| std::io::Error::other("vault root resolution failed"))?;
            io.create_dir_all(&dir)
                .await
                .map_err(|_| std::io::Error::other("create_dir_all failed"))?;
            Ok(dir)
        }
        None => current_vault_root_from_host(host)
            .map_err(|_| std::io::Error::other("vault root resolution failed")),
    }
}

/// [`vault_root_for_id_optional`] over a host — `Some(id)` targets that vault,
/// `None` falls back to the transitional sole-vault resolution, exactly as the
/// Tauri arm does.
pub fn vault_root_for_id_optional_from_host(
    host: &dyn HostCtx,
    vault_id: Option<VaultId>,
) -> Result<PathBuf, HostPathError> {
    match vault_id {
        Some(id) => vault_root_for_id_from_host(host, id),
        None => current_vault_root_from_host(host),
    }
}

/// [`current_vault_id`] over a host.
pub fn current_vault_id_from_host(host: &dyn HostCtx) -> Result<VaultId, HostPathError> {
    Ok(current_vault_id_from_base(&host.app_data_dir()?))
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// TRANSITIONAL (multi-vault sub-feature 2 — SYNC-6): replace with
/// active-VaultId resolution.
///
/// Resolve the SOLE current vault's root directory. Until the multi-slot
/// runtime (sub-feature 2) introduces an active-`VaultId` pointer there is
/// effectively one vault on disk, so this scans `<app_data_dir>/vaults/`
/// and returns the single `<id>/` child present. Resolution order:
///
/// 1. the single `vaults/<id>/` directory whose name parses as a [`VaultId`]
///    (if `vaults/` holds exactly one such child);
/// 2. otherwise the legacy `<app_data_dir>/vault/` (so the app still boots
///    *before* the boot migration of sub-feature task 4 has run);
/// 3. otherwise the conventional fresh-install destination — a freshly
///    *minted* `vaults/<id>/` is NOT created here; instead the legacy
///    `vault/` path is returned as the create destination so a brand-new
///    install behaves exactly as it did pre-change (task 4 owns minting +
///    migration). The directory is created lazily by the resolver that
///    needs it (`vault_dir` / `notes_dir` / …), not here.
///
/// This deliberately holds no runtime state and mints nothing — that is
/// sub-feature 2's job. Returns a path only; never `create_dir_all`s.
pub fn current_vault_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    Ok(current_vault_root_from_base(&app_data_dir(app)?))
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Tauri-aware companion to [`active_vault_root_from_base`]: resolve the active
/// (sole-`Unlocked`) vault's root. `active_id` is read from the runtime state
/// (`VaultRuntimeState::active_vault_id().await`) by the calling command, which
/// is the only place with `.await` access to the slot map. Returns the path
/// only; never `create_dir_all`s. This is the active-vault resolver every
/// command operating on the unlocked vault should use instead of the
/// transitional [`current_vault_root`] sole-vault disk heuristic.
pub fn active_vault_root<R: Runtime>(
    app: &AppHandle<R>,
    active_id: Option<VaultId>,
) -> Result<PathBuf, AppError> {
    Ok(active_vault_root_from_base(&app_data_dir(app)?, active_id))
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// [`active_vault_root`] re-mapped into the [`std::io::Result`] universe the
/// `notes` / `prefs` / `search` / `attachments` plugins match on (mirrors
/// [`current_vault_root_io`]).
pub fn active_vault_root_io<R: Runtime>(
    app: &AppHandle<R>,
    active_id: Option<VaultId>,
) -> std::io::Result<PathBuf> {
    active_vault_root(app, active_id)
        .map_err(|_| std::io::Error::other("vault root resolution failed"))
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Active-vault companion to [`notes_dir`]: resolve `<active-vault-root>/notes/`
/// and ensure it exists. Drop-in for the note commands, which read the active
/// id from the runtime state and thread it here.
pub fn notes_dir_for<R: Runtime>(
    app: &AppHandle<R>,
    active_id: Option<VaultId>,
) -> std::io::Result<PathBuf> {
    notes_dir_under(&active_vault_root_io(app, active_id)?)
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Active-vault companion to [`snapshots_dir`]: resolve
/// `<active-vault-root>/snapshots/` and ensure it exists.
pub fn snapshots_dir_for<R: Runtime>(
    app: &AppHandle<R>,
    active_id: Option<VaultId>,
) -> std::io::Result<PathBuf> {
    snapshots_dir_under(&active_vault_root_io(app, active_id)?)
}

/// TRANSITIONAL (multi-vault sub-feature 2, MYND-203 task 4 — explicit
/// `vault_id` targeting): derive the SOLE current vault's [`VaultId`] from an
/// already-resolved `<app_data_dir>` base.
///
/// Companion to [`current_vault_root_from_base`] — it resolves the same sole
/// vault root, then names it:
///
/// 1. if the resolved root is a `vaults/<id>/` directory, parse `<id>` back
///    into a [`VaultId`] (round-trips by construction — the resolver only
///    returns a child whose name already parsed);
/// 2. otherwise (the legacy `vault/` pre-migration / fresh-install path, which
///    has no UUID in its name), fall back to the fixed [`LEGACY_VAULT_ID_STR`]
///    sentinel so the runtime slot map has a deterministic, stable key.
///
/// This is how the UNLOCK / RECOVER set-sites key the slot map while there is
/// effectively one vault on disk. Task 4 replaces the derivation with an
/// id threaded explicitly through the IPC layer.
pub fn current_vault_id_from_base(base: &Path) -> VaultId {
    vault_id_from_root(&current_vault_root_from_base(base))
}

/// Name a resolved vault ROOT directory (`vaults/<id>/` or the legacy
/// `vault/`) with its [`VaultId`]: parse the directory's file-name back into a
/// `VaultId`, falling back to the [`LEGACY_VAULT_ID_STR`] sentinel when the
/// name is not a UUIDv7 (the legacy `vault/` case). Used by set-sites that
/// already hold the resolved root and want to avoid a second `vaults/` scan.
///
/// TRANSITIONAL (sub-feature task 4): superseded by explicit id threading.
pub fn vault_id_from_root(root: &Path) -> VaultId {
    root.file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| VaultId::parse(n).ok())
        .unwrap_or_else(legacy_vault_id)
}

/// Resolve the vault ROOT for an EXPLICIT [`VaultId`] from an already-resolved
/// `<app_data_dir>` base: `<base>/vaults/<id>/`.
///
/// This is the targeting counterpart to [`current_vault_root_from_base`] (which
/// resolves the *sole* vault transitionally): a caller that already knows WHICH
/// vault it wants (sub-feature 3's picker passes the chosen id) joins the
/// canonical `<id>` directory name directly, bypassing the sole-vault scan.
/// `VaultId`'s strict parse contract guarantees `id.to_string()` is a safe path
/// component (no traversal / case-folding), so the join is sound.
///
/// `pub` so the unlock / recover / create targeting wrappers — each with
/// its own error universe — can map their own `app_data_dir` lookup and then
/// layer this pure join on top.
pub fn vault_root_for_id_from_base(base: &Path, id: VaultId) -> PathBuf {
    base.join(VAULTS_DIR_NAME).join(id.to_string())
}

/// Resolve the **active** vault's root — the SYNC-6 "implicit active vault"
/// resolution that replaces the transitional disk-heuristic
/// [`current_vault_root_from_base`] for every command operating on the unlocked
/// vault. `active_id` is the sole-`Unlocked` slot key the caller reads from
/// `VaultRuntimeState::active_vault_id`:
///
/// - `Some(id)` → `<base>/vaults/<id>/` (the unlocked vault — the only correct
///   answer once two or more vaults exist on disk).
/// - `None` → the legacy sole-vault fallback. Reached only when nothing is
///   unlocked (or a pre-migration single `vault/`); preserves today's behaviour
///   for the single-vault install where the disk heuristic is unambiguous.
///
/// The disk-heuristic fallback resolved to a *non-existent legacy path* once a
/// second vault appeared — so prefs / notes / snapshots / search / attachments
/// all silently mis-resolved for the non-first vault. Routing those callers
/// through the active id fixes that class of bug at its root.
pub fn active_vault_root_from_base(base: &Path, active_id: Option<VaultId>) -> PathBuf {
    match active_id {
        Some(id) => vault_root_for_id_from_base(base, id),
        None => current_vault_root_from_base(base),
    }
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Tauri-aware companion to [`vault_root_for_id_from_base`]: resolve
/// `<app_data_dir>/vaults/<id>/` for an explicit [`VaultId`]. Returns the path
/// only; never `create_dir_all`s (the write-path resolvers own creation).
///
/// Used by the unlock / recover / create TARGETING wrappers (sub-feature 2
/// task 4) when the IPC layer carries an explicit `vault_id`. When the IPC
/// layer carries no id the wrappers keep using the sole-vault
/// [`current_vault_root`] fallback.
pub fn vault_root_for_id<R: Runtime>(app: &AppHandle<R>, id: VaultId) -> Result<PathBuf, AppError> {
    Ok(vault_root_for_id_from_base(&app_data_dir(app)?, id))
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// TRANSITIONAL (multi-vault sub-feature 2, MYND-203 task 4): the Tauri-aware
/// companion to [`current_vault_id_from_base`]. Resolves `<app_data_dir>` then
/// derives the sole vault's [`VaultId`] (a real parsed id for a `vaults/<id>/`
/// root, else the [`LEGACY_VAULT_ID_STR`] sentinel). Used by the unlock /
/// recover set-sites to key the runtime slot map.
///
/// Dead in the non-test build until task 4 threads it through the IPC layer;
/// the unlock / recover set-sites currently derive the id from the already-
/// resolved vault root via [`vault_id_from_root`], not through an `AppHandle`.
#[allow(dead_code)]
pub fn current_vault_id<R: Runtime>(app: &AppHandle<R>) -> Result<VaultId, AppError> {
    Ok(current_vault_id_from_base(&app_data_dir(app)?))
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Resolve the vault directory for an OPTIONAL explicit [`VaultId`] and ensure
/// it exists — the CREATE-flow targeting resolver (sub-feature 2 task 4,
/// SYNC-6 create targeting). `vault_creation::commit` is its ONLY intended
/// caller: creating a vault root is exclusively the create / restore /
/// migration flows' privilege. Every other command resolves through the
/// non-creating [`vault_root_for_id_optional`] — a resolver `create_dir_all`
/// side effect on a probe path is what materialized the empty legacy `vault/`
/// behind the 2026-06-11 data-loss incident (MYND-253).
///
/// - `Some(id)` → `<app_data_dir>/vaults/<id>/`, `create_dir_all`'d (the
///   create flow passes the minted/chosen id).
/// - `None` → the sole-vault fallback path ([`vault_dir_path`]), returned
///   WITHOUT creating it. In the create flow this arm is reachable only with
///   an absent/expired session, where commit fails at the session take
///   before any write — so nothing legitimate ever needs the legacy dir
///   materialized here.
pub fn vault_dir_for_id<R: Runtime>(
    app: &AppHandle<R>,
    vault_id: Option<VaultId>,
) -> Result<PathBuf, AppError> {
    match vault_id {
        Some(id) => {
            let dir = vault_root_for_id(app, id)?;
            std::fs::create_dir_all(&dir)?;
            Ok(dir)
        }
        // sole-vault fallback until picker (sub-feature 3) — path only.
        None => vault_dir_path(app),
    }
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Resolve the vault directory for an OPTIONAL explicit [`VaultId`] **without
/// creating anything** — the targeting resolver for every command that reads
/// or destroys an EXISTING vault (`vault_delete`, `vault_export_backup`).
///
/// - `Some(id)` → `<app_data_dir>/vaults/<id>/` (path only; a stale or
///   forged IPC id resolves to a non-existent path the caller's own probe —
///   `vault.meta` check / delete scan — turns into a clean `VaultNotFound`,
///   instead of materializing an empty `vaults/<bogus-id>/` that discovery
///   would flag `Corrupted`).
/// - `None` → the sole-vault fallback ([`vault_dir_path`]).
pub fn vault_root_for_id_optional<R: Runtime>(
    app: &AppHandle<R>,
    vault_id: Option<VaultId>,
) -> Result<PathBuf, AppError> {
    match vault_id {
        Some(id) => vault_root_for_id(app, id),
        None => vault_dir_path(app),
    }
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Resolve the vault directory path **without creating it**.
///
/// Used by read-only probes — `vault_repair`'s residue scan (MYND-159) —
/// and by the `None` arms of the targeting resolvers above: nothing outside
/// the create / restore / migration flows may materialize a vault directory
/// as a side effect (the 2026-06-11 incident class, MYND-253).
pub fn vault_dir_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    // TRANSITIONAL (multi-vault sub-feature 2 — SYNC-6): replace with
    // active-VaultId resolution.
    current_vault_root(app)
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Resolve `<vault-root>/notes/` and ensure it exists. The returned
/// `PathBuf` points at `<current-vault-root>/notes/` and the directory is
/// `create_dir_all`'d before return.
///
/// Returns [`std::io::Result`] (rather than [`AppError`]) so the
/// `notes` plugin's commands can match on [`std::io::ErrorKind`] — the
/// file-at-notes-path conflict is special-cased into
/// `NoteCreateError::NotesDirNotADirectory`. The `vault_creation`'s
/// `AppError` shape collapses kind information into `IoErrorKind::Other`,
/// which would lose that signal.
///
/// Idempotent: a second call on the same `app` is a no-op. The vault ROOT
/// must already exist — child resolvers never create vault roots (the
/// 2026-06-11 incident class, MYND-253); a missing root surfaces as
/// `NotFound` instead of being silently materialized.
///
/// Tested via the lower-level [`notes_dir_under`] helper (which takes a
/// base path directly, allowing `ScopedTempDir` exercise without
/// `tauri::test::mock_app_builder`).
///
/// Superseded by [`notes_dir_for`] (active-VaultId resolution, SYNC-6) at every
/// command call site; retained as the sole-vault companion to the explicit-id
/// resolver until the transitional `current_vault_root*` heuristics are removed.
#[allow(dead_code)]
pub fn notes_dir<R: Runtime>(app: &AppHandle<R>) -> std::io::Result<PathBuf> {
    notes_dir_under(&current_vault_root_io(app)?)
}

/// Pure helper — joins `parent` with `"notes"` and `create_dir_all`s
/// the result. Used by [`notes_dir`] (Tauri-aware caller) and tests.
///
/// `parent` is the vault root (`vaults/<id>/`) in production; tests pass a
/// `ScopedTempDir` path so `notes_dir`'s behavior can be exercised
/// without spinning up a Tauri runtime.
///
/// The root itself must already exist ([`require_vault_root`]) — only the
/// `notes/` child is ever created here.
pub fn notes_dir_under(parent: &Path) -> std::io::Result<PathBuf> {
    require_vault_root(parent)?;
    let dir = parent.join("notes");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// [`notes_dir_under`] over the IO seam — the wasm-capable twin.
///
/// Same two steps, same order, same refusal: the vault root must already exist
/// (never materialize a phantom root — the 2026-06-11 incident class), and only
/// the `notes/` child is created.
///
/// It exists because `notes_dir_under` is `std::fs` all the way down, and its
/// root check is `Path::is_dir`, which on `wasm32-unknown-unknown` is the
/// unsupported-platform stub and answers `false` for every path. So a browser
/// caller does not fail to compile — it fails at runtime with `NotFound`,
/// before touching anything. That is precisely how the MYS1 search index
/// managed to never hydrate and never persist on the web client while both
/// hooks' doc comments said "implemented" (myne#303): the `NotFound` became a
/// `SearchSyncError::Io` and the best-effort caller swallowed it as a
/// `tracing::warn!`.
///
/// `notes_dir_under` keeps its callers (the native-only resolvers and the tests
/// that exercise it under a `ScopedTempDir`); anything a browser can reach uses
/// this.
pub async fn notes_dir_under_io(
    io: &dyn crate::vault_io::VaultIo,
    parent: &Path,
) -> std::io::Result<PathBuf> {
    if !io
        .exists(parent)
        .await
        .map_err(|_| std::io::Error::other("vault root probe failed"))?
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "vault root does not exist",
        ));
    }
    let dir = parent.join("notes");
    io.create_dir_all(&dir)
        .await
        .map_err(|_| std::io::Error::other("notes dir creation failed"))?;
    Ok(dir)
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Resolve `<vault-root>/snapshots/` and ensure it exists (MYND-96 encrypted
/// per-note version history; `spec/protocol.md` §9.1). Mirrors [`notes_dir`] —
/// the flat snapshots directory is a sibling of `notes/`, never nested inside
/// it (the flat-notes invariant, MYND-144). Returns [`std::io::Result`] so the
/// notes write-path hook can map IO failure kinds without losing signal.
///
/// Superseded by [`snapshots_dir_for`] (active-VaultId resolution, SYNC-6) at
/// every command call site; retained as the sole-vault companion to the
/// explicit-id resolver until the transitional `current_vault_root*` heuristics
/// are removed.
#[allow(dead_code)]
pub fn snapshots_dir<R: Runtime>(app: &AppHandle<R>) -> std::io::Result<PathBuf> {
    snapshots_dir_under(&current_vault_root_io(app)?)
}

/// Pure helper — joins `parent` with `"snapshots"` and `create_dir_all`s the
/// result. Used by [`snapshots_dir`] (Tauri-aware caller) and tests (which pass
/// a `ScopedTempDir` path to exercise behavior without a Tauri runtime).
///
/// The root itself must already exist ([`require_vault_root`]) — only the
/// `snapshots/` child is ever created here.
pub fn snapshots_dir_under(parent: &Path) -> std::io::Result<PathBuf> {
    require_vault_root(parent)?;
    let dir = parent.join("snapshots");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Guard for the child-directory resolvers: the vault ROOT must already
/// exist. Child resolvers never create vault roots — a recursive
/// `create_dir_all` here once materialized a phantom vault root for a
/// locked/absent vault, the trigger class of the 2026-06-11 data-loss
/// incident (MYND-253). Vault roots are created only by the create /
/// restore / migration flows.
fn require_vault_root(parent: &Path) -> std::io::Result<()> {
    if parent.is_dir() {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "vault root does not exist",
        ))
    }
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// [`current_vault_root`] re-mapped into the `std::io::Result` universe the
/// notes / snapshots resolvers use. The `AppError::Io` → `io::Error` bridge
/// drops kind detail (it is only `Other` here, an `app_data_dir` lookup
/// failure), which is acceptable: the downstream IO-kind signal these
/// callers care about comes from the `create_dir_all` in the `*_under`
/// helper, not from path resolution.
///
/// Now only feeds the superseded sole-vault [`notes_dir`] / [`snapshots_dir`]
/// wrappers (their active-VaultId companions go through [`active_vault_root_io`]
/// instead); retained alongside them until the transitional heuristics are removed.
#[allow(dead_code)]
fn current_vault_root_io<R: Runtime>(app: &AppHandle<R>) -> std::io::Result<PathBuf> {
    current_vault_root(app).map_err(|_| std::io::Error::other("vault root resolution failed"))
}

#[cfg(test)]
mod tests {
    /// The web's single-vault id is a CONSTANT, distinct from the legacy
    /// sentinel, and a valid `VaultId`.
    ///
    /// All three properties are load-bearing (task 85). Constant is what makes
    /// re-running the first-run bootstrap idempotent — "never mints a second
    /// container" holds by construction rather than by a check — and what keeps
    /// the `VaultId` on the unlock stage payload stable across reloads.
    /// DISTINCT from the legacy sentinel because that one means "a migrated
    /// pre-multi-vault install"; colliding them would make a fresh browser
    /// bootstrap look like a migration to any code that branches on it.
    #[test]
    fn the_web_single_vault_id_is_a_stable_distinct_constant() {
        let a = super::web_single_vault_id();
        let b = super::web_single_vault_id();
        assert_eq!(
            a, b,
            "must be stable across calls — it is the container key"
        );
        assert_ne!(
            a,
            super::legacy_vault_id(),
            "must not collide with the legacy-migration sentinel"
        );
        // Round-trips through the string form the path layer uses.
        assert_eq!(
            crate::vault_id::VaultId::parse(&a.to_string()).expect("valid VaultId"),
            a
        );
    }

    use super::*;
    use crate::test_support::ScopedTempDir;

    // ---- notes_dir_under: happy paths ----------------------------------

    #[test]
    fn notes_dir_under_creates_on_first_call() {
        let tmp = ScopedTempDir::new("notes-dir-first").unwrap();
        let result = notes_dir_under(tmp.path()).unwrap();
        assert!(result.is_dir(), "result must be an existing directory");
        assert_eq!(result, tmp.path().join("notes"));
    }

    #[test]
    fn notes_dir_under_returns_canonical_join() {
        let tmp = ScopedTempDir::new("notes-dir-canonical").unwrap();
        let result = notes_dir_under(tmp.path()).unwrap();
        assert_eq!(result, tmp.path().join("notes"));
        assert!(result.starts_with(tmp.path()));
        assert_eq!(result.file_name().expect("filename"), "notes");
    }

    #[test]
    fn notes_dir_under_rejects_missing_parent_without_creating_it() {
        // Child resolvers never create vault roots (MYND-253): a missing
        // `vaults/<id>/` root must surface as NotFound, and NOTHING may be
        // materialized — the recursive-create behavior this test used to
        // pin is the trigger class of the 2026-06-11 data-loss incident.
        let tmp = ScopedTempDir::new("notes-dir-no-root").unwrap();
        let nested_parent = tmp
            .path()
            .join("vaults")
            .join("vault-that-doesnt-exist-yet");

        let err = notes_dir_under(&nested_parent)
            .expect_err("a missing vault root must be rejected, not created");
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
        assert!(
            !nested_parent.exists(),
            "the resolver must not materialize the vault root"
        );

        // Same contract for the snapshots sibling.
        let err = snapshots_dir_under(&nested_parent)
            .expect_err("a missing vault root must be rejected, not created");
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
        assert!(!nested_parent.exists());
    }

    // ---- notes_dir_under_io: the seam twin (myne#303) -------------------
    //
    // A `VaultIo` whose namespace `std::fs` cannot see. Every byte still lands
    // on a real temp directory through `StdVaultIo`; only the PATHS the caller
    // uses are virtual, rebased onto that directory on the way in.
    //
    // That is exactly the wasm32 condition, reproduced on the host: `io.exists`
    // says the vault root is there, `Path::is_dir` says it is not. It is the
    // whole reason `notes_dir_under` could compile for the browser and then
    // fail at runtime with `NotFound` before touching a single note — which is
    // how the MYS1 search index came to never hydrate and never persist on the
    // web client, with both hooks' doc comments claiming otherwise.
    struct Rebased {
        virt: PathBuf,
        real: PathBuf,
    }

    impl Rebased {
        fn at(&self, p: &Path) -> PathBuf {
            match p.strip_prefix(&self.virt) {
                Ok(rest) => self.real.join(rest),
                // Outside the virtual root: leave it alone, so a leaked
                // real path in a test failure is obvious rather than silently
                // rewritten.
                Err(_) => p.to_path_buf(),
            }
        }
    }

    #[async_trait::async_trait]
    impl crate::vault_io::VaultIo for Rebased {
        async fn read(&self, p: &Path) -> crate::vault_io::IoResult<Vec<u8>> {
            crate::vault_io::StdVaultIo.read(&self.at(p)).await
        }
        async fn read_prefix(&self, p: &Path, n: usize) -> crate::vault_io::IoResult<Vec<u8>> {
            crate::vault_io::StdVaultIo
                .read_prefix(&self.at(p), n)
                .await
        }
        async fn write(
            &self,
            p: &Path,
            b: &[u8],
            o: crate::vault_io::WriteOpts,
        ) -> crate::vault_io::IoResult<()> {
            crate::vault_io::StdVaultIo.write(&self.at(p), b, o).await
        }
        async fn remove_file(&self, p: &Path) -> crate::vault_io::IoResult<()> {
            crate::vault_io::StdVaultIo.remove_file(&self.at(p)).await
        }
        async fn remove_dir_all(&self, p: &Path) -> crate::vault_io::IoResult<()> {
            crate::vault_io::StdVaultIo
                .remove_dir_all(&self.at(p))
                .await
        }
        async fn create_dir_all(&self, p: &Path) -> crate::vault_io::IoResult<()> {
            crate::vault_io::StdVaultIo
                .create_dir_all(&self.at(p))
                .await
        }
        async fn read_dir(
            &self,
            p: &Path,
        ) -> crate::vault_io::IoResult<Vec<crate::vault_io::DirEntry>> {
            crate::vault_io::StdVaultIo.read_dir(&self.at(p)).await
        }
        async fn exists(&self, p: &Path) -> crate::vault_io::IoResult<bool> {
            crate::vault_io::StdVaultIo.exists(&self.at(p)).await
        }
        async fn is_dir(&self, p: &Path) -> crate::vault_io::IoResult<bool> {
            crate::vault_io::StdVaultIo.is_dir(&self.at(p)).await
        }
        async fn rename(&self, a: &Path, b: &Path) -> crate::vault_io::IoResult<()> {
            crate::vault_io::StdVaultIo
                .rename(&self.at(a), &self.at(b))
                .await
        }
    }

    #[test]
    fn notes_dir_under_io_resolves_a_root_only_the_seam_can_see() {
        let tmp = ScopedTempDir::new("notes-dir-io").unwrap();
        let virt = PathBuf::from("/myne-virtual/vaults/v1");
        let io = Rebased {
            virt: virt.clone(),
            real: tmp.path().to_path_buf(),
        };

        crate::test_support::block_on(async {
            // The std::fs twin cannot see this root at all — the wasm32
            // behaviour, on the host.
            let err = notes_dir_under(&virt).expect_err("std::fs must not see a virtual root");
            assert_eq!(err.kind(), std::io::ErrorKind::NotFound);

            let dir = notes_dir_under_io(&io, &virt)
                .await
                .expect("the seam twin must resolve it");
            assert_eq!(dir, virt.join("notes"));
            assert!(
                tmp.path().join("notes").is_dir(),
                "…and must really have created the child"
            );
            // Idempotent, like its twin.
            assert_eq!(notes_dir_under_io(&io, &virt).await.unwrap(), dir);
        });
    }

    #[test]
    fn notes_dir_under_io_refuses_a_missing_root_without_creating_it() {
        // The refusal `notes_dir_under` exists to make (MYND-253) survives the
        // port: a child resolver never materializes a vault root, so a
        // mis-resolved root fails loudly instead of producing an empty vault.
        let tmp = ScopedTempDir::new("notes-dir-io-noroot").unwrap();
        let virt = PathBuf::from("/myne-virtual/vaults/absent");
        let io = Rebased {
            virt: virt.clone(),
            // Points at a subdirectory that does not exist.
            real: tmp.path().join("nothing-here"),
        };
        crate::test_support::block_on(async {
            let err = notes_dir_under_io(&io, &virt)
                .await
                .expect_err("a missing vault root must be rejected, not created");
            assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
            assert!(!tmp.path().join("nothing-here").exists());
        });
    }

    /// The search-index hooks must reach the notes directory through the seam.
    ///
    /// Source-level because no native test can see the difference: on the host
    /// both helpers work, and the divergence only appears on wasm32, where
    /// `Path::is_dir` is the unsupported-platform stub. That is what let the
    /// std::fs helper sit in a fully-ported module for a whole release while
    /// the doc comments on both hooks said "implemented".
    #[test]
    fn the_wasm_reachable_modules_do_not_call_the_std_fs_path_helpers() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for rel in [
            "src/plugins/notes/search_sync_core.rs",
            "../web/wasm/src/dispatch.rs",
        ] {
            let text = std::fs::read_to_string(root.join(rel)).unwrap_or_else(|e| {
                panic!("read {rel}: {e}");
            });
            for (i, line) in text.lines().enumerate() {
                let code = line.split("//").next().unwrap_or("");
                assert!(
                    !code.contains("notes_dir_under(") && !code.contains("snapshots_dir_under("),
                    "{rel}:{} calls a std::fs path helper; use the `_io` twin \
                     (it returns NotFound for every path on wasm32)",
                    i + 1
                );
            }
        }
    }

    // ---- notes_dir_under: file-at-notes-path defensive -----------------
    //
    // When the user has manually placed a file at `<parent>/notes`
    // (OS-level manipulation of the vault directory), `create_dir_all`
    // surfaces the conflict via an IO error. The exact `io::ErrorKind`
    // depends on platform + Rust version: stable Rust ≥ 1.83 returns
    // `NotADirectory` on Unix; older Rust + Windows may return
    // `AlreadyExists`. The notes mapping accepts either via
    // `matches!(io_kind, NotADirectory | AlreadyExists)` →
    // `NotesDirNotADirectory`.

    #[test]
    fn notes_dir_under_errors_when_path_is_a_file() {
        let tmp = ScopedTempDir::new("notes-dir-file-conflict").unwrap();
        let conflict = tmp.path().join("notes");
        std::fs::write(&conflict, b"hostile").unwrap();

        let err = notes_dir_under(tmp.path())
            .expect_err("create_dir_all must reject when <parent>/notes is a regular file");

        let kind = err.kind();
        assert!(
            matches!(
                kind,
                std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists
            ),
            "expected NotADirectory or AlreadyExists, got {kind:?}"
        );

        // Pre-existing file bytes are untouched — the helper rejected
        // before any directory mutation happened.
        let bytes = std::fs::read(&conflict).unwrap();
        assert_eq!(bytes, b"hostile");
    }

    // ---- snapshots_dir_under: sibling of notes/ ------------------------

    #[test]
    fn snapshots_dir_under_creates_sibling_of_notes() {
        let tmp = ScopedTempDir::new("snap-dir-sibling").unwrap();
        let notes = notes_dir_under(tmp.path()).unwrap();
        let snaps = snapshots_dir_under(tmp.path()).unwrap();
        assert!(snaps.is_dir());
        assert_eq!(snaps, tmp.path().join("snapshots"));
        // snapshots/ is a sibling of notes/, never nested inside it.
        assert!(!snaps.starts_with(&notes));
        assert_eq!(snaps.parent(), notes.parent());
    }

    // ---- current_vault_root_from_base (transitional resolver) ----------
    //
    // Exercises the sole-vault scan + legacy/fresh-install fallback that
    // sub-feature 2 will replace with active-VaultId resolution. The
    // `app_data_dir` lookup is the caller's, so these pass a base dir
    // directly.

    #[test]
    fn current_vault_root_falls_back_to_legacy_when_vaults_dir_absent() {
        // Fresh install: no `vaults/` dir at all → legacy `vault/`
        // (the create destination, byte-for-byte pre-change behavior).
        let tmp = ScopedTempDir::new("cvr-fresh").unwrap();
        let root = current_vault_root_from_base(tmp.path());
        assert_eq!(root, tmp.path().join(LEGACY_VAULT_DIR_NAME));
    }

    #[test]
    fn current_vault_root_falls_back_to_legacy_when_vaults_dir_empty() {
        let tmp = ScopedTempDir::new("cvr-empty").unwrap();
        std::fs::create_dir_all(tmp.path().join(VAULTS_DIR_NAME)).unwrap();
        let root = current_vault_root_from_base(tmp.path());
        assert_eq!(root, tmp.path().join(LEGACY_VAULT_DIR_NAME));
    }

    #[test]
    fn current_vault_root_returns_legacy_dir_when_present_pre_migration() {
        // Pre-migration boot: only the legacy `vault/` exists.
        let tmp = ScopedTempDir::new("cvr-legacy").unwrap();
        let legacy = tmp.path().join(LEGACY_VAULT_DIR_NAME);
        std::fs::create_dir_all(&legacy).unwrap();
        let root = current_vault_root_from_base(tmp.path());
        assert_eq!(root, legacy);
    }

    #[test]
    fn current_vault_root_returns_the_sole_vaults_child() {
        let tmp = ScopedTempDir::new("cvr-single").unwrap();
        let id = VaultId::mint().to_string();
        let vault = tmp.path().join(VAULTS_DIR_NAME).join(&id);
        std::fs::create_dir_all(&vault).unwrap();
        let root = current_vault_root_from_base(tmp.path());
        assert_eq!(root, vault);
        assert_eq!(root.file_name().unwrap().to_str().unwrap(), id);
    }

    #[test]
    fn current_vault_root_ignores_non_vaultid_children() {
        // A stray non-UUID dir (e.g. a Tauri scratch dir) under `vaults/`
        // must not be mistaken for a vault; with no real vault present we
        // fall back to legacy.
        let tmp = ScopedTempDir::new("cvr-stray").unwrap();
        std::fs::create_dir_all(tmp.path().join(VAULTS_DIR_NAME).join("not-a-vault")).unwrap();
        let root = current_vault_root_from_base(tmp.path());
        assert_eq!(root, tmp.path().join(LEGACY_VAULT_DIR_NAME));
    }

    #[test]
    fn current_vault_root_falls_through_when_multiple_vaults_present() {
        // Ambiguous: two well-formed vault dirs. The transitional resolver
        // does NOT pick one (sub-feature 2 owns disambiguation); it falls
        // back to the legacy path rather than guessing.
        let tmp = ScopedTempDir::new("cvr-multi").unwrap();
        for _ in 0..2 {
            let v = tmp
                .path()
                .join(VAULTS_DIR_NAME)
                .join(VaultId::mint().to_string());
            std::fs::create_dir_all(&v).unwrap();
        }
        let root = current_vault_root_from_base(tmp.path());
        assert_eq!(root, tmp.path().join(LEGACY_VAULT_DIR_NAME));
    }

    // ---- current_vault_id / vault_id_from_root (transitional id resolver) ---

    #[test]
    fn current_vault_id_returns_the_sole_vaults_child_id() {
        // A single well-formed `vaults/<id>/` child resolves to that id.
        let tmp = ScopedTempDir::new("cvid-single").unwrap();
        let id = VaultId::mint();
        std::fs::create_dir_all(tmp.path().join(VAULTS_DIR_NAME).join(id.to_string())).unwrap();
        assert_eq!(current_vault_id_from_base(tmp.path()), id);
    }

    #[test]
    fn current_vault_id_falls_back_to_legacy_sentinel_pre_migration() {
        // No `vaults/<id>/` child → the resolver returns the legacy `vault/`
        // root, which has no UUID name → the fixed legacy sentinel id.
        let tmp = ScopedTempDir::new("cvid-legacy").unwrap();
        std::fs::create_dir_all(tmp.path().join(LEGACY_VAULT_DIR_NAME)).unwrap();
        assert_eq!(current_vault_id_from_base(tmp.path()), legacy_vault_id());
    }

    // ---- vault_root_for_id_from_base (explicit-id targeting) -----------

    #[test]
    fn vault_root_for_id_from_base_joins_vaults_child() {
        // The explicit-id resolver joins `<base>/vaults/<id>/` directly,
        // bypassing the sole-vault scan — and round-trips back to the id.
        let tmp = ScopedTempDir::new("vrfid").unwrap();
        let id = VaultId::mint();
        let root = vault_root_for_id_from_base(tmp.path(), id);
        assert_eq!(root, tmp.path().join(VAULTS_DIR_NAME).join(id.to_string()));
        assert_eq!(
            vault_id_from_root(&root),
            id,
            "an explicit-id root must name back to that id"
        );
    }

    #[test]
    fn vault_root_for_id_from_base_targets_named_vault_among_several() {
        // With TWO vaults on disk (where the sole-vault resolver would
        // ambiguously fall through to legacy), the explicit-id resolver
        // targets the NAMED one precisely.
        let tmp = ScopedTempDir::new("vrfid-multi").unwrap();
        let id_a = VaultId::mint();
        let id_b = VaultId::mint();
        for id in [id_a, id_b] {
            std::fs::create_dir_all(tmp.path().join(VAULTS_DIR_NAME).join(id.to_string())).unwrap();
        }
        // Sole-vault resolver is ambiguous here → legacy fallback.
        assert_eq!(
            current_vault_root_from_base(tmp.path()),
            tmp.path().join(LEGACY_VAULT_DIR_NAME)
        );
        // Explicit-id resolver reaches exactly the named vault.
        assert_eq!(
            vault_root_for_id_from_base(tmp.path(), id_b),
            tmp.path().join(VAULTS_DIR_NAME).join(id_b.to_string())
        );
    }

    #[test]
    fn vault_id_from_root_parses_vaults_child_name_else_legacy_sentinel() {
        // A `vaults/<id>/` root parses back to its id; a non-UUID root
        // (legacy `vault/`) falls back to the legacy sentinel.
        let id = VaultId::mint();
        let vaults_child = Path::new("/somewhere/vaults").join(id.to_string());
        assert_eq!(vault_id_from_root(&vaults_child), id);
        assert_eq!(
            vault_id_from_root(Path::new("/somewhere/vault")),
            legacy_vault_id()
        );
    }

    #[test]
    fn legacy_vault_id_is_a_stable_valid_v7() {
        // Deterministic + re-parses; two calls agree.
        assert_eq!(legacy_vault_id(), legacy_vault_id());
        assert_eq!(legacy_vault_id().as_uuid().get_version_num(), 7);
    }

    // ── the host arm computes the same paths as the Tauri arm ────────────────
    //
    // The `*_from_host` resolvers are one-line delegations over the pure
    // `*_from_base` helpers, so asserting the two agree would be a tautology
    // (removed, myne-md/myne#802). What is checked below is the host-only
    // behaviour a delegation cannot express: the sole-vault fallback, its
    // override by an active id, directory creation, and the error shape.

    use crate::host::test_host::TestHost;
    use crate::host::{HostCtx, NoopHost};

    /// A host that names a sole vault, the way the browser's `WebHost` does.
    struct SoleVaultHost {
        inner: TestHost,
        sole: VaultId,
    }

    impl HostCtx for SoleVaultHost {
        fn app_data_dir(&self) -> Result<PathBuf, HostPathError> {
            self.inner.app_data_dir()
        }
        fn app_config_dir(&self) -> Result<PathBuf, HostPathError> {
            self.inner.app_config_dir()
        }
        fn emit(&self, _event: &'static str, _payload: crate::host::EventPayload) {}
        fn now_unix_millis(&self) -> u64 {
            0
        }
        fn monotonic_millis(&self) -> u64 {
            0
        }
        fn sole_vault_id(&self) -> Option<VaultId> {
            Some(self.sole)
        }
    }

    /// The pre-unlock window: `active_id` is `None`, and a host that owns
    /// exactly one vault must still resolve to THAT vault rather than to the
    /// legacy directory the disk-scan arm falls back to.
    ///
    /// This is the browser's whole problem in one assertion. There,
    /// `current_vault_root_from_base`'s `std::fs::read_dir` always errors, so
    /// the scan silently yields the legacy path and every pre-unlock read
    /// reports an absent vault. Asserting against `vaults/<sole>/`
    /// **explicitly** — rather than against whatever the default arm returns —
    /// is what makes this test fail if the `or_else` is ever dropped.
    #[test]
    fn a_sole_vault_host_resolves_to_its_own_vault_when_none_is_active() {
        let tmp = ScopedTempDir::new("sole-vault-host").unwrap();
        let sole = VaultId::mint();
        let host = SoleVaultHost {
            inner: TestHost::with_dirs(tmp.path(), tmp.path().join("config")),
            sole,
        };
        let base = host.app_data_dir().unwrap();

        assert_eq!(
            active_vault_root_from_host(&host, None).unwrap(),
            vault_root_for_id_from_base(&base, sole),
            "a host that names a sole vault must resolve to it before the disk scan"
        );
        assert_ne!(
            active_vault_root_from_host(&host, None).unwrap(),
            current_vault_root_from_base(&base),
            "resolving to the scan's answer is the bug, not an equivalent result"
        );
    }

    /// An ACTIVE id outranks the fallback. A host that can hold several vaults
    /// and has one open must resolve to the open one — otherwise this fix would
    /// pin every read to the sole id even after a different vault was unlocked.
    #[test]
    fn an_active_id_outranks_the_sole_vault_fallback() {
        let tmp = ScopedTempDir::new("sole-vault-override").unwrap();
        let sole = VaultId::mint();
        let active = VaultId::mint();
        assert_ne!(sole, active);
        let host = SoleVaultHost {
            inner: TestHost::with_dirs(tmp.path(), tmp.path().join("config")),
            sole,
        };
        let base = host.app_data_dir().unwrap();

        assert_eq!(
            active_vault_root_from_host(&host, Some(active)).unwrap(),
            vault_root_for_id_from_base(&base, active)
        );
    }

    #[test]
    fn host_dir_resolvers_create_the_directory_like_their_tauri_twins() {
        // `notes_dir_under` / `snapshots_dir_under` `create_dir_all`. The host
        // arm must inherit that, not just the path arithmetic — a resolver that
        // returned the right path without ensuring it would fail on first write.
        let tmp = ScopedTempDir::new("host-dir-create").unwrap();
        let host = TestHost::with_dirs(tmp.path(), tmp.path().join("config"));
        let id = VaultId::mint();
        // The vault root must exist for `require_vault_root` to accept it.
        let root = active_vault_root_from_host(&host, Some(id)).unwrap();
        std::fs::create_dir_all(&root).unwrap();

        let notes = notes_dir_for_host(&host, Some(id)).unwrap();
        assert!(notes.is_dir(), "notes dir should have been created");
        let snaps = snapshots_dir_for_host(&host, Some(id)).unwrap();
        assert!(snaps.is_dir(), "snapshots dir should have been created");
    }

    #[test]
    fn a_host_that_cannot_resolve_fails_the_same_shape_the_tauri_arm_does() {
        // The Tauri arms collapse an `app_data_dir()` failure to one opaque
        // variant; the host arms must do the same, or a ported command's error
        // behaviour changes.
        let host = NoopHost;
        assert!(current_vault_root_from_host(&host).is_err());
        assert!(active_vault_root_from_host(&host, None).is_err());
        let io_err = active_vault_root_io_from_host(&host, None).unwrap_err();
        assert_eq!(io_err.to_string(), "vault root resolution failed");
    }
}
