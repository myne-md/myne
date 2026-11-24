// SPDX-License-Identifier: AGPL-3.0-only
//! Model side-load + device-local storage-path layer (local-ai epic,
//! MYND-406, task 2).
//!
//! Models are **side-loaded** — the user picks a model file from their own
//! disk via the existing `dialog`+`fs` plugins (zero new network surface,
//! SYNC-1); this module owns where those files may live and where the chosen
//! path is recorded. Two hard rules:
//!
//! 1. **Model files live OUTSIDE the vault tree.** The models directory is
//!    `<app_data_dir>/models/` — a *sibling* of `<app_data_dir>/vaults/`, never
//!    inside any `vaults/<VaultId>/`. A user-picked path that resolves inside
//!    the vault tree is **rejected** ([`ensure_outside_vault_tree`]) so model
//!    files can never co-mingle with ciphertext or trip the boot migration
//!    (cf. the 2026-06-11 empty-vault migration data-loss incident).
//! 2. **The chosen path is device-local config, not vault content.** It is
//!    recorded in a small marker file under `models/` — never synced, never in
//!    a `.myn`, never inside a vault.
//!
//! No download path and no networked crate: acquisition is user-initiated
//! side-load only. The runtime resolution mirrors `core/src/paths.rs`
//! (`*_from_base(base)` pure core for tests + a thin `<R>(app)` wrapper).
//!
//! Logging: DENY-list clean (`src-tauri/AGENTS.md`) — [`ModelStoreError`]
//! reduces every IO failure to the closed [`IoFailureKind`] (no raw
//! `io::Error` `Display`, which can leak OS paths) and carries no path in any
//! variant. The recorded model path is device-local config, not a secret.

// Every item is task-2 path/validation logic consumed by task-6 commands +
// the tests below; nothing is reachable from a live root (init/lib.rs) until
// task 6 wires the `#[tauri::command]`, so the non-test build sees it as dead.
#![cfg_attr(not(test), allow(dead_code))]

use std::fmt::Write as _;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use crate::paths::VAULTS_DIR_NAME;

/// Top-level directory holding side-loaded model files + their device-local
/// marker files. A **sibling** of `paths::VAULTS_DIR_NAME`, never inside it.
pub const MODELS_DIR_NAME: &str = "models";

/// Marker file (under `models/`) recording the lowercase-hex SHA-256 of the
/// selected **transcription** (Whisper) model's file bytes — the model-identity
/// input the transcript `MYE1` cache binds so a model swap invalidates stale
/// transcripts (voice-to-text, MYND-550; SYNC-V3).
const TRANSCRIPTION_HASH_MARKER: &str = "transcription.hash";

/// Which model a stored path refers to. The generation model (Qwen2.5-1.5B,
/// task 3) and the transcription model are side-loaded
/// independently, so each has its own marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ModelRole {
    /// Text-completion model (`infer`).
    Generation,
    /// Speech-to-text model (`transcribe`) — Whisper, voice-to-text MYND-550
    /// (SYNC-V3). Side-loaded + swappable independently of the other roles.
    Transcription,
    /// Tag-suggestion model (auto-tag, MYND-651). Historically **bundled-only**
    /// (no marker file, no picker, no IPC role string). Since myne-md/myne#805
    /// (`decisions/ai/0627`) it is a selectable, user-storable role like the
    /// other two: a downloaded or side-loaded path (`tag.path`) takes
    /// precedence over the bundled default, and [`ModelRole::parse`] accepts
    /// `"tag"`. The fetch is verified against a SHA-256 compiled into the client
    /// binary before the model is registered; a Developer-mode side-load of a
    /// user-supplied file re-enters the same untrusted-input case the
    /// transcription override already carries.
    TagSuggestion,
}

impl ModelRole {
    /// Marker file name (under `models/`) recording this role's chosen path, or
    /// `None` for a bundled-only role that has no user-selectable path at all.
    fn marker_file_name(self) -> Option<&'static str> {
        match self {
            ModelRole::Generation => Some("generation.path"),
            ModelRole::Transcription => Some("transcription.path"),
            ModelRole::TagSuggestion => Some("tag.path"),
        }
    }

    /// Which hash-marker file (if any) records this role's model SHA-256.
    /// `Generation` has none (it does not key a persisted index); `Transcription`
    /// keys the transcript `MYE1` cache.
    /// `TagSuggestion` has none either — tag suggestions are RAM-only, so no
    /// persisted artefact keys on the model's identity (`decisions.md`
    /// 2026-07-31).
    fn hash_marker_file_name(self) -> Option<&'static str> {
        match self {
            ModelRole::Generation | ModelRole::TagSuggestion => None,
            ModelRole::Transcription => Some(TRANSCRIPTION_HASH_MARKER),
        }
    }

    /// Parse the IPC role string (`"generation"` /
    /// `"transcription"` / `"tag"`): the command layer's only re-entry point
    /// for a UI-supplied role. `"tag"` joined this set with myne-md/myne#805
    /// (`decisions/ai/0627`), when the auto-tag model became a downloaded,
    /// user-storable role rather than a bundled-only one.
    pub fn parse(s: &str) -> Option<ModelRole> {
        match s {
            "generation" => Some(ModelRole::Generation),
            "transcription" => Some(ModelRole::Transcription),
            "tag" => Some(ModelRole::TagSuggestion),
            _ => None,
        }
    }
}

/// Failure modes of the model-store path layer. DENY-list clean: no variant
/// carries a path or a raw OS error string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, thiserror::Error)]
pub enum ModelStoreError {
    /// The picked model path resolves inside the vault tree
    /// (`<app_data_dir>/vaults/…`). Rejected so model files never co-mingle
    /// with ciphertext.
    #[error("model path is inside the vault tree")]
    InsideVaultTree,
    /// The IPC role string was not `"generation"` /
    /// `"transcription"` / `"tag"` (a UI/codegen
    /// bug, not user-facing input), or the role names a model with no
    /// user-selectable path.
    #[error("unknown model role")]
    InvalidRole,
    /// A marker records a model path and **the file it names is not there**
    /// (myne-md/myne#466). Distinct from `Ok(None)` — "nothing was ever picked"
    /// and "what was picked is gone" want different next steps, and the second
    /// one used to reach the caller wearing the first one's clothes, or worse,
    /// as a generic load failure with nothing in it to act on.
    ///
    /// Carries no path: a backend-resolved filesystem path may neither be
    /// logged nor cross IPC (see: src-tauri/AGENTS.md "Secret-handling logging
    /// discipline").
    #[error("the recorded model file is missing")]
    RecordedModelMissing,
    /// An IO failure resolving/creating the models directory or reading/
    /// writing a marker, reduced to a closed, path-free kind.
    #[error("model store io failure")]
    Io { kind: IoFailureKind },
    /// A downloaded artifact's SHA-256 did not match the digest compiled into
    /// the client binary (myne-md/myne#805, `decisions/ai/0627`). The staged
    /// bytes are deleted and nothing is registered. The expected digest is never
    /// read from the origin that served the bytes, so a tampered or truncated
    /// download reaches this arm rather than becoming a model.
    #[error("downloaded model failed its digest check")]
    DigestMismatch,
}

impl ModelStoreError {
    /// Bounded, content-free tag for structured logging (DENY-list safe).
    pub fn kind(&self) -> &'static str {
        match self {
            ModelStoreError::InsideVaultTree => "inside_vault_tree",
            ModelStoreError::InvalidRole => "invalid_role",
            ModelStoreError::RecordedModelMissing => "recorded_model_missing",
            ModelStoreError::Io { .. } => "io",
            ModelStoreError::DigestMismatch => "digest_mismatch",
        }
    }
}

impl From<std::io::Error> for ModelStoreError {
    fn from(e: std::io::Error) -> Self {
        ModelStoreError::Io {
            kind: from_io_error_kind(e.kind()),
        }
    }
}

/// The models directory for a given `<app_data_dir>` base — pure path logic
/// (`base/models`), no IO. Tests pass a `ScopedTempDir` path here.
pub fn models_dir_from_base(base: &Path) -> PathBuf {
    base.join(MODELS_DIR_NAME)
}

/// Resolve + create the models directory under an already-resolved base.
pub fn ensure_models_dir(base: &Path) -> Result<PathBuf, ModelStoreError> {
    let dir = models_dir_from_base(base);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Resolve the models directory under the app's `app_data_dir`, creating it.
///
/// The runtime wrapper task 6's command calls; the tested core is
/// [`models_dir_from_base`] / [`ensure_models_dir`] (the runtime-free
/// `_from_base` seam the tests drive, so this wrapper has no unit test).
#[allow(dead_code)] // wired to the task-6 command; needs a Tauri runtime, not unit-tested
pub fn models_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, ModelStoreError> {
    let base = crate::paths::app_data_dir(app).map_err(|_| ModelStoreError::Io {
        kind: IoFailureKind::Other,
    })?;
    ensure_models_dir(&base)
}

/// Lexically fold `.`/`..` components so a `starts_with` containment test is
/// not defeated by `vaults/../vaults/x` or `./`. Does not touch the disk (the
/// candidate may not exist yet), so it is a pure syntactic normalization.
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether `candidate` resolves inside `<base>/vaults/` (any vault root).
/// Lexical containment — the guard is against accidental co-mingling, and the
/// dialog hands back absolute paths.
pub fn is_inside_vaults_tree(base: &Path, candidate: &Path) -> bool {
    let vaults = normalize_lexical(&base.join(VAULTS_DIR_NAME));
    normalize_lexical(candidate).starts_with(&vaults)
}

/// Accept `candidate` as a side-load target iff it is NOT inside the vault
/// tree; returns the lexically-normalized accepted path.
pub fn ensure_outside_vault_tree(
    base: &Path,
    candidate: &Path,
) -> Result<PathBuf, ModelStoreError> {
    if is_inside_vaults_tree(base, candidate) {
        return Err(ModelStoreError::InsideVaultTree);
    }
    Ok(normalize_lexical(candidate))
}

/// A cheap file-identity signal: `(len, mtime_nanos)`. Recorded next to the
/// pick-time hash so the unlock path can detect an IN-PLACE model replacement
/// (same path, new bytes) with a `stat` instead of a full re-hash, and re-hash
/// (invalidating the persisted index) only when the file actually changed. `0`
/// mtime when the platform has none — a benign miss that just forces a re-hash.
fn file_stat(path: &Path) -> Result<(u64, i128), ModelStoreError> {
    let meta = std::fs::metadata(path)?;
    // Reject non-regular files (FIFO / device / socket): hashing `/dev/zero` or a
    // pipe never terminates. Only a real, bounded file is a valid model.
    if !meta.is_file() {
        return Err(ModelStoreError::Io {
            kind: IoFailureKind::Other,
        });
    }
    let mtime_nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0);
    Ok((meta.len(), mtime_nanos))
}

/// Stream-hash a file with SHA-256, bounded memory regardless of file size — a
/// safetensors model can be hundreds of MiB. Rejects a non-regular
/// file first (a FIFO/device would never terminate). Called at model-pick time
/// (not on the unlock hot path) so a warm unlock never re-hashes.
fn compute_file_sha256(path: &Path) -> Result<[u8; 32], ModelStoreError> {
    // The loop lives in `crate::file_digest`, shared with the diagnostics
    // plugin's build digest (myne-md/myne#991): one implementation, one
    // non-regular-file guard, so a FIFO/device masquerading as a model file
    // cannot make either reader hang.
    Ok(crate::file_digest::sha256_of_file(path)?)
}

/// Marker line format: `hex_hash\nlen\nmtime_nanos`. Line 1 is the hash (read by
/// [`hash_from_marker_body`]); lines 2–3 are the cheap staleness stat.
fn hash_marker_body(hash: &[u8; 32], stat: (u64, i128)) -> String {
    format!("{}\n{}\n{}", hex_lower(hash), stat.0, stat.1)
}

/// Parse the recorded `(len, mtime_nanos)` from a hash marker body
/// (lines 2–3), or `None` if absent/malformed (a marker written before staleness
/// tracking → treat as unknown, forcing a re-hash).
fn parse_marker_stat(body: &str) -> Option<(u64, i128)> {
    let mut lines = body.lines().skip(1);
    let len = lines.next()?.trim().parse().ok()?;
    let mtime = lines.next()?.trim().parse().ok()?;
    Some((len, mtime))
}

/// Lowercase-hex encode (device-local marker content, not a secret).
fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Record a user-picked model path for `role`, device-locally under
/// `models/`, after rejecting any path inside the vault tree. Returns the
/// accepted (normalized) path. Does NOT copy the model file — the side-load
/// semantic records where the user's file already lives.
///
/// For [`ModelRole::Transcription`], this ALSO computes and records the file's
/// SHA-256 (`transcription.hash` marker) — the model-identity input the
/// transcript `MYE1` cache binds (SYNC-V3). Hashing runs BEFORE the
/// path marker is written, so a hash/IO failure records nothing (a swap either
/// fully lands or fully rolls back). This is where the (potentially seconds-
/// long) hash cost is paid, once, so the unlock path stays fast.
pub fn set_selected_model(
    base: &Path,
    role: ModelRole,
    model_path: &Path,
) -> Result<PathBuf, ModelStoreError> {
    // Every role is selectable since myne-md/myne#805 (TagSuggestion gained a
    // stored path). This guard is kept as a safety net for a future
    // bundled-only role: refuse BEFORE touching the filesystem so a rejected
    // pick records nothing anywhere.
    let Some(marker_name) = role.marker_file_name() else {
        return Err(ModelStoreError::InvalidRole);
    };
    let accepted = ensure_outside_vault_tree(base, model_path)?;
    // Refuse a pick whose file is not there, for EVERY role (myne-md/myne#466).
    // The hash-marker roles below already got this incidentally, through
    // `file_stat` inside the hashing block; `Generation` has no hash marker, so
    // nothing checked its pick and nothing checked its read either. Recording a
    // path that cannot be opened is never useful, whatever the role.
    //
    // One call, reused below. Adding a second beside the existing one gave
    // Transcription three `metadata()` syscalls per pick (here,
    // in the hash block, and again inside `compute_file_sha256`) where one
    // result serves all three.
    let stat = file_stat(&accepted)?;
    let dir = ensure_models_dir(base)?;
    // Roles with a hash marker (Transcription) record the file's
    // SHA-256 at pick-time — computed BEFORE the path marker so a hash/IO
    // failure records nothing (the swap fully lands or fully rolls back).
    if let Some(marker) = role.hash_marker_file_name() {
        let hash = compute_file_sha256(&accepted)?;
        std::fs::write(dir.join(marker), hash_marker_body(&hash, stat).as_bytes())?;
    }
    let marker = dir.join(marker_name);
    std::fs::write(&marker, accepted.to_string_lossy().as_bytes())?;
    Ok(accepted)
}

/// Remove the recorded model for `role`, deleting a **downloaded** bundle if the
/// recorded path lives under `<models>/` (myne-md/myne#805).
///
/// Only a file the app owns is deleted. A **side-loaded** path points at a file
/// the user chose elsewhere on disk; removing the marker must not delete their
/// file, so a path outside `models/` is only unregistered. This is the
/// "manage a model, remove it" half of the Settings surface: a downloaded model
/// is reclaimable, a side-loaded one is merely forgotten.
///
/// Idempotent: removing a role that has no recorded path is `Ok(())`, and so is
/// removing one whose bytes are already gone — a `NotFound` on the byte-deletion
/// arm is treated as success so the marker still gets dropped.
pub fn remove_selected_model(base: &Path, role: ModelRole) -> Result<(), ModelStoreError> {
    let Some(marker_name) = role.marker_file_name() else {
        return Ok(());
    };
    let dir = models_dir_from_base(base);
    // The recorded path, if any. Read before the marker is deleted.
    let recorded = selected_model(base, role)?;

    // Delete the model bytes only when they live under `models/`: the one
    // directory the app owns. A side-loaded path elsewhere is the user's file.
    // A `NotFound` is success: the marker must still be dropped.
    let delete_result = if let Some(path) = recorded {
        let owned_dir = ensure_models_dir(base)?;
        if is_under(&path, &owned_dir) {
            // A downloaded bundle records its PRIMARY FILE inside
            // `<models>/<dest_dir>/`, so removing the parent directory reclaims
            // the whole set (model + tokenizer/config siblings). A marker that
            // names a file directly under `models/` is a single-file install.
            match path.parent() {
                Some(parent) if parent != owned_dir.as_path() && is_under(parent, &owned_dir) => {
                    std::fs::remove_dir_all(parent).or_else(ignore_not_found)
                }
                _ => std::fs::remove_file(&path).or_else(ignore_not_found),
            }
        } else {
            Ok(())
        }
    } else {
        Ok(())
    };
    delete_result?;

    // Drop the role's markers (path marker, and the hash marker for the roles
    // that carry one) so a stale hash cannot outlive the model it described.
    for name in [Some(marker_name), role.hash_marker_file_name()]
        .into_iter()
        .flatten()
    {
        match std::fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// Treat a `NotFound` IO error as success, so an already-gone file does not
/// block the marker cleanup that follows (idempotent remove).
fn ignore_not_found(e: std::io::Error) -> Result<(), ModelStoreError> {
    if e.kind() == std::io::ErrorKind::NotFound {
        Ok(())
    } else {
        Err(e.into())
    }
}

/// Whether `candidate` is `dir` or lives inside it.
///
/// Symlinks are resolved on both sides when the path exists, so a symlinked
/// subdirectory under `models/` cannot make a lexical match delete a file
/// outside it. A path that does not exist yet (a marker naming a since-deleted
/// file) falls back to lexical normalization, where `models/../other` is still
/// not mistaken for a child of `models/`.
fn is_under(candidate: &Path, dir: &Path) -> bool {
    let resolved = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| normalize_lexical(p));
    resolved(candidate).starts_with(resolved(dir))
}

/// Read back the recorded model path for `role`, or `None` if none is set.
pub fn selected_model(base: &Path, role: ModelRole) -> Result<Option<PathBuf>, ModelStoreError> {
    let Some(marker_name) = role.marker_file_name() else {
        return Ok(None);
    };
    let marker = models_dir_from_base(base).join(marker_name);
    match std::fs::read_to_string(&marker) {
        Ok(s) => {
            let trimmed = s.trim();
            Ok(if trimmed.is_empty() {
                None
            } else {
                Some(PathBuf::from(trimmed))
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// [`selected_model`], but the recorded path is checked against the filesystem
/// before it is handed back (myne-md/myne#466).
///
/// `selected_model` answers "what is recorded", which is the right question for
/// the UI signal, the hash backfill and the transcription fallback. It is the
/// WRONG question for a loader, which is about to open the file: a marker
/// written months ago for a model since deleted comes back from it as
/// confidently as a live one, and the loader's `File::open` then fails with a
/// generic error naming nothing.
///
/// The **generation** role is the only one with this hole, which is why this
/// wrapper exists rather than a change to `selected_model` itself. Transcription
/// carries a hash marker, and
/// [`hash_marker_file_name`](ModelRole::hash_marker_file_name) returning `Some`
/// is exactly what routes it through [`file_stat`] at pick time and again on
/// every hash backfill. Generation returns `None` there, so nothing ever opened
/// its file except the loader.
///
/// **That reasoning is about PICK time, and the loaders are a separate
/// question.** `load_transcription` still calls plain
/// `selected_model`, so it is knowingly left on the unverified reader. The
/// consequence is worst for transcription: `Ok(Some(stale_path))` takes the
/// override arm, so a marker naming a deleted file permanently bypasses the
/// bundled-default fallback that lives only in the `Ok(None)` arm, and an
/// install shipping a working Whisper model reports a load failure forever.
/// Routing it through this wrapper is a behaviour change (transcription
/// would start falling back), which is its own decision rather than a rider on
/// this one.
pub fn selected_model_verified(
    base: &Path,
    role: ModelRole,
) -> Result<Option<PathBuf>, ModelStoreError> {
    let Some(path) = selected_model(base, role)? else {
        return Ok(None);
    };
    // `file_stat` rather than a second `is_file` check, because "what counts as
    // a loadable model file" must have ONE definition. A marker pointing at a
    // directory, a FIFO or a device is no more loadable than a marker pointing
    // at nothing, and `file_stat` is where that rule already lives and is
    // applied at pick time. Restating it here would mean a later tightening of
    // that rule (a symlink policy, a size floor) silently does not reach the
    // loader's reader, which is the drift this wrapper was added to close.
    //
    // The KIND is matched rather than collapsed, because the collapse sends the
    // user in a circle. `RecordedModelMissing` renders "the model is not on
    // this device any more, pick a model again"; on a `PermissionDenied` (a
    // `.gguf` under a macOS TCC-protected directory, a remounted volume, a
    // chmod'd file) the file IS there and re-picking the same path fails again
    // at the pick-time `file_stat`, with a different error. Only "not there"
    // and "not a regular file" mean what that sentence says.
    match file_stat(&path) {
        Ok(_) => Ok(Some(path)),
        Err(ModelStoreError::Io {
            kind: IoFailureKind::NotFound,
        })
        | Err(ModelStoreError::Io {
            kind: IoFailureKind::Other,
        }) => Err(ModelStoreError::RecordedModelMissing),
        Err(other) => Err(other),
    }
}

/// Path components (under the Tauri `resource_dir`) of the **bundled default**
/// transcription model shipped with the desktop app (voice-to-text, MYND-270):
/// `<resource_dir>/models/whisper/model.gguf`, with sibling `config.json` +
/// `tokenizer.json` (the `load_transcription` layout). Desktop-only — mobile
/// stays side-load. A quantized `whisper-base` GGUF (Apache-2.0; `LICENSING.md`).
pub const BUNDLED_TRANSCRIPTION_SUBPATH: [&str; 3] = ["models", "whisper", "model.gguf"];

/// Path components (under the Tauri `resource_dir`) of the **bundled** auto-tag
/// task-model (MYND-651) `<resource_dir>/models/tag/model.gguf`, with a sibling
/// `tokenizer.json` (the `load_tag` layout). A quantized Qwen2.5-0.5B-Instruct
/// GGUF (Apache-2.0; `LICENSING.md`): the same Qwen2 architecture family the
/// generation role loads, which is why it needs no new runtime. Desktop-only.
/// Since myne-md/myne#805 (`decisions/ai/0627`) the desktop installer no longer
/// ships this file; it remains here as the **fallback resolver** for a build
/// that does carry one, and `effective_tag_model` prefers a downloaded or
/// side-loaded path (`tag.path`) over it.
pub const BUNDLED_TAG_MODEL_SUBPATH: [&str; 3] = ["models", "tag", "model.gguf"];

/// The bundled default transcription model path IFF it is actually present on
/// disk. Returns `None` when no model ships (an `--no-default-features` AI-free
/// build, or a checkout whose LFS model blob was not fetched) so resolution
/// degrades cleanly to side-load-only — never a phantom path that fails to load.
pub fn bundled_transcription_model(resource_dir: &Path) -> Option<PathBuf> {
    bundled_model(resource_dir, BUNDLED_TRANSCRIPTION_SUBPATH)
}

/// The bundled auto-tag model path IFF it is actually present on disk (MYND-651).
/// `None` on an `--no-default-features` AI-free build or a checkout whose LFS
/// blob was not fetched. Since myne-md/myne#805 this is only the *fallback*
/// input to [`effective_tag_model`]; a `None` here plus no stored `tag.path`
/// means "no auto-tag on this device", and the engine answers `NotReady` so the
/// feature stays absent rather than half-working.
pub fn bundled_tag_model(resource_dir: &Path) -> Option<PathBuf> {
    bundled_model(resource_dir, BUNDLED_TAG_MODEL_SUBPATH)
}

/// Resolve one bundled model subpath under `resource_dir`, `None` unless the
/// file is really there. Shared by the transcription + tag resolvers so
/// "present-or-nothing" cannot drift between them.
fn bundled_model(resource_dir: &Path, subpath: [&str; 3]) -> Option<PathBuf> {
    let mut p = resource_dir.to_path_buf();
    for c in subpath {
        p.push(c);
    }
    p.is_file().then_some(p)
}

/// The transcription model actually used: the user's picker **override**
/// (`transcription.path`) if set, else the **bundled** default (MYND-270).
/// `bundled` is `None` on a build with no bundled model, so the result is then
/// override-only (the pre-MYND-270 behaviour). One source of truth shared by the
/// engine loader, the `get_model_path` UI signal, and the model-hash resolver.
pub fn effective_transcription_model(
    base: &Path,
    bundled: Option<&Path>,
) -> Result<Option<PathBuf>, ModelStoreError> {
    if let Some(p) = selected_model(base, ModelRole::Transcription)? {
        return Ok(Some(p));
    }
    Ok(bundled.map(|p| p.to_path_buf()))
}

/// The auto-tag model actually used: the downloaded or side-loaded **override**
/// (`tag.path`) if set, else the **bundled** default (myne-md/myne#805,
/// `decisions/ai/0627`). One source of truth shared by the engine loader and the
/// capability report, so a downloaded model and a side-loaded one converge on
/// one resolution exactly as transcription's override does. `bundled` is `None`
/// on a build with no bundled model, making the result override-only.
pub fn effective_tag_model(
    base: &Path,
    bundled: Option<&Path>,
) -> Result<Option<PathBuf>, ModelStoreError> {
    if let Some(p) = selected_model(base, ModelRole::TagSuggestion)? {
        return Ok(Some(p));
    }
    Ok(bundled.map(|p| p.to_path_buf()))
}

/// One file inside a downloadable artefact, with the SHA-256 compiled into the
/// client binary (myne-md/myne#805, `decisions/ai/0627`). `sha256_hex` is
/// lowercase hex; it is decoded at install time rather than written as a byte
/// array literal so the table stays greppable and typo-resistant.
pub struct ArtifactFile {
    /// Bare file name, exactly as the origin's hashed path spells it.
    pub name: &'static str,
    /// Lowercase-hex SHA-256, never read from the serving origin.
    pub sha256_hex: &'static str,
}

/// Decode a 64-char lowercase-hex SHA-256 into 32 bytes, or `None`.
fn hex_to_32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Install a downloaded **multi-file** artefact for `role` (myne-md/myne#805).
///
/// A model is rarely one file: the tag loader reads a sibling `tokenizer.json`
/// (`engine_candle.rs`), so all of a bundle's files must land together in one
/// directory for
/// the loader's bare `models/<dir>/<file>` layout to resolve.
///
/// `staged_dir` holds the fetched files, downloaded outside the final location.
/// Every file is hashed and compared against its compiled-in digest **before**
/// anything is registered: on any mismatch the whole staging directory is
/// deleted and [`ModelStoreError::DigestMismatch`] is returned, so a tampered or
/// truncated download can never become a model. On success the staging directory
/// is renamed (same filesystem, atomic) to `<models>/<dest_dir_name>` and the
/// role's path marker records the primary file.
///
/// `dest_dir_name` and the file names are validated as bare names, so an
/// artefact table cannot be made to write outside `models/`.
pub fn install_downloaded_bundle(
    base: &Path,
    role: ModelRole,
    staged_dir: &Path,
    dest_dir_name: &str,
    files: &[ArtifactFile],
) -> Result<PathBuf, ModelStoreError> {
    if role.marker_file_name().is_none() {
        return Err(ModelStoreError::InvalidRole);
    }
    // The primary file is the table's first entry; its path is what the marker
    // records. Validate names before any IO.
    let Some(primary) = files.first() else {
        return Err(ModelStoreError::InvalidRole);
    };
    if !is_bare_name(dest_dir_name) || files.iter().any(|f| !is_bare_name(f.name)) {
        return Err(ModelStoreError::InvalidRole);
    }

    // Verify every file BEFORE registering anything.
    for file in files {
        let Some(expected) = hex_to_32(file.sha256_hex) else {
            // A malformed compiled-in digest is a code defect, not user input.
            let _ = std::fs::remove_dir_all(staged_dir);
            return Err(ModelStoreError::InvalidRole);
        };
        let staged = staged_dir.join(file.name);
        let actual = compute_file_sha256(&staged)?;
        if actual != expected {
            let _ = std::fs::remove_dir_all(staged_dir);
            return Err(ModelStoreError::DigestMismatch);
        }
    }

    let dir = ensure_models_dir(base)?;
    let dest = dir.join(dest_dir_name);
    let backup_prefix = format!("{dest_dir_name}.old-");
    // Recover from a crash during a PREVIOUS install: if `dest` is absent but an
    // `.old-*` copy of it survives, the crash landed between the two renames and
    // the old copy is the only one. Promote it back before proceeding. Also clear
    // any other orphaned `.old-*` copies (they are superseded now).
    if !dest.exists() {
        if let Some(orphan) = find_old_backup(&dir, &backup_prefix) {
            let _ = std::fs::rename(&orphan, &dest);
        }
    }
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&backup_prefix) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    // Replace in place with as small a no-model window as possible. The old
    // copy is moved aside with a same-filesystem rename (O(1)) BEFORE the
    // verified staging directory is renamed in, rather than deleted first: a
    // crash between the two renames leaves the previous copy under a temp name
    // instead of leaving the role with nothing, and the slow part (deleting a
    // multi-hundred-MB dir) happens after the new model is already visible.
    let mut backup: Option<PathBuf> = None;
    if dest.exists() {
        let tmp = dir.join(format!("{dest_dir_name}.old-{}", std::process::id()));
        // Clear a leftover from an earlier crashed install before reusing the name.
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::rename(&dest, &tmp)?;
        backup = Some(tmp);
    }
    if let Err(e) = std::fs::rename(staged_dir, &dest) {
        // Put the previous copy back so a failed rename does not lose it.
        if let Some(b) = &backup {
            let _ = std::fs::rename(b, &dest);
        }
        return Err(e.into());
    }
    if let Some(b) = backup {
        let _ = std::fs::remove_dir_all(&b);
    }
    set_selected_model(base, role, &dest.join(primary.name))
}

/// Whether `name` is a bare file/directory name (no separators, not `.`/`..`).
fn is_bare_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\\')
}

/// The first orphaned `<prefix>*` directory under `dir`, if any (used to recover
/// a copy moved aside by a crashed install).
fn find_old_backup(dir: &Path, prefix: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(prefix) {
            return Some(entry.path());
        }
    }
    None
}

/// The transcription (Whisper) model hash for the **effective** model — the
/// picker override if set, else the `bundled` default (voice-to-text, MYND-270)
/// — backfilled once if the marker is missing.
/// A transcript produced by the bundled model gets that model's identity hash
/// bound into its `MYE1` cache (and swapping to an override correctly re-hashes →
/// invalidates stale transcripts). `None` when neither an override nor a bundled
/// model is present.
pub fn ensure_transcription_model_hash_with_bundled(
    base: &Path,
    bundled: Option<&Path>,
) -> Result<Option<[u8; 32]>, ModelStoreError> {
    let Some(marker_name) = ModelRole::Transcription.hash_marker_file_name() else {
        return Ok(None);
    };
    let Some(path) = effective_transcription_model(base, bundled)? else {
        return Ok(None);
    };
    hash_model_at_path(base, marker_name, &path).map(Some)
}

/// Compute (or reuse the cached) SHA-256 of the model file at `path`, keyed by
/// the `<models>/<marker_name>` marker's `(hash, len, mtime)`. The bundled-default
/// transcription model
/// ([`effective_transcription_model`]) hashes through the SAME cache path as a
/// picked model. The hash cost is paid at most once per actual file change.
fn hash_model_at_path(
    base: &Path,
    marker_name: &str,
    path: &Path,
) -> Result<[u8; 32], ModelStoreError> {
    let marker_path = models_dir_from_base(base).join(marker_name);
    let marker = std::fs::read_to_string(&marker_path).ok();
    let cached_hash = marker.as_deref().and_then(hash_from_marker_body);
    let recorded_stat = marker.as_deref().and_then(parse_marker_stat);

    // Fast path: a cached hash whose recorded `(len, mtime)` still matches the
    // file on disk — no re-hash. Detects an IN-PLACE model replacement (same
    // path, new bytes) with a cheap `stat` and re-hashes only then, so the swap
    // correctly invalidates the persisted artefact instead of poisoning it with
    // a stale hash (SYNC-V3 for transcripts).
    let current_stat = file_stat(path)?;
    if let (Some(hash), Some(stat)) = (cached_hash, recorded_stat) {
        if stat == current_stat {
            return Ok(hash);
        }
    }

    // No hash, no recorded stat, or the file changed → (re)hash and rewrite the
    // marker (hash + fresh stat). Cost paid at most once per actual change.
    let hash = compute_file_sha256(path)?;
    let stat = file_stat(path)?;
    let dir = ensure_models_dir(base)?;
    std::fs::write(
        dir.join(marker_name),
        hash_marker_body(&hash, stat).as_bytes(),
    )?;
    Ok(hash)
}

/// Parse the hex hash (line 1) from a marker body into 32 bytes, or `None`.
fn hash_from_marker_body(body: &str) -> Option<[u8; 32]> {
    let hex = body.lines().next().unwrap_or("").trim();
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Runtime wrapper: resolve the app's `app_data_dir` base and return the
/// transcription (Whisper) model hash (backfilling once if needed). Best-effort
/// — `None` on any failure. The transcript-storage-search sibling reads this to
/// bind the transcript `MYE1` cache's model-identity (SYNC-V3).
pub fn transcription_model_hash_for<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<[u8; 32]> {
    use tauri::Manager;
    let base = crate::paths::app_data_dir(app).ok()?;
    // Hash the EFFECTIVE model (override else bundled default, MYND-270) so a
    // bundled-model transcript binds that model's identity into its MYE1 cache.
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|rd| bundled_transcription_model(&rd));
    ensure_transcription_model_hash_with_bundled(&base, bundled.as_deref())
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    #[test]
    fn models_dir_is_a_sibling_of_vaults_not_inside_it() {
        let base = Path::new("/data/md.myne.desktop");
        let models = models_dir_from_base(base);
        assert_eq!(models, base.join("models"));
        // The models dir must NOT be inside the vault tree.
        assert!(!is_inside_vaults_tree(base, &models));
    }

    #[test]
    fn rejects_a_path_inside_the_vault_tree() {
        let base = Path::new("/data/md.myne.desktop");
        let inside = base.join("vaults").join("018f-uuid").join("qwen.gguf");
        assert!(is_inside_vaults_tree(base, &inside));
        assert_eq!(
            ensure_outside_vault_tree(base, &inside),
            Err(ModelStoreError::InsideVaultTree)
        );
    }

    #[test]
    fn rejects_a_dotdot_escape_back_into_the_vault_tree() {
        let base = Path::new("/data/md.myne.desktop");
        // models/../vaults/x/model.gguf lexically resolves into the vault tree.
        let sneaky = base.join("models/../vaults/018f/model.gguf");
        assert!(is_inside_vaults_tree(base, &sneaky));
        assert!(ensure_outside_vault_tree(base, &sneaky).is_err());
    }

    #[test]
    fn accepts_a_path_outside_the_vault_tree() {
        let base = Path::new("/data/md.myne.desktop");
        let downloads = Path::new("/home/user/Downloads/qwen2.5-1.5b-q4.gguf");
        let accepted = ensure_outside_vault_tree(base, downloads).expect("outside is accepted");
        assert_eq!(accepted, downloads);
        // A file in the models dir itself is fine (sibling of vaults).
        let in_models = models_dir_from_base(base).join("minilm.gguf");
        assert!(ensure_outside_vault_tree(base, &in_models).is_ok());
    }

    /// A real, bounded file to point a marker at. Since myne-md/myne#466 a pick
    /// is refused unless its target exists, so a test that wants a successful
    /// pick has to put something on disk — an invented path is now exactly the
    /// case the guard rejects.
    fn a_model_file(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::create_dir_all(dir).expect("model dir");
        std::fs::write(&p, b"gguf-ish bytes").expect("model file");
        p
    }

    #[test]
    fn set_and_get_selected_model_round_trips_device_locally() {
        let tmp = ScopedTempDir::new("local-inf-model-store").expect("scoped tempdir");
        let base = tmp.path();
        let model = a_model_file(&base.join("elsewhere"), "qwen2.5-1.5b-q4.gguf");
        let model = model.as_path();

        assert_eq!(selected_model(base, ModelRole::Generation).unwrap(), None);

        let accepted = set_selected_model(base, ModelRole::Generation, model).expect("set ok");
        assert_eq!(accepted, model);
        assert_eq!(
            selected_model(base, ModelRole::Generation).unwrap(),
            Some(model.to_path_buf())
        );
        // Roles are independent — setting generation does not set transcription.
        assert_eq!(
            selected_model(base, ModelRole::Transcription).unwrap(),
            None
        );

        // The marker lives under models/, outside the vault tree.
        let marker = models_dir_from_base(base).join("generation.path");
        assert!(marker.exists());
        assert!(!is_inside_vaults_tree(base, &marker));
    }

    /// The half of myne-md/myne#466 that reads. A marker recorded months ago for
    /// a model since deleted came back from `selected_model` as confidently as a
    /// live one, and the loader's `File::open` then failed with an error that
    /// named nothing — which the frontend's catch-all rendered as a *provider*
    /// failure, on a request that never left the device.
    #[test]
    fn a_marker_pointing_at_a_deleted_file_is_not_a_selected_model() {
        let tmp = ScopedTempDir::new("local-inf-stale-marker").expect("scoped tempdir");
        let base = tmp.path();
        let model = a_model_file(&base.join("elsewhere"), "gone.gguf");

        set_selected_model(base, ModelRole::Generation, &model).expect("set ok");
        // Live: both readers agree.
        assert_eq!(
            selected_model_verified(base, ModelRole::Generation).unwrap(),
            Some(model.clone())
        );

        std::fs::remove_file(&model).expect("delete the model out from under the marker");

        // `selected_model` still answers "what is recorded" — that contract is
        // unchanged, and the UI signal and hash backfill depend on it.
        assert_eq!(
            selected_model(base, ModelRole::Generation).unwrap(),
            Some(model.clone())
        );
        // The loader's reader is the one that must not be fooled, and it must
        // NOT answer `Ok(None)` either: "nothing was ever picked" and "what was
        // picked is gone" want different sentences.
        assert_eq!(
            selected_model_verified(base, ModelRole::Generation).err(),
            Some(ModelStoreError::RecordedModelMissing)
        );

        // A directory where a model should be is no more loadable than nothing.
        std::fs::create_dir_all(&model).expect("directory in the model's place");
        assert_eq!(
            selected_model_verified(base, ModelRole::Generation).err(),
            Some(ModelStoreError::RecordedModelMissing)
        );
    }

    /// The kind is matched, not collapsed, and the difference is what the user
    /// is told to do next.
    ///
    /// `RecordedModelMissing` renders "the model is not on this device any
    /// more, pick a model again". On an unreadable-but-present file that advice
    /// cannot work: re-picking the same path hits the pick-time `file_stat` and
    /// fails again with a different error, so the user is sent in a circle. Only
    /// "not there" and "not a regular file" mean what that sentence says.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_model_is_an_io_failure_and_not_a_missing_one() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = ScopedTempDir::new("local-inf-unreadable").expect("scoped tempdir");
        let base = tmp.path();
        let dir = base.join("elsewhere");
        let model = a_model_file(&dir, "locked.gguf");
        set_selected_model(base, ModelRole::Generation, &model).expect("set ok");

        // The DIRECTORY loses traversal, not the file: `metadata()` on the file
        // then fails with PermissionDenied while the file itself is untouched
        // and still there, which is exactly the state the wrong mapping
        // described as "gone".
        let original = std::fs::metadata(&dir).expect("dir meta").permissions();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).expect("chmod");

        let got = selected_model_verified(base, ModelRole::Generation).err();

        // Restore before asserting, so a failure does not leave an unreadable
        // directory behind for the tempdir cleanup to trip over.
        std::fs::set_permissions(&dir, original).expect("restore");

        match got {
            // The honest outcome: an IO failure carrying its own kind.
            Some(ModelStoreError::Io { .. }) => {}
            // Running as root (the CI container does) makes the chmod
            // ineffective and the read succeeds. Skipping is right: the
            // assertion below is the one that must never hold, and a root run
            // cannot produce it either.
            None => {}
            other => panic!("an unreadable model must not read as missing, got {other:?}"),
        }
    }

    /// The half of myne-md/myne#466 that writes. Transcription got
    /// an existence check incidentally, through the `file_stat` inside its
    /// hashing block; `Generation` has no hash marker, so nothing checked its
    /// pick — a path could be recorded that was never openable in the first
    /// place.
    #[test]
    fn picking_a_generation_model_refuses_a_path_that_is_not_there() {
        let tmp = ScopedTempDir::new("local-inf-pick-missing").expect("scoped tempdir");
        let base = tmp.path();
        let absent = base.join("elsewhere").join("never-existed.gguf");

        assert!(set_selected_model(base, ModelRole::Generation, &absent).is_err());
        // And it recorded NOTHING — a refused pick must not leave a marker
        // behind for the loader to trip over later.
        assert_eq!(selected_model(base, ModelRole::Generation).unwrap(), None);
    }

    #[test]
    fn set_selected_model_rejects_a_vault_path() {
        let tmp = ScopedTempDir::new("local-inf-model-store-reject").expect("scoped tempdir");
        let base = tmp.path();
        let vault_path = base.join("vaults").join("018f").join("evil.gguf");
        assert_eq!(
            set_selected_model(base, ModelRole::Generation, &vault_path),
            Err(ModelStoreError::InsideVaultTree)
        );
        // Nothing was recorded.
        assert_eq!(selected_model(base, ModelRole::Generation).unwrap(), None);
    }

    #[test]
    fn tag_role_is_selectable_and_stores_its_path() {
        // myne-md/myne#805 (`decisions/ai/0627`): auto-tag's model is no longer
        // bundled-only. It is a selectable, user-storable role, so a downloaded
        // or side-loaded path can be recorded and read back, and the model
        // resolves through `effective_tag_model` with the bundled default as the
        // fallback.
        let tmp = ScopedTempDir::new("local-inf-tag-selectable").expect("scoped tempdir");
        let base = tmp.path();

        // 1. An IPC re-entry point exists.
        assert_eq!(ModelRole::parse("tag"), Some(ModelRole::TagSuggestion));
        assert_eq!(ModelRole::parse("tag-suggestion"), None);

        // 2. A pick is accepted and recorded.
        let dl = base.join("downloads");
        std::fs::create_dir_all(&dl).unwrap();
        let model = dl.join("qwen-tag.gguf");
        std::fs::write(&model, b"not really a model").unwrap();
        let stored =
            set_selected_model(base, ModelRole::TagSuggestion, &model).expect("tag is selectable");

        // 3. It reads back, and `effective_tag_model` prefers it over the
        //    bundled default.
        assert_eq!(
            selected_model(base, ModelRole::TagSuggestion).unwrap(),
            Some(stored.clone())
        );
        let bundled = base.join("resource-tag.gguf");
        assert_eq!(
            effective_tag_model(base, Some(&bundled)).unwrap(),
            Some(stored)
        );

        // 4. With no stored pick, the bundled default is used, and `None` when
        //    neither is present.
        let tmp2 = ScopedTempDir::new("local-inf-tag-fallback").expect("scoped tempdir");
        assert_eq!(
            effective_tag_model(tmp2.path(), Some(&bundled)).unwrap(),
            Some(bundled.clone())
        );
        assert_eq!(effective_tag_model(tmp2.path(), None).unwrap(), None);
    }

    #[test]
    fn install_downloaded_bundle_refuses_a_path_traversal_name() {
        // The bundle installer validates `dest_dir_name` and every file name as
        // bare names before any IO, so the compiled-in artefact table cannot be
        // made to write outside `models/`. (The single-file installer that used
        // to carry this test had no production caller and was removed.)
        let tmp = ScopedTempDir::new("local-inf-bundle-name").expect("scoped tempdir");
        let base = tmp.path();
        let staging = base.join("staged").join("tag");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("model.gguf"), b"x").unwrap();

        let files = [ArtifactFile {
            name: "model.gguf",
            sha256_hex: "",
        }];

        assert_eq!(
            install_downloaded_bundle(
                base,
                ModelRole::TagSuggestion,
                &staging,
                "../escape",
                &files
            ),
            Err(ModelStoreError::InvalidRole)
        );
        assert_eq!(
            install_downloaded_bundle(
                base,
                ModelRole::TagSuggestion,
                &staging,
                "tag",
                &[ArtifactFile {
                    name: "../escape.gguf",
                    sha256_hex: ""
                }]
            ),
            Err(ModelStoreError::InvalidRole)
        );
    }

    #[test]
    fn bundled_tag_model_resolves_only_when_the_blob_is_present() {
        let tmp = ScopedTempDir::new("local-inf-tag-bundled").expect("scoped tempdir");
        let rd = tmp.path();

        // Nothing bundled (AI-free build / unfetched LFS blob) → no phantom path.
        assert_eq!(bundled_tag_model(rd), None);

        // The whisper blob alone must NOT satisfy the tag resolver: a copy-paste
        // of the transcription subpath would silently load Whisper weights into
        // the tag role, which loads-or-fails far away from the mistake.
        let whisper = rd.join("models").join("whisper");
        std::fs::create_dir_all(&whisper).unwrap();
        std::fs::write(whisper.join("model.gguf"), b"whisper-bytes").unwrap();
        assert_eq!(bundled_tag_model(rd), None);
        assert!(bundled_transcription_model(rd).is_some());

        // Present → the documented `models/tag/model.gguf` path, and the two
        // resolvers stay distinct.
        let tag = rd.join("models").join("tag");
        std::fs::create_dir_all(&tag).unwrap();
        let blob = tag.join("model.gguf");
        std::fs::write(&blob, b"tag-bytes").unwrap();
        assert_eq!(bundled_tag_model(rd), Some(blob));
        assert_ne!(bundled_tag_model(rd), bundled_transcription_model(rd));

        // A directory at the blob's path is not a model.
        let tmp2 = ScopedTempDir::new("local-inf-tag-bundled-dir").expect("scoped tempdir");
        std::fs::create_dir_all(tmp2.path().join("models").join("tag").join("model.gguf")).unwrap();
        assert_eq!(bundled_tag_model(tmp2.path()), None);
    }

    #[test]
    fn transcription_model_hash_computed_and_stored_at_pick_time() {
        use sha2::{Digest, Sha256};
        let tmp = ScopedTempDir::new("local-inf-stt-hash").expect("scoped tempdir");
        let base = tmp.path();
        let dl = base.join("downloads");
        std::fs::create_dir_all(&dl).unwrap();
        let model = dl.join("whisper.bin");
        std::fs::write(&model, b"fake-whisper-bytes-v1").unwrap();

        // No hash before selection.
        assert_eq!(
            ensure_transcription_model_hash_with_bundled(base, None).unwrap(),
            None
        );

        set_selected_model(base, ModelRole::Transcription, &model).expect("set transcription");

        let expected: [u8; 32] = Sha256::digest(b"fake-whisper-bytes-v1").into();
        assert_eq!(
            ensure_transcription_model_hash_with_bundled(base, None).unwrap(),
            Some(expected)
        );
    }

    #[test]
    fn swapping_transcription_model_updates_the_stored_hash() {
        use sha2::{Digest, Sha256};
        let tmp = ScopedTempDir::new("local-inf-stt-swap").expect("scoped tempdir");
        let base = tmp.path();
        let dl = base.join("downloads");
        std::fs::create_dir_all(&dl).unwrap();
        let a = dl.join("whisper-a.bin");
        let b = dl.join("whisper-b.bin");
        std::fs::write(&a, b"model-A").unwrap();
        std::fs::write(&b, b"model-B-different-content").unwrap();

        set_selected_model(base, ModelRole::Transcription, &a).unwrap();
        let ha = ensure_transcription_model_hash_with_bundled(base, None)
            .unwrap()
            .unwrap();
        set_selected_model(base, ModelRole::Transcription, &b).unwrap();
        let hb = ensure_transcription_model_hash_with_bundled(base, None)
            .unwrap()
            .unwrap();

        assert_ne!(ha, hb);
        let expected_b: [u8; 32] = Sha256::digest(b"model-B-different-content").into();
        assert_eq!(hb, expected_b);
    }

    #[test]
    fn in_place_model_replacement_reforces_a_rehash() {
        use sha2::{Digest, Sha256};
        let tmp = ScopedTempDir::new("local-inf-stt-inplace").expect("scoped tempdir");
        let base = tmp.path();
        let dl = base.join("downloads");
        std::fs::create_dir_all(&dl).unwrap();
        let model = dl.join("whisper.bin");
        std::fs::write(&model, b"weights-v1").unwrap();
        set_selected_model(base, ModelRole::Transcription, &model).expect("set transcription");
        let h1 = ensure_transcription_model_hash_with_bundled(base, None)
            .unwrap()
            .unwrap();
        let expected_v1: [u8; 32] = Sha256::digest(b"weights-v1").into();
        assert_eq!(h1, expected_v1);

        // Replace the file IN PLACE (same path, different, longer bytes → the
        // len changes even if mtime resolution is coarse).
        std::fs::write(&model, b"weights-v2-different-and-longer").unwrap();
        let h2 = ensure_transcription_model_hash_with_bundled(base, None)
            .unwrap()
            .unwrap();
        let expected_v2: [u8; 32] = Sha256::digest(b"weights-v2-different-and-longer").into();
        assert_eq!(
            h2, expected_v2,
            "an in-place replacement must re-hash, not serve the stale pick-time hash"
        );
        assert_ne!(h1, h2);
    }

    #[test]
    fn a_role_with_no_hash_marker_records_none() {
        let tmp = ScopedTempDir::new("local-inf-gen-nohash").expect("scoped tempdir");
        let base = tmp.path();
        let dl = base.join("downloads");
        std::fs::create_dir_all(&dl).unwrap();
        let gen = dl.join("qwen.gguf");
        std::fs::write(&gen, b"gguf-bytes").unwrap();

        set_selected_model(base, ModelRole::Generation, &gen).unwrap();
        // Generation keys no persisted artefact → no hash marker is written, so
        // the transcription resolver stays `None` with no transcription model.
        assert!(!models_dir_from_base(base)
            .join(TRANSCRIPTION_HASH_MARKER)
            .exists());
        assert_eq!(
            ensure_transcription_model_hash_with_bundled(base, None).unwrap(),
            None
        );
    }

    /// Leak a computed digest into a `&'static str` for an `ArtifactFile` in a
    /// test. The production table carries literals; this lets a test build the
    /// table's shape from real bytes without hand-computing a digest.
    fn leak(s: String) -> &'static str {
        Box::leak(s.into_boxed_str())
    }

    #[test]
    fn install_downloaded_bundle_verifies_every_file_then_registers_the_primary() {
        use sha2::{Digest, Sha256};
        let tmp = ScopedTempDir::new("local-inf-bundle-ok").expect("scoped tempdir");
        let base = tmp.path();
        let staging = base.join("staged").join("tag");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("model.gguf"), b"weights").unwrap();
        std::fs::write(staging.join("tokenizer.json"), b"tokenizer").unwrap();

        let files = [
            ArtifactFile {
                name: "model.gguf",
                sha256_hex: leak(format!("{:x}", Sha256::digest(b"weights"))),
            },
            ArtifactFile {
                name: "tokenizer.json",
                sha256_hex: leak(format!("{:x}", Sha256::digest(b"tokenizer"))),
            },
        ];

        let installed =
            install_downloaded_bundle(base, ModelRole::TagSuggestion, &staging, "tag-test", &files)
                .expect("a matching bundle installs");

        assert!(installed.ends_with("model.gguf"));
        assert!(installed.is_file());
        // Every sibling landed together, so the loader's bare-name layout resolves.
        assert!(installed.parent().unwrap().join("tokenizer.json").is_file());
        assert!(
            !staging.exists(),
            "the staging dir is consumed by the rename"
        );
        assert_eq!(
            selected_model(base, ModelRole::TagSuggestion).unwrap(),
            Some(installed)
        );
    }

    #[test]
    fn install_downloaded_bundle_rejects_a_mismatch_and_removes_staging() {
        use sha2::{Digest, Sha256};
        let tmp = ScopedTempDir::new("local-inf-bundle-bad").expect("scoped tempdir");
        let base = tmp.path();
        let staging = base.join("staged").join("tag");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("model.gguf"), b"tampered").unwrap();
        std::fs::write(staging.join("tokenizer.json"), b"tokenizer").unwrap();

        let files = [
            ArtifactFile {
                name: "model.gguf",
                sha256_hex: leak(format!("{:x}", Sha256::digest(b"original"))),
            },
            ArtifactFile {
                name: "tokenizer.json",
                sha256_hex: leak(format!("{:x}", Sha256::digest(b"tokenizer"))),
            },
        ];

        assert_eq!(
            install_downloaded_bundle(base, ModelRole::TagSuggestion, &staging, "tag-test", &files),
            Err(ModelStoreError::DigestMismatch)
        );
        assert!(
            !staging.exists(),
            "a failed digest check removes the staging dir"
        );
        assert!(!models_dir_from_base(base).join("tag-test").exists());
        assert_eq!(
            selected_model(base, ModelRole::TagSuggestion).unwrap(),
            None
        );
    }

    /// Removing a DOWNLOADED model deletes the app-owned bytes and drops the
    /// markers. Removing a SIDE-LOADED one forgets it but leaves the user's file
    /// untouched: those are the two behaviours the Settings "remove" button
    /// rests on (myne-md/myne#805 task 7).
    #[test]
    fn remove_deletes_an_owned_download_but_only_forgets_a_side_load() {
        let tmp = ScopedTempDir::new("local-inf-remove").expect("scoped tempdir");
        let base = tmp.path();

        // A downloaded bundle installed into models/ under the app's control.
        let dl = base.join("downloads");
        std::fs::create_dir_all(&dl).unwrap();
        let owned_dir = models_dir_from_base(base).join("transcription-abc");
        std::fs::create_dir_all(&owned_dir).unwrap();
        let owned = owned_dir.join("model.bin");
        std::fs::write(&owned, b"weights").unwrap();
        set_selected_model(base, ModelRole::Transcription, &owned).expect("record owned");

        remove_selected_model(base, ModelRole::Transcription).expect("remove owned");
        assert!(!owned.exists(), "the app-owned model file is deleted");
        assert!(
            selected_model(base, ModelRole::Transcription)
                .unwrap()
                .is_none(),
            "the marker is dropped"
        );

        // A side-loaded file OUTSIDE models/: the user's own file.
        let user_file = dl.join("my-model.gguf");
        std::fs::write(&user_file, b"user weights").unwrap();
        set_selected_model(base, ModelRole::Generation, &user_file).expect("record side-load");
        remove_selected_model(base, ModelRole::Generation).expect("remove side-load");
        assert!(
            user_file.exists(),
            "a side-loaded file the user chose is never deleted"
        );
        assert!(selected_model(base, ModelRole::Generation)
            .unwrap()
            .is_none());

        // Idempotent: removing a role with nothing recorded is fine.
        remove_selected_model(base, ModelRole::Transcription).expect("idempotent");
    }
}
