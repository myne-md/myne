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
//! Sets `NSURLIsExcludedFromBackupKey` on the **directory**, through one body
//! with two entry points (myne-md/myne#517). [`ensure`] resolves the directory,
//! creates it, applies the exclusion and hands the path back only if all three
//! succeeded. [`init`] walks [`ExportDir::ALL`] through it once at startup, and
//! `plugin:export-dir|export_path` walks the one export destination through it
//! on every export, which is what the WebView's `exportPath()` seam calls.
//! Directory-level exclusion covers files created inside it afterwards (Apple
//! QA1719), so the startup call alone already closed all four writers and every
//! future one. What the command adds is that no caller ever HOLDS a destination
//! whose exclusion did not take: the startup path warns and carries on, because
//! a failure there must not block a launch, while the command fails closed,
//! because its caller's next act is to write plaintext into what it returns.
//!
//! [`init`] stays rather than being replaced by the command, and the reason is
//! not symmetry. It carries the second, written purpose of repairing a container
//! restored from an older backup that predates this call, and it is what makes
//! `mobile/docs/dev/device-matrix.md` §8 row 8.9 ("launch the app once, then
//! `ls -l@` Documents") runnable exactly as written. That row has never been
//! run, and rewriting an unrun procedure is how it stops being run.
//!
//! The Android half of the same decision is declarative and lives in
//! `android-widgets/src/main/res/xml/myne_backup_rules*.xml`;
//! `scripts/check-mobile-export-backup.mjs` holds the Android rules to the
//! directory roster this enum defines. One direction: every name here must be
//! excluded there. The reverse, an XML `<exclude>` for a directory nothing
//! writes to, is not flagged, and saying "both directions" (as this doc did for
//! a round) describes the pre-myne#517 guard, which compared a hand-kept TS
//! roster against a `&[&str]` and had a stale-entry arm to go with it.
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

/// A directory this module keeps out of the platform's automatic cloud backup.
///
/// A TYPE rather than the `EXCLUDED_DIRS: &[&str]` roster this used to be
/// (myne-md/myne#517). The string list needed [`ExportDir::from_name`]'s
/// ancestor and a test beside it to stop a name being added with nothing behind
/// it, because a name is only a name: it compiled, satisfied the guard, the
/// Android XML and the TS roster all at once, then excluded nothing at runtime
/// and said so only in a device log. A variant cannot be added without an arm in
/// [`Self::name`] and one in [`Self::resolve`], and the compiler is what says
/// so. A test can be deleted; a match arm cannot.
///
/// [`Self::name`] survives the change because two things compare against these
/// directory NAMES and neither of them reads Rust: the Android backup-rules XML,
/// and `scripts/check-mobile-export-backup.mjs`, which requires every name here
/// to be excluded there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportDir {
    /// The app's `Documents` container, `PathResolver::document_dir()` on both
    /// targets. It is the directory `documentDir()` used to hand the WebView
    /// directly, and is now reachable only through `plugin:export-dir|export_path`.
    Documents,
}

impl ExportDir {
    /// Every variant, which is what [`init`] walks at startup.
    ///
    /// Hand-written, and that is the one hole the enum opens which the slice did
    /// not have: a variant declared with both of its match arms present is still
    /// absent from here, and so is never excluded at startup.
    /// `scripts/check-mobile-export-backup.mjs` compares this list against the
    /// `enum ExportDir` declaration for exactly that reason, in ONE direction:
    /// a declared variant absent from here fails. The reverse, this list naming
    /// a variant the enum does not declare, is E0599 and does not compile, so a
    /// guard arm for it was two messages for a defect `cargo build` already
    /// refuses. This doc said "both directions" for a round while
    /// `docs/decisions/security/0595` said one; the entry was the correct half.
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    pub const ALL: &'static [ExportDir] = &[ExportDir::Documents];

    /// The directory's NAME, relative to the platform export root rather than a
    /// path. This is the string the Android backup rules carry in
    /// `<exclude domain="external" path="…"/>` and the string the guard reads.
    pub const fn name(self) -> &'static str {
        match self {
            ExportDir::Documents => "Documents",
        }
    }

    /// The inverse of [`Self::name`], and note the deliberate absence of a
    /// catch-all returning a default: an unknown name resolves to `None`, and
    /// `tests::an_unwired_directory_resolves_to_nothing` turns a catch-all added
    /// later into a test failure.
    ///
    /// `cfg(test)` rather than an `allow(dead_code)`, because the test module is
    /// its only caller and saying so is cheaper than a silenced warning. It was
    /// `cfg_attr(not(target_os = "ios"), allow(dead_code))` for one round, which
    /// warned on exactly the target that matters here and nowhere else: the
    /// Linux CI runner cannot build for iOS at all, so
    /// `cargo check --target aarch64-apple-ios-sim` by hand is what found it.
    #[cfg(test)]
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "Documents" => Some(ExportDir::Documents),
            _ => None,
        }
    }

    /// Resolve through Tauri's own path API rather than composing the path here:
    /// this MUST be the same directory the export flows write into, and the only
    /// way to guarantee that is to ask the same resolver they ask.
    fn resolve<R: tauri::Runtime>(
        self,
        resolver: &tauri::path::PathResolver<R>,
    ) -> tauri::Result<std::path::PathBuf> {
        match self {
            ExportDir::Documents => resolver.document_dir(),
        }
    }
}

/// Why [`ensure`] did not hand back a directory.
///
/// Closed taxonomy, and it carries no path string. The startup path logs it, and
/// `plugin:export-dir|export_path` maps it onto its own IPC error. See the main
/// repo's `src-tauri/CLAUDE.md` "Secret-handling logging discipline".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureError {
    /// Tauri's path resolver failed, so there is no directory to speak of.
    Unresolved,
    /// The directory could not be created.
    Mkdir(std::io::ErrorKind),
    /// The resolved path is not UTF-8, so the Foundation bridge cannot take it.
    NonUtf8,
    /// The exclusion flag does not read back as set on the directory.
    NotExcluded,
}

impl EnsureError {
    /// The `event` field the startup path logs. The four strings are the ones
    /// `init` has always emitted, kept verbatim so a device-log grep written
    /// against the old shape still finds the new one.
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    pub const fn event(self) -> &'static str {
        match self {
            EnsureError::Unresolved => "backup_exclude_unresolved",
            EnsureError::Mkdir(_) => "backup_exclude_mkdir_failed",
            EnsureError::NonUtf8 => "backup_exclude_non_utf8_path",
            EnsureError::NotExcluded => "backup_exclude_failed",
        }
    }
}

/// Resolve, create, exclude, in that order, and hand the path back only when all
/// three succeeded.
///
/// **The order is the property**, and it is asserted by
/// `tests::the_exclusion_is_applied_before_the_caller_holds_a_path` rather than
/// described here, because a comment cannot carry it: if the mkdir and the
/// exclude are ever swapped the failure is silent, the flag lands on nothing,
/// and every export after that is backed up while this function still returns
/// `Ok`.
///
/// `exclude` is a parameter rather than a direct call so that ordering is
/// observable off iOS. Everything here except the Foundation call is
/// platform-independent, and the Foundation call is the one part that already
/// has its own tests (`tests::macos`). Injecting it is what lets the ordering be
/// checked by `cargo test` on Linux and on a Mac, rather than only on a device
/// nobody has run row 8.9 against.
fn ensure_with<F>(
    resolved: tauri::Result<std::path::PathBuf>,
    exclude: F,
) -> Result<std::path::PathBuf, EnsureError>
where
    F: FnOnce(&str) -> bool,
{
    let path = resolved.map_err(|_| EnsureError::Unresolved)?;
    // A first launch that has not exported anything yet may have no such
    // directory. Create it now: the flag has to be set BEFORE the first write,
    // and setting it on a missing path is a no-op that would leave the first
    // export backed up (`tests::macos::a_missing_directory_is_not_reported_as_excluded`
    // is that claim, checked rather than assumed). Unconditional because
    // `create_dir_all` is already `Ok(())` on an existing directory, and an
    // `exists()` test in front of it only adds a window in which the answer
    // stops being true.
    std::fs::create_dir_all(&path).map_err(|e| EnsureError::Mkdir(e.kind()))?;
    let as_str = path.to_str().ok_or(EnsureError::NonUtf8)?;
    if !exclude(as_str) {
        // Fail CLOSED, which is the one place the command and the startup path
        // differ: handing the path back here would give a caller a directory
        // nothing excluded, and that caller's next act is to write plaintext
        // into it. `init` turns this into a warn and carries on, because a
        // failure there must not block a launch and the pre-#491 behaviour is
        // what it falls back to.
        return Err(EnsureError::NotExcluded);
    }
    Ok(path)
}

/// The platform's exclusion call.
#[cfg(target_os = "ios")]
fn exclude_from_backup_at(path: &str) -> bool {
    apple::exclude_from_backup(path)
}

/// Android carries the same property declaratively, the two `<application>`
/// attributes `android:dataExtractionRules` and `android:fullBackupContent`, from
/// the committed `android-widgets` library manifest, so there is nothing to do
/// at runtime. Desktop targets have no platform backup of this kind. `true`
/// rather than `false`, because the directory IS excluded on Android by a
/// mechanism this function does not own; answering `false` would fail every
/// export there on a property that holds.
#[cfg(not(target_os = "ios"))]
fn exclude_from_backup_at(_path: &str) -> bool {
    true
}

/// Resolve `dir`, create it, and exclude it from platform backup. The shared
/// body behind both entry points: [`init`] at startup and
/// `plugin:export-dir|export_path` on every export.
pub fn ensure<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    dir: ExportDir,
) -> Result<std::path::PathBuf, EnsureError> {
    use tauri::Manager;

    ensure_with(dir.resolve(app.path()), exclude_from_backup_at)
}

/// Which directory every mobile export flow writes into.
///
/// Named here rather than derived from [`ExportDir::ALL`], because which
/// directory the exports land in is a decision and not a consequence of the
/// roster's length. It is a `const` rather than a literal inside
/// [`ensure_export_dir`] so that the plugin's `dir` field and the path it
/// accompanies come from ONE variant: they were two independent
/// `ExportDir::Documents` mentions for a review round, which is the same drift
/// the field exists to remove, one level down.
pub const EXPORT_DESTINATION: ExportDir = ExportDir::Documents;

/// The single destination every mobile export flow writes into, ready to be
/// written into.
pub fn ensure_export_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<std::path::PathBuf, EnsureError> {
    ensure(app, EXPORT_DESTINATION)
}

/// Exclude the app's export directories from iCloud Backup at startup.
/// Idempotent, the resource value is re-set on every launch, which also repairs
/// a container restored from an older backup that predates this call.
///
/// Never panics and never blocks startup: every failure is a `tracing::warn!`,
/// following `share_file.rs` / `screen_guard.rs`. A failure here means the
/// directory stays backed up, which is the pre-#491 behaviour, not a crash. The
/// export command is the half that fails closed.
#[cfg(target_os = "ios")]
pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    for dir in ExportDir::ALL {
        if let Err(e) = ensure(app, *dir) {
            tracing::warn!(
                event = e.event(),
                dir = dir.name(),
                reason = ?e,
                "directory not excluded from platform backup"
            );
        }
    }
}

/// Android carries the same property declaratively (see
/// [`exclude_from_backup_at`]), so there is nothing to do at startup. Desktop
/// targets have no platform backup of this kind. The export command still runs
/// [`ensure`] on these targets, because the resolve-and-create half is needed
/// everywhere; only the exclusion half is a no-op.
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
    use super::{ensure_with, EnsureError, ExportDir};

    /// A scratch directory that removes itself, so a failing assert does not
    /// leave one behind. Deliberately separate from the one inside
    /// `mod macos`: these tests run on every platform and that module compiles
    /// only on a Mac.
    struct ScratchDir(std::path::PathBuf);

    impl ScratchDir {
        fn new(tag: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!(
                "myne-ensure-export-dir-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("scratch dir");
            Self(path)
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The roster is what `scripts/check-mobile-export-backup.mjs` compares the
    /// Android rules XML against; an empty or duplicated one would make that
    /// comparison vacuous while still passing.
    #[test]
    fn excluded_dirs_is_non_empty_and_unique() {
        assert!(!ExportDir::ALL.is_empty(), "roster may not be empty");
        let mut seen = std::collections::BTreeSet::new();
        for dir in ExportDir::ALL {
            let name = dir.name();
            assert!(seen.insert(name), "duplicate directory in roster: {name}");
            assert!(!name.is_empty(), "empty directory name in roster");
            assert!(
                !name.contains('/') && !name.contains('\\'),
                "roster holds directory NAMES relative to the platform export \
                 root, not paths: {name}"
            );
        }
    }

    /// The fail-open hole the guard cannot see, in the form it takes now that
    /// the roster is a type.
    ///
    /// Renamed from `every_excluded_dir_has_a_resolver`, because that is no
    /// longer what it does and the name is what the next grep finds. `ExportDir::resolve` is exhaustive, so a variant
    /// with no resolver arm no longer compiles and this test cannot be about
    /// that any more. What it is about instead is the NAME: two things outside
    /// Rust compare against `name()` (the Android rules XML and the guard), and
    /// a name that does not map back to the variant that produced it means the
    /// roster and the resolver have drifted while every match stayed exhaustive.
    #[test]
    fn every_roster_name_maps_back_to_its_variant() {
        for dir in ExportDir::ALL {
            assert_eq!(
                ExportDir::from_name(dir.name()),
                Some(*dir),
                "ExportDir::ALL carries {dir:?}, whose name {:?} maps back to something else. \
                 The Android XML and scripts/check-mobile-export-backup.mjs both address this \
                 directory by that name, so the two sides are describing different directories.",
                dir.name()
            );
        }
    }

    /// Reject the name nothing resolves, rather than trusting a `match` to have
    /// no catch-all. A `_ => Some(ExportDir::Documents)` would make the test
    /// above pass for every possible string.
    #[test]
    fn an_unwired_directory_resolves_to_nothing() {
        assert!(ExportDir::from_name("Downloads").is_none());
        assert!(ExportDir::from_name("").is_none());
    }

    /// **The ordering property, asserted rather than described.** The exclusion
    /// must be applied before anything can be written into the directory, and
    /// the only writer is whoever holds the path, so the claim is that the
    /// exclusion runs while the directory exists and is still empty, and that
    /// the path is returned afterwards.
    ///
    /// Swapping the `create_dir_all` and the `exclude` in [`super::ensure_with`]
    /// fails the first assert; deleting the `create_dir_all` fails it too. Both
    /// were checked by reverting, because a test that passes against the defect
    /// it names is not a test.
    #[test]
    fn the_exclusion_is_applied_before_the_caller_holds_a_path() {
        let scratch = ScratchDir::new("order");
        let target = scratch.0.join("Documents");
        let order = std::cell::RefCell::new(Vec::<&'static str>::new());

        let out = ensure_with(Ok(target.clone()), |path| {
            let at = std::path::Path::new(path);
            assert!(
                at.is_dir(),
                "the exclusion ran before the directory existed, so it lands on nothing \
                 and every export after it is backed up"
            );
            assert_eq!(
                std::fs::read_dir(at).expect("read_dir").count(),
                0,
                "something was written into the directory before it was excluded"
            );
            order.borrow_mut().push("excluded");
            true
        });

        order.borrow_mut().push("returned");
        assert_eq!(out.expect("ensure_with"), target);
        assert_eq!(*order.borrow(), ["excluded", "returned"]);
    }

    /// Fail closed. A directory whose exclusion did not take must not reach a
    /// caller, because the caller's next act is to write plaintext into it.
    /// Deleting the early return in [`super::ensure_with`] fails this.
    #[test]
    fn a_directory_that_could_not_be_excluded_is_not_handed_to_the_caller() {
        let scratch = ScratchDir::new("closed");
        let target = scratch.0.join("Documents");

        let out = ensure_with(Ok(target.clone()), |_| false);

        assert_eq!(out, Err(EnsureError::NotExcluded));
        // The mkdir DID run, and the caller still got nothing. That is the
        // point: the directory existing is not what an export is allowed to
        // proceed on.
        assert!(target.is_dir());
    }

    /// A resolver failure stops before anything is created, so a wrong or
    /// missing container is never quietly brought into existence.
    #[test]
    fn an_unresolved_directory_is_never_created() {
        let calls = std::cell::Cell::new(0_u32);

        let out = ensure_with(
            Err(tauri::Error::Io(std::io::Error::other("no document dir"))),
            |_| {
                calls.set(calls.get() + 1);
                true
            },
        );

        assert_eq!(out, Err(EnsureError::Unresolved));
        assert_eq!(calls.get(), 0, "the exclusion ran on an unresolved path");
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
