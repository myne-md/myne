// The plain-file editor seam: desktop implementation (myne-md/myne#788).
//
// The commands take an OPAQUE HANDLE and never a path: a path only enters Rust
// from an OS ingress or a native dialog, where it is canonicalised and minted.
// The WebView therefore cannot name a file this surface will touch, which is
// what makes "sandboxed" structural rather than a promise. See
// `src-tauri/src/plugins/plain_file/handles.rs`.
//
// The gate (`plainFileGateGet` / `plainFileGateSet`) is a device-local JSON
// file, its own file rather than a `vault.prefs` field, because the surface it
// guards must work with the vault locked and with no vault at all.

import { invoke } from "./core";
import { listen, type UnlistenFn } from "./event";

/** An open delivered by a Rust-side ingress (argv, OS open event). */
export type PlainFileOpened = {
  handle: number;
  /** File name only. A full path never crosses IPC. */
  name: string;
  /** The file's text, `\n`-normalised (CRLF files are converted in Rust). */
  content: string;
  /** SHA-256 of the bytes ON DISK, for the compare-and-swap on write. */
  baseHash: string;
};

/** A read of a handle's current state. */
export type PlainFileContent = {
  content: string;
  baseHash: string;
};

/** Rust event name; mirrors `plain_file::ingest::OPENED_EVENT`. */
const OPENED_EVENT = "plain-file:opened";

/**
 * Whether the plain-file editor is enabled on this device.
 *
 * Answers `false` on every failure: an unreadable gate is never read as
 * enabled.
 */
export async function plainFileGateGet(): Promise<boolean> {
  return await invoke<boolean>("plugin:plain-file|gate_get");
}

/** Persist the device-local gate. */
export async function plainFileGateSet(enabled: boolean): Promise<void> {
  await invoke<void>("plugin:plain-file|gate_set", { enabled });
}

/**
 * Subscribe to opens that arrive while the app is running.
 *
 * The startup argv ingest runs before the WebView can attach this listener, so
 * a cold launch is recovered by {@link plainFileTakeUnclaimed} instead. Both
 * paths deliver the same `{ handle, ... }`, and a store keyed by handle
 * collapses a double delivery.
 */
export async function onPlainFileOpened(
  callback: (opened: PlainFileOpened) => void,
): Promise<UnlistenFn> {
  return await listen<PlainFileOpened>(OPENED_EVENT, (event) => {
    callback(event.payload);
  });
}

/** Handles an ingress minted before the listener attached (cold launch). */
export async function plainFileTakeUnclaimed(): Promise<PlainFileOpened[]> {
  return await invoke<PlainFileOpened[]>("plugin:plain-file|plain_file_take_unclaimed");
}

/** Current content and on-disk base hash for a handle. */
export async function plainFileRead(handle: number): Promise<PlainFileContent> {
  return await invoke<PlainFileContent>("plugin:plain-file|plain_file_read", { handle });
}

/**
 * Write `content` when the file still hashes to `expectedBase`.
 *
 * Resolves to the hash of the bytes written (the next expected base) and
 * rejects with `kind: "conflict"` when the file changed, was deleted or was
 * replaced outside Myne.
 */
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

/** Drop a handle. Idempotent. */
export async function plainFileClose(handle: number): Promise<void> {
  await invoke<void>("plugin:plain-file|plain_file_close", { handle });
}
