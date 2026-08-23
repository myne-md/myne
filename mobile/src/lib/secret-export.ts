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
 * The `"shared"` sentence names no operating system, and used to name iOS. It is
 * also no longer where a failed probe lands: that has its own arm now, because
 * the sentence tells the user to use the share sheet and Android's is a
 * documented no-op, so on an Android phone whose probe failed the app pointed at
 * an affordance that never appears and offered "tap Save again" to bring it
 * back.
 */
export type SecretSaveOutcome =
  /** Written, and the path is meaningful to the user. */
  | { readonly kind: "path"; readonly label: string }
  /** Written inside the app, where only the share sheet can reach it. */
  | { readonly kind: "shared" }
  /**
   * Written, and nothing else is known.
   *
   * The platform probe is an IPC read and it can fail. The two arms above are
   * both CLAIMS about a file holding a plaintext recovery phrase, on the one
   * screen `recovery-flow.md` §2.4 says is never re-displayable, and §2.2 in
   * this same spec now says a success may claim only what the client observed.
   * Routing an unknown platform into `"shared"` was the smaller claim of the
   * two and still not an observed one: on an Android device whose probe failed
   * it told the user to use a share sheet that `share_file.rs` documents as a
   * no-op there, and to tap Save again to bring back a sheet that never
   * appeared. The write is the only thing this arm witnessed, so it is the only
   * thing it says.
   */
  | { readonly kind: "written" };

/**
 * Which {@link SecretSaveOutcome} the platform's delivery calls for.
 *
 * A named predicate rather than a `platform === "android"` compare at the point
 * of use, following `canHoldSecretOnClipboard` in `clipboardTransport.ts`: the
 * fact being branched on is a property of the delivery, and a bare platform
 * string at the call site invites the next caller to re-derive it from a
 * different premise.
 *
 * It returns the outcome's own `kind` rather than a second three-value
 * vocabulary, because a private `"path" | "share-sheet" | "unknown"` mapped 1:1
 * onto the public one and the only thing between them was an if-chain at the
 * caller: two names for each of three facts.
 *
 * `"written"` is its own answer rather than folded into either real one, because
 * both real ones are CLAIMS and a failed probe has established neither. The
 * failure mode of an IPC read is silence, so folding it in is how a claim gets
 * made about a device nobody asked.
 */
async function savedFileDelivery(): Promise<SecretSaveOutcome["kind"]> {
  const platform = await devicePlatform().catch(() => null);
  if (platform === null) return "written";
  return platform === "android" ? "path" : "shared";
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
    // the save. It can only cost the app the right to say where the file went,
    // which is what the third arm is.
    const kind = await savedFileDelivery();
    return kind === "path" ? { kind, label: `Documents/${filename}` } : { kind };
  } catch (e) {
    logErrorKind(e, "secret-save-failed");
    return null;
  }
}
