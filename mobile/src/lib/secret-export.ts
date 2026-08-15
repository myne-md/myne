// Centralises the clipboard auto-clear and save-dialog plumbing for
// vault-creation steps so the 30 s auto-clear window is enforced in
// one place and the step components don't pull in Tauri plugin imports.

import {
  writeText as clipboardWriteText,
  readText as clipboardReadText,
  clear as clipboardClear,
} from "../platform/clipboardManager";
import { invoke } from "../platform/core";
import { documentDir, join } from "../platform/path";
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
 * Documents directory — reachable via the iOS Files app — then present the
 * native share sheet (MYND-475) so the user can pick a destination ("Save to
 * Files" elsewhere, AirDrop, etc.). Uses the `myne-core` `secret_export` plugin
 * (the Rust-side write) because the mobile backend has no fs / save-dialog
 * plugin. The plaintext secret is written to a user-visible location by the
 * user's explicit intent (threat-model TB3 egress exception).
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
