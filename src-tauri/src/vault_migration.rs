//! Eager boot migration: legacy `<app_data_dir>/vault/` → `vaults/<id>/`.
//!
//! SAFETY-CRITICAL. This is the one-shot, idempotent migration that runs at
//! boot **before any routing** (wired from `lib.rs`'s `setup` hook), so the
//! rest of the app only ever observes the post-migration `vaults/<id>/`
//! layout — there is exactly one on-disk invariant for every downstream
//! probe / resolver (PRD §Solution; grill Q3, 2026-06-08).
//!
//! ## Step order (the data-loss-impossible contract)
//!
//! When a legacy `<app_data_dir>/vault/` directory exists:
//!
//! 1. **Discard every partial `vaults/<id>/`** first. The old `vault/` being
//!    present means migration is unfinished, and the only way a `vaults/<id>/`
//!    can exist while `vault/` still does is as a partial from an interrupted
//!    run — so every such directory is discardable. (A fresh install has no
//!    `vaults/`; a completed migration deleted `vault/`.)
//! 2. **Mint** a fresh [`VaultId`](crate::vault_id::VaultId) via
//!    [`mint_unique_vault_id`] (collision-retry) into the now-clean
//!    `vaults/` — the migration target is `vaults/<minted-id>/`.
//! 3. **Copy** the entire legacy `vault/` tree into `vaults/<id>/` —
//!    faithfully, with no hardcoded artefact allowlist: every child present
//!    (the `notes/`, `snapshots/`, `attachments/` directory trees, the
//!    `vault.meta` / `vault.prefs` / `vault.search` / `vault.attachments`
//!    top-level blobs, and any future or unexpected sibling) is carried over,
//!    each file via [`crate::atomic_write::atomic_write`]'s temp+fsync+rename
//!    durability. Copying everything on disk — rather than a fixed
//!    enumeration coupled-by-comment to the verify taxonomy — means no
//!    artefact is ever silently left behind (the drift class that an
//!    allowlist missing `vault.search` would have introduced).
//! 4. **fsync** the new vault root (and its subdirectories) so the new
//!    directory entries reach the OS journal before the verify reads them.
//! 5. **Verify** the new dir: [`vault_artifacts_present`] returns `true`
//!    (the artefact taxonomy is present + readable). A failed verify aborts
//!    *before* the old `vault/` is touched.
//! 6. **Delete the old `vault/` LAST.** Only after a clean verify is the old
//!    directory removed. The old `vault/` is the untouched source of truth
//!    for every step until this final unlink.
//!
//! ## Recovery rule (interrupted migration)
//!
//! The presence of the old `vault/` directory **is** the "migration
//! unfinished" signal. A crash / power loss at any point before step 6
//! leaves `vault/` intact, so the next boot:
//!
//! - sees `vault/` still present ⇒ migration did not finish,
//! - **discards every partial `vaults/<id>/`** left by the interrupted run(s)
//!   (step 1), and
//! - **re-runs** the whole copy from the untouched old `vault/`.
//!
//! Because the old `vault/` is removed only after a verified-complete copy,
//! there is **no window** in which both the old and new directories are
//! gone, and no window in which a partial new dir is mistaken for a complete
//! one (the verify gate + delete-old-last ordering closes both). Data loss
//! is structurally impossible.
//!
//! Each re-run discards **all** prior partials before minting a *fresh* id,
//! so repeated interrupts never accumulate sibling directories — the disk
//! holds at most one `vaults/<id>/` (the in-progress copy) plus the
//! untouched `vault/` at any moment, and after a clean run exactly one
//! `vaults/<id>/` and no `vault/`. The discard sweep removes only directories
//! whose name parses as a `VaultId`; the best-effort `registry.json` cache
//! (and any non-vault sibling) is left untouched.
//!
//! ## Fault-injection seam (mirrors MYND-88 `atomic_write`)
//!
//! The interrupted-recovery contract is exercised by a `#[cfg(test)]`
//! fault-injection seam ([`Fault`]): [`migrate_legacy_vault`] passes
//! [`Fault::None`], so in non-test builds the enum has only that one variant
//! and every `match fault` arm compiles out — the production migration is
//! byte-identical to a seam-free implementation (zero runtime cost). The
//! injected faults model a crash at each of the three interrupt points
//! between the durable steps:
//!
//! - [`Fault::StopAfterCopyBeforeFsync`] — files copied, before the dir fsync.
//! - [`Fault::StopAfterFsyncBeforeVerify`] — copied + fsynced, before verify.
//! - [`Fault::StopAfterVerifyBeforeDeleteOld`] — verified, before the
//!   old-`vault/` delete (the last and most dangerous interrupt — the new
//!   dir is complete but the old one has not yet been removed).
//!
//! In every case the old `vault/` is left intact and the next (fault-free)
//! re-run discards the partial new dir and completes cleanly.
//!
//! ## Logging discipline
//!
//! Per `src-tauri/CLAUDE.md` "Secret-handling logging discipline", full
//! filesystem paths and `VaultId`s are DENY-listed. This module keeps both
//! off the tracing surface — only coarse static `stage` strings and the
//! closed [`IoFailureKind`] reduction are emitted.

use crate::io_failure_kind::from_io_error_kind;
use crate::paths::{LEGACY_VAULT_DIR_NAME, VAULTS_DIR_NAME};
use crate::plugins::vault_creation::commands::vault_artifacts_present;
use crate::vault_registry::mint_unique_vault_id;
use std::path::{Path, PathBuf};

/// Test-only fault-injection points for the boot-migration interrupted-
/// recovery contract — the structural parallel of MYND-88's `atomic_write`
/// [`Fault`](crate::atomic_write) seam.
///
/// In non-test builds the enum has only the [`Fault::None`] variant, so the
/// `match fault` arms in [`migrate_legacy_vault_inner`] compile out and the
/// production migration is byte-identical to a seam-free implementation
/// (zero runtime cost).
#[derive(Clone, Copy)]
enum Fault {
    /// Production path: no injected failure.
    None,
    /// Crash *after* the artefacts are copied into `vaults/<id>/` but
    /// *before* the new-dir fsync — the earliest interrupt point.
    #[cfg(test)]
    StopAfterCopyBeforeFsync,
    /// Crash *after* the copy + fsync but *before* the verify step.
    #[cfg(test)]
    StopAfterFsyncBeforeVerify,
    /// Crash *after* a clean verify but *before* the old-`vault/` delete —
    /// the last interrupt point. The new dir is complete and verified, yet
    /// the old `vault/` has not been removed, so the next boot still treats
    /// the migration as unfinished and re-runs (discarding this verified-but-
    /// uncommitted new dir).
    #[cfg(test)]
    StopAfterVerifyBeforeDeleteOld,
}

/// Outcome of a boot-migration attempt. The path is **internal-only** — it is
/// never emitted over IPC or tracing (full paths are DENY-listed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MigrationOutcome {
    /// No legacy `vault/` directory present — nothing to migrate (fresh
    /// install, or a boot after a prior successful migration). No-op.
    NothingToMigrate,
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
    let legacy = base.join(LEGACY_VAULT_DIR_NAME);

    // The presence of the legacy `vault/` directory IS the "migration
    // unfinished / not-yet-run" signal. Absent ⇒ nothing to do (fresh
    // install, or a boot after a prior successful migration that deleted it).
    if !legacy.is_dir() {
        return Ok(MigrationOutcome::NothingToMigrate);
    }

    tracing::info!(
        stage = "vault_migration_begin",
        "legacy vault/ present — migrating to vaults/<id>/"
    );

    // (1) Discard EVERY partial `vaults/<id>/` BEFORE minting/copying. The
    // old `vault/` being present means the migration is unfinished, and the
    // ONLY way a `vaults/<id>/` can exist while `vault/` still does is as a
    // partial from an interrupted run (a fresh install has no `vaults/`; a
    // completed migration deleted `vault/`). So every `vaults/<id>/` here is
    // discardable partial state. Discarding all of them — not just the
    // about-to-be-minted target — is what prevents siblings accumulating
    // across repeated interrupts (each interrupted run minted its own id).
    discard_all_partial_vault_dirs(base)?;

    // (2) Mint a fresh, collision-free target id into the now-clean `vaults/`.
    // A re-run always mints a NEW id (the prior partials were discarded
    // above), so no half-written bytes from a predecessor ever survive.
    let id = mint_unique_vault_id(base);
    let new_root = base.join(VAULTS_DIR_NAME).join(id.to_string());

    // (3) Copy every artefact into the new root via atomic_write durability.
    copy_vault_tree(&legacy, &new_root)?;

    // --- Interrupt point A: after copy, before the new-dir fsync. ---
    #[cfg(test)]
    if let Fault::StopAfterCopyBeforeFsync = fault {
        return Err(interrupt_error("StopAfterCopyBeforeFsync"));
    }

    // (4) fsync the new vault root + its subdirectories so the new directory
    // entries reach the OS journal before the verify reads them (and before
    // the old dir is deleted).
    fsync_dir_tree(&new_root)?;

    // --- Interrupt point B: after fsync, before verify. ---
    #[cfg(test)]
    if let Fault::StopAfterFsyncBeforeVerify = fault {
        return Err(interrupt_error("StopAfterFsyncBeforeVerify"));
    }

    // (5) Verify the new dir is a present + readable vault BEFORE touching
    // the old one. A failed/partial copy fails the verify and aborts here,
    // leaving the old `vault/` untouched for the next boot to retry.
    if !vault_artifacts_present(&new_root)? {
        tracing::error!(
            stage = "vault_migration_verify_failed",
            "migrated vaults/<id>/ failed the artefact-present verify; aborting before old vault/ delete"
        );
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "migrated vault failed verification",
        ));
    }

    // --- Interrupt point C: after verify, before the old-vault/ delete. ---
    // The last and most dangerous interrupt — the new dir is complete and
    // verified, but the old `vault/` still exists, so the next boot re-runs
    // (discarding this verified-but-uncommitted dir). No data loss.
    #[cfg(test)]
    if let Fault::StopAfterVerifyBeforeDeleteOld = fault {
        return Err(interrupt_error("StopAfterVerifyBeforeDeleteOld"));
    }

    // (6) Delete the old `vault/` LAST. Only now — after a verified-complete
    // copy — is the source of truth removed. This is the single commit point;
    // its completion is what makes the migration "finished".
    delete_old_vault(&legacy)?;

    tracing::info!(
        stage = "vault_migration_complete",
        "migration committed — old vault/ removed"
    );
    Ok(MigrationOutcome::Migrated(new_root))
}

/// Discard EVERY `vaults/<id>/` partial under `base` before a (re-)copy.
///
/// Called only when the old `vault/` is present (migration unfinished), where
/// any `vaults/<id>/` is necessarily a partial from an interrupted run — see
/// the call site. Removing *all* of them (not just the next target) is what
/// keeps siblings from accumulating across repeated interrupts: each
/// interrupted attempt minted its own distinct id, so a per-target discard
/// would leave the previous attempt's dir behind. Only directories whose name
/// parses as a [`VaultId`](crate::vault_id::VaultId) are removed — the
/// best-effort `registry.json` cache (and any non-vault sibling) is left
/// untouched.
///
/// A no-op when `vaults/` is absent (the common fresh-migration case).
/// Surfaces an IO error so a failure to clear a stale partial does not
/// silently co-mingle with a fresh copy.
fn discard_all_partial_vault_dirs(base: &Path) -> std::io::Result<()> {
    let vaults_dir = base.join(VAULTS_DIR_NAME);
    let entries = match std::fs::read_dir(&vaults_dir) {
        Ok(entries) => entries,
        // No `vaults/` dir at all → nothing to discard.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let is_vault_dir = path.is_dir()
            && path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| crate::vault_id::VaultId::parse(n).is_ok());
        if is_vault_dir {
            tracing::warn!(
                stage = "vault_migration_discard_partial",
                "discarding a partial vaults/<id>/ from an interrupted run before re-copy"
            );
            std::fs::remove_dir_all(&path)?;
        }
    }
    Ok(())
}

/// Copy the **entire** legacy vault tree into `new_root`, faithfully — every
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
/// The verify (`vault_artifacts_present` on `new_root`) still gates the
/// delete-old-last commit: a complete copy of a real vault trivially passes,
/// since every artefact the predicate looks for is among the copied children.
fn copy_vault_tree(legacy: &Path, new_root: &Path) -> std::io::Result<()> {
    copy_dir_recursive(legacy, new_root)
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
/// freshly-minted (or freshly-discarded) directory, so a pre-existing target
/// would be a bug; the create-only mode surfaces it rather than silently
/// overwriting.
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

/// Remove the old `vault/` directory tree LAST — the single migration commit
/// point. Recursively unlinks it, then (Unix) `sync_all`s the parent so the
/// removal of the `vault/` directory entry is itself durable: a power loss
/// after this returns must not resurrect the old dir and trigger a spurious
/// re-migration onto a now-committed new layout.
fn delete_old_vault(legacy: &Path) -> std::io::Result<()> {
    std::fs::remove_dir_all(legacy)?;
    #[cfg(unix)]
    {
        if let Some(parent) = legacy.parent() {
            // Best-effort journal-commit of the removal; a failure here does
            // not undo the unlink (the dir is already gone), but surface it
            // so the boot wiring can log it.
            std::fs::File::open(parent)?.sync_all()?;
        }
    }
    Ok(())
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
    use crate::test_support::ScopedTempDir;
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

    /// Resolve the SINGLE `vaults/<id>/` directory under `base`, asserting
    /// exactly one is present. Used post-migration to find the new root
    /// without knowing the minted id.
    fn sole_new_vault_root(base: &Path) -> PathBuf {
        let vaults = base.join(VAULTS_DIR_NAME);
        let mut found: Vec<PathBuf> = std::fs::read_dir(&vaults)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.is_dir()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| VaultId::parse(n).is_ok())
            })
            .collect();
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
            "old vault/ must be deleted last"
        );
        // New vaults/<id>/ holds every artefact, byte-identical.
        let new_root = sole_new_vault_root(tmp.path());
        assert_eq!(outcome, MigrationOutcome::Migrated(new_root.clone()));
        assert_manifest_byte_identical(&new_root, &manifest);
        // The new root's name parses as a VaultId.
        assert!(VaultId::parse(new_root.file_name().unwrap().to_str().unwrap()).is_ok());
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
        // No vaults/ dir materialized.
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

    #[test]
    fn legacy_dir_present_but_empty_migrates_then_noop() {
        // A degenerate empty `vault/` (no artefacts) is still "present" so the
        // migration runs; the verify fails (no artefacts), the old dir is NOT
        // deleted, and an error surfaces — the old dir stays for the next boot.
        let tmp = ScopedTempDir::new("mig-empty-legacy").unwrap();
        std::fs::create_dir_all(tmp.path().join(LEGACY_VAULT_DIR_NAME)).unwrap();

        let err = migrate_legacy_vault(tmp.path())
            .expect_err("empty legacy vault/ fails the artefact verify");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        // Old (empty) vault/ is intact — never deleted on a failed verify.
        assert!(tmp.path().join(LEGACY_VAULT_DIR_NAME).is_dir());
        // No partial new dir survives the next run's pre-copy discard, but a
        // partial may exist now; the invariant under test is old-dir-intact.
    }

    // ---- interrupted migration: fault at EACH step ----------------------
    //
    // The heart of acceptance (PRD §Testing; à la MYND-88). For each of the
    // three interrupt points: (a) the old vault/ is intact + fully readable,
    // (b) a fault-free re-run discards the partial new dir and completes,
    // (c) every artefact is byte-identical to the original.

    /// Drive one interrupt point: inject `fault`, assert the old vault/ is
    /// intact, then re-run clean and assert a complete byte-identical
    /// migration with the old dir gone and exactly one new dir.
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

        // (b) Fault-free re-run discards any partial new dir + completes.
        let outcome = migrate_legacy_vault(tmp.path()).unwrap();
        assert!(
            matches!(outcome, MigrationOutcome::Migrated(_)),
            "{label}: clean re-run must complete the migration"
        );
        assert!(
            !legacy.exists(),
            "{label}: re-run must delete old vault/ last"
        );

        // Exactly one new dir (the partial from the interrupted run was
        // discarded, not left as a second sibling).
        let new_root = sole_new_vault_root(tmp.path());

        // (c) Every artefact byte-identical to the original.
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
    fn interrupt_after_verify_before_delete_old_recovers_no_data_loss() {
        // The most dangerous interrupt: the new dir is complete + verified,
        // yet the old vault/ is not deleted, so the migration is still
        // "unfinished" and the re-run discards the verified-but-uncommitted
        // dir. No data-loss window.
        assert_interrupt_then_clean_rerun("mig-int-verify", Fault::StopAfterVerifyBeforeDeleteOld);
    }

    #[test]
    fn interrupt_leaves_a_partial_new_dir_that_rerun_discards() {
        // Explicitly assert the partial-discard half of the recovery rule:
        // after an interrupt that copied files, a partial vaults/<id>/ DOES
        // exist; the re-run must discard it (mint a fresh id) rather than
        // leave two sibling vault dirs.
        let tmp = ScopedTempDir::new("mig-partial-discard").unwrap();
        seed_legacy_vault(tmp.path());

        // Interrupt after the copy — a partial new dir now exists on disk.
        let _ = migrate_legacy_vault_inner(tmp.path(), Fault::StopAfterCopyBeforeFsync)
            .expect_err("fault surfaces");
        let vaults = tmp.path().join(VAULTS_DIR_NAME);
        let partial_count = std::fs::read_dir(&vaults)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path().is_dir()
                    && e.file_name()
                        .to_str()
                        .is_some_and(|n| VaultId::parse(n).is_ok())
            })
            .count();
        assert_eq!(partial_count, 1, "interrupted copy left one partial dir");

        // Re-run: must end with EXACTLY one vault dir (partial discarded, not
        // accumulated). `sole_new_vault_root` asserts the count == 1.
        migrate_legacy_vault(tmp.path()).unwrap();
        let _ = sole_new_vault_root(tmp.path());
    }

    #[test]
    fn repeated_interrupts_never_accumulate_sibling_dirs() {
        // Crash at every step in sequence, re-attempting each time; the final
        // clean run must still leave exactly one vault dir — partials never
        // accumulate across multiple interrupted attempts.
        let tmp = ScopedTempDir::new("mig-repeat-int").unwrap();
        let manifest = seed_legacy_vault(tmp.path());

        for fault in [
            Fault::StopAfterCopyBeforeFsync,
            Fault::StopAfterFsyncBeforeVerify,
            Fault::StopAfterVerifyBeforeDeleteOld,
        ] {
            let err = migrate_legacy_vault_inner(tmp.path(), fault).expect_err("fault surfaces");
            assert_eq!(err.kind(), std::io::ErrorKind::Interrupted);
            assert!(
                tmp.path().join(LEGACY_VAULT_DIR_NAME).is_dir(),
                "old vault/ survives every interrupt"
            );
        }

        // Clean run finally commits.
        migrate_legacy_vault(tmp.path()).unwrap();
        assert!(!tmp.path().join(LEGACY_VAULT_DIR_NAME).exists());
        let new_root = sole_new_vault_root(tmp.path());
        assert_manifest_byte_identical(&new_root, &manifest);
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
