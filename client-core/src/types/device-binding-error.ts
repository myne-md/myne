// SPDX-License-Identifier: AGPL-3.0
//
// Manual TS mirror of the Rust `DeviceBindingError` enum
// (`core/src/plugins/device_binding/error.rs`, the `MYU5` family,
// myne-md/myne#852). Shared by both clients, because the store is: desktop and
// mobile read the same `vault.device-bindings` through the same `myne-core`
// command cores.
//
// TODO(Phase-1-end): replace this hand-written mirror with a `ts-rs`
// auto-generated artifact plus a CI drift check, like every other file in this
// directory. Until then, a variant change in the Rust enum must be reflected
// here in the same change.
//
// Wire shape: `#[serde(tag = "kind", content = "detail")]`.

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Failure modes of the device-binding store, closed and typed: no `String`
 * reaches the WebView.
 *
 * The arms a device-list surface can act on are `SlotNotUnlocked` (unlock the
 * vault), `NotASharedVault` (there is nothing to list on a vault nobody has
 * shared, which is a state and not an error to shout about), `NoDeviceId` (this
 * device has never enrolled, so it has no id to claim itself under) and
 * `ConflictingBinding` (a merge refused rather than picking a side; a fresh
 * claim is the repair). `StoreUnreadable` must NOT be folded into "no devices",
 * for the same reason it must not be in the member-names store: answering empty
 * for a damaged store lets the next write persist that emptiness over every
 * other device's real row, and the dropped rows carry no tombstone, so no later
 * merge could notice.
 */
export type DeviceBindingError =
  /** The family's file could not be consulted at all. */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** It exists, and NO copy decrypted. */
  | { kind: "StoreUnreadable" }
  /** The codec refused the map, or a signature could not be produced. */
  | { kind: "Codec" }
  /** A merge would put one device under two DIFFERENT people at the SAME
   *  version, with no arm left to separate the pair. */
  | { kind: "ConflictingBinding" }
  /** Nothing is unlocked, or no person identity is installed, so there is no
   *  key to derive and nobody to sign as. */
  | { kind: "SlotNotUnlocked" }
  /** The active vault is not shared (`NTV6`), where this family does not exist. */
  | { kind: "NotASharedVault" }
  /** The vault carries no enrolled device identity, so this device has no id
   *  to claim itself under. */
  | { kind: "NoDeviceId" };
