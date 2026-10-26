// SPDX-License-Identifier: AGPL-3.0

//! B2B device-to-person bindings (`vault.device-bindings`, magic `MYU5`;
//! `docs/spec/protocol.md` §9.30, the `member-devices` feature).
//!
//! One blob per vault holding `{device-id -> {person_fingerprint, version, tombstone}}`:
//! which person each enrolled device acts for. A device that has been in a vault since
//! before this family existed has no row until it claims itself, which is what
//! [`store::claim_self_in_dir`] does on every unlock.
//!
//! The store in [`store`] is HOST-FREE on purpose: it takes the vault directory, the
//! derived key, the account hash, the group epoch, the signer and the device id, and
//! nothing else. No session, no host, no command. That is the same split
//! `plugins::themes` and the sibling `plugins::member_names` use between their `_in_dir`
//! cores and their `_with_dir` entry pointed at a live session: it is what makes
//! `cargo test -p myne-core --lib plugins::device_binding` exercise the real
//! read-modify-write over a temp vault directory. [`commands`] is the native-only host
//! surface and [`sync`] is the target-independent half the shared sync engine calls into.
//!
//! The KEK is a GROUP-tier role (`GroupRole::DeviceBindingKey`), because every member
//! reads the whole map and only members read any of it: a binding says which person a
//! device acts for, which is roster-adjacent material. A pre-B2B `NTV5` vault has no
//! `group_key`, so this family does not exist there and arrives with the existing
//! owner-approved B2B migration; there is deliberately no `root_key` counterpart, and
//! `SubkeyRole::shared_group_role` has no arm for it (the vectors test asserts that).
//!
//! **Nothing here holds plaintext-derived vault state at module scope.** The two
//! process-global items this family owns are [`store::write_mutex`], a bare `Mutex<()>`,
//! and the derived KEK, which lives in a `Zeroizing` buffer owned by the caller for the
//! duration of one call. There is therefore no `VaultLifecycleHooks` teardown body to
//! fill, which is the state `scripts/check-lock-teardown.mjs` exists to catch: nothing
//! survives a lock that would need clearing.

pub mod error;
pub mod store;
/// The sync-facing surface: the group-tier resolver, the family's sync
/// discriminator and the decryption-free verified-bytes reader. Deliberately
/// UNGATED (it compiles for `wasm32`) because `plugins::sync::orchestrator` is
/// target-independent and calls in here.
pub mod sync;

/// The host surface. Native-only: it borrows the person account plane's session
/// accessors, which do not exist on `wasm32`, and this family is desktop/mobile by
/// decision (the web client has no member sharing at all).
#[cfg(not(target_arch = "wasm32"))]
pub mod commands;

pub use error::DeviceBindingError;
pub use store::{
    admit_other_in_dir, claim_self_in_dir, device_id_hex, live_row_count, merge_pulled_blob_in_dir,
    read_device_bindings_in_dir, tombstone_devices_for_person, tombstone_member_devices_in_dir,
    write_device_bindings_in_dir, write_mutex, ClaimOutcome, DeviceBindingKey,
};
pub use sync::{
    bindings_key_for_group, bindings_sync_id, read_verified_bindings_bytes,
    resolve_bindings_and_meta_from_group_key, resolve_bindings_from_group_key, ResolvedBindings,
};

#[cfg(not(target_arch = "wasm32"))]
pub use commands::{
    claim_own_binding_with_dir, device_bindings_list_with_dir, resolve_bindings, session_device_id,
    session_person_id,
};

/// The family's file at the vault root.
pub const DEVICE_BINDINGS_FILE: &str = "vault.device-bindings";
