// Centralises the clipboard auto-clear and save-dialog plumbing for
// vault-creation steps so the 30 s auto-clear window is enforced in
// one place and the step components don't pull in Tauri plugin imports.

import {
  writeText as clipboardWriteText,
  readText as clipboardReadText,
  clear as clipboardClear,
} from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { logErrorKind } from "./vault-creation-logging";
import { shareFile } from "./share";

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

/**
 * Save a secret (recovery phrase / account number) to a `.txt` file in the app's
 * Documents directory, then present the native share sheet (MYND-475) so the
 * user can pick a destination ("Save to Files" elsewhere, AirDrop, etc.). Uses
 * the `myne-core` `secret_export` plugin (the Rust-side write) because the
 * mobile backend has no fs / save-dialog plugin. The plaintext secret is written
 * by the user's explicit intent (threat-model TB3 egress exception).
 *
 * **Where that directory actually is, per platform** (this used to read
 * "reachable via the iOS Files app", which is not true of either platform as
 * shipped): on **iOS** the app declares no `UIFileSharingEnabled`, so `Documents`
 * is NOT browsable in the Files app and the share sheet is the only way the user
 * reaches the file. On **Android** the directory is
 * `Android/data/<pkg>/files/Documents`, reachable from the system Files app, and
 * the share sheet is a documented no-op (`share_file.rs`), so the write itself is
 * the delivery.
 *
 * The file is **excluded from the platform's automatic cloud backup** on both
 * platforms (myne-md/myne#491) — a saved recovery phrase alone reconstructs the
 * vault, and until that landed iCloud Backup and Google Auto Backup carried it
 * off the device. See `mobile/src-tauri/src/backup_exclude.rs`.
 *
 * Resolves to a short display label (`"Documents/<file>"`) on success, or `null`
 * on failure (the caller shows a message). `filename` should end in `.txt`.
 */
export async function saveSecretToDocuments(
  filename: string,
  contents: string,
): Promise<string | null> {
  try {
    const path = await join(await documentDir(), filename);
    await invoke("plugin:secret-export|save_secret_text", { path, contents });
    // Offer the native destination chooser on top of the guaranteed Documents
    // write; additive, so a share cancel still leaves the file saved.
    await shareFile(path);
    return `Documents/${filename}`;
  } catch (e) {
    logErrorKind(e, "secret-save-failed");
    return null;
  }
}
