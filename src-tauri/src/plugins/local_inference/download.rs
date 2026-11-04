// SPDX-License-Identifier: AGPL-3.0
//! On-demand AI model downloads (myne-md/myne#805, `decisions/ai/0627`).
//!
//! This is the **orchestration** half: the compiled-in artefact table (the sole
//! trust anchor for a download), the staging-then-verify-then-register flow, and
//! the per-download cancellation registry. The socket itself lives in
//! [`myne_core::inference::model_download`], in `myne-core`, because that is
//! where the TLS stack, the shared HTTP codec and the Tor routing seam already
//! are; this module never opens one.
//!
//! **The digest table is compiled into the binary.** Each artefact's files and
//! their SHA-256 values are constants here. The origin's `index.json` and
//! `SHA256SUMS` are discovery and display only and are never consulted to decide
//! whether bytes are acceptable (`prd.md`, story 17), so a tampered origin cannot
//! serve bytes that agree with the check.
//!
//! **No credential crosses this path.** The fetch carries no account number, no
//! key and no note bytes; the only thing it can reveal to the origin is that this
//! device chose to fetch a model. It is an inbound fetch with no provider named,
//! recorded once in the AI egress guard's allowlist.
//!
//! Logging: DENY-list clean (`src-tauri/AGENTS.md`). No host, path, digest or
//! byte of a model reaches a log or an error message.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

/// Reports total bytes written so far, across the whole artefact, on a
/// best-effort basis. Called on every sink write; a caller that forwards to the
/// WebView throttles it (the UI does not need one event per 64 KiB chunk).
pub type DownloadProgressFn = Arc<dyn Fn(u64) + Send + Sync>;

/// A `Write` sink that adds every byte written to a running total (seeded with
/// the bytes of any earlier files) and reports it. The total is clamped to the
/// artefact's approximate size so the bar never exceeds 100% when the estimate
/// is low.
struct ProgressWriter<W: Write> {
    inner: W,
    written: u64,
    total: u64,
    on_write: DownloadProgressFn,
}

impl<W: Write> Write for ProgressWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.written = self.written.saturating_add(n as u64);
        (self.on_write)(self.written.min(self.total));
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

use super::cancel::CancelToken;
use super::cancellable_io::CancelledFn;
use super::model_store::{self, ArtifactFile, ModelRole, ModelStoreError};
use myne_core::inference::model_download::{self, ModelDownloadError};

/// The single origin a model fetch may reach. Compiled in, never read from
/// prefs or from the WebView.
///
/// Under the E2E `local-inference-stub` build only, `MYNE_E2E_MODEL_ORIGIN` may
/// point it at a local fixture origin (`host:port`). This is a **build variant**
/// override, not a runtime knob: the default build does not read the variable,
/// so setting it on a shipped binary does nothing: the same discipline
/// `voice-capture-stub` and `local-inference-stub` state about themselves. The
/// digest check is unchanged, so a fixture must still serve bytes that match the
/// compiled-in table.
pub const DOWNLOAD_ORIGIN_HOST: &str = "downloads.myne.md";

/// HTTPS port for the production origin.
pub const DOWNLOAD_ORIGIN_PORT: u16 = 443;

/// The `(host, port)` a fetch actually uses. Production returns the compiled-in
/// origin; the E2E stub build may override it from the environment.
pub fn download_origin() -> (String, u16) {
    #[cfg(feature = "local-inference-stub")]
    {
        if let Ok(raw) = std::env::var("MYNE_E2E_MODEL_ORIGIN") {
            if let Some((host, port)) = raw.rsplit_once(':') {
                if let Ok(port) = port.parse::<u16>() {
                    return (host.to_string(), port);
                }
            }
        }
    }
    (DOWNLOAD_ORIGIN_HOST.to_string(), DOWNLOAD_ORIGIN_PORT)
}

/// One downloadable artefact: the role it registers, the origin path under
/// which its files live, where it lands under `models/`, and the exact files
/// with their compiled-in digests.
pub struct Artifact {
    /// The UI/codegen-facing id (stable; the downloaded-model settings use it).
    pub id: &'static str,
    /// The model store role this artefact registers.
    pub role: ModelRole,
    /// Origin path prefix, e.g. `/models/tag/05df94f8140a`.
    pub url_prefix: &'static str,
    /// Destination directory name under `models/` (content-addressed by digest
    /// prefix, so a new revision lands beside the old one).
    pub dest_dir: &'static str,
    /// The artefact's files. The **first** is the primary, whose path the role
    /// marker records.
    pub files: &'static [ArtifactFile],
    /// Approximate total size of the artefact, in bytes, for the download
    /// progress bar ONLY (myne-md/myne#814). Never a security check: the trust
    /// anchor is the compiled-in `sha256_hex` per file, and this number is the
    /// same "about N MB" the settings copy states. The bar clamps at 100%, so a
    /// size that is a little off reaches the end of the bar and then the row
    /// flips to "Installed".
    pub approx_total_bytes: u64,
}

/// The compiled-in artefact table. Only the auto-tag model is
/// offered here; the transcription model ships in the bundle.
pub const ARTIFACTS: &[Artifact] = &[Artifact {
    id: "tag",
    role: ModelRole::TagSuggestion,
    url_prefix: "/models/tag/05df94f8140a",
    dest_dir: "tag-05df94f8140a",
    // "about 337 MB" in the settings copy; 337 MiB.
    approx_total_bytes: 337 * 1024 * 1024,
    files: &[
        ArtifactFile {
            name: "model.gguf",
            sha256_hex: "05df94f8140a0cb43910c1f7b4c680c6dd1539ef6790b33dd9c6a10dc714cd93",
        },
        ArtifactFile {
            name: "tokenizer.json",
            sha256_hex: "c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539",
        },
    ],
}];

/// Stub-build fixture artefacts (myne-md/myne#805 task 8). Deterministic bytes
/// live here as digests only; the bytes themselves are served by
/// `e2e/support/model-fixture-origin.ts`, which computes the same values. Kept
/// out of the production table so a shipped binary cannot name them.
///
/// **One entry, for the auto-tag role.** It replaced `fixture-embedding` when
/// the AI embedding index was retired (`docs/decisions/ai/0703-*`): the
/// download path still needs a stub-only artefact to exercise install, digest
/// verification, marker write and removal without a network, and the tag role
/// is the surviving one with an otherwise identical flow. A fixture naming no
/// role the client still offers would leave that flow covered by nothing.
#[cfg(feature = "local-inference-stub")]
pub static FIXTURE_ARTIFACTS: &[Artifact] = &[Artifact {
    id: "fixture-tag",
    role: ModelRole::TagSuggestion,
    url_prefix: "/fixture/tag",
    dest_dir: "fixture-tag",
    // Fixture bytes are tiny; a small non-zero total keeps the bar determinate.
    approx_total_bytes: 4096,
    files: &[ArtifactFile {
        name: "model.gguf",
        // sha256("myne-e2e-fixture-tag-model-bytes"), the exact bytes
        // `e2e/support/model-fixture-origin.ts` serves.
        sha256_hex: "7f7ba98a1997e0f1c7cc0f1b6b2ae51c255eba84262cfc1800f935ffb9b8a22e",
    }],
}];

/// Look up an artefact by its id, or `None` for an unknown id (a UI/codegen bug,
/// not user input).
pub fn artifact_by_id(id: &str) -> Option<&'static Artifact> {
    if let Some(a) = ARTIFACTS.iter().find(|a| a.id == id) {
        return Some(a);
    }
    // E2E-only fixture artefacts (myne-md/myne#805 task 8). Tiny, deterministic
    // bytes whose digests the harness's local fixture origin serves. Gated on the
    // stub build so a shipped binary cannot name them; the verification path is
    // otherwise byte-for-byte the production one, which is the point: a
    // checksum mismatch is caught by the same `install_downloaded_bundle`.
    #[cfg(feature = "local-inference-stub")]
    {
        return FIXTURE_ARTIFACTS.iter().find(|a| a.id == id);
    }
    #[allow(unreachable_code)]
    None
}

/// The command-facing error. Serde-tagged so the TS mirror can branch on
/// `kind`; every payload is closed (no path, no OS string, no digest).
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum ModelDownloadCommandError {
    /// The requested artefact id is not in the compiled-in table.
    #[error("unknown model artifact")]
    UnknownArtifact,
    /// The download transport failed.
    #[error("model download failed")]
    Download(#[from] ModelDownloadError),
    /// The staged bytes failed verification or could not be stored.
    #[error("model store failed")]
    Store(#[from] ModelStoreError),
}

/// Per-download cancellation registry, keyed by the frontend-supplied
/// `download_id`. A separate map from [`super::cancel::CancelRegistry`] because
/// a download has no shared Stop button and is not a model generation: it is
/// cancelled by id, exactly, from the surface that started it.
#[derive(Default)]
pub struct DownloadCancels {
    inner: Mutex<HashMap<String, CancelToken>>,
}

impl DownloadCancels {
    /// Register a new download. The returned guard deregisters on drop, so a
    /// panicking or early-returning command cannot leak an entry.
    pub fn begin<'a>(&'a self, id: &'a str) -> (CancelToken, DownloadGuard<'a>) {
        let token = CancelToken::default();
        self.inner
            .lock()
            .expect("download cancel registry mutex poisoned")
            .insert(id.to_string(), token.clone());
        (token, DownloadGuard { registry: self, id })
    }

    /// Cancel a download by id. `false` when it already finished.
    pub fn cancel(&self, id: &str) -> bool {
        match self
            .inner
            .lock()
            .expect("download cancel registry mutex poisoned")
            .get(id)
        {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }
}

/// One download's registry handle. Deregisters itself on drop.
pub struct DownloadGuard<'a> {
    registry: &'a DownloadCancels,
    id: &'a str,
}

impl Drop for DownloadGuard<'_> {
    fn drop(&mut self) {
        self.registry
            .inner
            .lock()
            .expect("download cancel registry mutex poisoned")
            .remove(self.id);
    }
}

/// Fetch one artefact file over the production TLS transport, or, under the E2E
/// stub build against a local fixture origin, over plain HTTP.
fn fetch_one<W: std::io::Write>(
    artifact: &Artifact,
    file: &ArtifactFile,
    host: &str,
    port: u16,
    sink: &mut W,
    cancelled: &CancelledFn,
) -> Result<u64, ModelDownloadError> {
    let url = format!("{}/{}", artifact.url_prefix, file.name);
    #[cfg(feature = "local-inference-stub")]
    {
        // The fixture origin serves plain HTTP; the production origin serves TLS.
        if std::env::var("MYNE_E2E_MODEL_ORIGIN").is_ok() {
            return model_download::download_http(
                host,
                port,
                &url,
                sink,
                model_download::MAX_MODEL_DOWNLOAD_BYTES,
                cancelled,
            );
        }
    }
    model_download::download_https(
        host,
        port,
        &url,
        sink,
        model_download::MAX_MODEL_DOWNLOAD_BYTES,
        cancelled,
    )
}

/// Fetch and install `artifact`, and record the attempt.
///
/// **One wrapper, three records, no scattered call sites.** A model download moves
/// hundreds of megabytes in one attempt with no retry behind it, and until this
/// wrapper existed it left no trace at all: the only evidence of a failed download
/// was a typed error the page turned into a sentence. Recording it here rather than
/// at each `return Err` in the body is what makes the coverage total — the body has
/// four failure arms today and a fifth would be silent otherwise.
///
/// `expected_bytes` is the artefact's declared size, not a count of what moved: the
/// body streams file by file and reports progress through `progress`, and re-deriving
/// a byte count here would be a second measure of the same thing.
pub fn download_and_install(
    base: &Path,
    artifact: &Artifact,
    download_id: &str,
    cancelled: &CancelledFn,
    progress: &DownloadProgressFn,
) -> Result<PathBuf, ModelDownloadCommandError> {
    let started = std::time::Instant::now();
    tracing::info!(
        event = "model_download_started",
        artifact = artifact.id,
        expected_bytes = artifact.approx_total_bytes
    );
    let outcome = download_and_install_inner(base, artifact, download_id, cancelled, progress);
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match &outcome {
        Ok(_) => tracing::info!(
            event = "model_download_installed",
            artifact = artifact.id,
            expected_bytes = artifact.approx_total_bytes,
            elapsed_ms
        ),
        // `?error` on this pair of closed enums: neither variant set carries an
        // `io::Error`, so no path and no OS message can reach the file.
        Err(error) => tracing::warn!(
            event = "model_download_failed",
            artifact = artifact.id,
            kind = ?error,
            elapsed_ms
        ),
    }
    outcome
}

/// Fetch and install `artifact`, streaming each file to a staging directory and
/// registering only after every file verifies against its compiled-in digest.
///
/// Blocking (sockets + fs); the caller runs it on a blocking task. On any
/// failure the staging directory is removed, so no partial artefact is left for
/// the loader to find.
fn download_and_install_inner(
    base: &Path,
    artifact: &Artifact,
    download_id: &str,
    cancelled: &CancelledFn,
    progress: &DownloadProgressFn,
) -> Result<PathBuf, ModelDownloadCommandError> {
    // Staging is keyed by the caller-minted `download_id`, NOT the artefact id:
    // two concurrent downloads of the same artefact must not share a directory,
    // or one's opening `remove_dir_all` truncates the other's files and a file
    // verified against the compiled-in digest can be replaced between the
    // verification and the rename.
    let staging = model_store::models_dir_from_base(base)
        .join(".staging")
        .join(download_id);
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(ModelStoreError::from)?;

    // Bytes of the files already fully written, so the progress total is
    // cumulative across the artefact rather than resetting per file.
    let mut done_bytes: u64 = 0;
    for file in artifact.files {
        let dest = staging.join(file.name);
        let (host, port) = download_origin();
        let out = match std::fs::File::create(&dest) {
            Ok(f) => f,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(ModelStoreError::from(e).into());
            }
        };
        let mut writer = ProgressWriter {
            inner: out,
            written: done_bytes,
            total: artifact.approx_total_bytes,
            on_write: progress.clone(),
        };
        let result = fetch_one(artifact, file, &host, port, &mut writer, cancelled);
        done_bytes = writer.written;
        // Drop closes the file before the next iteration reuses the staging dir
        // and before the hash-verify pass in `install_downloaded_bundle` reads it.
        drop(writer);
        if let Err(e) = result {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e.into());
        }
    }

    let installed = model_store::install_downloaded_bundle(
        base,
        artifact.role,
        &staging,
        artifact.dest_dir,
        artifact.files,
    );
    // A failed verification removes its own staging on the digest-mismatch and
    // name-validation arms; on any other error (IO) clear it here too.
    if installed.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    installed.map_err(ModelDownloadCommandError::from)
}

/// Build the cancellation predicate the transport polls from a token.
pub fn cancelled_fn(token: &CancelToken) -> CancelledFn {
    let token = token.clone();
    Arc::new(move || token.is_cancelled())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The stub fixture table obeys the same shape rules as the production one,
    /// and every entry really resolves through [`artifact_by_id`]: the download
    /// E2E lane names `fixture-tag` by id, so a table that silently stopped
    /// carrying it would redden that lane with no compile error here.
    #[cfg(feature = "local-inference-stub")]
    #[test]
    fn the_fixture_table_is_shape_checked_and_resolvable() {
        assert!(
            !FIXTURE_ARTIFACTS.is_empty(),
            "the model-download E2E lane needs a stub fixture artefact"
        );
        for a in FIXTURE_ARTIFACTS {
            assert!(a.url_prefix.starts_with("/fixture/"), "{} prefix", a.id);
            assert!(!a.files.is_empty(), "{} has no files", a.id);
            for f in a.files {
                assert!(
                    !f.name.contains('/'),
                    "{} file {} is not bare",
                    a.id,
                    f.name
                );
                assert_eq!(
                    f.sha256_hex.len(),
                    64,
                    "{} {} digest not 32 bytes",
                    a.id,
                    f.name
                );
                assert!(
                    f.sha256_hex
                        .chars()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                    "{} {} digest is not lowercase hex",
                    a.id,
                    f.name
                );
            }
            assert!(
                artifact_by_id(a.id).is_some(),
                "{} does not resolve through artifact_by_id",
                a.id
            );
        }
    }

    #[test]
    fn the_table_ids_are_unique_and_each_names_bare_files() {
        let mut seen = std::collections::BTreeSet::new();
        for a in ARTIFACTS {
            assert!(seen.insert(a.id), "duplicate artefact id {}", a.id);
            assert!(!a.files.is_empty(), "{} has no files", a.id);
            assert!(a.url_prefix.starts_with("/models/"), "{} prefix", a.id);
            for f in a.files {
                assert!(
                    !f.name.contains('/'),
                    "{} file {} is not bare",
                    a.id,
                    f.name
                );
                assert_eq!(
                    f.sha256_hex.len(),
                    64,
                    "{} {} digest not 32 bytes",
                    a.id,
                    f.name
                );
                assert!(
                    f.sha256_hex
                        .chars()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                    "{} {} digest is not lowercase hex",
                    a.id,
                    f.name
                );
            }
        }
    }

    #[test]
    fn lookup_finds_only_compiled_in_ids() {
        assert_eq!(
            artifact_by_id("tag").map(|a| a.role),
            Some(ModelRole::TagSuggestion)
        );
        assert!(artifact_by_id("all-minilm").is_none());
    }

    /// Cancelling a download by id flips exactly that token, and a finished
    /// download deregisters so a later cancel cannot reach it.
    #[test]
    fn cancel_targets_one_download_and_forgets_finished_ones() {
        let reg = DownloadCancels::default();
        let (token_a, guard_a) = reg.begin("a");
        let (token_b, _guard_b) = reg.begin("b");
        assert!(reg.cancel("a"));
        assert!(token_a.is_cancelled());
        assert!(!token_b.is_cancelled(), "cancelling A must not abort B");
        drop(guard_a);
        assert!(!reg.cancel("a"), "a finished download cannot be cancelled");
        // The predicate a transport polls reads only its own token.
        let pred = cancelled_fn(&token_b);
        assert!(!pred());
        reg.cancel("b");
        assert!(pred());
    }

    /// The progress sink reports cumulative bytes and clamps at the total, so a
    /// low estimate never drives the bar past 100% (myne-md/myne#814).
    #[test]
    fn progress_writer_reports_cumulative_bytes_clamped_to_total() {
        let seen = Arc::new(Mutex::new(Vec::<u64>::new()));
        let sink = Arc::clone(&seen);
        let progress: DownloadProgressFn = Arc::new(move |n| {
            sink.lock().expect("progress sink poisoned").push(n);
        });
        let mut w = ProgressWriter {
            inner: Vec::<u8>::new(),
            written: 0,
            total: 10,
            on_write: progress,
        };
        w.write_all(&[0u8; 4]).expect("write");
        w.write_all(&[0u8; 4]).expect("write");
        w.write_all(&[0u8; 8]).expect("write");
        assert_eq!(
            *seen.lock().expect("progress sink poisoned"),
            vec![4, 8, 10]
        );
        assert_eq!(
            w.written, 16,
            "the raw count keeps advancing past the estimate"
        );
    }
}
