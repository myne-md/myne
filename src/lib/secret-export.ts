// Centralises the clipboard auto-clear and save-dialog plumbing for
// vault-creation steps so the 30 s auto-clear window is enforced in
// one place and the step components don't pull in Tauri plugin imports.

import { writeText as clipboardWriteText } from "../platform/clipboardManager";
import { save as dialogSave } from "../platform/dialog";
import { invoke } from "../platform/core";
import { has } from "../platform/capabilities";
import { deliverFile } from "../platform/download";
import { logErrorKind } from "./vault-creation-logging";
import { copySecret, type CancelClear, type Feedback } from "./clipboard";

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
  feedback: Feedback,
): Promise<CancelClear | null> {
  // Delegates to the shared copy-policy chokepoint (myne-md/myne#390). What
  // used to live here, try the write, log the kind on rejection, return `null`
  // with nothing scheduled, otherwise schedule the clear and return a canceller
  //, is that module's `copySecret` verbatim, with the three environmental parts
  // lifted into parameters. This function is now the DESKTOP binding of them:
  // the platform seam's write, the host-side clear, and the vault-creation log
  // discipline.
  //
  // The `feedback` parameter is the point of the exercise. This function
  // previously reported nothing and left every caller to decide, and two of them
  // decided nothing at all, on the screen where a recovery phrase is shown once.
  return copySecret(
    clipboardWriteText,
    value,
    feedback,
    {
      kind: "host",
      delayMs: CLIPBOARD_AUTO_CLEAR_MS,
      clear: (v) => invoke("plugin:secret-export|clipboard_clear_if_matches", { value: v }),
    },
    {
      onError: (e) => logErrorKind(e, "clipboard-write-failed"),
      // A distinct label, because this is the only outcome here that leaves the
      // secret exposed: the write landed, the window passed, and the clear did
      // not run. Collapsing it into the write label made the exposure case
      // unreadable in the one place it is recorded.
      onClearError: (e) => logErrorKind(e, "clipboard-clear-failed"),
    },
  );
}

// Why the clear is a HOST call and not a read-back here (myne#379), kept because
// the reasoning outlives the code that used to sit below it. `recovery-flow.md`
// §2.2 requires the clear to verify the clipboard still holds the phrase, a
// comparison requirement, not a requirement that the WebView be the one
// comparing, and doing it in this file cost a process-lifetime OS-clipboard READ
// grant on the main window for one `setTimeout` body. Read is the more dangerous
// direction than write: a write destroys the user's clipboard, a read harvests
// whatever they last copied from a password manager. Same narrow-seam move
// `saveSecretAsTextFile` below makes for the filesystem.
//
// The command returns nothing and swallows a non-text clipboard (which already
// means our value is gone); a rejection from it is an ACL refusal, not a
// statement about the clipboard's contents.

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
