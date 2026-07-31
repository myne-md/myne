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
//! Logging: DENY-list clean (`src-tauri/CLAUDE.md`) — [`ModelStoreError`]
//! reduces every IO failure to the closed [`IoFailureKind`] (no raw
//! `io::Error` `Display`, which can leak OS paths) and carries no path in any
//! variant. The recorded model path is device-local config, not a secret.

// Every item is task-2 path/validation logic consumed by task-6 commands +
// the tests below; nothing is reachable from a live root (init/lib.rs) until
// task 6 wires the `#[tauri::command]`, so the non-test build sees it as dead.
#![cfg_attr(not(test), allow(dead_code))]

use std::fmt::Write as _;
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use crate::paths::VAULTS_DIR_NAME;

/// Top-level directory holding side-loaded model files + their device-local
/// marker files. A **sibling** of `paths::VAULTS_DIR_NAME`, never inside it.
pub const MODELS_DIR_NAME: &str = "models";

/// Marker file (under `models/`) recording the lowercase-hex SHA-256 of the
/// selected **embedding** model's file bytes — the `model_hash` field of the
/// `vault.embeddings` model-identity tuple (`protocol.md` §9.17.2, MYND-453).
/// Only the embedding role has one: the generation model does not feed the
/// embedding index identity. Computed once at pick-time so the unlock hot path
/// never re-hashes a hundreds-of-MiB safetensors file.
const EMBEDDING_HASH_MARKER: &str = "embedding.hash";

/// Marker file (under `models/`) recording the lowercase-hex SHA-256 of the
/// selected **transcription** (Whisper) model's file bytes — the model-identity
/// input the transcript `MYE1` cache binds so a model swap invalidates stale
/// transcripts (voice-to-text, MYND-550; SYNC-V3, mirroring the embedding rule).
const TRANSCRIPTION_HASH_MARKER: &str = "transcription.hash";

/// Which model a stored path refers to. The generation model (Qwen2.5-1.5B,
/// task 3) and the embedding model (all-MiniLM-L6-v2, task 4) are side-loaded
/// independently, so each has its own marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ModelRole {
    /// Text-completion model (`infer`).
    Generation,
    /// Embedding model (`embed`).
    Embedding,
    /// Speech-to-text model (`transcribe`) — Whisper, voice-to-text MYND-550
    /// (SYNC-V3). Side-loaded + swappable independently of the other two.
    Transcription,
}

impl ModelRole {
    /// Marker file name (under `models/`) recording this role's chosen path.
    fn marker_file_name(self) -> &'static str {
        match self {
            ModelRole::Generation => "generation.path",
            ModelRole::Embedding => "embedding.path",
            ModelRole::Transcription => "transcription.path",
        }
    }

    /// Which hash-marker file (if any) records this role's model SHA-256.
    /// `Generation` has none (it does not key a persisted index); `Embedding`
    /// keys `vault.embeddings`, `Transcription` keys the transcript `MYE1` cache.
    fn hash_marker_file_name(self) -> Option<&'static str> {
        match self {
            ModelRole::Generation => None,
            ModelRole::Embedding => Some(EMBEDDING_HASH_MARKER),
            ModelRole::Transcription => Some(TRANSCRIPTION_HASH_MARKER),
        }
    }

    /// Parse the IPC role string (`"generation"` / `"embedding"` /
    /// `"transcription"`) — the command layer's only re-entry point for a
    /// UI-supplied role.
    pub fn parse(s: &str) -> Option<ModelRole> {
        match s {
            "generation" => Some(ModelRole::Generation),
            "embedding" => Some(ModelRole::Embedding),
            "transcription" => Some(ModelRole::Transcription),
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
    /// The IPC role string was not `"generation"` / `"embedding"` (a UI/codegen
    /// bug, not user-facing input).
    #[error("unknown model role")]
    InvalidRole,
    /// An IO failure resolving/creating the models directory or reading/
    /// writing a marker, reduced to a closed, path-free kind.
    #[error("model store io failure")]
    Io { kind: IoFailureKind },
}

impl ModelStoreError {
    /// Bounded, content-free tag for structured logging (DENY-list safe).
    pub fn kind(&self) -> &'static str {
        match self {
            ModelStoreError::InsideVaultTree => "inside_vault_tree",
            ModelStoreError::InvalidRole => "invalid_role",
            ModelStoreError::Io { .. } => "io",
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
/// safetensors embedding model can be hundreds of MiB. Rejects a non-regular
/// file first (a FIFO/device would never terminate). Called at model-pick time
/// (not on the unlock hot path) so a warm unlock never re-hashes.
fn compute_file_sha256(path: &Path) -> Result<[u8; 32], ModelStoreError> {
    // Guard against a FIFO/device masquerading as a model file (unbounded read).
    let _ = file_stat(path)?;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}

/// Marker line format: `hex_hash\nlen\nmtime_nanos`. Line 1 is the hash (read by
/// [`selected_embedding_model_hash`]); lines 2–3 are the cheap staleness stat.
fn embedding_hash_marker_body(hash: &[u8; 32], stat: (u64, i128)) -> String {
    format!("{}\n{}\n{}", hex_lower(hash), stat.0, stat.1)
}

/// Parse the recorded `(len, mtime_nanos)` from an embedding-hash marker body
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
/// For [`ModelRole::Embedding`], this ALSO computes and records the file's
/// SHA-256 (`embedding.hash` marker) — the `model_hash` of the
/// `vault.embeddings` model-identity tuple (§9.17.2). Hashing runs BEFORE the
/// path marker is written, so a hash/IO failure records nothing (a swap either
/// fully lands or fully rolls back). This is where the (potentially seconds-
/// long) hash cost is paid, once, so the unlock path stays fast.
pub fn set_selected_model(
    base: &Path,
    role: ModelRole,
    model_path: &Path,
) -> Result<PathBuf, ModelStoreError> {
    let accepted = ensure_outside_vault_tree(base, model_path)?;
    let dir = ensure_models_dir(base)?;
    // Roles with a hash marker (Embedding / Transcription) record the file's
    // SHA-256 at pick-time — computed BEFORE the path marker so a hash/IO
    // failure records nothing (the swap fully lands or fully rolls back).
    if let Some(marker) = role.hash_marker_file_name() {
        let stat = file_stat(&accepted)?;
        let hash = compute_file_sha256(&accepted)?;
        std::fs::write(
            dir.join(marker),
            embedding_hash_marker_body(&hash, stat).as_bytes(),
        )?;
    }
    let marker = dir.join(role.marker_file_name());
    std::fs::write(&marker, accepted.to_string_lossy().as_bytes())?;
    Ok(accepted)
}

/// The SHA-256 of the selected embedding model, recorded at pick-time
/// ([`set_selected_model`] for [`ModelRole::Embedding`]). `None` if no embedding
/// model is selected, no hash was recorded, or the marker is malformed. Read on
/// the unlock path to build the `vault.embeddings` model-identity tuple WITHOUT
/// re-hashing the model file.
pub fn selected_embedding_model_hash(base: &Path) -> Result<Option<[u8; 32]>, ModelStoreError> {
    let marker = models_dir_from_base(base).join(EMBEDDING_HASH_MARKER);
    match std::fs::read_to_string(&marker) {
        Ok(s) => {
            // Line 1 is the hex hash (lines 2–3, if present, are the staleness
            // stat read separately).
            let hex = s.lines().next().unwrap_or("").trim();
            if hex.len() != 64 {
                return Ok(None);
            }
            let mut out = [0u8; 32];
            for (i, byte) in out.iter_mut().enumerate() {
                *byte = match u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16) {
                    Ok(b) => b,
                    Err(_) => return Ok(None),
                };
            }
            Ok(Some(out))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Read back the recorded model path for `role`, or `None` if none is set.
pub fn selected_model(base: &Path, role: ModelRole) -> Result<Option<PathBuf>, ModelStoreError> {
    let marker = models_dir_from_base(base).join(role.marker_file_name());
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

/// Path components (under the Tauri `resource_dir`) of the **bundled default**
/// transcription model (MYND-563): `<resource_dir>/models/whisper/model.gguf`,
/// with sibling `config.json` + `tokenizer.json` (the `load_transcription`
/// layout). On mobile this is a quantized **whisper-tiny** GGUF (Apache-2.0;
/// `LICENSING.md`), bundled via `tauri.conf.json` from the parent repo's
/// `resources/models/whisper-tiny/` (desktop ships whisper-base at the same
/// runtime path — the per-platform model split is deliberate).
pub const BUNDLED_TRANSCRIPTION_SUBPATH: [&str; 3] = ["models", "whisper", "model.gguf"];

/// The bundled default transcription model path IFF it is actually present on
/// disk. Returns `None` when no model ships (an `--no-default-features` AI-free
/// build, or a checkout whose LFS model blob was not fetched) so resolution
/// degrades cleanly to side-load-only — never a phantom path that fails to load.
pub fn bundled_transcription_model(resource_dir: &Path) -> Option<PathBuf> {
    let mut p = resource_dir.to_path_buf();
    for c in BUNDLED_TRANSCRIPTION_SUBPATH {
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

/// Return the embedding model hash, backfilling it (compute + persist) from the
/// currently-selected embedding model if the pick-time marker is missing — e.g.
/// a model selected before MYND-453 shipped. `None` if no embedding model is
/// selected. Thin wrapper over [`ensure_model_hash`].
pub fn ensure_embedding_model_hash(base: &Path) -> Result<Option<[u8; 32]>, ModelStoreError> {
    ensure_model_hash(base, ModelRole::Embedding)
}

/// The transcription (Whisper) model hash for the **effective** model — the
/// picker override if set, else the `bundled` default (voice-to-text, MYND-270)
/// — backfilled once if the marker is missing (like [`ensure_embedding_model_hash`]).
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

/// Shared backfill for any role that has a hash marker ([`ModelRole::Embedding`]
/// / [`ModelRole::Transcription`]). The hash cost is paid at most ONCE (then
/// cached), never on every unlock. `None` if the role has no hash marker or no
/// model is selected.
fn ensure_model_hash(base: &Path, role: ModelRole) -> Result<Option<[u8; 32]>, ModelStoreError> {
    let Some(marker_name) = role.hash_marker_file_name() else {
        return Ok(None);
    };
    let Some(path) = selected_model(base, role)? else {
        return Ok(None);
    };
    hash_model_at_path(base, marker_name, &path).map(Some)
}

/// Compute (or reuse the cached) SHA-256 of the model file at `path`, keyed by
/// the `<models>/<marker_name>` marker's `(hash, len, mtime)`. Extracted from
/// [`ensure_model_hash`] so the bundled-default transcription model
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
    // correctly invalidates the persisted index instead of poisoning it with a
    // stale hash (§9.17.2 for embeddings; the same rule for transcripts).
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
        embedding_hash_marker_body(&hash, stat).as_bytes(),
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
/// embedding model hash (backfilling once if needed). Best-effort — `None` on
/// any failure. The unlock path reads this to build the `vault.embeddings`
/// model-identity tuple (§9.17.2).
pub fn embedding_model_hash_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<[u8; 32]> {
    let base = crate::paths::app_data_dir(app).ok()?;
    ensure_embedding_model_hash(&base).ok().flatten()
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

    #[test]
    fn set_and_get_selected_model_round_trips_device_locally() {
        let tmp = ScopedTempDir::new("local-inf-model-store").expect("scoped tempdir");
        let base = tmp.path();
        let model = Path::new("/home/user/models/qwen2.5-1.5b-q4.gguf");

        assert_eq!(selected_model(base, ModelRole::Generation).unwrap(), None);

        let accepted = set_selected_model(base, ModelRole::Generation, model).expect("set ok");
        assert_eq!(accepted, model);
        assert_eq!(
            selected_model(base, ModelRole::Generation).unwrap(),
            Some(model.to_path_buf())
        );
        // Roles are independent — setting generation does not set embedding.
        assert_eq!(selected_model(base, ModelRole::Embedding).unwrap(), None);

        // The marker lives under models/, outside the vault tree.
        let marker = models_dir_from_base(base).join("generation.path");
        assert!(marker.exists());
        assert!(!is_inside_vaults_tree(base, &marker));
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
    fn error_kind_labels_are_deny_safe() {
        assert_eq!(ModelStoreError::InsideVaultTree.kind(), "inside_vault_tree");
        assert_eq!(
            ModelStoreError::Io {
                kind: IoFailureKind::NotFound
            }
            .kind(),
            "io"
        );
    }

    #[test]
    fn embedding_model_hash_computed_and_stored_at_pick_time() {
        use sha2::{Digest, Sha256};
        let tmp = ScopedTempDir::new("local-inf-embed-hash").expect("scoped tempdir");
        let base = tmp.path();
        let dl = base.join("downloads");
        std::fs::create_dir_all(&dl).unwrap();
        let model = dl.join("minilm.safetensors");
        std::fs::write(&model, b"fake-safetensors-bytes-v1").unwrap();

        // No hash before selection.
        assert_eq!(selected_embedding_model_hash(base).unwrap(), None);

        set_selected_model(base, ModelRole::Embedding, &model).expect("set embedding");

        let expected: [u8; 32] = Sha256::digest(b"fake-safetensors-bytes-v1").into();
        assert_eq!(selected_embedding_model_hash(base).unwrap(), Some(expected));
    }

    #[test]
    fn swapping_embedding_model_updates_the_stored_hash() {
        use sha2::{Digest, Sha256};
        let tmp = ScopedTempDir::new("local-inf-embed-swap").expect("scoped tempdir");
        let base = tmp.path();
        let dl = base.join("downloads");
        std::fs::create_dir_all(&dl).unwrap();
        let a = dl.join("minilm.safetensors");
        let b = dl.join("multilingual.safetensors");
        std::fs::write(&a, b"model-A").unwrap();
        std::fs::write(&b, b"model-B-different-content").unwrap();

        set_selected_model(base, ModelRole::Embedding, &a).unwrap();
        let ha = selected_embedding_model_hash(base).unwrap().unwrap();
        set_selected_model(base, ModelRole::Embedding, &b).unwrap();
        let hb = selected_embedding_model_hash(base).unwrap().unwrap();

        assert_ne!(ha, hb);
        let expected_b: [u8; 32] = Sha256::digest(b"model-B-different-content").into();
        assert_eq!(hb, expected_b);
    }

    #[test]
    fn in_place_model_replacement_reforces_a_rehash() {
        use sha2::{Digest, Sha256};
        let tmp = ScopedTempDir::new("local-inf-embed-inplace").expect("scoped tempdir");
        let base = tmp.path();
        let dl = base.join("downloads");
        std::fs::create_dir_all(&dl).unwrap();
        let model = dl.join("minilm.safetensors");
        std::fs::write(&model, b"weights-v1").unwrap();
        set_selected_model(base, ModelRole::Embedding, &model).expect("set embedding");
        let h1 = ensure_embedding_model_hash(base).unwrap().unwrap();
        let expected_v1: [u8; 32] = Sha256::digest(b"weights-v1").into();
        assert_eq!(h1, expected_v1);

        // Replace the file IN PLACE (same path, different, longer bytes → the
        // len changes even if mtime resolution is coarse).
        std::fs::write(&model, b"weights-v2-different-and-longer").unwrap();
        let h2 = ensure_embedding_model_hash(base).unwrap().unwrap();
        let expected_v2: [u8; 32] = Sha256::digest(b"weights-v2-different-and-longer").into();
        assert_eq!(
            h2, expected_v2,
            "an in-place replacement must re-hash, not serve the stale pick-time hash"
        );
        assert_ne!(h1, h2);
    }

    #[test]
    fn generation_model_records_no_embedding_hash() {
        let tmp = ScopedTempDir::new("local-inf-gen-nohash").expect("scoped tempdir");
        let base = tmp.path();
        let dl = base.join("downloads");
        std::fs::create_dir_all(&dl).unwrap();
        let gen = dl.join("qwen.gguf");
        std::fs::write(&gen, b"gguf-bytes").unwrap();

        set_selected_model(base, ModelRole::Generation, &gen).unwrap();
        // Generation does not feed the embedding identity → no hash recorded.
        assert_eq!(selected_embedding_model_hash(base).unwrap(), None);
    }
}
