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
//! What is **proven**: the exact call sequence below, run against macOS
//! Foundation on a fresh directory, produces
//! `com.apple.metadata:com_apple_backup_excludeItem = bplist00_com.apple.backupd`
//! where the directory previously had no such xattr. That covers the parts that
//! could be silently wrong — the `NSURLIsExcludedFromBackupKey` constant, the
//! `NSNumber` boxing, the `fileURLWithPath:isDirectory:` bridge, and reading the
//! result rather than assuming it.
//!
//! What is **not**: that the same call, made from the app on a real iOS device,
//! lands on the directory the WebView writes to and is honoured by iOS's backup
//! rather than macOS's. Like `share_file.rs` and `pdf_export.rs`, the effect is
//! device/simulator-verified via `docs/dev/device-matrix.md` §8 (row 8.9) and not
//! in CI — the runner is Linux. A green build is not that proof, and neither is
//! a green `scripts/check-mobile-export-backup.mjs`: the guard proves the four
//! files agree with each other.

/// The directories this module excludes from platform backup, as the *names*
/// `scripts/check-mobile-export-backup.mjs` compares against the roster of
/// `@tauri-apps/api/path` accessors the mobile tree actually calls and against
/// the Android backup-rules XML. A directory reachable from `mobile/src` that is
/// absent here is an egress channel nothing closed — which is exactly the
/// pre-#491 state, one accessor over.
///
/// Kept as a plain slice rather than folded into [`init`] so the guard can read
/// the iOS side of the contract without parsing Rust control flow.
///
/// Off iOS no Rust code reads it — the reader is the guard, and the `cfg`ed
/// `allow` says so rather than letting a blanket `#[allow(dead_code)]` hide a
/// future constant that really is dead.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub const EXCLUDED_DIRS: &[&str] = &["Documents"];

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
        let path = match *dir {
            "Documents" => resolver.document_dir(),
            other => {
                tracing::warn!(
                    event = "backup_exclude_unknown_dir",
                    dir = other,
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
        // the first export backed up.
        if !path.exists() {
            if let Err(e) = std::fs::create_dir_all(&path) {
                tracing::warn!(
                    event = "backup_exclude_mkdir_failed",
                    dir = *dir,
                    error_kind = ?e.kind(),
                    "could not create directory; not excluded from backup"
                );
                continue;
            }
        }
        let Some(path) = path.to_str() else {
            tracing::warn!(
                event = "backup_exclude_non_utf8_path",
                dir = *dir,
                "path is not UTF-8; directory not excluded from backup"
            );
            continue;
        };
        if !ios::exclude_from_backup(path) {
            tracing::warn!(
                event = "backup_exclude_failed",
                dir = *dir,
                "setResourceValue:forKey: returned NO; directory not excluded from backup"
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

#[cfg(target_os = "ios")]
mod ios {
    use objc2_foundation::{NSNumber, NSString, NSURLIsExcludedFromBackupKey, NSURL};

    /// `[[NSURL fileURLWithPath:isDirectory:YES] setResourceValue:@YES
    /// forKey:NSURLIsExcludedFromBackupKey error:nil]`. Returns whether the flag
    /// was set.
    ///
    /// Typed `objc2-foundation` bindings rather than the raw `msg_send!` idiom
    /// `share_file.rs` uses: `NSURLIsExcludedFromBackupKey` is an extern
    /// `NSString` constant, and hand-declaring it (or hardcoding its string
    /// value) is the one part of this that would fail silently — a wrong key
    /// name makes `setResourceValue:` return NO and the directory stays backed
    /// up. The crate is already a direct iOS dependency here with `NSURL` and
    /// `NSString` enabled; only `NSValue` (which carries `NSNumber`) is new, and
    /// it is a module of a crate already in the build, not a new crate.
    pub fn exclude_from_backup(path: &str) -> bool {
        let ns_path = NSString::from_str(path);
        // `isDirectory: true` rather than `fileURLWithPath:` alone: the flag
        // saves UIKit a stat, and the URL must denote the DIRECTORY — a URL that
        // resolved as a file would set the flag on nothing.
        let url = NSURL::fileURLWithPath_isDirectory(&ns_path, true);
        let yes = NSNumber::new_bool(true);
        // SAFETY: `setResourceValue:forKey:error:` takes an id value and an
        // NSString key; `NSURLIsExcludedFromBackupKey` is the Foundation-owned
        // constant, and the objc2 binding maps the trailing NSError** out-param
        // onto the `Result`, so no raw error pointer is constructed here.
        unsafe { url.setResourceValue_forKey_error(Some(&yes), NSURLIsExcludedFromBackupKey) }
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::EXCLUDED_DIRS;

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
}
