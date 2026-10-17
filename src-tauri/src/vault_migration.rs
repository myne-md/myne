// SPDX-License-Identifier: AGPL-3.0
//! Eager boot migration: legacy `<app_data_dir>/vault/` → `vaults/<id>/`.
//!
//! SAFETY-CRITICAL. This is the one-shot, idempotent migration that runs at
//! boot **before any routing** (wired from `lib.rs`'s `setup` hook), so the
//! rest of the app only ever observes the post-migration `vaults/<id>/`
//! layout — there is exactly one on-disk invariant for every downstream
//! probe / resolver (PRD §Solution; grill Q3, 2026-06-08).
//!
//! ## Why staging (the 2026-06-11 data-loss incident, MYND-253)
//!
//! The original design treated the mere presence of `vault/` as proof that
//! every `vaults/<id>/` was a discardable partial, and deleted them all
//! before re-copying. That invariant is FALSE: an unrelated code path (a
//! resolver `create_dir_all` side effect) materialized an *empty* legacy
//! `vault/` on a machine whose real vaults lived under `vaults/<id>/`, and
//! the next boot's discard pass destroyed them. Real vault directories are
//! now NEVER deleted, under any precondition — interrupted copies live in
//! discovery-invisible staging directories instead (the `vault_restore_backup`
//! placement mechanics, §9.11 / SYNC-5).
//!
//! ## Step order (the data-loss-impossible contract)
//!
//! 0. **Sweep stale residue** — leftover `.migration-staging-*` /
//!    `.migration-trash-*` directories from crashed prior runs are removed.
//!    Unconditional (runs even when no `vault/` is present — an interrupt
//!    after the commit rename leaves residue but no legacy dir), and never
//!    creates `vaults/` itself.
//! 1. **Classify the legacy dir.** Absent ⇒ `NothingToMigrate`. Present but
//!    *effectively empty* (no files anywhere in the tree besides OS junk —
//!    `.DS_Store` & co.) ⇒ remove it and return `RemovedEmptyLegacy`: there
//!    is nothing to migrate, and leaving it would re-trigger this pipeline
//!    every boot. Present with content that is neither empty nor a
//!    recognizable vault ([`vault_artifacts_present`] false) ⇒
//!    `SkippedUnrecognizedLegacy`, touching NOTHING — unknown bytes are
//!    preserved-by-default, only provably-nothing is ever removed.
//! 2. **Copy into staging**: the entire legacy tree goes into
//!    `vaults/.migration-staging-<pid>-<n>/` — faithfully, with no hardcoded
//!    artefact allowlist: every child present (the `notes/`, `snapshots/`,
//!    `attachments/` directory trees, the `vault.meta` / `vault.prefs` /
//!    `vault.search` / `vault.attachments` top-level blobs, and any future or
//!    unexpected sibling) is carried over, each file via
//!    [`crate::atomic_write::atomic_write`]'s temp+fsync+rename durability.
//!    The staging name never parses as a [`VaultId`](crate::vault_id::VaultId),
//!    so discovery / boot / picker cannot see a half-staged vault.
//! 3. **fsync** the staging root (and its subdirectories) so the new
//!    directory entries reach the OS journal before the verify reads them.
//! 4. **Verify** the staged dir: [`vault_artifacts_present`] returns `true`.
//!    A failed verify aborts *before* anything visible changes.
//! 5. **Commit rename**: mint a fresh id ([`mint_unique_vault_id`],
//!    collision-retry) and `rename` the staged dir to `vaults/<id>/` in one
//!    same-filesystem syscall, then best-effort-sync the `vaults/` handle.
//! 6. **Retire the old `vault/` LAST**, also by rename — into
//!    `vaults/.migration-trash-<pid>-<n>/` (atomic: the "migration
//!    unfinished" signal disappears in one syscall, so a partially-deleted
//!    legacy tree can never be re-migrated as a truncated source), then
//!    best-effort delete the trash dir.
//!
//! ## Recovery rule (interrupted migration)
//!
//! The presence of the old `vault/` directory **is** the "migration
//! unfinished" signal. A crash / power loss before step 6's rename leaves
//! `vault/` intact, so the next boot re-runs the whole pipeline from the
//! untouched source; whatever the interrupted run staged is invisible
//! residue that step 0 reclaims. A crash *between* step 5 and step 6 (the
//! two adjacent commit syscalls) leaves a committed copy AND the legacy
//! source, so the next boot migrates again and the user sees a duplicate
//! vault — the deliberate failure direction: a duplicate is recoverable,
//! deleting a real vault is not. No window deletes data, ever.
//!
//! ## Fault-injection seam (mirrors MYND-88 `atomic_write`)
//!
//! The interrupted-recovery contract is exercised by a `#[cfg(test)]`
//! fault-injection seam ([`Fault`]): [`migrate_legacy_vault`] passes
//! [`Fault::None`], so in non-test builds the enum has only that one variant
//! and every `match fault` arm compiles out — the production migration is
//! byte-identical to a seam-free implementation (zero runtime cost). The
//! injected faults model a crash at each interrupt point between the
//! durable steps:
//!
//! - [`Fault::StopAfterCopyBeforeFsync`] — staged, before the dir fsync.
//! - [`Fault::StopAfterFsyncBeforeVerify`] — staged + fsynced, before verify.
//! - [`Fault::StopAfterVerifyBeforeRename`] — verified, before the commit
//!   rename: nothing visible exists yet, the re-run starts over.
//! - [`Fault::StopAfterRenameBeforeTrash`] — committed, before the legacy
//!   retire — the duplicate-producing window documented above.
//!
//! ## Logging discipline
//!
//! Per `src-tauri/AGENTS.md` "Secret-handling logging discipline", full
//! filesystem paths and `VaultId`s are DENY-listed. This module keeps both
//! off the tracing surface — only coarse static `stage` strings and the
//! closed [`IoFailureKind`] reduction are emitted.

use crate::io_failure_kind::from_io_error_kind;
use crate::paths::{LEGACY_VAULT_DIR_NAME, VAULTS_DIR_NAME};
use crate::plugins::vault_creation::commands::vault_artifacts_present;
use crate::vault_registry::mint_unique_vault_id;
use std::path::{Path, PathBuf};

/// Prefix of the discovery-invisible staging directories under `vaults/`
/// (never parses as a `VaultId`; leading dot keeps it out of casual `ls`).
/// Distinct from restore's `.restore-staging-` so the two sweeps can never
/// reclaim each other's residue.
const STAGING_PREFIX: &str = ".migration-staging-";

/// Prefix of the post-commit trash directory the old `vault/` is renamed
/// into (step 6) before its best-effort delete.
const TRASH_PREFIX: &str = ".migration-trash-";

/// File names that do NOT count as content when classifying a legacy
/// `vault/` as effectively empty — OS metadata droppings only. Anything
/// else (unknown bytes included) makes the dir non-empty and therefore
/// non-removable.
const JUNK_FILE_NAMES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

/// Test-only fault-injection points for the boot-migration interrupted-
/// recovery contract — the structural parallel of MYND-88's `atomic_write`
/// [`Fault`](crate::atomic_write) seam.
///
/// In non-test builds the enum has only the [`Fault::None`] variant, so the
/// `match fault` arms in [`stage_verify_commit`] compile out and the
/// production migration is byte-identical to a seam-free implementation
/// (zero runtime cost).
#[derive(Clone, Copy)]
enum Fault {
    /// Production path: no injected failure.
    None,
    /// Crash *after* the artefacts are copied into staging but *before* the
    /// staging fsync — the earliest interrupt point.
    #[cfg(test)]
    StopAfterCopyBeforeFsync,
    /// Crash *after* the copy + fsync but *before* the verify step.
    #[cfg(test)]
    StopAfterFsyncBeforeVerify,
    /// Crash *after* a clean verify but *before* the commit rename — nothing
    /// visible exists yet; the re-run starts over from the intact legacy.
    #[cfg(test)]
    StopAfterVerifyBeforeRename,
    /// Crash *after* the commit rename but *before* the legacy dir is
    /// retired — the two-syscall window that yields a duplicate vault on
    /// the next boot (deliberately: duplicate over deletion).
    #[cfg(test)]
    StopAfterRenameBeforeTrash,
}

/// Outcome of a boot-migration attempt. The path is **internal-only** — it is
/// never emitted over IPC or tracing (full paths are DENY-listed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MigrationOutcome {
    /// No legacy `vault/` directory present — nothing to migrate (fresh
    /// install, or a boot after a prior successful migration). No-op.
    NothingToMigrate,
    /// A legacy `vault/` existed but held no content (only OS junk and/or
    /// empty subdirectories) — it was removed so it cannot re-trigger the
    /// pipeline, and nothing else was touched. The 2026-06-11 incident
    /// precondition resolves here, with real `vaults/<id>/` dirs untouched.
    RemovedEmptyLegacy,
    /// A legacy `vault/` existed with content this module does not recognize
    /// as a vault ([`vault_artifacts_present`] false, yet not effectively
    /// empty — e.g. only a `vault.search`). NOTHING was touched: unknown
    /// bytes are preserved-by-default and surface via tracing for a human.
    SkippedUnrecognizedLegacy,
    /// A legacy `vault/` was migrated to `vaults/<id>/`; the old `vault/` is
    /// gone. Carries the new vault root (internal-only).
    Migrated(PathBuf),
}

/// Run the eager boot migration against an already-resolved `<app_data_dir>`
/// base. The production entry point — wired from `lib.rs`'s `setup` hook
/// before any vault command can be invoked.
///
/// Infallible from the caller's perspective in the no-op case; returns the
/// underlying [`std::io::Error`] if a migration was attempted and a durable
/// step failed (the boot wiring logs a closed-enum reduction and leaves the
/// old `vault/` intact so the next boot retries). Passes [`Fault::None`], so
/// the fault-injection seam is fully compiled out here.
pub(crate) fn migrate_legacy_vault(base: &Path) -> std::io::Result<MigrationOutcome> {
    migrate_legacy_vault_inner(base, Fault::None)
}

/// Testable core of [`migrate_legacy_vault`]. `fault` is read only under
/// `#[cfg(test)]`; in production it is always [`Fault::None`] and every
/// `match fault` arm below is compiled out.
#[cfg_attr(not(test), allow(unused_variables))]
fn migrate_legacy_vault_inner(base: &Path, fault: Fault) -> std::io::Result<MigrationOutcome> {
    let vaults_dir = base.join(VAULTS_DIR_NAME);

    // (0) Reclaim residue from crashed prior runs BEFORE the legacy early
    // return: an interrupt between the commit rename and the legacy retire
    // leaves trash/staging on disk but no `vault/`, so a sweep gated on the
    // legacy dir would never run again. Boot is strictly serial (this runs
    // in `setup` before any IPC handler; `tauri-plugin-single-instance`
    // excludes sibling processes; restore staging uses a different prefix),
    // so ANY `.migration-*` entry here is stale by construction — no
    // live-pid exemption needed, unlike restore's in-process-concurrent
    // `sweep_stale_staging`.
    sweep_stale_migration_residue(&vaults_dir);

    let legacy = base.join(LEGACY_VAULT_DIR_NAME);

    // (1) Classify. Absent ⇒ nothing to do (fresh install, or a boot after
    // a prior successful migration that retired it).
    if !legacy.is_dir() {
        return Ok(MigrationOutcome::NothingToMigrate);
    }

    if dir_is_effectively_empty(&legacy)? {
        // Provably nothing to migrate — remove the trigger so it cannot
        // re-enter this pipeline every boot. This is the ONLY branch that
        // deletes a legacy dir without staging it first, and it is gated on
        // recursive enumeration finding zero non-junk files — NOT on the
        // fixed `vault_artifacts_present` taxonomy (which would mistake an
        // unlisted artefact like `vault.search` for nothing).
        tracing::info!(
            stage = "vault_migration_removed_empty_legacy",
            "legacy vault/ holds no content — removed; nothing migrated"
        );
        remove_empty_legacy(&legacy)?;
        return Ok(MigrationOutcome::RemovedEmptyLegacy);
    }

    if !vault_artifacts_present(&legacy)? {
        // Content exists but is not a recognizable vault. Preserve-by-
        // default: touch nothing, tell a human via tracing.
        tracing::warn!(
            stage = "vault_migration_skipped_unrecognized_legacy",
            "legacy vault/ holds unrecognized content — left untouched"
        );
        return Ok(MigrationOutcome::SkippedUnrecognizedLegacy);
    }

    tracing::info!(
        stage = "vault_migration_begin",
        "legacy vault/ present — migrating to vaults/<id>/ via staging"
    );

    // (2)–(6) Stage, verify, commit. A failure anywhere removes the staging
    // dir (best-effort — a crash instead of an Err leaves it for step 0).
    std::fs::create_dir_all(&vaults_dir)?;
    let staging = residue_dir(&vaults_dir, STAGING_PREFIX);
    let result = stage_verify_commit(base, &vaults_dir, &legacy, &staging, fault);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

/// Steps 2–6: copy the legacy tree into `staging`, verify it, commit it to
/// `vaults/<minted-id>/` by rename, then retire the legacy dir by rename.
/// Carved out so the caller owns the staging cleanup on every `Err` path.
#[cfg_attr(not(test), allow(unused_variables))]
fn stage_verify_commit(
    base: &Path,
    vaults_dir: &Path,
    legacy: &Path,
    staging: &Path,
    fault: Fault,
) -> std::io::Result<MigrationOutcome> {
    // (2) Copy every artefact into staging via atomic_write durability.
    copy_vault_tree(legacy, staging)?;

    // --- Interrupt point A: after copy, before the staging fsync. ---
    #[cfg(test)]
    if let Fault::StopAfterCopyBeforeFsync = fault {
        return Err(interrupt_error("StopAfterCopyBeforeFsync"));
    }

    // (3) fsync the staging root + its subdirectories so the new directory
    // entries reach the OS journal before the verify reads them (and before
    // the commit rename publishes them).
    fsync_dir_tree(staging)?;

    // --- Interrupt point B: after fsync, before verify. ---
    #[cfg(test)]
    if let Fault::StopAfterFsyncBeforeVerify = fault {
        return Err(interrupt_error("StopAfterFsyncBeforeVerify"));
    }

    // (4) Verify the staged dir is a present + readable vault BEFORE
    // publishing anything. A failed/partial copy fails the verify and
    // aborts here, leaving the old `vault/` untouched for the next boot.
    if !vault_artifacts_present(staging)? {
        tracing::error!(
            stage = "vault_migration_verify_failed",
            "staged copy failed the artefact-present verify; aborting before any visible change"
        );
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "migrated vault failed verification",
        ));
    }

    // --- Interrupt point C: after verify, before the commit rename. ---
    // Nothing visible exists yet — the re-run starts over from the intact
    // legacy, and step 0 reclaims this staging dir.
    #[cfg(test)]
    if let Fault::StopAfterVerifyBeforeRename = fault {
        return Err(interrupt_error("StopAfterVerifyBeforeRename"));
    }

    // (5) Commit: mint a fresh, collision-free id and publish the staged
    // tree in one same-filesystem rename. `mint_unique_vault_id` loops until
    // `!exists()`, so the rename can never land on an existing directory.
    let id = mint_unique_vault_id(base);
    let new_root = vaults_dir.join(id.to_string());
    std::fs::rename(staging, &new_root)?;
    sync_dir_best_effort(vaults_dir);

    // --- Interrupt point D: after the commit rename, before the legacy
    // retire — the documented duplicate-producing window. ---
    #[cfg(test)]
    if let Fault::StopAfterRenameBeforeTrash = fault {
        return Err(interrupt_error("StopAfterRenameBeforeTrash"));
    }

    // (6) Retire the old `vault/` LAST, by atomic rename into a trash dir —
    // the single migration commit point for the "unfinished" signal. A
    // recursive delete here could fail partway and leave a truncated legacy
    // tree to be re-migrated as if complete; the rename cannot.
    retire_old_vault(legacy, vaults_dir)?;

    tracing::info!(
        stage = "vault_migration_complete",
        "migration committed — old vault/ retired"
    );
    Ok(MigrationOutcome::Migrated(new_root))
}

/// `true` when `dir`'s tree contains no files besides [`JUNK_FILE_NAMES`]
/// (empty subdirectories permitted). The deletion gate for
/// [`MigrationOutcome::RemovedEmptyLegacy`] — deliberately an exhaustive
/// enumeration, not the `vault_artifacts_present` taxonomy: the predicate's
/// fixed list cannot prove absence-of-content, only absence-of-known-kinds.
/// Symlinks count as content (not followed).
fn dir_is_effectively_empty(dir: &Path) -> std::io::Result<bool> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if std::fs::symlink_metadata(&path)?.is_dir() {
            if !dir_is_effectively_empty(&path)? {
                return Ok(false);
            }
        } else {
            let name = entry.file_name();
            let is_junk = name.to_str().is_some_and(|n| JUNK_FILE_NAMES.contains(&n));
            if !is_junk {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// Remove an effectively-empty legacy `vault/` (junk files + empty subdirs
/// only — gated by [`dir_is_effectively_empty`] at the call site), then
/// (Unix) `sync_all` the parent so the removal of the directory entry is
/// durable and cannot resurrect the boot-loop trigger.
fn remove_empty_legacy(legacy: &Path) -> std::io::Result<()> {
    std::fs::remove_dir_all(legacy)?;
    #[cfg(unix)]
    if let Some(parent) = legacy.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

/// Retire the old `vault/` by atomic rename into `vaults/.migration-trash-*`,
/// (Unix) `sync_all` the parent so the disappearance of the "unfinished"
/// signal is durable, then best-effort delete the trash. A partially-deleted
/// trash dir is invisible residue for the next boot's sweep — never a
/// re-migration source.
fn retire_old_vault(legacy: &Path, vaults_dir: &Path) -> std::io::Result<()> {
    let trash = residue_dir(vaults_dir, TRASH_PREFIX);
    std::fs::rename(legacy, &trash)?;
    #[cfg(unix)]
    if let Some(parent) = legacy.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    let _ = std::fs::remove_dir_all(&trash);
    Ok(())
}

/// Mint a fresh process-unique residue path under `vaults/` with the given
/// prefix (staging or trash). The pid + counter shape mirrors restore's
/// `staging_dir`; the name never parses as a `VaultId`.
fn residue_dir(vaults_dir: &Path, prefix: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    vaults_dir.join(format!("{prefix}{}-{n}", std::process::id()))
}

/// Remove every `.migration-staging-*` / `.migration-trash-*` entry under
/// `vaults/`. Best-effort, never creates `vaults/`, never touches any other
/// name (restore's `.restore-staging-*` included). See the step-0 call site
/// for why no live-pid exemption applies here.
fn sweep_stale_migration_residue(vaults_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(vaults_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with(STAGING_PREFIX) || name.starts_with(TRASH_PREFIX) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Copy the **entire** legacy vault tree into `staging`, faithfully — every
/// child present under `legacy/` is carried over, with no hardcoded allowlist.
/// Each regular file goes through [`crate::atomic_write::atomic_write`]
/// (temp+fsync+rename); each subdirectory (`notes/`, `snapshots/`,
/// `attachments/`, …) is copied recursively with the same per-file durability.
///
/// Copying every on-disk entry — rather than enumerating a fixed taxonomy
/// (`vault.meta` / `vault.prefs` / `vault.attachments` + `notes/` / `snapshots/`
/// / `attachments/`) — eliminates a SAFETY-CRITICAL drift class: a manifest
/// coupled-by-comment-only to `vault_artifacts_present` would silently leave
/// behind any artefact not on the list (e.g. `vault.search` / `MYS1`, which the
/// old allowlist missed) and any future artefact. Nothing on disk is ever left
/// behind, so the migration cannot lose data to a stale enumeration.
///
/// The verify (`vault_artifacts_present` on the staged tree) still gates the
/// commit rename: a complete copy of a real vault trivially passes, since
/// every artefact the predicate looks for is among the copied children.
fn copy_vault_tree(legacy: &Path, staging: &Path) -> std::io::Result<()> {
    copy_dir_recursive(legacy, staging)
}

/// Recursively copy `src_dir` into `dst_dir`, preserving the tree shape. Each
/// regular file is copied via [`copy_file_durable`]; nested directories
/// recurse. Symlinks are not followed (`symlink_metadata`) — the vault tree
/// is flat ciphertext blobs, no symlinks, matching the no-follow posture of
/// `vault_sweep`.
fn copy_dir_recursive(src_dir: &Path, dst_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst_dir)?;
    for entry in std::fs::read_dir(src_dir)? {
        let entry = entry?;
        let src = entry.path();
        let dst = dst_dir.join(entry.file_name());
        let meta = std::fs::symlink_metadata(&src)?;
        if meta.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            // Regular file (or symlink treated as a file — not followed). The
            // vault tree holds only ciphertext blobs.
            copy_file_durable(&src, &dst)?;
        }
    }
    Ok(())
}

/// Copy one file's bytes from `src` to `dst` with [`crate::atomic_write`]
/// durability (temp+fsync+rename). `replace = false` — the destination is a
/// freshly-minted staging directory, so a pre-existing target would be a
/// bug; the create-only mode surfaces it rather than silently overwriting.
///
/// The bytes are ciphertext blobs (the entire vault tree is encrypted at
/// rest), so reading them into memory for the copy never exposes plaintext —
/// consistent with `atomic_write`'s "callers only pass ciphertext" invariant.
fn copy_file_durable(src: &Path, dst: &Path) -> std::io::Result<()> {
    let bytes = std::fs::read(src)?;
    crate::atomic_write::atomic_write(dst, &bytes, false)
}

/// fsync `dir` and every immediate subdirectory so the new directory entries
/// (created by the per-file `atomic_write` renames) reach the OS journal.
///
/// **Unix-only**, matching the `atomic_write` / `vault_sweep` durability
/// asymmetry precedent: `atomic_write`'s per-file rename already commits each
/// file durably on both platforms (Unix parent-dir `sync_all`; Windows
/// `MoveFileExW(WRITE_THROUGH)`), so the directory entries for the copied
/// files are durable cross-platform. This extra root/subdir `sync_all` is the
/// Unix journal-commit hint for the *directory* nodes themselves; on Windows
/// it is an explicit no-op (no `FlushFileBuffers` parent-handle machinery —
/// the same posture as `note_delete` / `vault_sweep`).
#[cfg_attr(not(unix), allow(unused_variables))]
fn fsync_dir_tree(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        sync_one_dir(dir)?;
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() {
                sync_one_dir(&path)?;
            }
        }
    }
    Ok(())
}

/// Open `dir` and `sync_all()` it to flush the directory-entry changes to the
/// OS journal. Unix-only (see [`fsync_dir_tree`]).
#[cfg(unix)]
fn sync_one_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

/// Best-effort variant of [`sync_one_dir`] for the post-rename `vaults/`
/// handle — the rename itself is the commit; a failed journal hint must not
/// turn a committed migration into a reported failure. No-op on non-Unix.
fn sync_dir_best_effort(dir: &Path) {
    #[cfg(unix)]
    {
        let _ = sync_one_dir(dir);
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
}

/// Construct the `Interrupted`-kind error a fault-injection point returns,
/// modeling a crash. Test-only — the production path never reaches it.
#[cfg(test)]
fn interrupt_error(point: &str) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::Interrupted,
        format!("migration crash simulation at {point}"),
    )
}

/// Reduce a migration IO failure to a DENY-list-safe closed-enum signal for
/// the boot wiring's tracing. Carved out so the reduction is reused by the
/// `lib.rs` caller without duplicating the discipline.
pub(crate) fn migration_failure_kind(e: &std::io::Error) -> crate::io_failure_kind::IoFailureKind {
    from_io_error_kind(e.kind())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{seed_real_vault_meta, ScopedTempDir};
    use crate::vault_id::VaultId;

    // ---- fixtures -------------------------------------------------------

    /// A representative populated legacy `vault/` under `base`. Seeds the
    /// full artefact taxonomy: the top-level blobs (`vault.meta`,
    /// `vault.prefs`, `vault.search`, `vault.attachments`) + a note, a
    /// snapshot, and an attachment, each with distinctive bytes so a
    /// byte-identical assertion is meaningful. `vault.search` (MYS1) is
    /// seeded deliberately — it was MISSED by the old hardcoded migration
    /// allowlist; the faithful copy-everything migration carries it over,
    /// and the byte-identical assertions below prove it. Returns the seeded
    /// (relative-path, bytes) manifest for later equality checks.
    fn seed_legacy_vault(base: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let legacy = base.join(LEGACY_VAULT_DIR_NAME);
        std::fs::create_dir_all(&legacy).unwrap();

        let mut manifest: Vec<(PathBuf, Vec<u8>)> = Vec::new();

        let seed = |dir: &Path, rel: &str, bytes: &[u8], manifest: &mut Vec<(PathBuf, Vec<u8>)>| {
            let full = dir.join(rel);
            if let Some(p) = full.parent() {
                std::fs::create_dir_all(p).unwrap();
            }
            std::fs::write(&full, bytes).unwrap();
            manifest.push((PathBuf::from(rel), bytes.to_vec()));
        };

        seed(
            &legacy,
            "vault.meta",
            b"MYV1-vault-meta-bytes-0001",
            &mut manifest,
        );
        seed(
            &legacy,
            "vault.prefs",
            b"MYP1-vault-prefs-bytes-0002",
            &mut manifest,
        );
        // `vault.search` (MYS1) — the artefact the OLD hardcoded migration
        // allowlist silently dropped. Seeded so the byte-identical assertions
        // prove the faithful copy-everything migration carries it over.
        seed(
            &legacy,
            "vault.search",
            b"MYS1-search-index-bytes-0003",
            &mut manifest,
        );
        seed(
            &legacy,
            "vault.attachments",
            b"MYC1-catalog-bytes-0004",
            &mut manifest,
        );
        seed(
            &legacy,
            "notes/0190a000-0000-7000-8000-000000000001.myn",
            b"MY01-note-ciphertext-blob-AAAA",
            &mut manifest,
        );
        seed(
            &legacy,
            "snapshots/0190a000-0000-7000-8000-000000000001__1.myn",
            b"MY01-snapshot-ciphertext-BBBB",
            &mut manifest,
        );
        seed(
            &legacy,
            "attachments/0190a000000070008000000000000abc",
            b"MYA1-attachment-ciphertext-CCCC",
            &mut manifest,
        );

        manifest
    }

    /// Seed a REAL sibling `vaults/<id>/` (a fully-formed vault that must
    /// survive every migration scenario — the 2026-06-11 incident victim).
    /// Returns its root.
    fn seed_real_sibling_vault(base: &Path, seed_byte: u8) -> PathBuf {
        let root = base.join(VAULTS_DIR_NAME).join(VaultId::mint().to_string());
        std::fs::create_dir_all(root.join("notes")).unwrap();
        seed_real_vault_meta(&root, seed_byte);
        std::fs::write(
            root.join("notes/0190b000-0000-7000-8000-000000000002.myn"),
            [seed_byte; 64],
        )
        .unwrap();
        root
    }

    /// Collect every `vaults/<id>/` root under `base` (name parses as a
    /// `VaultId`), sorted for stable assertions.
    fn vault_roots(base: &Path) -> Vec<PathBuf> {
        let vaults = base.join(VAULTS_DIR_NAME);
        let Ok(entries) = std::fs::read_dir(&vaults) else {
            return Vec::new();
        };
        let mut found: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.is_dir()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| VaultId::parse(n).is_ok())
            })
            .collect();
        found.sort();
        found
    }

    /// Resolve the SINGLE `vaults/<id>/` directory under `base`, asserting
    /// exactly one is present. Used post-migration to find the new root
    /// without knowing the minted id.
    fn sole_new_vault_root(base: &Path) -> PathBuf {
        let mut found = vault_roots(base);
        assert_eq!(
            found.len(),
            1,
            "expected exactly one vaults/<id>/ dir, got {found:?}"
        );
        found.remove(0)
    }

    /// Assert every seeded artefact exists at the new root with byte-identical
    /// content.
    fn assert_manifest_byte_identical(new_root: &Path, manifest: &[(PathBuf, Vec<u8>)]) {
        for (rel, bytes) in manifest {
            let migrated = new_root.join(rel);
            assert!(
                migrated.is_file(),
                "artefact {rel:?} missing from migrated vault"
            );
            assert_eq!(
                &std::fs::read(&migrated).unwrap(),
                bytes,
                "artefact {rel:?} is not byte-identical after migration"
            );
        }
    }

    // ---- happy path -----------------------------------------------------

    #[test]
    fn migrates_populated_legacy_vault_byte_identical_and_removes_old() {
        let tmp = ScopedTempDir::new("mig-happy").unwrap();
        let manifest = seed_legacy_vault(tmp.path());

        let outcome = migrate_legacy_vault(tmp.path()).unwrap();

        // Old vault/ is gone.
        assert!(
            !tmp.path().join(LEGACY_VAULT_DIR_NAME).exists(),
            "old vault/ must be retired last"
        );
        // New vaults/<id>/ holds every artefact, byte-identical.
        let new_root = sole_new_vault_root(tmp.path());
        assert_eq!(outcome, MigrationOutcome::Migrated(new_root.clone()));
        assert_manifest_byte_identical(&new_root, &manifest);
        // The new root's name parses as a VaultId.
        assert!(VaultId::parse(new_root.file_name().unwrap().to_str().unwrap()).is_ok());
        // No staging / trash residue survives a clean run's own sweep window.
        assert!(
            std::fs::read_dir(tmp.path().join(VAULTS_DIR_NAME))
                .unwrap()
                .filter_map(|e| e.ok())
                .all(|e| {
                    let n = e.file_name();
                    let n = n.to_str().unwrap_or_default().to_owned();
                    !n.starts_with(STAGING_PREFIX) && !n.starts_with(TRASH_PREFIX)
                }),
            "clean migration must leave no staging/trash residue"
        );
    }

    #[test]
    fn migrated_dir_passes_artifacts_present_verify() {
        let tmp = ScopedTempDir::new("mig-verify").unwrap();
        seed_legacy_vault(tmp.path());
        migrate_legacy_vault(tmp.path()).unwrap();
        let new_root = sole_new_vault_root(tmp.path());
        assert!(
            vault_artifacts_present(&new_root).unwrap(),
            "migrated dir must satisfy the verify predicate"
        );
    }

    #[test]
    fn migrates_vault_search_and_unexpected_artefacts_too() {
        // Drift-class regression guard: the migration copies EVERY entry
        // present under the legacy `vault/`, not a hardcoded allowlist. The
        // standard fixture already seeds `vault.search` (MYS1) — which the
        // old enumerated manifest silently dropped. Here we additionally seed
        // an UNEXPECTED top-level blob and an UNEXPECTED nested file under a
        // future subdir, then assert both survive byte-identical. Nothing on
        // disk is ever left behind.
        let tmp = ScopedTempDir::new("mig-faithful").unwrap();
        let mut manifest = seed_legacy_vault(tmp.path());
        let legacy = tmp.path().join(LEGACY_VAULT_DIR_NAME);

        // A future/unexpected top-level artefact (e.g. a v005-era blob, or a
        // hypothetical `vault.indices`) the migration has never heard of.
        std::fs::write(
            legacy.join("vault.future"),
            b"FUTR-unexpected-top-level-0001",
        )
        .unwrap();
        manifest.push((
            PathBuf::from("vault.future"),
            b"FUTR-unexpected-top-level-0001".to_vec(),
        ));
        // A file under a subdirectory not on the old `MIGRATED_SUBDIRS` list.
        let extra_dir = legacy.join("extra");
        std::fs::create_dir_all(&extra_dir).unwrap();
        std::fs::write(extra_dir.join("blob.bin"), b"EXTR-nested-unexpected-0002").unwrap();
        manifest.push((
            PathBuf::from("extra").join("blob.bin"),
            b"EXTR-nested-unexpected-0002".to_vec(),
        ));

        migrate_legacy_vault(tmp.path()).unwrap();
        let new_root = sole_new_vault_root(tmp.path());

        // Every artefact — the taxonomy, `vault.search`, AND the two
        // unexpected entries — is carried over byte-identical.
        assert_manifest_byte_identical(&new_root, &manifest);
        // Specifically pin the two artefacts that a hardcoded allowlist would
        // have dropped.
        assert!(
            new_root.join("vault.search").is_file(),
            "vault.search (MYS1) must migrate — the old allowlist missed it"
        );
        assert!(
            new_root.join("vault.future").is_file(),
            "an unexpected top-level artefact must migrate too"
        );
        assert!(
            new_root.join("extra").join("blob.bin").is_file(),
            "an unexpected nested artefact must migrate too"
        );
    }

    // ---- fresh install + idempotency -----------------------------------

    #[test]
    fn fresh_install_no_legacy_is_noop() {
        let tmp = ScopedTempDir::new("mig-fresh").unwrap();
        // No vault/ at all.
        let outcome = migrate_legacy_vault(tmp.path()).unwrap();
        assert_eq!(outcome, MigrationOutcome::NothingToMigrate);
        // No vaults/ dir materialized (the residue sweep must not create it).
        assert!(
            !tmp.path().join(VAULTS_DIR_NAME).exists(),
            "fresh install must not create vaults/"
        );
    }

    #[test]
    fn second_boot_after_success_is_noop() {
        let tmp = ScopedTempDir::new("mig-idem").unwrap();
        seed_legacy_vault(tmp.path());

        // First boot migrates.
        let first = migrate_legacy_vault(tmp.path()).unwrap();
        assert!(matches!(first, MigrationOutcome::Migrated(_)));
        let new_root = sole_new_vault_root(tmp.path());

        // Second boot: old vault/ gone ⇒ nothing to migrate.
        let second = migrate_legacy_vault(tmp.path()).unwrap();
        assert_eq!(second, MigrationOutcome::NothingToMigrate);

        // The migrated vault is untouched and still the sole one.
        assert_eq!(sole_new_vault_root(tmp.path()), new_root);
    }

    // ---- the 2026-06-11 incident class (MYND-253) ------------------------

    #[test]
    fn empty_legacy_is_removed_and_real_sibling_vaults_survive() {
        // THE incident regression. An empty legacy `vault/` (materialized by
        // a resolver side effect) must NEVER cause the deletion of real
        // `vaults/<id>/` siblings — under the old discard-all design this
        // exact precondition wiped them.
        let tmp = ScopedTempDir::new("mig-incident").unwrap();
        let sibling_a = seed_real_sibling_vault(tmp.path(), 0x33);
        let sibling_b = seed_real_sibling_vault(tmp.path(), 0x44);
        let before_a = read_tree(&sibling_a);
        let before_b = read_tree(&sibling_b);

        std::fs::create_dir_all(tmp.path().join(LEGACY_VAULT_DIR_NAME)).unwrap();

        let outcome = migrate_legacy_vault(tmp.path()).unwrap();
        assert_eq!(outcome, MigrationOutcome::RemovedEmptyLegacy);

        // The trigger is gone — no boot-loop — and the siblings are intact.
        assert!(!tmp.path().join(LEGACY_VAULT_DIR_NAME).exists());
        assert_eq!(read_tree(&sibling_a), before_a, "sibling A must survive");
        assert_eq!(read_tree(&sibling_b), before_b, "sibling B must survive");
        assert_eq!(vault_roots(tmp.path()).len(), 2, "no vault added/removed");

        // Next boot is a clean no-op.
        assert_eq!(
            migrate_legacy_vault(tmp.path()).unwrap(),
            MigrationOutcome::NothingToMigrate
        );
    }

    #[test]
    fn adversarial_repeated_empty_legacy_boots_never_erode_real_vaults() {
        // Faithful to the incident DYNAMIC, not just its single-boot snapshot:
        // the resolver side-effect re-materialized an empty legacy `vault/` on
        // EVERY boot, and under the old design it was a *later* boot's discard
        // pass that wiped real vaults. Here the empty legacy dir is regenerated
        // and migration re-run many times over MANY real siblings; every byte
        // of every real vault must survive every single boot, and the vault
        // count must never change.
        let tmp = ScopedTempDir::new("mig-incident-loop").unwrap();
        let siblings: Vec<_> = (0..5u8)
            .map(|i| seed_real_sibling_vault(tmp.path(), 0x20 + i))
            .collect();
        let before: Vec<_> = siblings.iter().map(|s| read_tree(s)).collect();

        for boot in 0..8 {
            // Resolver side-effect: an empty legacy dir reappears each boot.
            std::fs::create_dir_all(tmp.path().join(LEGACY_VAULT_DIR_NAME)).unwrap();

            let outcome = migrate_legacy_vault(tmp.path()).unwrap();
            assert_eq!(
                outcome,
                MigrationOutcome::RemovedEmptyLegacy,
                "boot {boot}: empty legacy must be removed, never treated as migratable"
            );
            assert!(
                !tmp.path().join(LEGACY_VAULT_DIR_NAME).exists(),
                "boot {boot}: the trigger dir must be gone (no boot-loop)"
            );
            assert_eq!(
                vault_roots(tmp.path()).len(),
                siblings.len(),
                "boot {boot}: a real vault was added or removed"
            );
            for (s, b0) in siblings.iter().zip(&before) {
                assert_eq!(
                    &read_tree(s),
                    b0,
                    "boot {boot}: a real vault's bytes were mutated or erased"
                );
            }
        }
    }

    #[test]
    fn junk_only_legacy_counts_as_empty_and_is_removed() {
        // OS droppings + empty subdirs are not content: the legacy dir is
        // still provably empty and is removed without touching anything else.
        let tmp = ScopedTempDir::new("mig-junk-empty").unwrap();
        let legacy = tmp.path().join(LEGACY_VAULT_DIR_NAME);
        std::fs::create_dir_all(legacy.join("notes")).unwrap();
        std::fs::write(legacy.join(".DS_Store"), b"finder droppings").unwrap();
        std::fs::write(legacy.join("notes/.DS_Store"), b"more droppings").unwrap();

        let outcome = migrate_legacy_vault(tmp.path()).unwrap();
        assert_eq!(outcome, MigrationOutcome::RemovedEmptyLegacy);
        assert!(!legacy.exists());
    }

    #[test]
    fn artifact_bearing_legacy_migrates_alongside_real_sibling() {
        // The falsified old invariant, head-on: a REAL legacy migration with
        // a REAL pre-existing sibling vault. The old discard-all deleted the
        // sibling; the staging design must migrate the legacy NEXT TO it.
        let tmp = ScopedTempDir::new("mig-sibling").unwrap();
        let sibling = seed_real_sibling_vault(tmp.path(), 0x55);
        let before = read_tree(&sibling);
        let manifest = seed_legacy_vault(tmp.path());

        let outcome = migrate_legacy_vault(tmp.path()).unwrap();
        let MigrationOutcome::Migrated(new_root) = outcome else {
            panic!("expected Migrated, got {outcome:?}");
        };

        // Sibling untouched, byte-identical; legacy retired; migrated copy
        // complete — two vaults total.
        assert_eq!(read_tree(&sibling), before, "sibling must survive");
        assert!(!tmp.path().join(LEGACY_VAULT_DIR_NAME).exists());
        assert_manifest_byte_identical(&new_root, &manifest);
        assert_eq!(vault_roots(tmp.path()).len(), 2);
    }

    #[test]
    fn unrecognized_legacy_content_is_skipped_untouched() {
        // Content that is neither empty nor a recognizable vault (e.g. only a
        // `vault.search` — absent from the vault_artifacts_present taxonomy)
        // must be preserved-by-default: no migration, no deletion, no staging.
        let tmp = ScopedTempDir::new("mig-unrecognized").unwrap();
        let legacy = tmp.path().join(LEGACY_VAULT_DIR_NAME);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("vault.search"), b"MYS1-orphan-index").unwrap();
        let before = read_tree(&legacy);

        let outcome = migrate_legacy_vault(tmp.path()).unwrap();
        assert_eq!(outcome, MigrationOutcome::SkippedUnrecognizedLegacy);
        assert_eq!(
            read_tree(&legacy),
            before,
            "unknown bytes must be preserved"
        );
        assert!(
            vault_roots(tmp.path()).is_empty(),
            "nothing may be staged or committed for unrecognized content"
        );
    }

    // ---- interrupted migration: fault at EACH step ----------------------
    //
    // For each pre-commit interrupt point: (a) the old vault/ is intact +
    // fully readable, (b) NOTHING visible exists under vaults/<id>/ (the
    // staging design's core promise — a partial is never publishable), and
    // (c) a fault-free re-run completes byte-identical.

    /// Drive one pre-commit interrupt point: inject `fault`, assert the old
    /// vault/ is intact and nothing visible was published, then re-run clean
    /// and assert a complete byte-identical migration.
    fn assert_interrupt_then_clean_rerun(label: &str, fault: Fault) {
        let tmp = ScopedTempDir::new(label).unwrap();
        let manifest = seed_legacy_vault(tmp.path());
        let legacy = tmp.path().join(LEGACY_VAULT_DIR_NAME);

        // Snapshot the legacy bytes so we can prove the SOURCE is untouched
        // by the interrupted run.
        let legacy_before = read_tree(&legacy);

        // Interrupted run: surfaces the injected Interrupted error.
        let err = migrate_legacy_vault_inner(tmp.path(), fault)
            .expect_err("injected fault must surface as Err");
        assert_eq!(
            err.kind(),
            std::io::ErrorKind::Interrupted,
            "{label}: fault must surface as Interrupted"
        );

        // (a) Old vault/ intact + byte-identical to before the interrupt.
        assert!(
            legacy.is_dir(),
            "{label}: old vault/ must survive the interrupt"
        );
        assert_eq!(
            read_tree(&legacy),
            legacy_before,
            "{label}: old vault/ bytes must be untouched by the interrupted run"
        );

        // (b) Nothing visible was published — a partial NEVER lands as a
        // `vaults/<id>/` (the discovery-invisible staging promise).
        assert!(
            vault_roots(tmp.path()).is_empty(),
            "{label}: an interrupted run must not publish any vaults/<id>/"
        );

        // (c) Fault-free re-run completes the migration.
        let outcome = migrate_legacy_vault(tmp.path()).unwrap();
        assert!(
            matches!(outcome, MigrationOutcome::Migrated(_)),
            "{label}: clean re-run must complete the migration"
        );
        assert!(
            !legacy.exists(),
            "{label}: re-run must retire old vault/ last"
        );

        // Exactly one new dir, every artefact byte-identical to the original.
        let new_root = sole_new_vault_root(tmp.path());
        assert_manifest_byte_identical(&new_root, &manifest);
        assert!(
            vault_artifacts_present(&new_root).unwrap(),
            "{label}: re-run dir must pass verify"
        );
    }

    #[test]
    fn interrupt_after_copy_before_fsync_recovers_no_data_loss() {
        assert_interrupt_then_clean_rerun("mig-int-copy", Fault::StopAfterCopyBeforeFsync);
    }

    #[test]
    fn interrupt_after_fsync_before_verify_recovers_no_data_loss() {
        assert_interrupt_then_clean_rerun("mig-int-fsync", Fault::StopAfterFsyncBeforeVerify);
    }

    #[test]
    fn interrupt_after_verify_before_rename_recovers_no_data_loss() {
        assert_interrupt_then_clean_rerun("mig-int-verify", Fault::StopAfterVerifyBeforeRename);
    }

    #[test]
    fn interrupt_after_rename_before_trash_duplicates_but_never_loses() {
        // The documented two-syscall window: the staged copy is committed but
        // the legacy retire did not happen. The re-run migrates AGAIN —
        // yielding a duplicate vault, never deleting the committed one, and
        // never touching an unrelated sibling. Duplicate over deletion.
        let tmp = ScopedTempDir::new("mig-int-trash").unwrap();
        let sibling = seed_real_sibling_vault(tmp.path(), 0x66);
        let before_sibling = read_tree(&sibling);
        let manifest = seed_legacy_vault(tmp.path());
        let legacy = tmp.path().join(LEGACY_VAULT_DIR_NAME);

        let err = migrate_legacy_vault_inner(tmp.path(), Fault::StopAfterRenameBeforeTrash)
            .expect_err("injected fault must surface as Err");
        assert_eq!(err.kind(), std::io::ErrorKind::Interrupted);

        // Committed copy exists, legacy still present (signal not retired).
        assert!(legacy.is_dir(), "legacy survives until the trash rename");
        assert_eq!(
            vault_roots(tmp.path()).len(),
            2,
            "sibling + the committed copy"
        );

        // Clean re-run: a second migrated copy appears; nothing is deleted.
        let outcome = migrate_legacy_vault(tmp.path()).unwrap();
        assert!(matches!(outcome, MigrationOutcome::Migrated(_)));
        assert!(!legacy.exists());
        let roots = vault_roots(tmp.path());
        assert_eq!(
            roots.len(),
            3,
            "sibling + two duplicate migrated copies — duplication, never loss"
        );
        assert_eq!(read_tree(&sibling), before_sibling, "sibling untouched");
        for root in roots.iter().filter(|r| **r != sibling) {
            assert_manifest_byte_identical(root, &manifest);
        }
    }

    #[test]
    fn interrupt_publishes_no_visible_partial() {
        // Explicitly pin the staging promise: after an interrupt that copied
        // files, NO `vaults/<id>/` exists (the old design left a visible
        // partial here and relied on discard-all — the incident's weapon).
        let tmp = ScopedTempDir::new("mig-no-partial").unwrap();
        seed_legacy_vault(tmp.path());

        let _ = migrate_legacy_vault_inner(tmp.path(), Fault::StopAfterCopyBeforeFsync)
            .expect_err("fault surfaces");
        assert!(
            vault_roots(tmp.path()).is_empty(),
            "no visible vaults/<id>/ may exist after an interrupted copy"
        );

        // Re-run: ends with EXACTLY one vault dir.
        migrate_legacy_vault(tmp.path()).unwrap();
        let _ = sole_new_vault_root(tmp.path());
    }

    #[test]
    fn repeated_interrupts_never_accumulate_sibling_dirs() {
        // Crash at every pre-commit step in sequence, re-attempting each
        // time; the final clean run must still leave exactly one vault dir —
        // staging residue never accumulates into visible siblings.
        let tmp = ScopedTempDir::new("mig-repeat-int").unwrap();
        let manifest = seed_legacy_vault(tmp.path());

        for fault in [
            Fault::StopAfterCopyBeforeFsync,
            Fault::StopAfterFsyncBeforeVerify,
            Fault::StopAfterVerifyBeforeRename,
        ] {
            let err = migrate_legacy_vault_inner(tmp.path(), fault).expect_err("fault surfaces");
            assert_eq!(err.kind(), std::io::ErrorKind::Interrupted);
            assert!(
                tmp.path().join(LEGACY_VAULT_DIR_NAME).is_dir(),
                "old vault/ survives every pre-commit interrupt"
            );
        }

        // Clean run finally commits.
        migrate_legacy_vault(tmp.path()).unwrap();
        assert!(!tmp.path().join(LEGACY_VAULT_DIR_NAME).exists());
        let new_root = sole_new_vault_root(tmp.path());
        assert_manifest_byte_identical(&new_root, &manifest);
    }

    // ---- residue sweep ---------------------------------------------------

    #[test]
    fn stale_residue_swept_even_without_legacy_dir() {
        // An interrupt at point D leaves residue but NO legacy dir, so the
        // sweep must run before the legacy early-return — and must never
        // touch restore's staging or real vaults.
        let tmp = ScopedTempDir::new("mig-sweep").unwrap();
        let vaults = tmp.path().join(VAULTS_DIR_NAME);
        let sibling = seed_real_sibling_vault(tmp.path(), 0x77);
        let before = read_tree(&sibling);

        let stale_staging = vaults.join(format!("{STAGING_PREFIX}99999-0"));
        let stale_trash = vaults.join(format!("{TRASH_PREFIX}99999-1"));
        let restore_staging = vaults.join(".restore-staging-99999-0");
        for dir in [&stale_staging, &stale_trash, &restore_staging] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("residue.bin"), b"stale bytes").unwrap();
        }

        let outcome = migrate_legacy_vault(tmp.path()).unwrap();
        assert_eq!(outcome, MigrationOutcome::NothingToMigrate);

        assert!(!stale_staging.exists(), "stale migration staging reclaimed");
        assert!(!stale_trash.exists(), "stale migration trash reclaimed");
        assert!(
            restore_staging.is_dir(),
            "restore's staging prefix must never be touched by migration"
        );
        assert_eq!(read_tree(&sibling), before, "sibling untouched by sweep");
    }

    // ---- helpers --------------------------------------------------------

    /// Read a directory tree into a sorted (relative-path, bytes) manifest for
    /// byte-equality assertions. Used to prove the legacy source is untouched
    /// across an interrupted run.
    fn read_tree(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        fn walk(base: &Path, dir: &Path, acc: &mut Vec<(PathBuf, Vec<u8>)>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(base, &path, acc);
                } else {
                    let rel = path.strip_prefix(base).unwrap().to_path_buf();
                    acc.push((rel, std::fs::read(&path).unwrap()));
                }
            }
        }
        let mut acc = Vec::new();
        walk(root, root, &mut acc);
        acc.sort_by(|a, b| a.0.cmp(&b.0));
        acc
    }
}
