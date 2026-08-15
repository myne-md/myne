// Centralises the clipboard auto-clear and save-dialog plumbing for
// vault-creation steps so the 30 s auto-clear window is enforced in
// one place and the step components don't pull in Tauri plugin imports.

import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { logErrorKind } from "./vault-creation-logging";
import { shareFile } from "./share";
import { writeSecret } from "./clipboard";
import { copySecret, type CancelClear, type Feedback } from "@myne/clipboard";

/**
 * Copy a secret to the clipboard and report the outcome.
 *
 * Returns a cancel function on success, or `null` when the write failed. The
 * cancel is a no-op here because the expiry belongs to the OS; it is returned
 * anyway so callers keep one unmount path instead of branching on platform.
 *
 * # This function did not work before myne-md/myne#455
 *
 * It wrote through `@tauri-apps/plugin-clipboard-manager`, whose plugin was
 * registered nowhere on mobile: no Cargo dependency, no `.plugin()` call, no
 * capability grant. Every call was dispatched to a plugin that does not exist
 * and rejected at runtime, so the account-number Copy reported
 * `vaultCreation.account.copyFailed` on every tap, on every device, for as long
 * as it shipped. What kept that from being a silent lie is that
 * myne-md/myne-mobile#51 had already made the caller check the write, which is
 * also why myne-md/myne#390 held this up as the shape for desktop to adopt: the
 * shape was right and the wiring underneath it was never done.
 *
 * # The auto-clear moved into the OS
 *
 * The old body scheduled a JavaScript `setTimeout` that read the clipboard back,
 * compared, and cleared. Three things were wrong with it beyond not running.
 * The read-back needed a clipboard READ, the direction that harvests whatever
 * the user last copied from a password manager. The timer's closure held the
 * secret in the JS heap for the entire window. And a timer dies with the
 * process, which on a phone means most of the time.
 *
 * The native write asks the OS to expire the item instead. That survives the app
 * being killed, holds nothing in the heap, needs no read, and expires THAT item
 * so it can never destroy something the user copied afterwards.
 */
export async function copySecretToClipboard(
  value: string,
  feedback: Feedback,
): Promise<CancelClear | null> {
  return copySecret(
    writeSecret,
    value,
    feedback,
    // The OS owns the window: iOS through the pasteboard item's expiry, Android
    // through a Kotlin-side clear the plugin schedules inside the write. Either
    // way there is nothing for this side to schedule and nothing to cancel.
    { kind: "os-managed" },
    { onError: (e) => logErrorKind(e, "clipboard-write-failed") },
  );
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
