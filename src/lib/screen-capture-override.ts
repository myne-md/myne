// Tauri IPC wrappers for the device-local screen-capture override
// (myne-md/myne#482) and the re-assert after a WebView re-show
// (myne-md/myne#483).
//
// Deliberately NOT in `prefs.ts`. Everything that module carries is a field of
// the encrypted `vault.prefs` (`MYP1`) blob, which is readable only AFTER a
// vault is unlocked. And unreadable-before-unlock is the entire reason this
// setting exists. Protection is always on before unlock, the toggle that could
// clear it is sealed inside a vault, and the control that writes it is in the
// post-unlock Privacy panel, so on Windows a user on remote-control software or
// a screen magnifier sees a black window at the unlock screen with no path to
// anything. What is behind that black window is the account number, the 24-word
// recovery-phrase ceremony and the device-join QR, which makes it a data-loss
// path rather than only an accessibility one.
//
// So it lives in its own device-local file (`<app_config_dir>/screen-capture.json`,
// sibling of `tor-routing.json`, `vault-names.json` and the rest of that
// family) and gets its own commands, reachable pre-unlock.
//
// Signature parity (no codegen, see src/AGENTS.md "Tauri command bindings"):
// keep this in step with `src-tauri/src/plugins/screen_capture/commands.rs`.
//
// Desktop-only. The `screenCaptureProtection` capability is absent on web. A
// page cannot ask a browser to exclude itself from capture, so there is nothing
// to escape from. And the wasm dispatcher answers all three commands with a
// typed refusal.

import { invoke } from "../platform/core";

/** Mirrors `plugins::screen_capture::commands::ScreenCaptureOverrideView`. */
export interface ScreenCaptureOverrideView {
  /** The persisted override, as `screen-capture.json` has it. */
  disabled: boolean;
  /**
   * Whether this run was launched with `--disable-screen-capture-protection`.
   * Not persisted and not clearable: an argv cannot be un-passed.
   */
  via_flag: boolean;
  /** Whether protection is suppressed at all, from either source. */
  effective: boolean;
}

// There is deliberately no `…ErrorKind` narrower here, unlike `vault-label.ts`.
// The backend enum has two variants, `Io` and `Parse`, and neither surface wants
// the distinction: on the WRITE path `Parse` means `serde_json` failed to encode
// one boolean, and both variants reduce to the same sentence a user can act on
// ("that could not be saved; try the process flag"). A narrower nothing calls is
// a contract that drifts unnoticed.

/**
 * Read the override. Answers from backend process state rather than from disk,
 * so what comes back describes the window the user is looking at.
 *
 * An absent file reads as `disabled: false`. Every install that has never
 * opted out. And so does a damaged one, because this file fails towards
 * protection. The process flag is the recovery path for that case.
 */
export async function getScreenCaptureOverride(): Promise<ScreenCaptureOverrideView> {
  return await invoke<ScreenCaptureOverrideView>(
    "plugin:screen-capture|screen_capture_override_get",
  );
}

/**
 * Flip the override. On resolve the file is written and the window already
 * matches it. The backend writes disk first, then makes the native call, so a
 * rejection means nothing was changed on either side.
 *
 * Re-read the returned view rather than assuming the argument took: passing
 * `false` on a flag-launched run records the intent for the next launch and
 * leaves `effective` true, which is the one case a caller must not report as
 * "protection is back on".
 */
export async function setScreenCaptureOverride(
  disabled: boolean,
): Promise<ScreenCaptureOverrideView> {
  return await invoke<ScreenCaptureOverrideView>(
    "plugin:screen-capture|screen_capture_override_set",
    { disabled },
  );
}

/**
 * Ask the host to bring the main window back, protected, after idle auto-lock
 * hid it (myne-md/myne#483).
 *
 * The lock teardown re-applies protection while the window is HIDDEN, and the
 * Windows capture affinity is reported not to survive a hide/show cycle
 * (tauri-apps/tauri#14189, the same defect Electron fixed in
 * electron/electron#45868). Without a re-apply on this path the unlock screen
 * comes back unprotected for the rest of the session, including after the next
 * unlock.
 *
 * **The host performs the whole sequence**, rather than this side calling
 * `window.show()` and a re-apply after it. Two independent calls whose ordering
 * lives in a comment is the shape that failed at the other three re-show sites,
 * and it was worst here. It also let `core:window:allow-show` be dropped, this
 * being its only consumer. That is a TRADE rather than a narrowing: the page
 * loses its one window mutator and gains `unminimize` and `set_focus`, which
 * `core:window:default`'s 28 read-only grants never included. What narrows is
 * parameterisation, since page context chooses none of the values.
 *
 * Takes nothing and chooses nothing. Safe to call more than once.
 */
export async function showWindowProtected(): Promise<void> {
  await invoke<void>("plugin:screen-capture|screen_capture_show_protected");
}
