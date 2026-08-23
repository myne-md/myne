// Centralises the clipboard auto-clear and save-dialog plumbing for
// vault-creation steps so the 30 s auto-clear window is enforced in
// one place and the step components don't pull in Tauri plugin imports.

import { invoke } from "../platform/core";
import { documentDir, join } from "../platform/path";
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
 * `Android/data/<pkg>/files/Documents`, which the system Files app and
 * DocumentsUI have refused to navigate into since Android 11 (API 30) while
 * `minSdk` here is 24, and the share sheet is a documented no-op
 * (`share_file.rs`). So on a current Android the write is the delivery and the
 * user has no supported way to reach what was delivered: myne-md/myne#505 is the
 * follow-up, and myne-md/myne#504 is the iOS label that claims otherwise.
 *
 * The file is **excluded from the platform's automatic cloud backup** on both
 * platforms (myne-md/myne#491) — a saved recovery phrase alone reconstructs the
 * vault, and until that landed iCloud Backup and Google Auto Backup carried it
 * off the device. See `mobile/src-tauri/src/backup_exclude.rs`.
 *
 * Resolves to a {@link SecretSaveOutcome} on success, or `null` on failure (the
 * caller shows a message). `filename` should end in `.txt`.
 *
 * **The outcome names the DELIVERY, not a path, and the two platforms have
 * different ones** (myne-md/myne#504). This used to answer `"Documents/<file>"`
 * on both, and on iOS that is a location the user cannot open: the app declares
 * no `UIFileSharingEnabled` and no `LSSupportsOpeningDocumentsInPlace` in either
 * `Info.ios.plist` or the generated plist, so its Documents directory is not in
 * the Files app at all. The share sheet is the only route to the file there, and
 * a user who dismissed it was left holding a success message naming a folder
 * that does not exist for them, for the one file the app produces that is never
 * re-displayable (`recovery-flow.md` §2.4).
 *
 * Adding `UIFileSharingEnabled` is deliberately NOT the fix: it would make the
 * claim true by making a plaintext recovery phrase browsable to anyone holding
 * the unlocked phone.
 *
 * Android keeps the path, because there the share sheet is the documented no-op
 * (`share_file.rs`) and the write IS the delivery. Note that `share_file.rs` and
 * this file's own header disagree about whether that directory is reachable from
 * the system Files app on a current Android; that question is myne-md/myne#505's
 * and is not answered here, so this says only where the file went and promises
 * nothing about which app can browse to it.
 *
 * The `"shared"` sentence names no operating system, and used to name iOS. The
 * probe's failure arm resolves to that same wording deliberately, so on a phone
 * where the platform read failed the sentence would have said "iOS" without
 * anything having established that. What it needs to convey is that the file is
 * not reachable by path and the share sheet is the route, which is true wherever
 * this arm is taken.
 */
export type SecretSaveOutcome =
  /** Written, and the path is meaningful to the user. */
  | { readonly kind: "path"; readonly label: string }
  /** Written inside the app, where only the share sheet can reach it. */
  | { readonly kind: "shared" };

/**
 * Can the user reach the written file by PATH, or only through the share sheet?
 *
 * A named predicate rather than a `platform === "android"` compare at the point
 * of use, following `canHoldSecretOnClipboard` in `clipboardTransport.ts`: the
 * fact being branched on is a property of the delivery, and a bare platform
 * string at the call site invites the next caller to re-derive it from a
 * different premise.
 *
 * Unknown resolves to `false`, the arm that claims LESS: it names no location,
 * so it cannot name a wrong one. That matters because the probe is an IPC read
 * and its failure mode is silence.
 */
async function savedFileIsReachableByPath(): Promise<boolean> {
  return (await devicePlatform().catch(() => "ios")) === "android";
}

export async function saveSecretToDocuments(
  filename: string,
  contents: string,
): Promise<SecretSaveOutcome | null> {
  try {
    const path = await join(await documentDir(), filename);
    await invoke("plugin:secret-export|save_secret_text", { path, contents });
    // Offer the native destination chooser on top of the guaranteed Documents
    // write; additive, so a share cancel still leaves the file saved.
    await shareFile(path);
    // The platform read comes AFTER the write, so a probe failure cannot cost
    // the save.
    return (await savedFileIsReachableByPath())
      ? { kind: "path", label: `Documents/${filename}` }
      : { kind: "shared" };
  } catch (e) {
    logErrorKind(e, "secret-save-failed");
    return null;
  }
}
