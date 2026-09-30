//! The handle registry and the file IO for the plain-file editor
//! (myne-md/myne#788).
//!
//! **Paths never come from the WebView.** A path arrives at this module from
//! an OS ingress (argv, macOS open event, drag, native dialog, CLI command or
//! a confirmed deep link), where it is canonicalised, checked against the
//! extension allowlist and minted into an opaque handle. The frontend sees the
//! handle, the file name and the content, and can do nothing else with it. The
//! three commands in `commands.rs` take a handle and never a path, which is
//! what makes "no JavaScript-named path exists" structural rather than a
//! promise.
//!
//! **The base hash is the conflict guard.** A read returns the SHA-256 of the
//! bytes on disk; a write takes that hash back and refuses when the file no
//! longer matches, which covers an external edit, a deletion and a
//! replacement with one mechanism. The write is atomic and preserves the
//! destination's permissions, because a rename-replace that reset a `0600`
//! note to the umask default would widen it silently.
//!
//! **The gate guards OPEN, not read/write.** Minting a handle is the moment
//! Myne is handed a file; the commands operate on a handle the user already
//! granted. That split is deliberate: the UI flushes an open tab before it
//! closes it when the gate goes off, and refusing that flush because the flag
//! was already persisted would turn a settings change into data loss. File
//! count, path and content never appear in an error (a path in an error is a
//! disclosure, `src-tauri/AGENTS.md` DENY list).

use super::gate::{gate_path_in, read_gate};
use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Extensions the surface opens, matched case-insensitively against the
/// CANONICAL path (what actually gets edited, not the name the user clicked).
pub const ALLOWED_EXTENSIONS: &[&str] = &["md", "markdown"];

/// Failure surface. Closed, so the UI switches on it rather than reading prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum PlainFileError {
    /// The device-local gate is off: no handle is minted.
    #[error("the plain-file editor is off")]
    GateOff,
    /// Not a `.md` or `.markdown` file.
    #[error("the file type is not supported")]
    UnsupportedExtension,
    /// Missing, a directory, or a name the UI cannot present as a string.
    #[error("the path is not a readable file")]
    NotAFile,
    /// The bytes are not valid UTF-8. Refused rather than decoded lossily,
    /// because a lossy round-trip would write the damage back on the first
    /// save.
    #[error("the file is not valid UTF-8")]
    NotUtf8,
    /// The file on disk no longer matches the hash the caller held: an
    /// external edit, a deletion or a replacement.
    #[error("the file changed on disk")]
    Conflict,
    /// A handle this registry never minted (or one already closed).
    #[error("unknown plain-file handle")]
    UnknownHandle,
    /// Filesystem error.
    #[error("filesystem error")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
}

fn io(e: std::io::Error) -> PlainFileError {
    PlainFileError::Io {
        io_error_kind: from_io_error_kind(e.kind()),
    }
}

/// The line ending the file uses on disk.
///
/// The editor works in `\n`; a COHERENTLY CRLF file is converted on the way in
/// and converted back on the way out, so a save never rewrites a Windows
/// checkout's line endings into a whole-file diff. A file with MIXED endings
/// is treated as LF and left byte-for-byte as it was (the conversion is
/// skipped, so the stray `\r`s ride along untouched).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Eol {
    Lf,
    Crlf,
}

/// A coherently CRLF file: it has at least one `\r\n` and no bare `\n`.
fn detect_eol(bytes: &[u8]) -> Eol {
    let mut saw_crlf = false;
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            if i > 0 && bytes[i - 1] == b'\r' {
                saw_crlf = true;
            } else {
                return Eol::Lf;
            }
        }
    }
    if saw_crlf {
        Eol::Crlf
    } else {
        Eol::Lf
    }
}

/// Normalise a VALIDATED UTF-8 file's text to the editor's `\n` convention.
fn to_editor_text(text: String, eol: Eol) -> String {
    match eol {
        Eol::Lf => text,
        Eol::Crlf => text.replace("\r\n", "\n"),
    }
}

fn to_disk_bytes(content: &str, eol: Eol) -> Vec<u8> {
    match eol {
        Eol::Lf => content.as_bytes().to_vec(),
        Eol::Crlf => content.replace('\n', "\r\n").into_bytes(),
    }
}

/// Lowercase hex, written locally rather than pulling `hex` in for six lines.
fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

fn extension_allowed(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ALLOWED_EXTENSIONS.iter().any(|a| e.eq_ignore_ascii_case(a)))
}

/// One open handle. No `Debug`: the path is a DENY-listed emission class.
#[derive(Clone)]
struct Entry {
    path: PathBuf,
    eol: Eol,
}

/// What an open returns.
///
/// `rename_all = "camelCase"`: Tauri camel-cases command ARGUMENTS, not
/// returned structs. Every TS mirror reads `baseHash`, so without this the
/// compare-and-swap base arrives `undefined` and every autosave rejects.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    /// The opaque handle the frontend passes back to read/write/close.
    pub handle: u64,
    /// The file name, for the tab title. Never a full path.
    pub name: String,
    /// The file's text, `\n`-normalised (see [`Eol`]).
    pub content: String,
    /// SHA-256 of the bytes ON DISK, for the compare-and-swap on write.
    pub base_hash: String,
}

/// What a read returns. `camelCase` for the same reason as [`OpenedFile`].
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    /// The file's text, `\n`-normalised.
    pub content: String,
    /// SHA-256 of the bytes on disk at read time.
    pub base_hash: String,
}

/// The handle registry. Held in this plugin's managed state; one per app.
/// No `Debug`: the entries carry filesystem paths.
#[derive(Default)]
pub struct PlainFileRegistry {
    next_id: u64,
    /// Keyed by handle. Values carry the CANONICAL path, so every later IO
    /// targets the resolved file rather than a symlink the user clicked.
    entries: HashMap<u64, Entry>,
    /// Handles an ingress minted that the frontend has not claimed yet.
    ///
    /// The startup argv path runs before the WebView can have attached its
    /// event listener, so an emitted event alone would lose the file on every
    /// cold launch. The frontend drains this list on mount as well as
    /// subscribing (`plain_file_take_unclaimed`), which makes the two orders
    /// equivalent.
    unclaimed: Vec<u64>,
}

impl PlainFileRegistry {
    /// Mint a handle for `path`, or return the existing one for the same
    /// canonical file.
    ///
    /// The gate is read per call and never cached: a settings change takes
    /// effect on the next open in the same session.
    pub fn open(&mut self, config_dir: &Path, path: &Path) -> Result<OpenedFile, PlainFileError> {
        if !read_gate(&gate_path_in(config_dir)) {
            return Err(PlainFileError::GateOff);
        }
        if !extension_allowed(path) {
            return Err(PlainFileError::UnsupportedExtension);
        }
        let canonical = path.canonicalize().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                PlainFileError::NotAFile
            } else {
                io(e)
            }
        })?;
        if !canonical.is_file() {
            return Err(PlainFileError::NotAFile);
        }
        // The extension check runs again on the RESOLVED path: a symlink named
        // `notes.md` pointing at `/etc/passwd` must be refused for what it
        // actually is, not for what it is called.
        if !extension_allowed(&canonical) {
            return Err(PlainFileError::UnsupportedExtension);
        }

        let bytes = std::fs::read(&canonical).map_err(io)?;
        let eol = detect_eol(&bytes);
        let content = to_editor_text(
            String::from_utf8(bytes.clone()).map_err(|_| PlainFileError::NotUtf8)?,
            eol,
        );
        let name = canonical
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
            .ok_or(PlainFileError::NotAFile)?;

        if let Some((handle, entry)) = self
            .entries
            .iter_mut()
            .find(|(_, entry)| entry.path == canonical)
        {
            entry.eol = eol;
            let handle = *handle;
            if !self.unclaimed.contains(&handle) {
                self.unclaimed.push(handle);
            }
            return Ok(OpenedFile {
                handle,
                name,
                content,
                base_hash: hash_bytes(&bytes),
            });
        }

        self.next_id += 1;
        let handle = self.next_id;
        self.entries.insert(
            handle,
            Entry {
                path: canonical,
                eol,
            },
        );
        self.unclaimed.push(handle);
        Ok(OpenedFile {
            handle,
            name,
            content,
            base_hash: hash_bytes(&bytes),
        })
    }

    /// Read the current content. Re-detects the line ending, so a conflict
    /// reload through this call adopts whatever the file now uses.
    pub fn read(&mut self, handle: u64) -> Result<FileContent, PlainFileError> {
        let path = self
            .entries
            .get(&handle)
            .map(|entry| entry.path.clone())
            .ok_or(PlainFileError::UnknownHandle)?;
        let bytes = std::fs::read(&path).map_err(io)?;
        let eol = detect_eol(&bytes);
        let content = to_editor_text(
            String::from_utf8(bytes.clone()).map_err(|_| PlainFileError::NotUtf8)?,
            eol,
        );
        if let Some(entry) = self.entries.get_mut(&handle) {
            entry.eol = eol;
        }
        Ok(FileContent {
            content,
            base_hash: hash_bytes(&bytes),
        })
    }

    /// Write `content` when the file on disk still hashes to `expected_base`.
    ///
    /// Returns the hash of the bytes written, which is the next expected base.
    /// A missing file is a conflict: an autosave that silently recreated a
    /// file somebody else deleted would overwrite that decision.
    pub fn write(
        &self,
        handle: u64,
        content: &str,
        expected_base: &str,
    ) -> Result<String, PlainFileError> {
        let entry = self
            .entries
            .get(&handle)
            .ok_or(PlainFileError::UnknownHandle)?;
        let current = match std::fs::read(&entry.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(PlainFileError::Conflict)
            }
            Err(e) => return Err(io(e)),
        };
        if hash_bytes(&current) != expected_base {
            return Err(PlainFileError::Conflict);
        }
        let bytes = to_disk_bytes(content, entry.eol);
        write_atomic_preserving(&entry.path, &bytes)?;
        Ok(hash_bytes(&bytes))
    }

    /// Drop a handle. Closing an unknown handle is a no-op: handle ids are
    /// never reused, so a stale close from a torn-down tab is harmless and
    /// must not surface as an error.
    pub fn close(&mut self, handle: u64) {
        self.entries.remove(&handle);
        self.unclaimed.retain(|h| *h != handle);
    }

    /// Every handle an ingress minted and the frontend has not claimed yet,
    /// with fresh content, and clears the list.
    ///
    /// A handle that can no longer be read (deleted between ingest and claim)
    /// is dropped silently: the frontend would have nothing to render.
    pub fn take_unclaimed(&mut self) -> Vec<OpenedFile> {
        let handles = std::mem::take(&mut self.unclaimed);
        let mut out = Vec::with_capacity(handles.len());
        for handle in handles {
            let Ok(content) = self.read(handle) else {
                continue;
            };
            let Some(entry) = self.entries.get(&handle) else {
                continue;
            };
            let Some(name) = entry.path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            out.push(OpenedFile {
                handle,
                name: name.to_string(),
                content: content.content,
                base_hash: content.base_hash,
            });
        }
        out
    }
}

/// Atomic replace that keeps the destination's permissions, with an
/// UNCLOBBERED temp name.
///
/// The fixed `<path>.tmp` name is wrong at a destination the user owns: a real
/// file they happen to have named that way would be truncated and renamed away,
/// and a symlink placed there redirects the write. `format/src/atomic_write.rs`
/// documents exactly this and routes user-owned destinations to
/// `atomic_write_unclobbered`, so the naming contract is reproduced here
/// (randomized, `create_new`, bounded retry) with the one addition this caller
/// needs: the destination's mode is applied to the temp AT CREATION, before any
/// content exists, so a `0600` note is never briefly wider and a crash cannot
/// leave a sibling holding the user's text at umask mode.
fn write_atomic_preserving(path: &Path, bytes: &[u8]) -> Result<(), PlainFileError> {
    let perms = std::fs::metadata(path).map_err(io)?.permissions();
    let parent = path.parent().ok_or(PlainFileError::NotAFile)?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(PlainFileError::NotAFile)?;
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        perms.mode()
    };
    let mut last = PlainFileError::Io {
        io_error_kind: IoFailureKind::Other,
    };
    for attempt in 0..16u32 {
        let tmp = parent.join(format!(".{name}.{}-{attempt}.myne-tmp", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        let mut file = match options.open(&tmp) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io(e)),
        };
        #[cfg(not(unix))]
        if let Err(e) = file.set_permissions(perms.clone()) {
            let _ = std::fs::remove_file(&tmp);
            return Err(io(e));
        }
        let write_result = (|| -> std::io::Result<()> {
            use std::io::Write;
            file.write_all(bytes)?;
            file.sync_all()
        })();
        if let Err(e) = write_result {
            let _ = std::fs::remove_file(&tmp);
            return Err(io(e));
        }
        match crate::atomic_write::finalize_atomic(&tmp, path, true) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                last = io(e);
            }
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::plain_file::gate::write_gate;
    use myne_core::test_support::ScopedTempDir;

    /// A temp dir with the gate ON, plus a second dir for the file itself.
    struct Fixture {
        config: ScopedTempDir,
        files: ScopedTempDir,
    }

    impl Fixture {
        fn new(label: &str, gate_on: bool) -> Self {
            let config = ScopedTempDir::new(&format!("plain-file-{label}-config")).expect("config");
            write_gate(&gate_path_in(config.path()), gate_on).expect("gate");
            let files = ScopedTempDir::new(&format!("plain-file-{label}-files")).expect("files");
            Self { config, files }
        }

        fn write_file(&self, name: &str, body: &[u8]) -> PathBuf {
            let path = self.files.path().join(name);
            std::fs::write(&path, body).expect("seed file");
            path
        }
    }

    #[test]
    fn gate_off_refuses_to_open() {
        let fixture = Fixture::new("gate-off", false);
        let path = fixture.write_file("note.md", b"# hi");
        let mut registry = PlainFileRegistry::default();
        assert_eq!(
            registry.open(fixture.config.path(), &path).map(|_| ()),
            Err(PlainFileError::GateOff)
        );
    }

    #[test]
    fn a_disallowed_extension_is_refused() {
        let fixture = Fixture::new("ext", true);
        let path = fixture.write_file("note.txt", b"hi");
        let mut registry = PlainFileRegistry::default();
        assert_eq!(
            registry.open(fixture.config.path(), &path).map(|_| ()),
            Err(PlainFileError::UnsupportedExtension)
        );
    }

    #[test]
    fn uppercase_extensions_are_allowed() {
        let fixture = Fixture::new("ext-case", true);
        let path = fixture.write_file("README.MD", b"# hi");
        let mut registry = PlainFileRegistry::default();
        let opened = registry.open(fixture.config.path(), &path).expect("open");
        assert_eq!(opened.content, "# hi");
    }

    #[test]
    fn a_missing_file_is_not_a_file() {
        let fixture = Fixture::new("missing", true);
        let mut registry = PlainFileRegistry::default();
        assert_eq!(
            registry
                .open(fixture.config.path(), &fixture.files.path().join("nope.md"))
                .map(|_| ()),
            Err(PlainFileError::NotAFile)
        );
    }

    #[test]
    fn a_directory_is_not_a_file() {
        let fixture = Fixture::new("dir", true);
        let dir = fixture.files.path().join("folder.md");
        std::fs::create_dir(&dir).expect("mkdir");
        let mut registry = PlainFileRegistry::default();
        assert_eq!(
            registry.open(fixture.config.path(), &dir).map(|_| ()),
            Err(PlainFileError::NotAFile)
        );
    }

    #[test]
    fn non_utf8_is_refused_rather_than_decoded_lossily() {
        let fixture = Fixture::new("utf8", true);
        let path = fixture.write_file("bin.md", &[0x23, 0xff, 0xfe, 0x0a]);
        let mut registry = PlainFileRegistry::default();
        assert_eq!(
            registry.open(fixture.config.path(), &path).map(|_| ()),
            Err(PlainFileError::NotUtf8)
        );
    }

    #[test]
    fn the_same_file_opened_twice_is_the_same_handle() {
        let fixture = Fixture::new("dedupe", true);
        let path = fixture.write_file("note.md", b"# one");
        let mut registry = PlainFileRegistry::default();
        let first = registry.open(fixture.config.path(), &path).expect("open");
        let second = registry.open(fixture.config.path(), &path).expect("open");
        assert_eq!(first.handle, second.handle);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_dedupes_to_its_target_and_is_checked_by_target() {
        let fixture = Fixture::new("symlink", true);
        let real = fixture.write_file("real.md", b"# real");
        let link = fixture.files.path().join("link.md");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        let mut registry = PlainFileRegistry::default();
        let via_real = registry.open(fixture.config.path(), &real).expect("real");
        let via_link = registry.open(fixture.config.path(), &link).expect("link");
        assert_eq!(via_real.handle, via_link.handle);

        // And a symlink whose TARGET has no allowed extension is refused even
        // though the link's own name ends in `.md`.
        let target = fixture.write_file("payload", b"# payload");
        let disguised = fixture.files.path().join("disguised.md");
        std::os::unix::fs::symlink(&target, &disguised).expect("symlink");
        assert_eq!(
            registry.open(fixture.config.path(), &disguised).map(|_| ()),
            Err(PlainFileError::UnsupportedExtension)
        );
    }

    #[test]
    fn write_with_a_stale_base_changes_nothing() {
        let fixture = Fixture::new("cas-stale", true);
        let path = fixture.write_file("note.md", b"# original");
        let mut registry = PlainFileRegistry::default();
        let opened = registry.open(fixture.config.path(), &path).expect("open");
        // Somebody else edits the file.
        std::fs::write(&path, b"# theirs").expect("external write");

        assert_eq!(
            registry.write(opened.handle, "# mine", &opened.base_hash),
            Err(PlainFileError::Conflict)
        );
        assert_eq!(std::fs::read(&path).expect("read"), b"# theirs");
    }

    #[test]
    fn write_with_a_matching_base_lands_and_returns_the_new_hash() {
        let fixture = Fixture::new("cas-ok", true);
        let path = fixture.write_file("note.md", b"# original");
        let mut registry = PlainFileRegistry::default();
        let opened = registry.open(fixture.config.path(), &path).expect("open");

        let new_hash = registry
            .write(opened.handle, "# edited", &opened.base_hash)
            .expect("write");
        assert_eq!(std::fs::read(&path).expect("read"), b"# edited");
        assert_eq!(new_hash, hash_bytes(b"# edited"));

        // And the next write accepts that hash.
        registry
            .write(opened.handle, "# again", &new_hash)
            .expect("second write");
        assert_eq!(std::fs::read(&path).expect("read"), b"# again");
    }

    #[test]
    fn write_after_external_deletion_is_a_conflict_not_a_recreation() {
        let fixture = Fixture::new("cas-deleted", true);
        let path = fixture.write_file("note.md", b"# original");
        let mut registry = PlainFileRegistry::default();
        let opened = registry.open(fixture.config.path(), &path).expect("open");
        std::fs::remove_file(&path).expect("delete");

        assert_eq!(
            registry.write(opened.handle, "# mine", &opened.base_hash),
            Err(PlainFileError::Conflict)
        );
        assert!(!path.exists());
    }

    #[test]
    fn read_returns_disk_state_not_cached_state() {
        let fixture = Fixture::new("read-live", true);
        let path = fixture.write_file("note.md", b"# one");
        let mut registry = PlainFileRegistry::default();
        let opened = registry.open(fixture.config.path(), &path).expect("open");
        std::fs::write(&path, b"# two").expect("external write");

        let current = registry.read(opened.handle).expect("read");
        assert_eq!(current.content, "# two");
        assert_eq!(current.base_hash, hash_bytes(b"# two"));
    }

    #[test]
    fn unknown_and_closed_handles_are_refused() {
        let fixture = Fixture::new("handles", true);
        let path = fixture.write_file("note.md", b"# one");
        let mut registry = PlainFileRegistry::default();
        assert_eq!(
            registry.read(99).map(|_| ()),
            Err(PlainFileError::UnknownHandle)
        );
        let opened = registry.open(fixture.config.path(), &path).expect("open");
        registry.close(opened.handle);
        assert_eq!(
            registry.read(opened.handle).map(|_| ()),
            Err(PlainFileError::UnknownHandle)
        );
        // Closing twice is a no-op rather than an error.
        registry.close(opened.handle);
    }

    #[test]
    fn a_crlf_file_round_trips_to_crlf() {
        let fixture = Fixture::new("crlf", true);
        let path = fixture.write_file("win.md", b"# one\r\n\r\ntwo\r\n");
        let mut registry = PlainFileRegistry::default();
        let opened = registry.open(fixture.config.path(), &path).expect("open");
        assert_eq!(opened.content, "# one\n\ntwo\n");

        let new_hash = registry
            .write(opened.handle, "# one\n\ntwo edited\n", &opened.base_hash)
            .expect("write");
        assert_eq!(
            std::fs::read(&path).expect("read"),
            b"# one\r\n\r\ntwo edited\r\n"
        );
        assert_eq!(new_hash, hash_bytes(b"# one\r\n\r\ntwo edited\r\n"));
    }

    #[test]
    fn a_mixed_ending_file_is_left_as_lf_and_keeps_its_carriage_returns() {
        let fixture = Fixture::new("mixed", true);
        let path = fixture.write_file("mixed.md", b"one\ntwo\r\nthree\n");
        let mut registry = PlainFileRegistry::default();
        let opened = registry.open(fixture.config.path(), &path).expect("open");
        // No normalisation: the file is not COHERENTLY CRLF, so the text keeps
        // its stray returns and a save writes those bytes back.
        assert_eq!(opened.content, "one\ntwo\r\nthree\n");
        registry
            .write(opened.handle, &opened.content, &opened.base_hash)
            .expect("write");
        assert_eq!(std::fs::read(&path).expect("read"), b"one\ntwo\r\nthree\n");
    }

    #[test]
    fn unclaimed_handles_drain_exactly_once() {
        let fixture = Fixture::new("unclaimed", true);
        let path = fixture.write_file("note.md", b"# one");
        let mut registry = PlainFileRegistry::default();

        let opened = registry.open(fixture.config.path(), &path).expect("open");
        let drained = registry.take_unclaimed();
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].handle, opened.handle);
        assert_eq!(drained[0].content, "# one");
        assert_eq!(drained[0].name, "note.md");

        // A second drain is empty, and reopening the same file re-arms it
        // (the OS tried to open it again, so the frontend should focus it).
        assert!(registry.take_unclaimed().is_empty());
        registry.open(fixture.config.path(), &path).expect("reopen");
        assert_eq!(registry.take_unclaimed().len(), 1);

        // Closing drops an unclaimed handle too, so the frontend never sees a
        // handle whose file is gone.
        registry.close(opened.handle);
        assert!(registry.take_unclaimed().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn write_preserves_the_destination_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new("perms", true);
        let path = fixture.write_file("private.md", b"# secret");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod");

        let mut registry = PlainFileRegistry::default();
        let opened = registry.open(fixture.config.path(), &path).expect("open");
        registry
            .write(opened.handle, "# secret edited", &opened.base_hash)
            .expect("write");

        let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
