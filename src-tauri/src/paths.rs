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

use crate::plugins::vault_creation::error::AppError;
use crate::vault_id::VaultId;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

/// Top-level directory holding every `<VaultId>/` vault root.
pub(crate) const VAULTS_DIR_NAME: &str = "vaults";

/// Legacy single-vault directory name (pre-`vaults/<id>/` layout). The
/// boot migration (sub-feature task 4) renames this into `vaults/<id>/`;
/// until then [`current_vault_root`] still accepts it so the app boots
/// pre-migration.
pub(crate) const LEGACY_VAULT_DIR_NAME: &str = "vault";

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

/// The fixed legacy-vault sentinel [`VaultId`] (see [`LEGACY_VAULT_ID_STR`]).
/// Used as a deterministic fallback key when no real `VaultId` is in play —
/// e.g. the active-vault read helpers when no vault is unlocked (the keyed
/// entry is absent → `Slot::Empty`). TRANSITIONAL (sub-feature task 4).
pub(crate) fn legacy_vault_id() -> VaultId {
    VaultId::parse(LEGACY_VAULT_ID_STR).expect("LEGACY_VAULT_ID_STR is a valid UUIDv7")
}

/// Resolve `<app_data_dir>` for the running app, mapping a failure to
/// the `vault_creation` plugin's [`AppError`] shape.
///
/// `pub(crate)` so `vault_creation::begin` can resolve the base it needs to
/// mint a fresh, collision-free [`VaultId`] (`vault_registry::mint_unique_vault_id`)
/// into the creation session (SYNC-6 create targeting — every vault, first or
/// Nth, lands at a freshly-minted `vaults/<id>/`).
pub(crate) fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    app.path().app_data_dir().map_err(|_| AppError::Io {
        kind: crate::plugins::vault_creation::error::IoErrorKind::Other,
    })
}

/// Error-agnostic core of [`current_vault_root`]: resolve the sole current
/// vault root from an already-resolved `<app_data_dir>` base. Pure path
/// logic + a read-only `vaults/` scan; the only fallible step (the
/// `app_data_dir` lookup) is the caller's, so this is infallible.
///
/// `pub(crate)` so the various plugin helpers — each with its own error
/// type (`VaultUnlockError`, `std::io::Error`, `Option<PathBuf>`) — can map
/// their `app_data_dir` lookup as they already do and then layer this
/// resolution on top without an `AppError` cross-plugin conversion.
pub(crate) fn current_vault_root_from_base(base: &Path) -> PathBuf {
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

/// Active-vault companion to [`notes_dir`]: resolve `<active-vault-root>/notes/`
/// and ensure it exists. Drop-in for the note commands, which read the active
/// id from the runtime state and thread it here.
pub fn notes_dir_for<R: Runtime>(
    app: &AppHandle<R>,
    active_id: Option<VaultId>,
) -> std::io::Result<PathBuf> {
    notes_dir_under(&active_vault_root_io(app, active_id)?)
}

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
pub(crate) fn current_vault_id_from_base(base: &Path) -> VaultId {
    vault_id_from_root(&current_vault_root_from_base(base))
}

/// Name a resolved vault ROOT directory (`vaults/<id>/` or the legacy
/// `vault/`) with its [`VaultId`]: parse the directory's file-name back into a
/// `VaultId`, falling back to the [`LEGACY_VAULT_ID_STR`] sentinel when the
/// name is not a UUIDv7 (the legacy `vault/` case). Used by set-sites that
/// already hold the resolved root and want to avoid a second `vaults/` scan.
///
/// TRANSITIONAL (sub-feature task 4): superseded by explicit id threading.
pub(crate) fn vault_id_from_root(root: &Path) -> VaultId {
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
/// `pub(crate)` so the unlock / recover / create targeting wrappers — each with
/// its own error universe — can map their own `app_data_dir` lookup and then
/// layer this pure join on top.
pub(crate) fn vault_root_for_id_from_base(base: &Path, id: VaultId) -> PathBuf {
    base.join(VAULTS_DIR_NAME).join(id.to_string())
}

/// Resolve the **active** vault's root — the SYNC-6 "implicit active vault"
/// resolution that replaces the transitional disk-heuristic
/// [`current_vault_root_from_base`] for every command operating on the unlocked
/// vault. `active_id` is the sole-`Unlocked` slot key the caller reads from
/// [`crate::plugins::vault_unlock::state::VaultRuntimeState::active_vault_id`]:
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

/// Resolve the vault directory and ensure it exists. The returned
/// `PathBuf` points at the current vault root (`vaults/<id>/`, or the
/// transitional legacy `vault/`) and the directory is `create_dir_all`'d
/// before return.
pub fn vault_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    // The non-creating resolver owns the base-path lookup + error mapping;
    // this adds only the `create_dir_all` side effect.
    let dir = vault_dir_path(app)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Resolve the vault directory for an OPTIONAL explicit [`VaultId`] and ensure
/// it exists — the TARGETING counterpart to [`vault_dir`] (sub-feature 2 task
/// 4, SYNC-6 create targeting).
///
/// - `Some(id)` → `<app_data_dir>/vaults/<id>/`, `create_dir_all`'d (the
///   picker / create flow of sub-feature 3+ passes the minted/chosen id).
/// - `None` → the sole-vault fallback ([`vault_dir`]), which preserves the
///   current single-vault create destination (legacy `vault/` on a fresh
///   install until the boot migration of task 4 mints a real id).
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
        // sole-vault fallback until picker (sub-feature 3).
        None => vault_dir(app),
    }
}

/// Resolve the vault directory path **without creating it**.
///
/// Used by read-only probes — `vault_repair`'s residue scan (MYND-159) —
/// that must not have the side effect of materializing an empty vault
/// directory on a device that never created a vault. [`vault_dir`] (which
/// `create_dir_all`s) stays the canonical resolver for write paths.
pub fn vault_dir_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    // TRANSITIONAL (multi-vault sub-feature 2 — SYNC-6): replace with
    // active-VaultId resolution.
    current_vault_root(app)
}

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
/// Idempotent: `create_dir_all` is recursive, so a missing
/// `vaults/<id>` parent is created in the same call; second call on the
/// same `app` is a no-op.
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
pub(crate) fn notes_dir_under(parent: &Path) -> std::io::Result<PathBuf> {
    let dir = parent.join("notes");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

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
pub(crate) fn snapshots_dir_under(parent: &Path) -> std::io::Result<PathBuf> {
    let dir = parent.join("snapshots");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

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
    fn notes_dir_under_is_idempotent_on_second_call() {
        let tmp = ScopedTempDir::new("notes-dir-idem").unwrap();
        let first = notes_dir_under(tmp.path()).unwrap();
        let second = notes_dir_under(tmp.path()).unwrap();
        assert_eq!(first, second, "second call must return the same path");
        assert!(second.is_dir());
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
    fn notes_dir_under_creates_missing_parent() {
        // `create_dir_all` is recursive — even if `parent` (a
        // `vaults/<id>/` root) doesn't exist, the call should create both.
        let tmp = ScopedTempDir::new("notes-dir-recursive").unwrap();
        let nested_parent = tmp
            .path()
            .join("vaults")
            .join("vault-that-doesnt-exist-yet");
        let result = notes_dir_under(&nested_parent).unwrap();
        assert!(result.is_dir());
        assert!(nested_parent.is_dir(), "parent must be created too");
        assert_eq!(result, nested_parent.join("notes"));
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
}
