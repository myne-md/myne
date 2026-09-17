// SPDX-License-Identifier: AGPL-3.0
//! The account record: the device-local half of the account/vault split
//! (`decisions.md` 2026-09-07).
//!
//! One account can own multiple vaults. The account is a purely client-side,
//! sealed ownership layer above the vault: this device-local record (account id,
//! member vault ids, label) plus a sealed membership field inside each member
//! vault's `vault.meta` (§9.3.1). This module owns the record's lifecycle.
//!
//! - [`key`]: one wrap key per device, in the OS keychain, under the shared
//!   vault-label service with a reserved account name (see `key` for the
//!   namespace partition), with no `DeriveSubkey` role. The record must be
//!   readable while every vault is locked, so it cannot be `root_key`-derived.
//! - [`store`]: the file at `<app_config_dir>/account.json`. Read, write, and the
//!   reconcile/rebuild/prune rules. No path writes the record in plaintext.
//! - [`commands`]: the desktop command surface (list, rename, move, split).
//!
//! **Never synced.** The record is device-local by design, and
//! grouping never converges across devices (`sync-protocol.md` §10.3).
//! Sealed at rest, which is what makes it safe inside a platform backup:
//! a backup carries the ciphertext, never the labels in the clear.

pub mod commands;
pub mod error;
pub mod key;
pub mod person_identity;
pub mod store;
