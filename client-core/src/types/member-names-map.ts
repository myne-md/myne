// SPDX-License-Identifier: AGPL-3.0
//
// Manual TS mirror of `protocol::MemberNamesMap` and its entry
// (`protocol/src/member_names_blob.rs`, the `MYO5` family, myne-md/myne#851). Shared
// by both clients because the store is: desktop and mobile write the same
// `vault.member-names` through the same `myne-core` command cores, and this is the
// shape `member_names_set_mine` / `member_names_clear_mine` return.
//
// TODO(Phase-1-end): replace this hand-written mirror with a `ts-rs`
// auto-generated artifact plus a CI drift check, like every other file in this
// directory. Until then, a shape change in the Rust map must be reflected here in
// the same change.
//
// It lived in `src/lib/memberNames.ts` alone until the phone needed to name a
// binding's return type too (myne-md/myne#851 task 15); a second copy of a wire
// shape is exactly the kind of twin `scripts/check-twin-inventory.mjs` records as
// debt, so the desktop module now imports this one.

/** One member's row in the store, as the codec serializes it. */
export interface MemberNameEntry {
  name: string;
  /** A wall-clock-free counter: two members renaming at once resolve by this,
   *  so a skewed clock cannot decide whose rename wins. */
  version: number;
  tombstone: boolean;
  /** Hybrid Ed25519 + ML-DSA-65 signature, lowercase hex, over the person the
   *  row names. Verified backend-side against that person's public half. */
  signature_hex: string;
}

/** `person_id_hash` (lowercase hex) to row. */
export type MemberNamesMap = Record<string, MemberNameEntry>;
