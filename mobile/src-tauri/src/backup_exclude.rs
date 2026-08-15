// SPDX-License-Identifier: AGPL-3.0
//! Keep Myne's mobile export directory out of the platform's automatic cloud
//! backup (myne-md/myne#491).
//!
//! ## The hole this closes
//!
//! Four mobile flows write **plaintext** into the app's `Documents` directory —
//! the recovery phrase / account number (`secret-export.ts`), the whole-vault
//! markdown tree (`export.ts`), a note's PDF (`EditorFlow.tsx`) and an exported
//! attachment (`editor-host.ts`). On iOS `Documents/` is included in iCloud
//! Backup by default; on Android the same directory (`getExternalFilesDir(
//! DIRECTORY_DOCUMENTS)`) is included in Auto Backup by default. Nothing in the
//! tree excluded either. A recovery phrase alone reconstructs the vault, so an
//! Apple- or Google-held copy of it defeats the zero-knowledge posture outright.
//!
//! ## What this module does
//!
//! Sets `NSURLIsExcludedFromBackupKey` on the **directory**, once, at startup.
//! Directory-level exclusion covers files created inside it afterwards (Apple
//! QA1719), so one call closes all four writers and every future one, instead of
//! each write site having to remember. The Android half of the same decision is
//! declarative and lives in `android-widgets/src/main/res/xml/myne_backup_rules
//! *.xml`; `scripts/check-mobile-export-backup.mjs` holds the two halves to the
//! same directory roster in both directions.
//!
//! The exclusion is a property of the destination, **not** a substitute for the
//! `0600` create mode or the app-data containment check in
//! `myne_core::plugins::secret_export` — it removes one egress channel (the
//! platform backup) and leaves the file exactly where the user asked for it.
//!
//! ## Verification status
//!
//! What is **proven**, and by a test rather than by a session nobody can repeat:
//! `exclude_from_backup` sets the flag on a real directory and the flag reads
//! back as set. `tests::macos::the_flag_is_set_and_reads_back` runs the exact
//! shipped call against macOS Foundation on a fresh temp directory and then
//! confirms `com.apple.metadata:com_apple_backup_excludeItem` where there was no
//! such xattr. That covers the parts that could be silently wrong: the
//! `NSURLIsExcludedFromBackupKey` constant, the `NSNumber` boxing, the
//! `fileURLWithPath:isDirectory:` bridge, and reading the result back rather
//! than trusting the setter's return.
//!
//! It is a macOS test because macOS is the only Apple target anything runs on
//! here: the CI runner is Linux and no simulator boots in it. That is a smaller
//! claim than "iOS honours it" and it is the largest one that can be made
//! automatically, so it is made automatically instead of being written down as a
//! thing somebody once did.
//!
//! What is **not** proven: that the same call, made from the app on a real iOS
//! device, lands on the directory the WebView writes to and is honoured by iOS's
//! backup rather than macOS's. Like `share_file.rs` and `pdf_export.rs`, that is
//! owed to `docs/dev/device-matrix.md` §8 row 8.9, which has not been run. A
//! green build is not that proof, and neither is a green
//! `scripts/check-mobile-export-backup.mjs`: the guard proves the four files
//! agree with each other.
//!
//! One more limit, stated because it was found by breaking the tests rather than
//! by reading them: no test here can pin that [`exclude_from_backup`] *returns*
//! the read-back rather than the setter's answer. Replacing its last line with
//! `true` leaves every test below green, because the case that separates the two
//! is "the setter reported success and the flag is absent", which is not
//! constructible on demand. What the tests do pin is that the read-back is a
//! live read of the file system (`the_read_back_is_a_live_read`) and that the
//! flag genuinely lands (`the_exclusion_lands_as_the_backupd_xattr`). The
//! composition of the two is five visible lines and a reviewer's job.

/// The directories this module excludes from platform backup, as the *names*
/// `scripts/check-mobile-export-backup.mjs` compares against the roster of
/// `@tauri-apps/api/path` accessors the mobile tree actually calls and against
/// the Android backup-rules XML. A directory reachable from `mobile/src` that is
/// absent here is an egress channel nothing closed — which is exactly the
/// pre-#491 state, one accessor over.
///
/// Kept as a plain slice rather than folded into [`init`] so the guard can read
/// the iOS side of the contract without parsing Rust control flow. That
/// convenience used to cost a fail-open hole: the guard reads this literal and
/// never the `match` that maps a name to a resolver, so a name added here with
/// no arm compiled, passed every check, and warned to a device log nobody reads
/// while excluding nothing. [`resolver_kind`] and
/// [`tests::every_excluded_dir_has_a_resolver`] close it, so an unwired entry
/// now fails `cargo test` on every platform rather than at runtime on one.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub const EXCLUDED_DIRS: &[&str] = &["Documents"];

/// Which Tauri path accessor resolves a roster name, or `None` when nothing
/// does. Split out of [`init`] so the mapping is testable off iOS: the failure
/// it guards (a roster entry with no resolver) is a property of the pair, and
/// pairing them only inside an `#[cfg(target_os = "ios")]` function is what made
/// the mismatch invisible to every platform anything runs on.
#[derive(Debug, PartialEq, Eq)]
pub enum ResolverKind {
    /// `PathResolver::document_dir()`, the directory `documentDir()` hands the
    /// WebView.
    DocumentDir,
}

/// Note the deliberate absence of a catch-all returning a default: an unknown
/// name resolves to `None`, and the test turns that into a build failure.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn resolver_kind(dir: &str) -> Option<ResolverKind> {
    match dir {
        "Documents" => Some(ResolverKind::DocumentDir),
        _ => None,
    }
}

/// Exclude the app's export directories from iCloud Backup. Idempotent — the
/// resource value is re-set on every launch, which also repairs a container
/// restored from an older backup that predates this call.
///
/// Never panics and never blocks startup: every failure is a `tracing::warn!`,
/// following `share_file.rs` / `screen_guard.rs`. A failure here means the
/// directory stays backed up, which is the pre-#491 behaviour, not a crash.
#[cfg(target_os = "ios")]
pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;

    let resolver = app.path();
    for dir in EXCLUDED_DIRS {
        // Resolve through Tauri's own path API rather than composing the path
        // here: this MUST be the same directory `documentDir()` returns to the
        // WebView, and the only way to guarantee that is to ask the same
        // resolver the WebView asks.
        let path = match resolver_kind(dir) {
            Some(ResolverKind::DocumentDir) => resolver.document_dir(),
            None => {
                // Unreachable in a tree that passes `cargo test`; kept because
                // the alternative is a panic on a startup path.
                tracing::warn!(
                    event = "backup_exclude_unknown_dir",
                    dir = *dir,
                    "no resolver wired for this directory; not excluded"
                );
                continue;
            }
        };
        let Ok(path) = path else {
            tracing::warn!(
                event = "backup_exclude_unresolved",
                dir = *dir,
                "path resolver failed; directory not excluded from backup"
            );
            continue;
        };
        // A first launch that has not exported anything yet may have no such
        // directory. Create it now: the flag has to be set BEFORE the first
        // write, and setting it on a missing path is a no-op that would leave
        // the first export backed up. Unconditional because `create_dir_all` is
        // already `Ok(())` on an existing directory, and an `exists()` test in
        // front of it only adds a window in which the answer stops being true.
        if let Err(e) = std::fs::create_dir_all(&path) {
            tracing::warn!(
                event = "backup_exclude_mkdir_failed",
                dir = *dir,
                error_kind = ?e.kind(),
                "could not create directory; not excluded from backup"
            );
            continue;
        }
        let Some(path) = path.to_str() else {
            tracing::warn!(
                event = "backup_exclude_non_utf8_path",
                dir = *dir,
                "path is not UTF-8; directory not excluded from backup"
            );
            continue;
        };
        if !apple::exclude_from_backup(path) {
            tracing::warn!(
                event = "backup_exclude_failed",
                dir = *dir,
                "the exclusion flag does not read back as set; directory not excluded from backup"
            );
        }
    }
}

/// Android carries the same property declaratively — the two `<application>`
/// attributes `android:dataExtractionRules` and `android:fullBackupContent`, from
/// the committed `android-widgets` library manifest — so there is nothing to do
/// at runtime. Desktop targets have no platform backup of this kind.
#[cfg(not(target_os = "ios"))]
pub fn init<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {}

/// The Apple half. Gated on iOS **plus macOS-under-test** rather than on iOS
/// alone, so the one function that performs the actual exclusion is compiled and
/// its effect asserted by `cargo test` on any Mac, instead of only by a build
/// nothing here runs. The shipped code path is the iOS one; macOS never calls
/// [`init`], which is a no-op there.
#[cfg(any(target_os = "ios", all(target_os = "macos", test)))]
mod apple {
    use objc2_foundation::{NSNumber, NSString, NSURLIsExcludedFromBackupKey, NSURL};

    /// `[[NSURL fileURLWithPath:isDirectory:YES] setResourceValue:@YES
    /// forKey:NSURLIsExcludedFromBackupKey error:nil]`, followed by a read-back
    /// of the same key. Returns whether the flag **is set**, which is not the
    /// same question as whether the setter returned YES.
    ///
    /// The read-back is the point. `setResourceValue:forKey:error:` reports that
    /// Foundation accepted the call; nothing in that answer says the attribute
    /// stuck to the directory, and this warn line is the only runtime evidence
    /// that exists (row 8.9 has to `ls -l@` the container by hand precisely
    /// because nothing in the process could answer it). Asserting the weaker
    /// fact and logging the stronger one is how a module ships inert.
    ///
    /// Typed `objc2-foundation` bindings rather than the raw `msg_send!` idiom
    /// `share_file.rs` uses: `NSURLIsExcludedFromBackupKey` is an extern
    /// `NSString` constant, and hand-declaring it (or hardcoding its string
    /// value) is the one part of this that would fail silently, since a wrong
    /// key name makes `setResourceValue:` return NO and the directory stays
    /// backed up. The crate is already a direct iOS dependency here with `NSURL`
    /// and `NSString` enabled; `NSValue` (which carries `NSNumber`) and
    /// `NSError` (which gates `setResourceValue:forKey:error:` itself) are the
    /// two added, and both are modules of a crate already in the build rather
    /// than new crates.
    pub fn exclude_from_backup(path: &str) -> bool {
        let ns_path = NSString::from_str(path);
        // `isDirectory: true` rather than `fileURLWithPath:` alone: the flag
        // saves UIKit a stat, and the URL must denote the DIRECTORY, since a URL
        // that resolved as a file would set the flag on nothing.
        let url = NSURL::fileURLWithPath_isDirectory(&ns_path, true);
        let yes = NSNumber::new_bool(true);
        // SAFETY: `setResourceValue:forKey:error:` takes an id value and an
        // NSString key; `NSURLIsExcludedFromBackupKey` is the Foundation-owned
        // constant, and the objc2 binding maps the trailing NSError** out-param
        // onto the `Result`, so no raw error pointer is constructed here.
        if unsafe { url.setResourceValue_forKey_error(Some(&yes), NSURLIsExcludedFromBackupKey) }
            .is_err()
        {
            return false;
        }
        reads_back_as_excluded(&url)
    }

    /// Whether `NSURLIsExcludedFromBackupKey` currently reads as `true` on `url`.
    ///
    /// A URL caches resource values it has already fetched, so the read happens
    /// on a freshly built `NSURL` rather than on the one just written through.
    pub fn reads_back_as_excluded(url: &NSURL) -> bool {
        // Drop the value this URL cached when the setter ran, so what comes back
        // is the file system's answer rather than the one just written through.
        url.removeCachedResourceValueForKey(unsafe { NSURLIsExcludedFromBackupKey });
        let mut value: Option<objc2::rc::Retained<objc2::runtime::AnyObject>> = None;
        // SAFETY: `NSURLIsExcludedFromBackupKey` is documented to carry a
        // boolean `NSNumber`, which is what the downcast below checks for rather
        // than assumes; the binding maps the trailing NSError** out-param onto
        // the `Result`, so no raw error pointer is constructed here.
        if unsafe { url.getResourceValue_forKey_error(&mut value, NSURLIsExcludedFromBackupKey) }
            .is_err()
        {
            return false;
        }
        value
            .and_then(|value| value.downcast::<NSNumber>().ok())
            .is_some_and(|number| number.as_bool())
    }
}

#[cfg(test)]
mod tests {
    use super::{resolver_kind, EXCLUDED_DIRS};

    /// The roster is what `scripts/check-mobile-export-backup.mjs` compares the
    /// Android rules XML against; an empty or duplicated one would make that
    /// comparison vacuous while still passing.
    #[test]
    fn excluded_dirs_is_non_empty_and_unique() {
        assert!(!EXCLUDED_DIRS.is_empty(), "roster may not be empty");
        let mut seen = std::collections::BTreeSet::new();
        for dir in EXCLUDED_DIRS {
            assert!(seen.insert(*dir), "duplicate directory in roster: {dir}");
            assert!(!dir.is_empty(), "empty directory name in roster");
            assert!(
                !dir.contains('/') && !dir.contains('\\'),
                "roster holds directory NAMES relative to the platform export \
                 root, not paths: {dir}"
            );
        }
    }

    /// The fail-open hole the guard cannot see. `scripts/check-mobile-export-backup.mjs`
    /// reads the `EXCLUDED_DIRS` literal and never the mapping, so a name added
    /// to the roster with no resolver behind it satisfies the guard, the Android
    /// XML and the TS roster all at once, then excludes nothing at runtime and
    /// says so only in a device log.
    #[test]
    fn every_excluded_dir_has_a_resolver() {
        for dir in EXCLUDED_DIRS {
            assert!(
                resolver_kind(dir).is_some(),
                "EXCLUDED_DIRS carries {dir:?} and no resolver arm answers it, so iOS would \
                 warn and exclude nothing. Add the arm in `resolver_kind`."
            );
        }
    }

    /// Reject the name nothing resolves, rather than trusting a `match` to have
    /// no catch-all. A `_ => Some(ResolverKind::DocumentDir)` would make the
    /// test above pass for every possible string.
    #[test]
    fn an_unwired_directory_resolves_to_nothing() {
        assert!(resolver_kind("Downloads").is_none());
        assert!(resolver_kind("").is_none());
    }

    /// The Apple half, run for real. macOS is the only Apple target anything in
    /// this repo executes on: CI is Linux and no simulator boots there. So this
    /// is the largest automatic claim available, and it is the one that would
    /// catch the failures that are otherwise silent, since a wrong key constant,
    /// a mis-boxed `NSNumber` or a URL built as a file rather than a directory
    /// all leave `setResourceValue:` reporting something while the flag is not
    /// set.
    #[cfg(target_os = "macos")]
    mod macos {
        use super::super::apple;
        use objc2_foundation::{NSString, NSURL};

        /// A temp directory that removes itself, so a failing assert does not
        /// leave one behind.
        struct TempDir(std::path::PathBuf);

        impl TempDir {
            fn new(tag: &str) -> Self {
                let mut path = std::env::temp_dir();
                path.push(format!(
                    "myne-backup-exclude-{tag}-{}-{:?}",
                    std::process::id(),
                    std::thread::current().id()
                ));
                let _ = std::fs::remove_dir_all(&path);
                std::fs::create_dir_all(&path).expect("temp dir");
                Self(path)
            }
        }

        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        fn url_for(path: &std::path::Path) -> objc2::rc::Retained<NSURL> {
            let ns = NSString::from_str(path.to_str().expect("utf-8 temp path"));
            NSURL::fileURLWithPath_isDirectory(&ns, true)
        }

        #[test]
        fn the_flag_is_set_and_reads_back() {
            let dir = TempDir::new("set");
            let path = dir.0.to_str().expect("utf-8 temp path");

            // The precondition matters: without it a Foundation that ignored the
            // call entirely would still pass, on a directory that happened to
            // carry the flag already.
            assert!(
                !apple::reads_back_as_excluded(&url_for(&dir.0)),
                "a fresh temp directory should not already be excluded from backup"
            );

            assert!(
                apple::exclude_from_backup(path),
                "setting NSURLIsExcludedFromBackupKey on a fresh directory failed"
            );
            assert!(
                apple::reads_back_as_excluded(&url_for(&dir.0)),
                "the flag was reported set and does not read back"
            );
        }

        /// The xattr is the thing iOS's backup actually consults, and
        /// `device-matrix.md` row 8.9 checks it by hand with `ls -l@`. Reading it
        /// here means the Foundation call is observed through a second,
        /// independent surface rather than only through Foundation's own answer.
        #[test]
        fn the_exclusion_lands_as_the_backupd_xattr() {
            let dir = TempDir::new("xattr");
            let path = dir.0.to_str().expect("utf-8 temp path");
            let names = || {
                std::process::Command::new("xattr")
                    .arg(path)
                    .output()
                    .map(|out| String::from_utf8_lossy(&out.stdout).to_string())
                    .unwrap_or_default()
            };
            const XATTR: &str = "com.apple.metadata:com_apple_backup_excludeItem";

            assert!(
                !names().contains(XATTR),
                "a fresh temp directory should not already carry {XATTR}"
            );
            assert!(apple::exclude_from_backup(path));
            assert!(
                names().contains(XATTR),
                "exclude_from_backup reported success and {XATTR} is absent; \
                 the flag did not reach the file system"
            );
        }

        /// A path with nothing at it cannot be excluded, and must not be
        /// reported as excluded. `init` creates the directory first for exactly
        /// this reason; this pins that the reason is real.
        #[test]
        fn a_missing_directory_is_not_reported_as_excluded() {
            let dir = TempDir::new("missing");
            let absent = dir.0.join("no-such-subdirectory");
            assert!(!apple::exclude_from_backup(
                absent.to_str().expect("utf-8 temp path")
            ));
        }

        /// The read-back has to be a live read, not a value that happens to be
        /// true. Clear the flag through a SECOND `NSURL` for the same directory
        /// and the answer must flip.
        ///
        /// Both mutations go through Foundation on purpose. The obvious version
        /// of this test strips the attribute with `xattr -d` and asks Foundation
        /// immediately afterwards, and that version is FLAKY: it failed 2 runs in
        /// 12 here, because an out-of-band change is not guaranteed to be visible
        /// to the next Foundation read. Keeping both mutations inside Foundation
        /// removes the window without weakening what is asserted.
        #[test]
        fn the_read_back_is_a_live_read() {
            let dir = TempDir::new("live");
            let path = dir.0.to_str().expect("utf-8 temp path");
            assert!(apple::exclude_from_backup(path));
            assert!(apple::reads_back_as_excluded(&url_for(&dir.0)));

            clear_exclusion(&url_for(&dir.0));

            assert!(
                !apple::reads_back_as_excluded(&url_for(&dir.0)),
                "the flag was cleared and the read-back still says excluded, so it is \
                 reporting a constant rather than reading the directory"
            );
        }

        /// The same property on the URL the production path actually uses, which
        /// is where it is load-bearing. `exclude_from_backup` reads back through
        /// the **same** `NSURL` it just wrote through, and an `NSURL` caches
        /// resource values it has fetched or set, so without the explicit cache
        /// drop the read-back would hand back the value Foundation remembers
        /// rather than the directory's. The test above cannot see that: it builds
        /// a fresh URL each time, which is exactly the shape that hides the bug.
        /// This one holds one URL across the write, the clear and the read, and
        /// it is the test that fails when `removeCachedResourceValueForKey` is
        /// deleted.
        #[test]
        fn the_read_back_does_not_serve_the_url_cache() {
            let dir = TempDir::new("cache");
            let path = dir.0.to_str().expect("utf-8 temp path");
            let held = url_for(&dir.0);

            assert!(apple::exclude_from_backup(path));
            // Populates `held`'s own resource-value cache with `true`.
            assert!(apple::reads_back_as_excluded(&held));

            clear_exclusion(&url_for(&dir.0));

            assert!(
                !apple::reads_back_as_excluded(&held),
                "the flag was cleared and this URL still reports excluded, so the read-back \
                 is serving NSURL's cache instead of the directory"
            );
        }

        /// Set `NSURLIsExcludedFromBackupKey` to false through `url`, so the
        /// tests above can flip the flag without leaving Foundation.
        fn clear_exclusion(url: &NSURL) {
            let no = objc2_foundation::NSNumber::new_bool(false);
            // SAFETY: same binding contract as the production setter.
            unsafe {
                url.setResourceValue_forKey_error(
                    Some(&no),
                    objc2_foundation::NSURLIsExcludedFromBackupKey,
                )
            }
            .expect("clearing the exclusion through Foundation");
        }
    }
}
