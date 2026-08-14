// SPDX-License-Identifier: AGPL-3.0
//! The sealed label store (`MYL1`, `docs/spec/protocol.md` § 9.22): what lets
//! the LOCKED vault picker show a vault's real name.
//!
//! A vault's name lives in `vault.prefs`, sealed under a `root_key`-derived KEK,
//! so it is readable only after that vault is unlocked. The picker runs before
//! any unlock, so it fell back to `Vault 1 / Vault 2 / Vault 3` on every launch.
//! This module caches the name, per vault, in a device-local file at the vault
//! root beside `vault.quickunlock`, sealed under a per-vault keychain
//! `wrap_key`.
//!
//! Three properties hold the design up, and each has its own home:
//!
//! - [`key`]: one wrap key **per vault**, in the OS keychain, under its own
//!   service string, with no `DeriveSubkey` role. Destroying one key is the
//!   erase, and per-vault scoping is what keeps vault deletion's per-`VaultId`
//!   cryptographic-erase guarantee intact.
//! - [`store`]: the file. Read, write, remove, and the combined erase. Reads
//!   never mint a key, and no path writes a name in the clear.
//! - `protocol::vault_label_blob`: the bytes. Magic checked before any
//!   decryption, and the AAD binds the `VaultId` the reader expected, so a file
//!   moved between vault directories fails AEAD rather than opening.
//!
//! Three more carry the device-wide **hide vault names** option, which is the
//! store's off switch and its eraser:
//!
//! - [`hide_flag`]: the flag itself, a device-local boolean at
//!   `<app_config_dir>/vault-names.json`. Deliberately not a `vault.prefs`
//!   field, because that file is sealed and the picker reads this with no key.
//! - [`erase_all`]: the sweep. Every vault the disk-scan finds, every key
//!   destroyed, every file removed, and a partial sweep reported as failure.
//! - [`commands`]: the read/write command pair, where turning the flag on
//!   performs the sweep in the same operation and the ordering between the two
//!   is what stops the screen claiming an erase that did not happen.
//!
//! **Never synced, never backed up.** The store is device-local by design, and
//! the § 9.11.3 closed allowlist rejects an unlisted member path outright, so a
//! new family is excluded from the backup container by construction rather than
//! by anyone remembering to exclude it.
//!
//! Still outside this module: the call sites that write through the store
//! (unlock, rename, vault delete) and the picker's own rendering. Each lands in
//! its own change; see `myne-agents/features/locked-picker-vault-names/`.

pub mod commands;
pub mod erase_all;
pub mod error;
pub mod hide_flag;
pub mod key;
pub mod store;

/// In-memory keychain stand-in, shared by [`key`]'s and [`store`]'s tests.
#[cfg(test)]
pub(crate) mod fake_keychain;

/// Two fixed `VaultId`s, shared by [`key`]'s and [`store`]'s tests so a
/// cross-vault assertion in one reads against the same pair as the other.
#[cfg(test)]
pub(crate) mod test_ids {
    use crate::vault_id::VaultId;

    pub(crate) const VAULT_A: &str = "0197c0de-0000-7000-8000-00000000000a";
    pub(crate) const VAULT_B: &str = "0197c0de-0000-7000-8000-00000000000b";

    pub(crate) fn vault(id: &str) -> VaultId {
        VaultId::parse(id).expect("test VaultId parses")
    }
}
