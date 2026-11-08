// Centralises the clipboard auto-clear and save-dialog plumbing for
// vault-creation steps so the 30 s auto-clear window is enforced in
// one place and the step components don't pull in Tauri plugin imports.

import { invoke } from "../platform/core";
import { exportPath } from "../platform/path";
import { devicePlatform } from "./prefs";
import { logErrorKind } from "./vault-creation-logging";
import { shareFile } from "./share";
import { writeSecret } from "./clipboardTransport";
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
 * and rejected at runtime, so the account-number Copy reported its copy-failed
 * string on every tap, on every device, for as long as it shipped. (That key was
 * `vaultCreation.account.copyFailed`; it retired with the account step when the
 * recovery kit merged the two in myne-md/myne#468.) What kept that from being a silent lie is that
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
 * Documents directory, then present the platform destination chooser (MYND-475)
 * so the user can pick where it goes: iOS's share sheet ("Save to Files",
 * AirDrop, …) or Android's Storage Access Framework picker (myne-md/myne#505).
 * Uses
 * the `myne-core` `secret_export` plugin (the Rust-side write) because the
 * mobile backend has no fs / save-dialog plugin. The plaintext secret is written
 * by the user's explicit intent (threat-model TB3 egress exception).
 *
 * **Where that directory actually is, per platform** (this used to read
 * "reachable via the iOS Files app", which is not true of either platform as
 * shipped): on **iOS** the app declares no `UIFileSharingEnabled`, so `Documents`
 * is NOT browsable in the Files app. On **Android** the directory is
 * `Android/data/<pkg>/files/Documents`, which the system Files app and
 * DocumentsUI have refused to navigate into since Android 11 (API 30) while
 * `minSdk` here is 24. Neither platform can open the directory, so the platform
 * chooser is the user's ONLY route to the file on both: iOS's share sheet, and
 * since myne-md/myne#505 Android's Storage Access Framework picker, where the
 * user picks the destination and the bytes are written there. Before #505 the
 * Android arm was a documented no-op, so the write was the delivery and nothing
 * delivered.
 *
 * The file is **excluded from the platform's automatic cloud backup** on both
 * platforms (myne-md/myne#491) — a saved recovery phrase alone reconstructs the
 * vault, and until that landed iCloud Backup and Google Auto Backup carried it
 * off the device. See `mobile/src-tauri/src/backup_exclude.rs`.
 *
 * Resolves to a {@link SecretSaveOutcome} on success, or `null` on failure (the
 * caller shows a message). `filename` should end in `.txt`.
 *
 * **The outcome names the DELIVERY, not a path** (myne-md/myne#504, and #505 for
 * the Android half). This used to answer `"Documents/<file>"` on Android, naming
 * a folder no app on that phone can open; on iOS the same answer named a folder
 * missing from the Files app. A success may claim only what the client observed
 * (`recovery-flow.md` §2.2), and what it observed is that it wrote the file and
 * offered the chooser.
 *
 * Adding `UIFileSharingEnabled` is deliberately NOT the fix: it would make the
 * claim true by making a plaintext recovery phrase browsable to anyone holding
 * the unlocked phone.
 */
export type SecretSaveOutcome =
  /** Written inside the app, and offered to the platform chooser. */
  | { readonly kind: "shared" }
  /**
   * Written, and nothing else is known.
   *
   * The platform probe is an IPC read and it can fail. Both real arms are CLAIMS
   * about a file holding a plaintext recovery phrase, on the one screen
   * `recovery-flow.md` §2.4 says is never re-displayable, and §2.2 of the same
   * spec says a success may claim only what the client observed. A failed probe
   * observed the write and nothing else, so that is all this arm says.
   */
  | { readonly kind: "written" };

/**
 * Which {@link SecretSaveOutcome} the platform's delivery calls for.
 *
 * A named predicate rather than a platform compare at the point of use,
 * following `canHoldSecretOnClipboard` in `clipboardTransport.ts`: the fact being
 * branched on is a property of the delivery, and a bare platform string at the
 * call site invites the next caller to re-derive it from a different premise.
 *
 * **Both known platforms now answer `"shared"`**, which is why the Android arm
 * returns that rather than `"path"`: since myne-md/myne#505 Android presents the
 * Storage Access Framework picker, so no platform's delivery can be described as
 * a path the user can open. `"written"` stays its own answer for a probe that
 * failed, because both real arms are claims and a failure has established
 * neither.
 */
async function savedFileDelivery(): Promise<SecretSaveOutcome["kind"]> {
  const platform = await devicePlatform().catch(() => null);
  return platform === null ? "written" : "shared";
}

/**
 * The i18n key (and params) that states what {@link saveSecretToDocuments}
 * actually did.
 *
 * **Shared rather than repeated, because it had already been written twice.**
 * `CreateVaultFlow` carried this `switch` and the identity flow needed the same
 * one for its own phrase screen (myne-md/myne#970); a second copy of a
 * three-arm switch over a union is how one screen keeps a claim the other has
 * stopped making, which is exactly the drift `savedFileDelivery` above was
 * factored out to prevent.
 *
 * A `switch` over the union rather than a ternary chain: a third `kind` becomes
 * a compile error here instead of falling into whichever arm happens to be last.
 * The sentences differ in exactly what they CLAIM, which is the point of the
 * union: one names the chooser as the route and one names neither, because the
 * probe that would have established the first failed.
 */
export function secretSaveMessage(
  outcome: SecretSaveOutcome | null,
): { key: string; params?: Record<string, string> } {
  if (outcome === null) return { key: "createVault.saveFileError" };
  switch (outcome.kind) {
    case "shared":
      return { key: "createVault.savedToShareSheet" };
    case "written":
      return { key: "createVault.savedFileWritten" };
  }
}

export async function saveSecretToDocuments(
  filename: string,
  contents: string,
): Promise<SecretSaveOutcome | null> {
  try {
    const { path } = await exportPath(filename);
    await invoke("plugin:secret-export|save_secret_text", { path, contents });
    // Offer the platform destination chooser on top of the guaranteed Documents
    // write; additive, so dismissing it still leaves the file saved.
    await shareFile(path);
    // The platform read comes AFTER the write, so a probe failure cannot cost
    // the save. It can only cost the app the right to say a chooser was offered,
    // which is what the third arm is.
    return { kind: await savedFileDelivery() };
  } catch (e) {
    logErrorKind(e, "secret-save-failed");
    return null;
  }
}
