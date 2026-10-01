// The plain-file editor seam: browser implementation (myne-md/myne#788).
//
// A deliberate mirror of `src/platform/plainFile.ts`: the browser arm must
// keep the identical signature, and there is no browser behaviour to give it.
// The feature is decided-absent on web (the PRD's `absent` verdict;
// `web/wasm/src/capability.rs` classifies the whole `plain-file` plugin as
// `Unsupported`), so routing the commands into the Worker transport is the
// honest implementation: the transport answers the one typed
// `PlatformUnsupportedError`, and nothing here hand-rolls a refusal shape the
// seam contract would then have to special-case.
//
// The surface that calls these never renders in a browser, so the commands are
// reachable only through a stale deep link or a replayed command: exactly the
// paths the typed refusal exists for.

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

/** Mirror of the desktop constant; the event never fires on web. */
const OPENED_EVENT = "plain-file:opened";

/** Whether the plain-file editor is enabled on this device. Browser: rejects. */
export async function plainFileGateGet(): Promise<boolean> {
  return await invoke<boolean>("plugin:plain-file|gate_get");
}

/** Persist the device-local gate. Browser: rejects. */
export async function plainFileGateSet(enabled: boolean): Promise<void> {
  await invoke<void>("plugin:plain-file|gate_set", { enabled });
}

/** Subscribe to opens. Browser: the event never fires, but the shape matches. */
export async function onPlainFileOpened(
  callback: (opened: PlainFileOpened) => void,
): Promise<UnlistenFn> {
  return await listen<PlainFileOpened>(OPENED_EVENT, (event) => {
    callback(event.payload);
  });
}

/** Handles an ingress minted before the listener attached. Browser: rejects. */
export async function plainFileTakeUnclaimed(): Promise<PlainFileOpened[]> {
  return await invoke<PlainFileOpened[]>("plugin:plain-file|plain_file_take_unclaimed");
}

/** Current content and base hash for a handle. Browser: rejects. */
export async function plainFileRead(handle: number): Promise<PlainFileContent> {
  return await invoke<PlainFileContent>("plugin:plain-file|plain_file_read", { handle });
}

/** Compare-and-swap write. Browser: rejects. */
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

/** Drop a handle. Browser: rejects. */
export async function plainFileClose(handle: number): Promise<void> {
  await invoke<void>("plugin:plain-file|plain_file_close", { handle });
}

/** Save-copy to a user-named file. Browser: rejects (no native save dialog). */
export async function plainFileSaveCopy(
  handle: number,
  content: string,
): Promise<string | null> {
  return await invoke<string | null>("plugin:plain-file|plain_file_save_copy", {
    handle,
    content,
  });
}

/** The in-app Open. Browser: rejects (no OS file ingress). */
export async function plainFileOpenDialog(): Promise<void> {
  await invoke<void>("plugin:plain-file|plain_file_open_dialog");
}

/** Deep-link resolve. Browser: rejects (the route is ignored before this). */
export async function plainFileResolvePath(path: string): Promise<string> {
  return await invoke<string>("plugin:plain-file|plain_file_resolve_path", {
    path,
  });
}

/** Confirmed deep-link open. Browser: rejects. */
export async function plainFileOpenConfirmed(path: string): Promise<void> {
  await invoke<void>("plugin:plain-file|plain_file_open_confirmed", { path });
}
