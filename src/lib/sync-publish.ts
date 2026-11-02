// Where a vault stands with respect to the sync server (myne-md/myne#911 task 8,
// reduced by myne-md/myne#974).
//
// Publishing itself is no longer a surface: the sync cycle publishes a
// person-born vault on its own the first time it has an endpoint, a registered
// identity and a person session (`core/src/plugins/sync/publish.rs::publish_if_due`).
// What the UI still needs is the GENERATION, because the legacy "add this device"
// form is the vault-account flow and a vault born under an identity has no such
// account to add a device to.

import { invoke } from "../platform/core";

/** Mirrors the Rust `PublishState` (myne-md/myne#911 task 8). */
export interface PublishState {
  /** `true` when this vault is reachable on a server. `false` is "device only". */
  published: boolean;
  /** The namespace publish recorded, lowercase hex. `null` for a legacy vault. */
  namespace_hex: string | null;
  /** Epoch-ms of the publish performed on this device, if any. */
  published_at_ms: number | null;
  /**
   * `true` for a vault born under an identity (`NTV7`/`NTV8`). Its credential is
   * the person session, so the legacy "add this device with an account number"
   * form does not apply to it.
   */
  person_born: boolean;
}

/**
 * The DURABLE publish state of the active vault.
 *
 * Read-only, device-local and network-free: it reads `sync-state.json` and four
 * bytes of `vault.meta`, so it is safe to ask on mount. The vault rows get the
 * same fact from `vault.published`, which is what draws "Device only" in the
 * picker; this read exists for the active vault's own panel.
 */
export function readPublishState(): Promise<PublishState> {
  return invoke<PublishState>("plugin:sync|sync_published_state");
}
