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

/// Fast Argon2id parameters for tests — pinned to the `validate_kdf_params`
/// memory floor (`MIN_KDF_M_KIB` = 8 MiB) so vaults built with these still
/// pass the unlock/recover/change-password range gate, while staying ~32×
/// cheaper than production (256 MiB). Production never uses these —
/// `protocol::DEFAULT_V0_1_KDF_PARAMS` is the only set used at runtime.
pub(crate) const FAST_TEST_KDF: KdfParams = KdfParams {
    m_kib: protocol::MIN_KDF_M_KIB,
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

/// Write a REAL, structurally-parseable 345-byte `vault.meta` into `dir`
/// with `account_number_hash` = `seed_byte` repeating (filler key material;
/// parse-passes, never unlock-passes). Shared by the prefs + backup test
/// suites — the restore validator's stage-5 parse needs a real header.
pub(crate) fn seed_real_vault_meta(dir: &Path, seed_byte: u8) {
    let meta = protocol::VaultMeta {
        account_number_hash: [seed_byte; 16],
        kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
        random_salt_password: [1u8; 16],
        random_salt_recovery: [2u8; 16],
        nonce_password_wrap: [3u8; 24],
        enc_root_key_password: [4u8; 64],
        nonce_recovery_wrap: [5u8; 24],
        enc_root_key_recovery: [6u8; 64],
        items_key_id: [7u8; 16],
        items_key_nonce: [8u8; 24],
        enc_items_key: [9u8; 64],
    };
    std::fs::write(
        dir.join("vault.meta"),
        protocol::serialize_vault_meta(&meta),
    )
    .expect("seed vault.meta");
}
