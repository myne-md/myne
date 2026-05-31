//! Cross-plugin test fixtures.
//!
//! The vault-creation, vault-unlock, and vault-recover plugins each
//! exercise the same on-disk shape — a `vault.meta` file under a
//! short-lived temp directory, sealed with an Argon2id parameter set
//! that runs in microseconds rather than the production ~1 s.
//!
//! This module hosts the shared pieces. Per-plugin test files still
//! own the bits that genuinely differ (e.g. each plugin's `seed_*`
//! helpers return different tuples depending on which side of the
//! flow they exercise).

use protocol::KdfParams;
use std::path::{Path, PathBuf};

/// Fast Argon2id parameters for tests (RFC 9106 minimum). Production
/// never uses these — `protocol::DEFAULT_V0_1_KDF_PARAMS` is the only
/// set that reaches `derive_*_wrap_key` at runtime.
pub(crate) const FAST_TEST_KDF: KdfParams = KdfParams {
    m_kib: 8,
    t: 1,
    p: 1,
    argon2_version: 0x13,
};

/// Scoped temp directory holding a single `vault.meta`. Caller writes
/// the bytes via [`Self::write_meta`]; the `Drop` impl removes the
/// directory tree at end of scope.
pub(crate) struct ScratchVault {
    pub(crate) dir: PathBuf,
    meta_path: PathBuf,
}

impl ScratchVault {
    pub(crate) fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("myne_{label}_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        let meta_path = dir.join("vault.meta");
        Self { dir, meta_path }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.meta_path
    }

    pub(crate) fn write_meta(&self, bytes: &[u8]) {
        std::fs::write(&self.meta_path, bytes).expect("write vault.meta");
    }
}

impl Drop for ScratchVault {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Generic self-cleaning scratch directory for tests that don't need
/// `ScratchVault`'s vault-meta convenience. Creates a unique-named dir
/// under `std::env::temp_dir()` and removes it on drop. Avoids pulling
/// `tempfile` as a dev-dep just to provide the same shape (TB9
/// minimal-dep posture).
pub(crate) struct ScopedTempDir {
    path: PathBuf,
}

impl ScopedTempDir {
    pub(crate) fn new(label: &str) -> std::io::Result<Self> {
        // UUID suffix (not a timestamp) so parallel tests sharing a label never
        // collide on one directory — a collision lets one test's `Drop`
        // `remove_dir_all` delete another's `vault.meta` mid-run. Mirrors the
        // sibling `ScratchVault::new` above.
        let path = std::env::temp_dir().join(format!("myne-test-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScopedTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
