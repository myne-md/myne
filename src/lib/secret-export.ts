// Centralises the clipboard auto-clear and save-dialog plumbing for
// vault-creation steps so the 30 s auto-clear window is enforced in
// one place and the step components don't pull in Tauri plugin imports.

import {
  writeText as clipboardWriteText,
  readText as clipboardReadText,
  clear as clipboardClear,
} from "../platform/clipboardManager";
import { save as dialogSave } from "../platform/dialog";
import { invoke } from "../platform/core";
import { has } from "../platform/capabilities";
import { deliverFile } from "../platform/download";
import { logErrorKind } from "./vault-creation-logging";

const CLIPBOARD_AUTO_CLEAR_MS = 30_000;

/**
 * Copy `value` to the clipboard and schedule a 30 s auto-clear that
 * only fires if the clipboard still holds exactly `value`.
 *
 * Returns a cancel function callers MUST invoke on unmount — otherwise
 * the timer's closure keeps `value` (a secret) alive in the JS heap
 * for the full 30 s. Returns `null` when the clipboard write itself
 * failed; in that case nothing is scheduled.
 */
export async function copySecretToClipboard(
  value: string,
): Promise<(() => void) | null> {
  try {
    await clipboardWriteText(value);
  } catch (e) {
    logErrorKind(e, "clipboard-write-failed");
    return null;
  }
  // `readText` rejects when the clipboard holds non-text content
  // (image, file, empty) — that already means our value is gone, so
  // swallow and skip the clear.
  const timer = setTimeout(async () => {
    try {
      const current = await clipboardReadText();
      if (current === value) await clipboardClear();
    } catch {
      // Clipboard moved on; nothing to clear.
    }
  }, CLIPBOARD_AUTO_CLEAR_MS);
  return () => clearTimeout(timer);
}

export async function saveSecretAsTextFile(
  defaultPath: string,
  contents: string,
): Promise<void> {
  let path: string | null;
  try {
    path = await dialogSave({
      defaultPath,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
  } catch (e) {
    logErrorKind(e, "dialog-save-failed");
    return;
  }
  if (!path) return;
  try {
    // Narrow seam: the Rust core does the only IO. The WebView holds NO
    // fs-write scope (removed from capabilities/default.json); the command
    // re-validates the destination and rejects the app-data / vault tree.
    await invoke("plugin:secret-export|save_secret_text", { path, contents });
  } catch (e) {
    logErrorKind(e, "fs-write-failed");
  }
}

/**
 * Save plaintext `contents` as a user-chosen `.json` file via the same
 * narrow save-seam as {@link saveSecretAsTextFile} (the Rust core does the only
 * IO; the WebView holds no fs-write scope, and the command re-validates the
 * destination against the app-data / vault tree). Used by the custom-theme
 * export (MYND-486) — a palette is not secret, but reusing this one file-write
 * path keeps the seam narrow. A cancelled dialog resolves silently; a write
 * failure REJECTS so the caller can surface it.
 */
export async function saveJsonAsFile(
  defaultPath: string,
  contents: string,
  filterName: string,
): Promise<void> {
  // The download arm (phase3-web-client task 97). This is the LAST of the four
  // formats that task left without a verdict, and its verdict is "ships" rather
  // than "absent" — a single file, which is exactly the case task 48 settled.
  //
  // **No egress disclosure here, and the distinction is the point.** Every other
  // download path in the client carries one because it delivers vault
  // plaintext. A palette is a set of colour values the user authored in
  // Settings: it is not note content, not a credential, and not derived from
  // either. Attaching an egress sentence to it would train the user to click
  // through the sentence on the paths where it means something — which is the
  // failure the say-it-once rule exists to prevent, arrived at from the other
  // direction.
  //
  // The name says `secret` because the sibling in this file writes recovery
  // material through the same narrow Rust seam; the palette rides it only so
  // there is one fs-write path, not because it is secret. On web there is no fs
  // write to narrow — the browser owns the destination — so the seam question
  // does not arise.
  if (!has("nativeSaveAs")) {
    try {
      await deliverFile(defaultPath, new TextEncoder().encode(contents), "application/json");
    } catch (e) {
      // REJECTS, like the dialog arm's write failure: the caller surfaces it.
      logErrorKind(e, "download-failed");
      throw e;
    }
    return;
  }

  let path: string | null;
  try {
    path = await dialogSave({
      defaultPath,
      filters: [{ name: filterName, extensions: ["json"] }],
    });
  } catch (e) {
    // A dialog-open failure is indistinguishable from a cancel to the user;
    // swallow it (nothing was written) rather than surfacing a scary error.
    logErrorKind(e, "dialog-save-failed");
    return;
  }
  if (!path) return; // user cancelled the save dialog
  await invoke("plugin:secret-export|save_secret_text", { path, contents });
}
