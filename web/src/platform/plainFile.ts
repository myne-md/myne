// The plain-file editor seam — browser implementation (myne-md/myne#788).
//
// A deliberate two-line mirror of `src/platform/plainFile.ts`: the browser
// arm must keep the identical signature, and there is no browser behaviour to
// give it. The feature is decided-absent on web (the PRD's `absent` verdict,
// `web/wasm/src/capability.rs` classifies the whole `plain-file` plugin as
// `Unsupported`), so routing the commands into the Worker transport is the
// honest implementation: the transport answers the one typed
// `PlatformUnsupportedError`, and nothing here hand-rolls a refusal shape the
// seam contract would then have to special-case.
//
// The surface that would call these functions never renders in a browser, so
// these commands are reachable only through a stale deep link or a replayed
// command — exactly the paths the typed refusal exists for.

import { invoke } from "./core";

/**
 * Whether the plain-file editor is enabled on this device.
 *
 * Browser: rejects with the typed unsupported outcome. The signature matches
 * the desktop arm so `conformance.ts` can assign the whole module.
 */
export async function plainFileGateGet(): Promise<boolean> {
  return await invoke<boolean>("plugin:plain-file|gate_get");
}

/** Persist the device-local gate. Browser: rejects with the typed unsupported outcome. */
export async function plainFileGateSet(enabled: boolean): Promise<void> {
  await invoke<void>("plugin:plain-file|gate_set", { enabled });
}
