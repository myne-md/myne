// SPDX-License-Identifier: AGPL-3.0-only
//
// Manual TS mirror of the Rust `MemberNamesError` enum
// (`core/src/plugins/member_names/error.rs`, myne-md/myne#851). Shared by both
// clients, because the store is: desktop and mobile write the same
// `vault.member-names` through the same `myne-core` command cores.
//
// TODO(Phase-1-end): replace this hand-written mirror with a `ts-rs`
// auto-generated artifact plus a CI drift check, like every other file in this
// directory. Until then, a variant change in the Rust enum must be reflected
// here in the same change.
//
// Wire shape: `#[serde(tag = "kind", content = "detail")]`.

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Failure modes of the member display-name store.
 *
 * The three arms a row editor can act on are `NameEmpty`, `NameTooLong` and
 * `SlotNotUnlocked`; `StoreUnreadable` is the one that must NOT be folded into
 * "no names", since answering empty for a damaged store is what lets the next
 * write persist that emptiness over real rows (`error.rs` states it).
 */
export type MemberNamesError =
  /** The store could not be consulted at all. */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** It exists, and no copy of it decrypted. */
  | { kind: "StoreUnreadable" }
  /** A display name was empty. Clearing is a SEPARATE operation, so this is a
   *  refusal rather than a silent clear. */
  | { kind: "NameEmpty" }
  /** A display name is over the family's byte cap; `detail.max` is that cap. */
  | { kind: "NameTooLong"; detail: { max: number } }
  /** The codec refused the map, or a signature could not be produced. */
  | { kind: "Codec" }
  /** Nothing is unlocked, or no person identity is installed, so there is
   *  nobody to sign as. */
  | { kind: "SlotNotUnlocked" }
  /** The vault is not shared (`NTV6`), which is where this family does not
   *  exist: a pre-B2B vault has no `group_key` to seal a member-writable name
   *  under, and no members to name. */
  | { kind: "NotASharedVault" };
