// SPDX-License-Identifier: AGPL-3.0

//! B2B member display names (`vault.member-names`, magic `MYO5`; `docs/spec/protocol.md`
//! §9.29, `decisions/protocol/0666`).
//!
//! The store in [`store`] is HOST-FREE on purpose: it takes the vault directory, the
//! derived key, the account hash, the group epoch, the signer and the person id, and
//! nothing else. No session, no host, no command. That is the same split
//! `plugins::themes` uses between its `_in_dir` cores and its `_with_dir` entry
//! pointed at a live session: it is what makes
//! `cargo test -p myne-core --lib plugins::member_names` exercise the real
//! read-modify-write over a temp vault directory, and it is why the command layer,
//! the sync classification and the capability grant were a separate slice (task 3b).
//! That slice is now here too: [`commands`] is the native-only host surface, and
//! [`sync`] is the target-independent half the shared sync engine calls into.
//!
//! The KEK is a GROUP-tier role (`GroupRole::MemberNamesKey`), because every member
//! reads every name and only members read any. A pre-B2B `NTV5` vault has no
//! `group_key`, so this family does not exist there and arrives with the existing
//! owner-approved B2B migration; there is deliberately no `root_key` counterpart.

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

pub use error::MemberNamesError;
pub use store::{
    clear_my_name_in_dir, live_row_count, merge_pulled_blob_in_dir, read_member_names_in_dir,
    set_my_name_in_dir, tombstone_member_in_dir, write_member_names_in_dir, write_mutex,
    MemberNamesKey, MemberNamesWriter,
};
pub use sync::{
    names_key_for_group, names_sync_id, read_verified_names_bytes, resolve_names_from_group_key,
    ResolvedNames,
};

#[cfg(not(target_arch = "wasm32"))]
pub use commands::{
    member_names_clear_mine_with_dir, member_names_list_with_dir,
    member_names_merge_pulled_with_dir, member_names_set_mine_with_dir, resolve_names,
    session_person_id,
};

/// The family's file at the vault root.
pub const MEMBER_NAMES_FILE: &str = "vault.member-names";
