// Centralises the clipboard auto-clear and save-dialog plumbing for
// vault-creation steps so the 30 s auto-clear window is enforced in
// one place and the step components don't pull in Tauri plugin imports.

import {
  writeText as clipboardWriteText,
  readText as clipboardReadText,
  clear as clipboardClear,
} from "@tauri-apps/plugin-clipboard-manager";
import { save as dialogSave } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
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
