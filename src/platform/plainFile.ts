// The plain-file editor seam: desktop implementation (myne-md/myne#788).
//
// The handle commands take an OPAQUE HANDLE and never a path: a path enters
// Rust from an OS ingress, where it is canonicalised and minted, and the
// WebView cannot name a file those commands will touch. See
// `src-tauri/src/plugins/plain_file/handles.rs`.
//
// The two ingress-shaped exceptions are deliberate and narrow. A
// `myne://open-file` URL is delivered to the WebView by the OS, so the deep
// link's path necessarily passes through JS: `plainFileResolvePath` returns
// only the RESOLVED canonical path (for the confirmation layer, so the user
// sees the real target), and `plainFileOpenConfirmed` re-validates from
// scratch host-side before anything is read. `plainFileOpenDialog` returns
// nothing at all: the native dialog runs host-side.
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

/**
 * Save the buffer to a file the user names (the conflict banner's copy arm).
 *
 * The native save dialog runs host-side, so no path crosses IPC in either
 * direction. Resolves to the written file's NAME, or `null` when the dialog
 * was cancelled.
 */
export async function plainFileSaveCopy(
  handle: number,
  content: string,
): Promise<string | null> {
  return await invoke<string | null>("plugin:plain-file|plain_file_save_copy", {
    handle,
    content,
  });
}

/**
 * The in-app Open: a native Markdown-filtered dialog, then the shared ingest.
 *
 * The picked file arrives through the same `plain-file:opened` event every
 * other ingress uses; no path is returned to the WebView. A cancelled dialog
 * resolves normally. Rejects with the plugin's typed refusal (gate off,
 * unsupported type, too large, unreadable).
 */
export async function plainFileOpenDialog(): Promise<void> {
  await invoke<void>("plugin:plain-file|plain_file_open_dialog");
}

/**
 * Canonicalise a caller-named path for the deep link's confirmation layer.
 *
 * `path` comes from a `myne://open-file` URL, which any website can mint, so
 * the host gate-checks it and answers with the RESOLVED canonical path: the
 * confirmation shows what would actually open, not what the link claimed.
 * Reads no content and mints no handle.
 */
export async function plainFileResolvePath(path: string): Promise<string> {
  return await invoke<string>("plugin:plain-file|plain_file_resolve_path", {
    path,
  });
}

/**
 * The deep link's confirmed open.
 *
 * The host re-checks the gate, the extension and the size cap on the
 * canonical path and funnels the file through the same ingest every OS
 * ingress uses. Nothing opens before this call, and the tab arrives through
 * `plain-file:opened` rather than as a return value.
 */
export async function plainFileOpenConfirmed(path: string): Promise<void> {
  await invoke<void>("plugin:plain-file|plain_file_open_confirmed", { path });
}
