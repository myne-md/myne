// SPDX-License-Identifier: AGPL-3.0
//! The `myne` PATH shim — how the bundled sidecar becomes a command the user
//! can type (cli-thin-client task 11; MYND-490).
//!
//! Tauri's `externalBin` puts the CLI binary *inside* the bundle, beside the
//! desktop executable (`Myne.app/Contents/MacOS/myne`, or next to
//! `myne-desktop` on Linux). That ships it; it does not make `myne list` work
//! in a fresh shell. This module writes a tiny launcher into the user's own
//! `~/.local/bin`, following `super::super::clipper::install`'s wrapper
//! precedent exactly: a `#!/bin/sh` one-liner that `exec`s the real sidecar,
//! rewritten on every startup so its target tracks the current binary
//! (dev ↔ prod), best-effort and non-fatal.
//!
//! ## Three rules that shape everything here
//!
//! 1. **Never clobber somebody else's `myne`.** Before writing anything we
//!    resolve `myne` on the live `$PATH`. A hit we did not write (no
//!    [`SHIM_MARKER`]) is left strictly alone and reported as
//!    [`ShimOutcome::ForeignOnPath`] — the user's own binary wins, and the
//!    desktop app is not in the business of shadowing it. A hit that IS the
//!    sidecar itself (a distro package that already installed it to
//!    `/usr/bin/myne` — see `packaging/arch/PKGBUILD`) needs no shim at all.
//! 2. **The shim is NOT gated on `cli_enabled`.** The door being off is a
//!    *refusal* the CLI reports (exit code 5, "enable it in Settings" — task
//!    4), and a refusal you can only read if the command exists. Gating the
//!    shim on the toggle would turn that carefully-worded refusal into
//!    `command not found`, which points the user nowhere. The shim is a
//!    launcher, not an access control: the access control is the command
//!    socket's own existence (`super::gate`), which stays default-off.
//! 3. **We do not edit shell profiles.** `~/.local/bin` is on `$PATH` by
//!    default on the mainstream Linux desktops (systemd's user environment,
//!    Debian's `~/.profile`) but not on macOS. Appending to `.zshrc`/`.profile`
//!    is a durable, hard-to-reverse edit to a file the user owns, so the
//!    reconcile reports the fact ([`shim_dir_on_path`]) rather than acting on
//!    it; task 12's Settings copy is where that one manual line belongs.
//!
//! ## Uninstall
//!
//! [`remove`] deletes the shim, and only if it is ours. Nothing calls it in
//! production today (Tauri bundles have no uninstall hook that runs our code),
//! so it is the tested opt-out seam a "remove from PATH" affordance would use.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline" — the shim
//! path and the sidecar path are full filesystem paths (DENY list), so this
//! module logs bounded outcome labels and a boolean only, never a path.

use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};

/// Marker line inside every shim we write. It is what makes "is this file
/// ours?" a fact rather than a guess, and therefore what makes rule 1 above
/// enforceable: a `myne` on `$PATH` without this line is somebody else's.
const SHIM_MARKER: &str = "# myne-cli-shim v1";

/// The command name — the `[[bin]] name` of the `myne-cli` crate, the staged
/// `externalBin` basename, and what the user types. One name, three roles.
const COMMAND_NAME: &str = "myne";

/// The user-level bin dir the shim goes into, relative to `$HOME`. Deliberately
/// not `/usr/local/bin`: that needs root, and a notes app must never ask for it.
const SHIM_DIR_UNDER_HOME: &[&str] = &[".local", "bin"];

/// What one reconcile did. Every variant is a bounded label safe to log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShimOutcome {
    /// The shim was written or refreshed to point at the current sidecar.
    Installed,
    /// A correct shim was already in place; nothing was written.
    Unchanged,
    /// No sidecar beside the running binary — a dev build that never ran
    /// `scripts/build-cli-sidecar.mjs`. Nothing to point a shim at.
    SidecarAbsent,
    /// The sidecar itself already resolves on `$PATH` (a distro package put it
    /// in `/usr/bin`). A shim would be redundant.
    SidecarAlreadyOnPath,
    /// Some other `myne` already resolves on `$PATH`. Left untouched (rule 1).
    ForeignOnPath,
    /// Windows: no shim mechanism yet (documented seam, mirroring
    /// `clipper::install`'s own Windows posture). Constructed only by the
    /// `#[cfg(windows)]` arm of [`reconcile`], so a Unix build sees it as
    /// dead — it stays in the enum because the outcome vocabulary is the
    /// documented surface, not a per-platform subset.
    #[cfg_attr(not(windows), allow(dead_code))]
    Unsupported,
    /// The write failed. Carries only the closed [`crate::io_failure_kind`]
    /// label, never the path or the raw `io::Error`.
    Failed(crate::io_failure_kind::IoFailureKind),
}

impl ShimOutcome {
    /// Stable label for logging + tests.
    pub fn label(self) -> &'static str {
        match self {
            ShimOutcome::Installed => "installed",
            ShimOutcome::Unchanged => "unchanged",
            ShimOutcome::SidecarAbsent => "sidecar_absent",
            ShimOutcome::SidecarAlreadyOnPath => "sidecar_already_on_path",
            ShimOutcome::ForeignOnPath => "foreign_on_path",
            ShimOutcome::Unsupported => "unsupported",
            ShimOutcome::Failed(_) => "failed",
        }
    }
}

/// The sidecar's path: beside the running executable, which is exactly where
/// Tauri places an `externalBin` (and how Tauri's own sidecar resolution finds
/// it), with the target-triple suffix stripped by the bundler.
pub fn sidecar_path_beside(exe: &Path) -> Option<PathBuf> {
    let parent = exe.parent()?;
    let name = if cfg!(windows) {
        format!("{COMMAND_NAME}.exe")
    } else {
        COMMAND_NAME.to_string()
    };
    Some(parent.join(name))
}

/// The shim directory under a given home dir.
pub fn shim_dir_under_home(home: &Path) -> PathBuf {
    let mut dir = home.to_path_buf();
    for part in SHIM_DIR_UNDER_HOME {
        dir.push(part);
    }
    dir
}

/// The shim's own path inside its directory.
fn shim_path(shim_dir: &Path) -> PathBuf {
    shim_dir.join(COMMAND_NAME)
}

// POSIX single-quoting moved to `crate::sh_quote` (myne#381) — the clipper's
// native-messaging launcher needed the same property and had been
// double-quoting instead. The sidecar path comes from `current_exe()`, not
// from a constant, so it is not ours to assume well-behaved; the helper's own
// doc says why double quotes are a different thing rather than a weaker one.
use crate::sh_quote::sh_single_quote;

/// The shim body: `exec` the sidecar with the user's args. The path is
/// single-quoted so one with spaces (`…/Application Support/…`) survives and
/// one with `"`/`` ` ``/`$` cannot expand; `"$@"` forwards verbatim so
/// `myne show <id>` reaches the sidecar unchanged.
fn shim_body(sidecar: &str) -> String {
    let quoted = sh_single_quote(sidecar);
    format!(
        "#!/bin/sh\n{SHIM_MARKER} — written by the Myne desktop app so `{COMMAND_NAME}` is on\n\
         # your PATH. Safe to delete; the app rewrites it on the next start.\nexec {quoted} \"$@\"\n"
    )
}

/// Is this file one of ours? The marker is the whole test — see rule 1.
fn is_our_shim(bytes: &[u8]) -> bool {
    // A shim is a tiny ASCII script; a non-UTF-8 file is definitionally not ours.
    std::str::from_utf8(bytes)
        .map(|text| text.contains(SHIM_MARKER))
        .unwrap_or(false)
}

/// First existing `myne` on a `$PATH`-shaped variable, in `$PATH` order.
/// Empty entries are skipped (a `::` in `$PATH` means "cwd" to some shells;
/// resolving a command out of the current directory is not a thing we want to
/// reason about here).
fn resolve_on_path(path_var: Option<&OsStr>) -> Option<PathBuf> {
    let path_var = path_var?;
    std::env::split_paths(path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(COMMAND_NAME))
        .find(|candidate| candidate.exists())
}

/// Is the shim dir itself on `$PATH`? Reported, never acted on (rule 3).
fn shim_dir_on_path(shim_dir: &Path, path_var: Option<&OsStr>) -> bool {
    match path_var {
        Some(var) => std::env::split_paths(var).any(|dir| dir == shim_dir),
        None => false,
    }
}

/// Does a `myne` the user types resolve at all, on the live `$PATH`?
///
/// The question task 12's Settings copy needs answered, and deliberately NOT
/// the same question as [`shim_dir_on_path`]: any of three things makes the
/// command typeable — a distro package's `/usr/bin/myne`, our own shim, or a
/// `myne` the user put there themselves — and the honest hint depends on
/// whether the command *works*, not on which of the three provided it. `false`
/// with a shim installed is exactly the macOS case rule 3 declines to fix by
/// editing a shell profile.
#[cfg(unix)]
pub fn command_on_path() -> bool {
    resolve_on_path(std::env::var_os("PATH").as_deref()).is_some()
}

/// The shim directory as a display string, for the one `export PATH=…` line
/// Settings tells the user to add (rule 3). `None` when `$HOME` is unset or
/// the path is not UTF-8 — in which case the hint is omitted rather than
/// guessed at.
///
/// This is a full filesystem path, so it may cross IPC to be shown to the
/// user who owns it (the `clipper_install_status` precedent, which surfaces
/// the host binary's path the same way) but must never reach a log line.
#[cfg(unix)]
pub fn shim_dir_for_display() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    shim_dir_under_home(Path::new(&home))
        .to_str()
        .map(str::to_owned)
}

/// Same-file test that tolerates symlinks and `..` (`/usr/bin/myne` reached via
/// a symlinked `/usr/local/bin`), falling back to a plain path comparison when
/// canonicalization is unavailable.
fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// The decision core: what to do given the world's current state. Pure over its
/// inputs (no IO beyond the existence/identity probes its callers already did),
/// so every branch of rule 1 is unit-testable without a bundle or a real PATH.
fn decide(sidecar: &Path, path_var: Option<&OsStr>) -> Result<(), ShimOutcome> {
    if !sidecar.exists() {
        return Err(ShimOutcome::SidecarAbsent);
    }
    match resolve_on_path(path_var) {
        Some(found) if same_file(&found, sidecar) => Err(ShimOutcome::SidecarAlreadyOnPath),
        // A `myne` that is ours — whether it is the file in our own shim dir
        // or a copy left in a directory the shim dir used to be — means
        // writing our own copy is still correct. Anything else (a user's own
        // script, or a file we cannot read) is theirs to keep: we never
        // clobber it, and we never delete files outside our own dir.
        Some(found) => match std::fs::read(&found) {
            Ok(bytes) if is_our_shim(&bytes) => Ok(()),
            _ => Err(ShimOutcome::ForeignOnPath),
        },
        None => Ok(()),
    }
}

/// Write the shim, creating its directory. Write-if-changed (a needless rewrite
/// churns mtime on every app start), executable bit set on Unix.
#[cfg(unix)]
fn write_shim(shim_dir: &Path, sidecar: &Path) -> io::Result<ShimOutcome> {
    use std::os::unix::fs::PermissionsExt;

    let Some(sidecar_str) = sidecar.to_str() else {
        // A non-UTF-8 sidecar path cannot be embedded in a shell script safely.
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "sidecar path is not UTF-8",
        ));
    };
    let body = shim_body(sidecar_str).into_bytes();
    let path = shim_path(shim_dir);
    match std::fs::read(&path) {
        Ok(cur) if cur == body => return Ok(ShimOutcome::Unchanged),
        // Rule 1 on the *write* path, and not a duplicate of `decide()`'s
        // check: `decide()` only ever sees the file `$PATH` resolves, so when
        // the shim dir is absent from `$PATH` — the macOS default rule 3
        // spends a paragraph on — a user-authored `~/.local/bin/myne` is
        // invisible to it and this write would silently replace it, on every
        // app start. `remove()` makes exactly this check before deleting;
        // acting is no less destructive than deleting.
        Ok(cur) if !is_our_shim(&cur) => return Ok(ShimOutcome::ForeignOnPath),
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        // A file we cannot read is a file we cannot claim — the same verdict
        // `decide()` reaches for an unreadable `myne` on `$PATH`.
        Err(_) => return Ok(ShimOutcome::ForeignOnPath),
    }
    std::fs::create_dir_all(shim_dir)?;
    std::fs::write(&path, &body)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    Ok(ShimOutcome::Installed)
}

/// Reconcile the shim against one explicit world (dir + sidecar + `$PATH`).
/// The seam the tests drive; [`reconcile`] is the thin production caller that
/// resolves those three from the environment.
#[cfg(unix)]
pub fn reconcile_in(shim_dir: &Path, sidecar: &Path, path_var: Option<&OsStr>) -> ShimOutcome {
    if let Err(outcome) = decide(sidecar, path_var) {
        return outcome;
    }
    match write_shim(shim_dir, sidecar) {
        Ok(outcome) => outcome,
        Err(e) => ShimOutcome::Failed(crate::io_failure_kind::from_io_error_kind(e.kind())),
    }
}

/// Remove the shim — but only if it is ours (rule 1 applies in both
/// directions). A missing file is success. The opt-out seam; see module docs.
#[cfg_attr(not(test), allow(dead_code))]
pub fn remove(shim_dir: &Path) -> ShimOutcome {
    let path = shim_path(shim_dir);
    match std::fs::read(&path) {
        Ok(bytes) if is_our_shim(&bytes) => match std::fs::remove_file(&path) {
            Ok(()) => ShimOutcome::Unchanged,
            Err(e) => ShimOutcome::Failed(crate::io_failure_kind::from_io_error_kind(e.kind())),
        },
        Ok(_) => ShimOutcome::ForeignOnPath,
        Err(e) if e.kind() == io::ErrorKind::NotFound => ShimOutcome::Unchanged,
        Err(e) => ShimOutcome::Failed(crate::io_failure_kind::from_io_error_kind(e.kind())),
    }
}

/// Startup entry point (`lib.rs` `.setup`): resolve the sidecar beside the
/// running binary and reconcile `~/.local/bin/myne` to it. Best-effort and
/// non-fatal, the same discipline as `clipper::install::reconcile_from_flag`
/// and the relay bind next to it — the app starts regardless.
#[cfg(unix)]
pub fn reconcile() {
    let Ok(exe) = std::env::current_exe() else {
        tracing::debug!(stage = "cli_path_shim", outcome = "exe_unresolved");
        return;
    };
    // Canonicalize so the shim's target survives a symlinked launch path.
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    let Some(sidecar) = sidecar_path_beside(&exe) else {
        tracing::debug!(stage = "cli_path_shim", outcome = "sidecar_unresolved");
        return;
    };
    let Some(home) = std::env::var_os("HOME") else {
        tracing::debug!(stage = "cli_path_shim", outcome = "home_unresolved");
        return;
    };
    let shim_dir = shim_dir_under_home(Path::new(&home));
    let path_var = std::env::var_os("PATH");
    let outcome = reconcile_in(&shim_dir, &sidecar, path_var.as_deref());
    // `on_path` is what task 12's Settings copy needs to know: on macOS
    // `~/.local/bin` is typically NOT on PATH, so an installed shim can still
    // be unreachable and the user needs that one line in their shell profile.
    let on_path = shim_dir_on_path(&shim_dir, path_var.as_deref());
    match outcome {
        ShimOutcome::Failed(kind) => {
            tracing::error!(
                stage = "cli_path_shim",
                outcome = outcome.label(),
                io_failure_kind = ?kind
            );
        }
        _ => tracing::debug!(
            stage = "cli_path_shim",
            outcome = outcome.label(),
            shim_dir_on_path = on_path
        ),
    }
}

/// Windows: no shim mechanism yet. The sidecar still ships inside the bundle;
/// putting it on `%PATH%` means a registry `Path` edit or a Start-menu shim,
/// which is the same fast-follow shape `clipper::install` documents for its own
/// Windows registration.
#[cfg(windows)]
pub fn reconcile() {
    tracing::debug!(
        stage = "cli_path_shim",
        outcome = ShimOutcome::Unsupported.label()
    );
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use myne_core::test_support::ScopedTempDir;
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;

    /// A fake sidecar binary that exists on disk.
    fn make_sidecar(dir: &Path) -> PathBuf {
        let path = dir.join(COMMAND_NAME);
        std::fs::write(&path, b"#!/bin/sh\ntrue\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn path_var(dirs: &[&Path]) -> OsString {
        std::env::join_paths(dirs.iter().map(|d| d.as_os_str())).unwrap()
    }

    #[test]
    fn installs_a_shim_when_nothing_named_myne_is_on_path() {
        let dir = ScopedTempDir::new("shim-install").unwrap();
        let bundle = dir.path().join("bundle");
        std::fs::create_dir_all(&bundle).unwrap();
        let sidecar = make_sidecar(&bundle);
        let shim_dir = dir.path().join("home/.local/bin");
        let empty = dir.path().join("empty-path-dir");
        std::fs::create_dir_all(&empty).unwrap();

        let outcome = reconcile_in(&shim_dir, &sidecar, Some(&path_var(&[&empty])));

        assert_eq!(outcome, ShimOutcome::Installed);
        let body = std::fs::read_to_string(shim_path(&shim_dir)).unwrap();
        assert!(body.starts_with("#!/bin/sh"));
        assert!(
            body.contains(SHIM_MARKER),
            "must carry the ownership marker"
        );
        assert!(body.contains(sidecar.to_str().unwrap()));
        assert!(
            body.contains("\"$@\""),
            "must forward the user's args verbatim"
        );
        let mode = std::fs::metadata(shim_path(&shim_dir))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111, "shim must be executable");
    }

    #[test]
    fn a_second_reconcile_is_a_no_op() {
        let dir = ScopedTempDir::new("shim-idem").unwrap();
        let sidecar = make_sidecar(dir.path());
        let shim_dir = dir.path().join("bin");

        assert_eq!(
            reconcile_in(&shim_dir, &sidecar, None),
            ShimOutcome::Installed
        );
        assert_eq!(
            reconcile_in(&shim_dir, &sidecar, None),
            ShimOutcome::Unchanged
        );
    }

    #[test]
    fn a_stale_shim_is_refreshed_to_the_current_sidecar() {
        // The dev ↔ prod case the clipper wrapper solves the same way: the app
        // moved, so the shim's target must move with it.
        let dir = ScopedTempDir::new("shim-refresh").unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("new");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        let old_sidecar = make_sidecar(&old);
        let new_sidecar = make_sidecar(&new);
        let shim_dir = dir.path().join("bin");

        reconcile_in(&shim_dir, &old_sidecar, None);
        // The shim dir is now on PATH and holds OUR shim — the refresh path.
        let outcome = reconcile_in(&shim_dir, &new_sidecar, Some(&path_var(&[&shim_dir])));

        assert_eq!(outcome, ShimOutcome::Installed);
        let body = std::fs::read_to_string(shim_path(&shim_dir)).unwrap();
        assert!(body.contains(new_sidecar.to_str().unwrap()));
        assert!(!body.contains(old_sidecar.to_str().unwrap()));
    }

    #[test]
    fn a_foreign_myne_on_path_is_left_strictly_alone() {
        let dir = ScopedTempDir::new("shim-foreign").unwrap();
        let sidecar = make_sidecar(dir.path());
        let foreign_dir = dir.path().join("usr-bin");
        std::fs::create_dir_all(&foreign_dir).unwrap();
        let foreign = foreign_dir.join(COMMAND_NAME);
        std::fs::write(&foreign, b"#!/bin/sh\necho somebody elses myne\n").unwrap();
        let shim_dir = dir.path().join("bin");

        let outcome = reconcile_in(&shim_dir, &sidecar, Some(&path_var(&[&foreign_dir])));

        assert_eq!(outcome, ShimOutcome::ForeignOnPath);
        assert!(
            !shim_path(&shim_dir).exists(),
            "must not install a shim that would shadow a foreign `myne`"
        );
        assert_eq!(
            std::fs::read(&foreign).unwrap(),
            b"#!/bin/sh\necho somebody elses myne\n",
            "the foreign binary must be byte-identical afterwards"
        );
    }

    #[test]
    fn a_user_written_file_in_our_own_shim_dir_is_also_left_alone() {
        // Rule 1 does not stop at other directories: if the user replaced our
        // shim with their own script, it is theirs now.
        let dir = ScopedTempDir::new("shim-ours-replaced").unwrap();
        let sidecar = make_sidecar(dir.path());
        let shim_dir = dir.path().join("bin");
        std::fs::create_dir_all(&shim_dir).unwrap();
        std::fs::write(shim_path(&shim_dir), b"#!/bin/sh\nmy own wrapper\n").unwrap();

        let outcome = reconcile_in(&shim_dir, &sidecar, Some(&path_var(&[&shim_dir])));

        assert_eq!(outcome, ShimOutcome::ForeignOnPath);
        assert_eq!(
            std::fs::read_to_string(shim_path(&shim_dir)).unwrap(),
            "#!/bin/sh\nmy own wrapper\n"
        );
    }

    #[test]
    fn a_user_written_file_survives_when_the_shim_dir_is_not_on_path() {
        // The same rule-1 case as above, in the configuration rule 3 exists to
        // describe: `~/.local/bin` absent from `$PATH` (the macOS default, and
        // any Linux user who has not enabled it). `decide()` cannot see the
        // file at all there — nothing named `myne` resolves — so the check has
        // to live on the write path or the user's script is silently replaced
        // on every app start.
        let dir = ScopedTempDir::new("shim-ours-replaced-off-path").unwrap();
        let sidecar = make_sidecar(dir.path());
        let shim_dir = dir.path().join("bin");
        std::fs::create_dir_all(&shim_dir).unwrap();
        std::fs::write(shim_path(&shim_dir), b"#!/bin/sh\nmy own wrapper\n").unwrap();
        let elsewhere = dir.path().join("usr-bin");
        std::fs::create_dir_all(&elsewhere).unwrap();

        let outcome = reconcile_in(&shim_dir, &sidecar, Some(&path_var(&[&elsewhere])));

        assert_eq!(outcome, ShimOutcome::ForeignOnPath);
        assert_eq!(
            std::fs::read_to_string(shim_path(&shim_dir)).unwrap(),
            "#!/bin/sh\nmy own wrapper\n",
            "a file we did not write must survive byte-identically"
        );

        // …and an empty `$PATH` is the same case, not a licence to write.
        assert_eq!(
            reconcile_in(&shim_dir, &sidecar, None),
            ShimOutcome::ForeignOnPath
        );
        assert_eq!(
            std::fs::read_to_string(shim_path(&shim_dir)).unwrap(),
            "#!/bin/sh\nmy own wrapper\n"
        );
    }

    #[test]
    fn a_sidecar_path_with_shell_metacharacters_is_execed_literally() {
        // `current_exe()` is not a constant: a user can install the app under a
        // directory containing `"`, `` ` `` or `$`. Unquoted (or double-quoted)
        // interpolation would produce a launcher that expands or breaks.
        let dir = ScopedTempDir::new("shim-metachars").unwrap();
        let bundle = dir.path().join("we$ird `dir` \"x\"");
        std::fs::create_dir_all(&bundle).unwrap();
        let sidecar = bundle.join(COMMAND_NAME);
        std::fs::write(&sidecar, b"#!/bin/sh\necho \"args:$*\"\nexit 3\n").unwrap();
        std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o755)).unwrap();
        let shim_dir = dir.path().join("bin");

        assert_eq!(
            reconcile_in(&shim_dir, &sidecar, None),
            ShimOutcome::Installed
        );

        let out = std::process::Command::new(shim_path(&shim_dir))
            .args(["list"])
            .output()
            .expect("the shim must be executable");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "args:list");
        assert_eq!(out.status.code(), Some(3));
    }

    // The quoting helper's own unit tests moved with it, to
    // `crate::sh_quote` (myne#381). What stays here is the test above, which
    // EXECUTES the generated shim — the property this module is responsible
    // for, as opposed to the property the helper is.

    #[test]
    fn the_sidecar_already_on_path_needs_no_shim() {
        // The `packaging/arch/PKGBUILD` case: the distro package installed the
        // real CLI to /usr/bin/myne, so a shim would be pure redundancy.
        let dir = ScopedTempDir::new("shim-already").unwrap();
        let usr_bin = dir.path().join("usr-bin");
        std::fs::create_dir_all(&usr_bin).unwrap();
        let sidecar = make_sidecar(&usr_bin);
        let shim_dir = dir.path().join("bin");

        let outcome = reconcile_in(&shim_dir, &sidecar, Some(&path_var(&[&usr_bin])));

        assert_eq!(outcome, ShimOutcome::SidecarAlreadyOnPath);
        assert!(!shim_path(&shim_dir).exists());
    }

    #[test]
    fn no_sidecar_beside_the_binary_installs_nothing() {
        let dir = ScopedTempDir::new("shim-absent").unwrap();
        let shim_dir = dir.path().join("bin");
        let missing = dir.path().join("nowhere").join(COMMAND_NAME);

        let outcome = reconcile_in(&shim_dir, &missing, None);

        assert_eq!(outcome, ShimOutcome::SidecarAbsent);
        assert!(!shim_path(&shim_dir).exists());
    }

    #[test]
    fn remove_deletes_our_shim_but_not_a_foreign_one() {
        let dir = ScopedTempDir::new("shim-remove").unwrap();
        let sidecar = make_sidecar(dir.path());
        let ours = dir.path().join("ours");
        let theirs = dir.path().join("theirs");
        reconcile_in(&ours, &sidecar, None);
        std::fs::create_dir_all(&theirs).unwrap();
        std::fs::write(shim_path(&theirs), b"not ours\n").unwrap();

        assert_eq!(remove(&ours), ShimOutcome::Unchanged);
        assert!(!shim_path(&ours).exists());
        assert_eq!(remove(&theirs), ShimOutcome::ForeignOnPath);
        assert!(shim_path(&theirs).exists());
        // Idempotent: removing an already-absent shim is success, not an error.
        assert_eq!(remove(&ours), ShimOutcome::Unchanged);
    }

    #[test]
    fn the_installed_shim_actually_execs_the_sidecar_with_the_users_args() {
        // The whole point of the file, executed rather than string-matched: a
        // shim that is not a runnable launcher (bad shebang, unquoted path,
        // dropped `"$@"`, swallowed exit code) passes every assertion above and
        // still leaves the user with a broken `myne`.
        let dir = ScopedTempDir::new("shim-exec").unwrap();
        // A directory with a space in it — the quoting case macOS hits by
        // default (`~/Library/Application Support/…`).
        let bundle = dir.path().join("Application Support");
        std::fs::create_dir_all(&bundle).unwrap();
        let sidecar = bundle.join(COMMAND_NAME);
        // Stands in for the real CLI: echoes its args, exits with a distinct code.
        std::fs::write(&sidecar, b"#!/bin/sh\necho \"args:$*\"\nexit 7\n").unwrap();
        std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o755)).unwrap();
        let shim_dir = dir.path().join("bin");

        assert_eq!(
            reconcile_in(&shim_dir, &sidecar, None),
            ShimOutcome::Installed
        );

        let out = std::process::Command::new(shim_path(&shim_dir))
            .args(["show", "a b"])
            .output()
            .expect("the shim must be executable");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "args:show a b",
            "args must reach the sidecar verbatim"
        );
        assert_eq!(
            out.status.code(),
            Some(7),
            "the sidecar's exit code must pass through (`exec`, not a subshell)"
        );
    }

    #[test]
    fn sidecar_resolves_beside_the_running_executable() {
        assert_eq!(
            sidecar_path_beside(Path::new("/Applications/Myne.app/Contents/MacOS/Myne")),
            Some(PathBuf::from("/Applications/Myne.app/Contents/MacOS/myne"))
        );
        assert_eq!(sidecar_path_beside(Path::new("/")), None);
    }

    #[test]
    fn shim_dir_is_dot_local_bin_under_home() {
        assert_eq!(
            shim_dir_under_home(Path::new("/home/someone")),
            PathBuf::from("/home/someone/.local/bin")
        );
    }

    #[test]
    fn shim_dir_on_path_reports_without_acting() {
        let on = path_var(&[Path::new("/home/x/.local/bin"), Path::new("/usr/bin")]);
        let off = path_var(&[Path::new("/usr/bin")]);
        let dir = Path::new("/home/x/.local/bin");
        assert!(shim_dir_on_path(dir, Some(&on)));
        assert!(!shim_dir_on_path(dir, Some(&off)));
        assert!(!shim_dir_on_path(dir, None));
    }

    #[test]
    fn empty_path_entries_never_resolve_a_command() {
        // A `::` in $PATH means the current directory to some shells; resolving
        // `myne` out of the cwd is not a decision this module should make.
        let dir = ScopedTempDir::new("shim-empty-entry").unwrap();
        make_sidecar(dir.path());
        assert_eq!(resolve_on_path(Some(OsStr::new("::"))), None);
        assert_eq!(resolve_on_path(None), None);
    }

    #[test]
    fn outcome_labels_are_bounded_and_carry_no_path() {
        // The logging discipline in one assertion: the label vocabulary is
        // closed, so no `tracing` call site in this module can emit a path.
        for outcome in [
            ShimOutcome::Installed,
            ShimOutcome::Unchanged,
            ShimOutcome::SidecarAbsent,
            ShimOutcome::SidecarAlreadyOnPath,
            ShimOutcome::ForeignOnPath,
            ShimOutcome::Unsupported,
            ShimOutcome::Failed(crate::io_failure_kind::IoFailureKind::PermissionDenied),
        ] {
            let label = outcome.label();
            assert!(!label.is_empty());
            assert!(!label.contains('/'), "a label must never look like a path");
        }
    }
}
