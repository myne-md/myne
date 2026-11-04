// Platform seam: the desktop self-update commands (`plugin:update|*`).
//
// The check and the install run HOST-side in Rust, not through
// `@tauri-apps/plugin-updater` in the WebView. The page reaches exactly these
// two narrow commands, and the result is the closed model in
// `src-tauri/src/update`. A browser cannot update itself, so the capability
// descriptor (`capabilities.ts`, `selfUpdate`) omits the affordance rather than
// showing it against a command that refuses.

import { invoke } from "./core";

/** The running version's update status, as the host reports it. */
export type UpdateStatus =
  | { kind: "up_to_date" }
  | { kind: "available"; version: string; notes: string | null };

/**
 * Why a check failed. A closed set the UI matches to a calm line; the command
 * rejects with one of these values.
 */
export type UpdateCheckError =
  | "unreachable"
  | "verification"
  | "unsupported"
  | "other";

/**
 * The event name `update_install` streams {@link UpdateProgress} on.
 *
 * Mirrors `PROGRESS_EVENT` in `src-tauri/src/update/mod.rs`, which a TypeScript
 * constant cannot import. A rename on one side only is a progress bar that never
 * moves and reports nothing about why: a `listen` on a name nobody emits is a
 * subscription that simply never fires.
 */
export const UPDATE_PROGRESS_EVENT = "update:progress";

/**
 * One tick of an install in flight, as the host reports it.
 *
 * `downloading` carries byte counts rather than a percentage because `total` is
 * genuinely optional: an origin that sends no `Content-Length` gives the host no
 * denominator, and a percentage invented here would be a number nobody measured.
 * `verifying` and `installing` carry nothing of their own; the screen derives its
 * bar from the phase.
 */
export type UpdateProgress =
  | { phase: "downloading"; downloaded: number; total: number | null }
  | { phase: "verifying" }
  | { phase: "installing" };

/** Check for a signed update. Rejects with an {@link UpdateCheckError}. */
export async function updateCheck(): Promise<UpdateStatus> {
  return await invoke<UpdateStatus>("plugin:update|update_check");
}

/** Download and install the offered update, then relaunch. */
export async function updateInstall(): Promise<void> {
  await invoke<void>("plugin:update|update_install");
}

/** Whether this device checks for updates automatically (device-local). */
export async function getAutoCheck(): Promise<boolean> {
  return await invoke<boolean>("plugin:update|update_get_auto_check");
}

/** Set whether this device checks for updates automatically. */
export async function setAutoCheck(enabled: boolean): Promise<void> {
  await invoke<void>("plugin:update|update_set_auto_check", { enabled });
}
