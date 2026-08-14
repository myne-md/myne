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
//! **Never synced, never backed up.** The store is device-local by design, and
//! the § 9.11.3 closed allowlist rejects an unlisted member path outright, so a
//! new family is excluded from the backup container by construction rather than
//! by anyone remembering to exclude it.
//!
//! This module is the storage layer only. The call sites that write through it
//! (unlock, rename, vault delete), the device-wide hide-vault-names option and
//! its erase sweep, and the picker's own rendering, each land in their own
//! change; see `agent-tooling/features/locked-picker-vault-names/`.

pub mod error;
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
