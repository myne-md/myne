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
 * Copy `value` to the clipboard, tell the caller which way it went, and arrange
 * for it to leave the clipboard again where the platform allows that.
 *
 * **A non-null return means the WRITE LANDED. It does not mean a clear is
 * pending.** Where `clipboardAutoClear` is absent the write still happens, the
 * success is still announced, and nothing at all is scheduled, so the returned
 * cancel is a no-op. `null` means one thing only: the write did not happen.
 * Keeping those two apart is the point — a caller that confuses them is one
 * keystroke from telling a user their phrase is safe when it is on the
 * clipboard indefinitely, or the reverse.
 *
 * Callers still invoke the cancel on unmount. On the desktop arm it releases
 * the pending clear's reference to `value`; on the others it costs nothing.
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
    // No auto-clear where the platform cannot perform one (`decisions.md`
    // 2026-08-15). Chosen HERE and passed as a strategy rather than returned
    // early: an early return before the write would report nothing, and one
    // after it would have to re-announce the success this module already owns.
    // What the CALLER owes is a sentence, since `recovery-flow.md` §2.2 forbids
    // presenting a control whose stated protection the client cannot perform,
    // and `PhraseStep` renders it off the same capability.
    has("clipboardAutoClear")
      ? {
          kind: "host" as const,
          delayMs: CLIPBOARD_AUTO_CLEAR_MS,
          clear: (v: string) =>
            invoke("plugin:secret-export|clipboard_clear_if_matches", { value: v }),
        }
      : {
          kind: "none" as const,
          reason:
            "A page is granted no clipboard read in Firefox and only a prompt-plus-focus read elsewhere, so the read-back this clear is gated on cannot run.",
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
  // The download arm, mirroring `saveJsonAsFile` below (`decisions.md`
  // 2026-08-15). `recovery-flow.md` §2.2 requires the save-as-file affordance
  // and this client cannot satisfy the "user-chosen location" half: a page has
  // no arbitrary write path, which is exactly what the absent `nativeSaveAs`
  // capability says. The browser download answers the requirement with the
  // destination the browser chooses, same content, same default filename.
  //
  // The file's exposure is identical on both platforms and is disclosed in the
  // same place on both: `threat-model.md` §5 already says a saved phrase is an
  // ordinary plain-text file that anyone with access to that location can read.
  // What differs is only who picked the location.
  if (!has("nativeSaveAs")) {
    try {
      await deliverFile(defaultPath, new TextEncoder().encode(contents), "text/plain");
    } catch (e) {
      // Swallowed, matching the dialog arm's write failure directly below: this
      // affordance is a convenience beside a phrase that is on screen, and the
      // user has not lost anything a retry cannot get.
      logErrorKind(e, "download-failed");
    }
    return;
  }

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
