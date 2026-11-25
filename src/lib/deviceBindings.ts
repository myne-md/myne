// SPDX-License-Identifier: AGPL-3.0-only
//
// The device-to-person binding read (`vault.device-bindings`, magic `MYU5`;
// myne-md/myne#852, `decisions/protocol/0669`). One `invoke`, one command.
//
// **It answers the verified view, and that is the contract this file exists to
// keep.** The store is group-tier sealed, which is exactly what makes it
// writable by every member, and the map key is the DEVICE with the claimed
// person inside the row: `protocol.md` §9.30.4 has the signature cover the row's
// own contents, so it binds the row to the person who signed it and binds NOTHING
// to the device. A raw map handed to this layer could therefore only be rendered
// unverified or not at all, which is why the command does not return one. It
// returns `DeviceAttributionView`, already partitioned against the owner-signed
// roster and the name store by `core/src/plugins/sync/identity_resolver.rs`, so
// no unverified row can reach a surface through this file.
//
// **The write half is gone** (myne-md/myne#976). `device_bindings_claim` existed
// for the `MEMBER DEVICES` panel's `Claim this device` button, and what it
// repaired is now repaired without a human: a `ConflictingBinding` this device is
// party to is re-claimed at a strictly higher version by the sync cycle's own
// boundary (`core/src/plugins/sync/cycle.rs`). A manual re-claim had exactly one
// reachable failure mode, and nobody was watching for it.

import { invoke } from "../platform/core";
import type { DeviceBindingError } from "@myne/client-core/types/device-binding-error";
// The view mirror lives in `@myne/client-core` because the wire shape is the
// shared backend's, not this client's: desktop and mobile read the same store
// through the same command cores.
import type { DeviceAttributionView } from "@myne/client-core/types/device-attribution";

export type { DeviceBindingError };
export type {
  DeviceAttributionRow,
  DeviceAttributionView,
} from "@myne/client-core/types/device-attribution";

/**
 * The vault's devices with the member each one is CLAIMED by.
 *
 * A row is a claim and never an ownership (§9.30.4). A device whose row did not
 * verify appears only in `unverified_device_ids`, which carries no person and no
 * name, so no surface may render one beside a member.
 */
export async function listDeviceBindings(): Promise<DeviceAttributionView> {
  return invoke<DeviceAttributionView>("plugin:device-binding|device_bindings_list");
}

/** The error kind of a thrown `DeviceBindingError`, or `"Internal"` for anything
 *  else. The backend's enum is tagged `{ kind, detail }`, so the kind is the
 *  only part a message needs. */
export function deviceBindingErrorKind(error: unknown): string {
  if (error && typeof error === "object" && "kind" in error) {
    return String((error as DeviceBindingError).kind);
  }
  return "Internal";
}

/**
 * The i18n key for a device-binding failure.
 *
 * Deliberately a total map over the closed enum rather than a fallback chain: an
 * arm that is dropped here would fall through to the generic message, which
 * still renders a plausible sentence, so nothing else would notice
 * (`memberNameErrorKey` makes the same argument for its own six arms).
 */
export function deviceBindingErrorKey(error: unknown): string {
  switch (deviceBindingErrorKind(error)) {
    case "SlotNotUnlocked":
      return "sync.deviceBindings.errorLocked";
    case "NotASharedVault":
      return "sync.deviceBindings.errorUnshared";
    case "NoDeviceId":
      return "sync.deviceBindings.errorNoDeviceId";
    case "ConflictingBinding":
      return "sync.deviceBindings.errorConflict";
    case "StoreUnreadable":
      return "sync.deviceBindings.errorUnreadable";
    default:
      return "sync.deviceBindings.errorGeneric";
  }
}
