// The plain-file editor seam — mobile implementation (myne-md/myne#788).
//
// A deliberate mirror of `src/platform/plainFile.ts`. Mobile has no OS file
// ingress for this feature (its own file flows are the share sheet and the
// importer), so the plugin is never registered here and both commands reject
// at the host. Nothing in the mobile tree imports this module today; it exists
// because the seam's shape is per-client, and a missing counterpart is how a
// shared caller ends up wired to a desktop implementation by accident.
//
// The signature is the contract: same names, same arguments, nothing wrapped.

import { invoke } from "./core";

/** Whether the plain-file editor is enabled on this device. Mobile: never enabled. */
export async function plainFileGateGet(): Promise<boolean> {
  return await invoke<boolean>("plugin:plain-file|gate_get");
}

/** Persist the device-local gate. Mobile: rejects (the plugin is not registered). */
export async function plainFileGateSet(enabled: boolean): Promise<void> {
  await invoke<void>("plugin:plain-file|gate_set", { enabled });
}
