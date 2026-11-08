// SPDX-License-Identifier: AGPL-3.0
//! `export-dir` plugin: the mobile host (myne-md/myne#517).
//!
//! One command, `export_path`. It resolves the export directory, creates it,
//! excludes it from the platform's automatic cloud backup and sanitizes the
//! filename, in one call, and hands back a path only when all four succeeded.
//!
//! **What that does and does not mean**, stated here because the first draft of
//! this header said "the ONLY way the WebView can name a plaintext export
//! destination" and that is false of all four writers. Each of the three export
//! COMMANDS (`secret-export|save_secret_text`, `export|vault_export_markdown`,
//! `attachments|attachment_export`) takes a caller-supplied path STRING, and a
//! literal absolute path needs no `plugin:path` grant, so dropping
//! `core:path:default` does not close that route. The fourth writer does not go
//! through a command at all: the note PDF reaches the host as an event payload
//! (`emit("export-note-pdf", { title, html, path })` to `pdf_export::present`)
//! with no containment check anywhere on the path. The fifth is a READ rather
//! than a write: `attachments|attachment_import`'s `ImportSource::Path` arm
//! (`core/src/plugins/attachments/commands.rs:473`, granted at
//! `mobile/src-tauri/permissions/attachments/default.toml:39`) takes a
//! caller-supplied path and reads whatever is at it. The sixth sits beside it
//! and is also a read: `mobile/src/lib/share.ts` emits `share-file` with a path
//! that `lib.rs` hands to `share_file::present`, which offers whatever it is
//! given to the platform's destination chooser (the iOS sheet, or the Android
//! Storage Access Framework picker since myne-md/myne#505). Since #505 that
//! function ALSO refuses a path outside the export directory, so this item is
//! narrowed rather than merely moved: it can no longer carry
//! `<app_config_dir>/person-auth.json` or a vault file to a chooser. Rounds 3 to 5
//! each asked for the fifth by name and the ordinal jumped from four to six until
//! round 6; that jump was the tell, and it is the reason a list here is numbered
//! rather than bulleted. `core:event:default` is granted, so the WebView can still
//! emit an arbitrary path to either of the two event-driven surfaces: the sixth
//! item above, which now refuses anything outside the export directory, and
//! `pdf_export::present`, which writes wherever the payload says. What this command IS: the
//! only way to obtain an export directory that is guaranteed to exist and to be
//! excluded from platform backup, and the only destination the four export flows
//! compose. Containment stays with the writers, and
//! `myne-agents/epics/mobile-icebox-pair/sync-ledger.md` ACCEPT-1 records
//! resolving each destination inside its own export command as the larger,
//! separate piece of work that would change that.
//!
//! ## What it replaces, and why the shape changed
//!
//! `mobile/src/platform/path.ts` used to be `export { documentDir, join } from
//! "@tauri-apps/api/path";` and four flows each did `join(await documentDir(),
//! name)` before relying on `backup_exclude::init` having excluded that
//! directory at startup. Three things were spread across that shape and are
//! gathered here:
//!
//!   1. **The destination.** Four call sites each composed one, so a fifth flow
//!      reaching for a sibling accessor got a directory nothing excluded. There
//!      is now one answer, and no EXPORT FLOW composes another: the accessors
//!      are gone from the seam and the whole `core:path:` namespace is gone from
//!      `capabilities/default.json`, so `plugin:path|*` is not reachable at all.
//!      Not "the WebView cannot compose another", which is the claim the
//!      paragraph above retracts.
//!   2. **The path-traversal sanitizer**, which existed twice, hand-rolled, in
//!      TypeScript (`EditorFlow.tsx` and `editor-host.ts`) and not at all in the
//!      other two flows, which did not need it. It is one function here, and
//!      [`export_path`] re-checks its own output rather than trusting it.
//!   3. **The exclusion's ordering.** `backup_exclude::ensure` applies it before
//!      it returns, so no caller ever holds a destination whose exclusion did
//!      not take. `backup_exclude::init` still runs at startup and shares that
//!      one body, so the startup repair of a container restored from an older
//!      backup survives and `device-matrix.md` row 8.9 stays runnable as
//!      written.
//!
//! ## Capability ACL
//!
//! `export-dir:default` grants the single `allow-export-path` permission,
//! main-window-only. Declared as an `InlinedPlugin` in `build.rs` with the
//! permission body in `permissions/export-dir/default.toml`, without the
//! `InlinedPlugin` declaration the permission flattens into `__app-acl__` and
//! never matches the `plugin:export-dir|export_path` authorize form. Adding a
//! command here without a matching entry in `permissions/export-dir/default.toml`
//! is a security bug.
//!
//! **Two guards compare those sites, and they split by property.**
//! `scripts/check-mobile-plugin-acl.mjs` owns the ACL half for all 27 mobile
//! plugin permission directories: that a granted `<plugin>:default` resolves to
//! a real permission set, that the declared commands are the ones allowed, and
//! that nothing granted denies them. `scripts/check-mobile-export-backup.mjs`
//! owns the export path's own wiring: the seam invokes this command, this
//! command goes through `backup_exclude::ensure_export_dir`, `build.rs` lists
//! it, `generate_handler!` registers it, `lib.rs` registers the plugin, and the
//! retired `core:path:` namespace stays out. "Nothing else on mobile does" was
//! true when this header was written and was falsified by a file added in the
//! same change.
//!
//! See: the main repo's `src-tauri/CLAUDE.md` "Secret-handling logging
//! discipline", no filename and no path is ever logged here, and the error
//! taxonomy carries neither.

use crate::backup_exclude::{self, EnsureError};
use myne_core::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use std::path::Path;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Runtime};
use thiserror::Error;

/// What [`export_path`] hands the WebView.
///
/// A pair rather than a string because one caller needs both halves:
/// `mobile/src/lib/export.ts` shows the user where the export went, and the
/// label it builds is `<dir>/<name>`. `dir` is the directory's display NAME
/// (`Documents`), not the absolute path, the absolute path is useless in a
/// sentence and both call sites used to hard-code the word instead, which is one
/// more place the answer could drift from the directory actually written to.
#[derive(Debug, Serialize)]
pub struct ExportPath {
    /// The absolute destination, a direct child of the export directory.
    pub path: String,
    /// The export directory's display name.
    pub dir: String,
    /// The basename actually used, AFTER sanitizing.
    ///
    /// Without it no caller can build an honest label: both label sites used to
    /// interpolate the name they passed IN, while the file landed under the
    /// host's sanitized basename, so a name carrying a separator produced a
    /// message naming a file that does not exist. The argument is the one
    /// `path.ts` already makes for `dir`, one field over.
    pub name: String,
}

/// Single error type returned by [`export_path`].
///
/// Closed taxonomy: no path strings, no filenames, no kernel-error display
/// strings. Serialization shape (`tag = "kind", content = "detail"`):
/// - `{"kind":"Unresolved"}`, the platform path resolver failed.
/// - `{"kind":"Io","detail":{"io_error_kind":"…"}}`, the directory could not be
///   created.
/// - `{"kind":"NonUtf8"}`, the resolved container path is not UTF-8.
/// - `{"kind":"NotExcluded"}`, the backup exclusion does not read back as set,
///   so no destination is returned. This is the arm that keeps a plaintext
///   export out of iCloud Backup: it fails the export rather than writing into a
///   directory the platform would copy. **iOS only**, and the scoping matters
///   because the neighbouring documents are careful about it: on Android
///   `exclude_from_backup_at` is the honest `true`, since the exclusion there is
///   declarative and carried by the committed manifest attributes, so this arm
///   is unreachable and Google Drive is not what it protects against.
/// - `{"kind":"InvalidFilename"}`, the name sanitizes to nothing, or would not
///   land as a direct child of the export directory.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum ExportDirError {
    #[error("the export directory could not be resolved")]
    Unresolved,
    #[error("io failure")]
    Io { io_error_kind: IoFailureKind },
    #[error("the export directory path is not utf-8")]
    NonUtf8,
    #[error("the export directory is not excluded from platform backup")]
    NotExcluded,
    #[error("filename is invalid")]
    InvalidFilename,
}

impl From<EnsureError> for ExportDirError {
    fn from(e: EnsureError) -> Self {
        match e {
            EnsureError::Unresolved => ExportDirError::Unresolved,
            EnsureError::Mkdir(kind) => ExportDirError::Io {
                io_error_kind: from_io_error_kind(kind),
            },
            EnsureError::NonUtf8 => ExportDirError::NonUtf8,
            EnsureError::NotExcluded => ExportDirError::NotExcluded,
        }
    }
}

/// Replace path separators, which is the half of sanitizing that is about
/// traversal rather than about emptiness.
fn flatten_separators(name: &str) -> String {
    name.chars()
        .map(|c| if c == '/' || c == '\\' { '_' } else { c })
        .collect()
}

/// Trim whitespace and leading dots until neither moves.
///
/// One pass in a fixed order is not enough and the test is what said so: the
/// TypeScript original stripped dots and then trimmed, which leaves `" .. "` as
/// `".."` because the leading character at the time of the strip is a space.
fn trim_to_fixed_point(name: &str) -> &str {
    let mut trimmed = name;
    loop {
        let next = trimmed.trim().trim_start_matches('.');
        if next == trimmed {
            return trimmed;
        }
        trimmed = next;
    }
}

/// Split a trailing extension off, as `(stem, extension_including_the_dot)`.
///
/// This exists because the extension is INSIDE the string being sanitized, and
/// stripping leading dots from the whole thing eats it. A note whose derived
/// title is `...` composes `"....pdf"`, which sanitized to `"pdf"`: a file with
/// no extension, which on iOS is a file the share sheet cannot type, and the
/// share sheet is the only route the user has to it there. The TypeScript this
/// replaced sanitized the STEM and appended the extension afterwards, so the
/// extension always survived, and that ordering is restored here.
///
/// Deliberately conservative. A leading dot is not an extension (`".pdf"` is a
/// hidden file whose whole name is at stake), and a suffix is only an extension
/// when it is one to ten ASCII-alphanumeric characters, so
/// `"Meeting notes. Draft two"` is left alone rather than being cut at the dot.
/// A length bound alone was not enough, and the test is what said so: that
/// example's suffix is exactly ten bytes and carries no dot.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(dot) if dot > 0 => {
            let extension = &name[dot..];
            let body = &extension[1..];
            // ASCII-alphanumeric, which is what an extension is. The doc above
            // carries why the length bound alone is not enough.
            if !body.is_empty()
                && body.len() <= 10
                && body.chars().all(|c| c.is_ascii_alphanumeric())
            {
                (&name[..dot], extension)
            } else {
                (name, "")
            }
        }
        _ => (name, ""),
    }
}

/// Reduce an untrusted name to a bare basename, or `None` when nothing is left
/// and the caller offered no fallback.
///
/// The two traversal rules are the ones the TypeScript call sites used to carry:
/// path separators become `_`, and leading dots go, so neither `../../x` nor
/// `/etc/x` nor `..` can address anything but a file inside the export
/// directory. What the first version dropped, and a user could reach, is the
/// third: the call sites also carried `|| "note"` / `|| "attachment"`.
///
/// Losing it was not the harmless tightening it looked like. The attachment
/// rename prompt rejects only the empty and unchanged cases
/// (`editor/src/attachments/fileCardActions.ts`), and `attachment_rename`
/// rejects only the empty one, so an attachment renamed to `..` reaches the
/// catalog and then became permanently un-exportable, where it used to export as
/// `Documents/attachment`. No crafted vault is needed for that.
///
/// So the fallback is back, and it belongs to the CALLER rather than to this
/// function: a chokepoint that invents a filename hides the case it was built to
/// notice, but a caller naming its own default is stating a policy, and it is
/// sanitized on exactly the same terms. A caller that offers none still gets
/// `None`, and the two flows with fixed names pass none.
///
/// This function is not what makes the property true on its own,
/// [`export_path`] re-checks the joined path, and that is deliberate: a
/// sanitizer is a claim about strings, and the claim that matters is about the
/// path that comes out.
fn sanitize_filename(filename: &str, fallback: Option<&str>) -> Option<String> {
    let flattened = flatten_separators(filename);
    let (stem, extension) = split_extension(&flattened);
    let stem = trim_to_fixed_point(stem);
    if !stem.is_empty() {
        return Some(format!("{stem}{extension}"));
    }
    // The caller's default, on the same terms, keeping whatever extension the
    // original carried: `"....pdf"` with a `"note"` fallback is `"note.pdf"`,
    // which is exactly what the deleted TypeScript produced.
    let flattened_fallback = flatten_separators(fallback?);
    let fallback = trim_to_fixed_point(&flattened_fallback);
    if fallback.is_empty() {
        return None;
    }
    Some(format!("{fallback}{extension}"))
}

/// Whether `path` is a direct child of `dir` named exactly `name`.
///
/// The post-condition [`export_path`] asserts instead of trusting
/// [`sanitize_filename`]. `dir.join("..")` is the case that motivates the
/// `file_name` half: its parent IS `dir`, so a parent check alone accepts it.
fn is_direct_child(path: &Path, dir: &Path, name: &str) -> bool {
    path.parent() == Some(dir) && path.file_name() == Some(std::ffi::OsStr::new(name))
}

/// `export_path`: the destination every mobile export flow composes.
///
/// Resolves + creates + excludes the export directory (through
/// `backup_exclude::ensure_export_dir`, the same body the startup hook runs),
/// sanitizes `filename` to a bare basename, and returns the absolute
/// destination plus the directory's display name plus the basename it used.
///
/// `filename` is ONE path component, not a path: the file an export flow is
/// about to write, or, for the whole-vault markdown export, the directory the
/// backend is about to stage and publish. `fallback` is the caller's own default
/// STEM for the case where the name sanitizes away, sanitized on the same terms;
/// a caller that offers none gets [`ExportDirError::InvalidFilename`] instead.
/// Neither is ever logged.
///
/// `async` so the `create_dir_all` and the two Foundation resource-value round
/// trips do not run inline on the IPC thread. The body is synchronous; the
/// attribute is what moves it off, with no signature change. What it moves the
/// body onto is a Tauri async-runtime worker (`tauri::ipc`'s
/// `respond_async_serialized` calls `async_runtime::spawn`), NOT the blocking
/// pool: `core/src/task.rs`'s `spawn_blocking` seam is a different mechanism
/// and this command does not use it. Accepted for one `create_dir_all` and two
/// Foundation calls per export, and stated rather than implied because the
/// attribute name suggests otherwise.
///
/// Not slot-gated. It reveals no vault content and touches no vault key: it
/// creates and names a directory the platform already gives this app.
///
/// **What it is NOT**, because the first draft of this doc claimed otherwise and
/// the claim reached `myne-agents/docs/threat-model.md`: this is not the only way the WebView
/// can name a destination. The module header carries the enumeration, and it is
/// the copy to keep current. It is not asserted to be exhaustive, and the
/// sentence this replaced asserted exactly that over a list that was short by
/// one. The writers remain the enforcement point for containment.
#[tauri::command(async)]
fn export_path<R: Runtime>(
    app: AppHandle<R>,
    filename: String,
    fallback: Option<String>,
) -> Result<ExportPath, ExportDirError> {
    let dir = backup_exclude::ensure_export_dir(&app)?;
    let name =
        sanitize_filename(&filename, fallback.as_deref()).ok_or(ExportDirError::InvalidFilename)?;
    let path = dir.join(&name);
    if !is_direct_child(&path, &dir, &name) {
        return Err(ExportDirError::InvalidFilename);
    }
    Ok(ExportPath {
        path: path.to_str().ok_or(ExportDirError::NonUtf8)?.to_string(),
        // One variant answers for both fields. See `EXPORT_DESTINATION`.
        dir: backup_exclude::EXPORT_DESTINATION.name().to_string(),
        name,
    })
}

/// Construct the mobile `export-dir` plugin (binds the single `export_path`
/// command). Holds no plugin-private state.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("export-dir")
        .invoke_handler(tauri::generate_handler![export_path])
        .build()
}

#[cfg(test)]
mod tests {
    use super::{is_direct_child, sanitize_filename, split_extension};
    use std::path::Path;

    /// The traversal cases, which is the whole reason the sanitizer moved out of
    /// TypeScript: it existed in two of the four flows and nowhere in the other
    /// two. Reverting either rule in `sanitize_filename` fails this.
    #[test]
    fn a_name_cannot_address_anything_outside_the_export_directory() {
        let dir = Path::new("/app/Documents");
        for raw in [
            "../../etc/passwd",
            "/etc/passwd",
            "..\\..\\windows\\system32",
            "../secret.txt",
            "sub/dir/file.md",
        ] {
            let name = sanitize_filename(raw, None).expect("sanitizes to something");
            let path = dir.join(&name);
            assert!(
                is_direct_child(&path, dir, &name),
                "{raw:?} sanitized to {name:?} and left the export directory"
            );
            assert!(
                !name.contains('/') && !name.contains('\\') && !name.starts_with('.'),
                "{raw:?} sanitized to {name:?}, which is not a bare basename"
            );
        }
    }

    /// A name that reduces to nothing, with NO fallback offered, is refused
    /// rather than replaced. The `..` case is the one the post-condition alone
    /// cannot catch, because the parent of `<dir>/..` IS `<dir>`.
    #[test]
    fn a_name_that_sanitizes_to_nothing_is_refused_when_no_fallback_is_offered() {
        for raw in ["..", ".", "...", "", "   ", " .. "] {
            assert_eq!(
                sanitize_filename(raw, None),
                None,
                "{raw:?} should sanitize away"
            );
        }
    }

    /// **The regression this fallback exists for.** An attachment renamed to
    /// `..` reaches the catalog: the rename prompt rejects only the empty and
    /// unchanged cases, and `attachment_rename` rejects only the empty one. With
    /// no fallback that attachment became permanently un-exportable, where the
    /// deleted TypeScript wrote `Documents/attachment`. No crafted vault is
    /// needed; the rename prompt accepts it.
    ///
    /// Deleting the fallback arm in `sanitize_filename` fails this.
    #[test]
    fn a_caller_supplied_fallback_rescues_a_name_that_sanitizes_away() {
        for raw in ["..", ".", "...", "", "   ", " .. ", "/", "\\"] {
            let name = sanitize_filename(raw, Some("attachment"))
                .unwrap_or_else(|| panic!("{raw:?} with a fallback should produce a name"));
            assert!(
                !name.is_empty() && !name.starts_with('.') && !name.contains('/'),
                "{raw:?} produced {name:?}"
            );
        }
        assert_eq!(
            sanitize_filename("..", Some("attachment")).as_deref(),
            Some("attachment")
        );
        // A fallback that itself sanitizes away is still a refusal: the
        // chokepoint never invents a name, it only accepts one.
        assert_eq!(sanitize_filename("..", Some("..")), None);
        // And a fallback is sanitized on the same terms as the name.
        assert_eq!(
            sanitize_filename("..", Some("../evil")).as_deref(),
            Some("_evil")
        );
    }

    /// **The other regression.** The extension is inside the string being
    /// sanitized, so a note whose derived title is `...` composed `"....pdf"`
    /// and landed as a file called `pdf`, with no extension. On iOS that is a
    /// file the share sheet cannot type, and the share sheet is the only route
    /// the user has to it there. Deleting `split_extension`'s use in
    /// `sanitize_filename` fails this.
    #[test]
    fn the_extension_survives_a_stem_that_sanitizes_away() {
        assert_eq!(
            sanitize_filename("....pdf", Some("note")).as_deref(),
            Some("note.pdf")
        );
        assert_eq!(
            sanitize_filename("...", Some("note")).as_deref(),
            Some("note")
        );
        // The shape the attachment flow actually passes since myne#517: a
        // derived stem rather than the literal `attachment`, which is what
        // `auto_filename` produces and therefore the one name most likely to be
        // on disk already (`mobile/src/lib/exportFallbackStem.ts`). Its hyphens
        // and digits must survive the sanitizer, and the extension must still
        // be re-appended after it.
        assert_eq!(
            sanitize_filename("..pdf", Some("myne-export-2e2e706466")).as_deref(),
            Some("myne-export-2e2e706466.pdf")
        );
        assert_eq!(
            sanitize_filename("..", Some("myne-export-2e2e")).as_deref(),
            Some("myne-export-2e2e")
        );
        // The pre-#517 TypeScript produced exactly these, by sanitizing the stem
        // and appending `.pdf` afterwards. This is that ordering restored.
        assert_eq!(
            sanitize_filename("../secrets.pdf", None).as_deref(),
            Some("_secrets.pdf")
        );
    }

    /// `split_extension` is conservative on purpose, so a name with a full stop
    /// in the middle of it is not cut in half.
    #[test]
    fn an_extension_is_only_taken_when_it_looks_like_one() {
        assert_eq!(split_extension("note.pdf"), ("note", ".pdf"));
        assert_eq!(split_extension("archive.tar.gz"), ("archive.tar", ".gz"));
        // A leading dot is a hidden file's whole name, not an extension.
        assert_eq!(split_extension(".pdf"), (".pdf", ""));
        // No suffix, a dotted suffix, or a suffix too long to be an extension.
        assert_eq!(split_extension("note."), ("note.", ""));
        assert_eq!(
            split_extension("Meeting notes. Draft two"),
            ("Meeting notes. Draft two", "")
        );
        assert_eq!(split_extension("no-dot-at-all"), ("no-dot-at-all", ""));
    }

    /// The ordinary names must survive untouched, or the sanitizer is a bug
    /// wearing a security label.
    #[test]
    fn an_ordinary_name_is_left_alone() {
        assert_eq!(
            sanitize_filename("myne-recovery-phrase.txt", None).as_deref(),
            Some("myne-recovery-phrase.txt")
        );
        assert_eq!(
            sanitize_filename("Myne Export 2026-09-19 1430", None).as_deref(),
            Some("Myne Export 2026-09-19 1430")
        );
        assert_eq!(
            sanitize_filename("résumé.pdf", None).as_deref(),
            Some("résumé.pdf")
        );
    }

    /// The neighbouring case, kept because the first version of the refusal test
    /// asserted it wrongly and this is where the correction belongs: a name that
    /// is nothing BUT separators does not reduce to nothing, it reduces to
    /// underscores. That is a legal, harmless basename inside the export
    /// directory, and refusing it would be the sanitizer inventing a policy it
    /// does not need.
    #[test]
    fn a_name_that_is_only_separators_becomes_a_harmless_basename() {
        let dir = Path::new("/app/Documents");
        for raw in ["/", "\\", "./", "//"] {
            let name = sanitize_filename(raw, None).expect("separators flatten to underscores");
            assert!(
                name.chars().all(|c| c == '_'),
                "{raw:?} sanitized to {name:?}"
            );
            assert!(is_direct_child(&dir.join(&name), dir, &name));
        }
    }

    /// `is_direct_child` is the post-condition, so it has to refuse the things
    /// it exists to refuse rather than answering `true` for everything.
    #[test]
    fn the_post_condition_refuses_a_path_that_is_not_a_direct_child() {
        let dir = Path::new("/app/Documents");
        assert!(is_direct_child(&dir.join("a.txt"), dir, "a.txt"));
        assert!(!is_direct_child(&dir.join(".."), dir, ".."));
        assert!(!is_direct_child(
            Path::new("/app/Other/a.txt"),
            dir,
            "a.txt"
        ));
        assert!(!is_direct_child(
            &dir.join("sub").join("a.txt"),
            dir,
            "a.txt"
        ));
    }
}
