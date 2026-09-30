// The plain-file editor seam — mobile implementation (myne-md/myne#788).
//
// A deliberate mirror of `src/platform/plainFile.ts`. Mobile has no OS file
// ingress for this feature (its own file flows are the share sheet and the
// importer), so the plugin is never registered here and every command rejects
// at the host. Nothing in the mobile tree imports this module today; it exists
// because the seam's shape is per-client, and a missing counterpart is how a
// shared caller ends up wired to a desktop implementation by accident.
//
// The signature is the contract: same names, same arguments, nothing wrapped.

import { invoke } from "./core";
import { listen, type UnlistenFn } from "./event";

/** An open delivered by a Rust-side ingress (desktop only). */
export type PlainFileOpened = {
  handle: number;
  name: string;
  content: string;
  baseHash: string;
};

/** A read of a handle's current state. */
export type PlainFileContent = {
  content: string;
  baseHash: string;
};

/** Mirror of the desktop constant; the event never fires on mobile. */
const OPENED_EVENT = "plain-file:opened";

/** Whether the plain-file editor is enabled on this device. Mobile: never enabled. */
export async function plainFileGateGet(): Promise<boolean> {
  return await invoke<boolean>("plugin:plain-file|gate_get");
}

/** Persist the device-local gate. Mobile: rejects (the plugin is not registered). */
export async function plainFileGateSet(enabled: boolean): Promise<void> {
  await invoke<void>("plugin:plain-file|gate_set", { enabled });
}

/** Subscribe to opens. Mobile: the event never fires, but the shape matches. */
export async function onPlainFileOpened(
  callback: (opened: PlainFileOpened) => void,
): Promise<UnlistenFn> {
  // Assigning the callback to the listener keeps the signature honest without
  // pretending a delivery path exists on this client.
  return await listen<PlainFileOpened>(OPENED_EVENT, (event) => {
    callback(event.payload);
  });
}

/** Handles an ingress minted before the listener attached. Mobile: rejects. */
export async function plainFileTakeUnclaimed(): Promise<PlainFileOpened[]> {
  return await invoke<PlainFileOpened[]>("plugin:plain-file|plain_file_take_unclaimed");
}

/** Current content and base hash for a handle. Mobile: rejects. */
export async function plainFileRead(handle: number): Promise<PlainFileContent> {
  return await invoke<PlainFileContent>("plugin:plain-file|plain_file_read", { handle });
}

/** Compare-and-swap write. Mobile: rejects. */
export async function plainFileWrite(
  handle: number,
  content: string,
  expectedBase: string,
): Promise<string> {
  return await invoke<string>("plugin:plain-file|plain_file_write", {
    handle,
    content,
    expectedBase,
  });
}

/** Drop a handle. Mobile: rejects. */
export async function plainFileClose(handle: number): Promise<void> {
  await invoke<void>("plugin:plain-file|plain_file_close", { handle });
}
