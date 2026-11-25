// SPDX-License-Identifier: AGPL-3.0-only
//
// Manual TS mirror of `DeviceAttributionRow` / `DeviceAttributionView`
// (`core/src/plugins/sync/identity_resolver.rs`, the `MYU5` device-binding
// family, myne-md/myne#852). Shared by both clients because the store is: the
// desktop and the mobile client read the SAME `vault.device-bindings` through
// the SAME `myne-core` command cores, and this is the shape
// `device_bindings_list` returns. That is the family's only command since
// myne-md/myne#976: the write went with the `MEMBER DEVICES` panel, and the one
// conflict it repaired is repaired by the sync cycle on the device that is party
// to it.
//
// TODO(Phase-1-end): replace this hand-written mirror with a `ts-rs`
// auto-generated artifact plus a CI drift check, like every other file in this
// directory. Until then, a shape change in the Rust view must be reflected here
// in the same change.
//
// **What a row is worth, because the field names are the trap.** A row says the
// named person CLAIMS this device, never that the device belongs to them:
// `protocol.md` §9.30.4 has the signature cover the row's own contents, which
// binds it to the person who signed it and binds NOTHING to the device, so any
// member could seal a row naming any device id. What makes a row renderable at
// all is the partition the backend performs before it answers, so `rows` holds
// only what survived `protocol::partition_verified_bindings`:
//
//   - the row's hybrid signature verified against the public half of the person
//     it names, and that person is a LIVE member of the owner-signed roster
//     (a departed or tombstoned member has no public half to verify against, so
//     their rows land in `unverified_device_ids` rather than being named), or
//   - it is a tombstone whose REMOVAL the owner signed, which verifies and is
//     then dropped: a removed device is neither a row nor an unverified id.
//
// Everything else is not softened into a guess. It appears only as an id in
// `unverified_device_ids`, which carries no person and no name by construction.
//
// So a surface renders "claimed by" and never "belongs to"/"owned by", and
// `unverified_device_ids` as bare device ids under a plain "not verified"
// marker. A caller that renders a name next to an id from that list has invented
// the attribution the partition exists to withhold.

/** One verified row: a device, and the person whose own signature claims it. */
export interface DeviceAttributionRow {
  /** The 16-byte enrolled device id, lowercase hex. The same id space the sync
   *  account roster uses (`DeviceEntry.device_id_hex`), which is what lets a
   *  surface join this view onto a device's friendly name. */
  device_id_hex: string;
  /** The claiming person's fingerprint, lowercase hex. Always present: it is
   *  what the row's signature was verified against. */
  person_fingerprint_hex: string;
  /** The roster person id, lowercase hex, or `null` when the claiming person's
   *  roster row carries none, which is the shape of a member migrated from a
   *  pre-B2B membership roster (no person account). `member_name` is only ever
   *  populated through a LIVE roster row, so it is `null` whenever this is. */
  person_id_hex: string | null;
  /** The claiming member's own signed display name (`vault.member-names`),
   *  or `null` when they have none, or when the name store was unreadable.
   *  A name is a label and not a credential, and this is a label. */
  member_name: string | null;
  /** True for the device this client is running on. `false` everywhere when the
   *  vault has no enrolled device id yet, which is why a surface must not read
   *  "no row is mine" as "my row is missing". */
  is_this_device: boolean;
}

/**
 * The whole answer: the verified rows, and the ids that did not verify.
 *
 * Two fields rather than one list with a flag, because the two are not the same
 * kind of thing: a row carries a person and can be named, an unverified id
 * carries neither and must be shown as an id. An unverified id may be a device
 * this vault has never seen claim itself, or one whose row a co-member wrote
 * under their own signature.
 */
export interface DeviceAttributionView {
  rows: DeviceAttributionRow[];
  /** Lowercase hex device ids whose rows did not verify, in map order: a key
   *  that is not a valid device id, a signature that does not check out against
   *  the person the row names, a named person the LIVE roster has no public half
   *  for, or a tombstone whose removal neither the named person nor the owner
   *  signed. Deliberately ids rather than rows: there is nothing here a name
   *  could honestly be attached to. Reported rather than dropped, so a tampered
   *  row is distinguishable from an absent one. */
  unverified_device_ids: string[];
}
