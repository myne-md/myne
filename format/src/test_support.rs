// SPDX-License-Identifier: AGPL-3.0
//! Test-only scratch directory for the `format/` crate's own tests.
//!
//! A minimal `ScopedTempDir` (the `myne-core` shape, without the vault-meta
//! convenience) so the moved `atomic_write` / `export_mtime` test suites keep
//! their self-cleaning temp dirs without pulling `myne-core` as a dev-dep.

use std::path::{Path, PathBuf};

/// Generic self-cleaning scratch directory. Creates a unique-named dir under
/// `std::env::temp_dir()` and removes it on drop.
pub struct ScopedTempDir {
    path: PathBuf,
}

impl ScopedTempDir {
    pub fn new(label: &str) -> std::io::Result<Self> {
        let path =
            std::env::temp_dir().join(format!("myne-format-test-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScopedTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
