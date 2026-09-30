// The plain-file editor seam — desktop implementation (myne-md/myne#788).
//
// The device-local gate lives in its own JSON file under `<app_config_dir>`
// because the surface it guards must work with the vault locked and with no
// vault at all, and `vault.prefs` is unreadable in both states. This module is
// the only place the two commands are named; the web counterpart routes the
// same names into the Worker transport, where `capability.rs` classifies the
// whole `plain-file` plugin as decided-absent and answers the typed
// `PlatformUnsupportedError`.

import { invoke } from "./core";

/**
 * Whether the plain-file editor is enabled on this device.
 *
 * Answers `false` on every failure — an unreadable gate is never read as
 * enabled.
 */
export async function plainFileGateGet(): Promise<boolean> {
  return await invoke<boolean>("plugin:plain-file|gate_get");
}

/** Persist the device-local gate. */
export async function plainFileGateSet(enabled: boolean): Promise<void> {
  await invoke<void>("plugin:plain-file|gate_set", { enabled });
}
