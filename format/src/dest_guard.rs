// SPDX-License-Identifier: AGPL-3.0
//! The ONE destination-containment predicate shared by every user-chosen write
//! destination in the app.
//!
//! Four commands take a path the WebView supplied after the OS save dialog:
//! the markdown-tree export, the backup export, the secret export (recovery
//! phrase / account number) and the diagnostics report bundle. Each has to
//! re-validate it, because the dialog is not evidence the user chose the path —
//! a page that skipped the dialog can call the command directly (TB6, the
//! mistake the removed `fs:allow-write-text-file` `$HOME/**` scope made). The
//! writers rename over an existing path, so a missing check is arbitrary write
//! over `vault.meta`, a `.myn` blob, the diagnostic log, the crash record or the
//! log switch file.
//!
//! They had drifted into three copies. Two of them read a canonicalize failure
//! on a guarded root as "nothing to compare against" and let the write through:
//! a guard that disables itself in the one state where it is still needed
//! (`secret_export`, `export_walk`). The third (diagnostics) got it right and
//! said why. This is that predicate, once.
//!
//! ## Fail-closed, with one stated exemption
//!
//! An unresolved root (`Err`) and a root or parent that cannot be canonicalized
//! both refuse, because a comparison that cannot be made must not pass. The one
//! exemption is a root that does not EXIST yet: it is skipped rather than
//! refused, because it cannot be a component prefix of a parent that did
//! canonicalize, and refusing there broke the feature outright in the DEFAULT
//! configuration — the log directory is created lazily by the first log write,
//! so with logging off it is absent and every report save was refused
//! (myne#860 review).
//!
//! ## Why this lives in `myne-format`
//!
//! The export walk is in this crate (so `myne-decrypt` shares it) and
//! `myne-core` depends on this crate, so this is the lowest point both the walk
//! and the command cores can reach. The alternative — a second copy in
//! `myne-core` — is the drift this module exists to end.
//!
//! Compiles for `wasm32` like [`crate::atomic_write`], where `canonicalize`
//! always fails and every destination is therefore refused. That is the right
//! answer for a client with no OS path to write to, and it is why the module is
//! not gated.

use std::path::{Path, PathBuf};

/// A guarded root as its caller resolved it. `Err` means the host could not
/// resolve it at all, which is a refusal rather than a skipped comparison, and
/// it is spelled `Result` rather than `Option` so a test can construct the
/// unresolved case without a host.
pub type ResolvedRoot = Result<PathBuf, ()>;

/// Why [`containment_refused`] refused a destination. Callers map this onto
/// their own closed error enum; it deliberately carries no `Display`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainmentRefusal {
    /// The parent is empty, or is not an existing directory.
    ParentNotADirectory,
    /// A root the host could not resolve, or a canonicalize failure that is not
    /// `NotFound`.
    Unresolvable,
    /// The canonical parent resolves inside a guarded root.
    InsideRoot,
}

/// The destination's parent must be non-empty and an existing directory. The OS
/// save dialog normally guarantees this; it fails when the directory vanished
/// between confirm and write.
pub fn parent_dir_ok(path: &Path) -> bool {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty() && p.is_dir())
        .is_some()
}

/// Refuse `destination` unless its canonical parent lies outside every guarded
/// root. `Ok(())` is an acceptance.
///
/// The parent is canonicalized (resolving symlinks and `..`) BEFORE the
/// containment test, or a path that reaches a guarded root through either would
/// pass a lexical comparison.
pub fn containment_refused(
    destination: &Path,
    roots: &[ResolvedRoot],
) -> Result<(), ContainmentRefusal> {
    if !parent_dir_ok(destination) {
        return Err(ContainmentRefusal::ParentNotADirectory);
    }
    let canon_parent = destination
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .ok_or(ContainmentRefusal::Unresolvable)?;
    for root in roots {
        let root = root
            .as_ref()
            .map_err(|_| ContainmentRefusal::Unresolvable)?;
        let canon_root = match root.canonicalize() {
            Ok(canon) => canon,
            // A root that does NOT EXIST cannot be a component prefix of a
            // parent that did canonicalize, so skipping buys no protection away
            // and refusing costs the whole feature (see the module doc).
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(ContainmentRefusal::Unresolvable),
        };
        if canon_parent.starts_with(&canon_root) {
            return Err(ContainmentRefusal::InsideRoot);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    fn root_ok(p: &Path) -> ResolvedRoot {
        Ok(p.to_path_buf())
    }

    #[test]
    fn a_destination_inside_a_guarded_root_is_refused() {
        let app_data = ScopedTempDir::new("dest-guard-inside").expect("tempdir");
        let vaults = app_data.path().join("vaults").join("abc");
        std::fs::create_dir_all(&vaults).expect("vault tree");

        assert_eq!(
            containment_refused(&vaults.join("vault.meta"), &[root_ok(app_data.path())]),
            Err(ContainmentRefusal::InsideRoot),
            "a destination inside a guarded root must be refused"
        );
    }

    #[test]
    fn a_traversal_that_reaches_a_guarded_root_is_refused() {
        // The half a lexical comparison misses: the parent is canonicalized
        // first for exactly this case.
        let app_data = ScopedTempDir::new("dest-guard-dotdot").expect("tempdir");
        let name = app_data.path().file_name().expect("tempdir has a name");
        std::fs::create_dir_all(app_data.path().join("vaults").join("abc")).expect("vault tree");
        let reached = app_data
            .path()
            .join("..")
            .join(name)
            .join("vaults")
            .join("abc")
            .join("vault.meta");

        assert_eq!(
            containment_refused(&reached, &[root_ok(app_data.path())]),
            Err(ContainmentRefusal::InsideRoot),
            "a destination that reaches a guarded root through `..` must be refused"
        );
    }

    #[test]
    fn an_unresolved_root_refuses_rather_than_skipping() {
        // The fail-open half, and why the signature takes a Result rather than
        // an Option: a resolver that could not answer means containment cannot
        // be evaluated, and reading that as "nothing to compare against" leaves
        // only the parent-directory rule standing.
        let user = ScopedTempDir::new("dest-guard-unresolved").expect("tempdir");
        assert_eq!(
            containment_refused(&user.path().join("report.txt"), &[Err(())]),
            Err(ContainmentRefusal::Unresolvable),
            "an unresolved guarded root must refuse, not skip"
        );
    }

    #[test]
    fn a_guarded_root_that_does_not_exist_yet_is_skipped() {
        // The fresh-install case, and the one justified exemption.
        let user = ScopedTempDir::new("dest-guard-missing-root").expect("tempdir");
        let missing = user.path().join("not-created");
        let out = ScopedTempDir::new("dest-guard-missing-out").expect("tempdir");

        assert_eq!(
            containment_refused(&out.path().join("report.txt"), &[root_ok(&missing)]),
            Ok(()),
            "a root that does not exist yet must not refuse the write"
        );
    }

    #[test]
    fn a_root_that_cannot_be_resolved_at_all_refuses() {
        // A canonicalize failure that is NOT NotFound refuses. ENOTDIR (a path
        // that runs through a regular file) is the portable way to construct one.
        let dir = ScopedTempDir::new("dest-guard-enotdir").expect("tempdir");
        let file = dir.path().join("regular-file");
        std::fs::write(&file, b"not a directory").expect("seed");
        let bogus_root = file.join("subdir");
        let out = ScopedTempDir::new("dest-guard-enotdir-out").expect("tempdir");

        assert_eq!(
            containment_refused(&out.path().join("report.txt"), &[root_ok(&bogus_root)]),
            Err(ContainmentRefusal::Unresolvable),
            "a root that cannot be canonicalized must refuse"
        );
    }

    #[test]
    fn an_ordinary_destination_outside_every_root_is_accepted() {
        // The non-vacuity half: the refusals above are refusals of THAT shape,
        // not of every path there is.
        let user = ScopedTempDir::new("dest-guard-accept").expect("tempdir");
        let elsewhere = ScopedTempDir::new("dest-guard-accept-root").expect("tempdir");

        assert_eq!(
            containment_refused(
                &user.path().join("myne-report.txt"),
                &[root_ok(elsewhere.path())]
            ),
            Ok(()),
            "a destination outside every guarded root is what the dialog hands us"
        );
    }

    #[test]
    fn a_destination_with_no_parent_directory_is_refused() {
        let dir = ScopedTempDir::new("dest-guard-no-parent").expect("tempdir");
        assert_eq!(
            containment_refused(&dir.path().join("gone").join("report.txt"), &[]),
            Err(ContainmentRefusal::ParentNotADirectory)
        );
        assert_eq!(
            containment_refused(Path::new("bare-filename.txt"), &[]),
            Err(ContainmentRefusal::ParentNotADirectory),
            "an empty parent is the same refusal"
        );
    }
}
