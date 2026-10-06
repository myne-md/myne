// The mobile clipboard TRANSPORT (myne-md/myne#390 + myne-md/myne#455).
//
// Named `clipboardTransport` rather than `clipboard` on purpose. The shared
// POLICY module is `src/lib/clipboard.ts`, aliased into this tree as
// `@myne/clipboard`, and it decides what the user is told. This file decides
// how the bytes reach the OS. Two different questions, and while the two files
// shared a basename the twin sweep paired them as one module answered twice,
// which is the opposite of true: neither is a copy of the other, and a verdict
// saying they should converge would have been wrong.
//
// One module, so the transport has one home. Before this, the mobile tree had
// three: `secret-export.ts` reached `@tauri-apps/plugin-clipboard-manager`, the
// editor flow's note copy called the WebView API directly, and the recover
// screen read through it. Only the middle one worked.
//
// # The bug this replaces
//
// `@tauri-apps/plugin-clipboard-manager` was in `mobile/package.json` and the
// plugin behind it was registered NOWHERE: no Cargo dependency, no `.plugin()`
// call in the mobile builder, no capability grant. Every call through it was an
// `invoke` against a plugin that does not exist, so it rejected at runtime. The
// account-number Copy on the vault-creation screen therefore reported its
// copy-failed string on every tap, on every device, since it shipped (the key was
// `vaultCreation.account.copyFailed`, retired with that step when the recovery kit
// merged the two in myne-md/myne#468), and the only reason that was honest rather than a silent lie is that
// myne-md/myne-mobile#51 had already made it check the write.
//
// The JS dependency is gone from `mobile/package.json` in the same change. The
// ROOT `package.json` keeps it, because the desktop platform seam re-exports
// from it.
//
// # Why not just register that plugin
//
// It has one write. This seam has two, and the second is the point: a SECRET
// write asks the OS to confine the value to this device and to expire it, which
// no generic clipboard plugin exposes and no JavaScript timer can substitute
// for. See `mobile/src-tauri/tauri-plugin-sensitive-clipboard/src/lib.rs`.
//
// # The read is not here
//
// Deliberately. It is an OPTIONAL member added by the task that needs it (the
// recovery-phrase paste), and the desktop seam refuses it outright: a write
// destroys the user's clipboard, a read harvests whatever they last copied from
// a password manager.

import { invoke } from "../platform/core";
import { devicePlatform } from "./prefs";

/**
 * Write ordinary, non-secret text: a note body, a wikilink.
 *
 * No device confinement and no expiry, on purpose. Someone copying a note may
 * well want it on their Mac, and expiring their note out from under them thirty
 * seconds later would be a bug wearing a security feature's clothes.
 *
 * Rejects when the write did not happen, which is what lets the shared copy
 * policy report a refusal instead of pretending.
 */
export async function writeText(value: string): Promise<void> {
  await invoke("plugin:sensitive-clipboard|write_text", { value });
}

/**
 * Write a credential: the account number, or the recovery phrase on the one
 * platform that offers it.
 *
 * On iOS the OS is asked to keep the item on this device AND to drop it after
 * the window. Those two are a pair rather than two settings: with confinement
 * off, the expiry does not reliably reach Universal Clipboard, so the value
 * stays pasteable on nearby devices long after it expired locally.
 *
 * On Android neither exists. What is available is a redaction hint (API 33+,
 * which suppresses the paste preview but does NOT stop a clipboard manager from
 * reading the value) plus a best-effort clear. That gap is why the
 * recovery-phrase Copy is withheld on Android entirely rather than gated to a
 * recent version.
 */
export async function writeSecret(value: string): Promise<void> {
  await invoke("plugin:sensitive-clipboard|write_secret", { value });
}

/**
 * Can this OS hold a Tier 1 secret to the standard Tier 1 requires?
 *
 * Tier 1 is the recovery phrase, and the standard is two properties TOGETHER:
 * the item stays on THIS device, and the OS drops it on a timer it enforces.
 *
 * **iOS: yes.** `UIPasteboard`'s `.localOnly` and `.expirationDate`, set as a
 * pair on every secret write. The constraint is not the iOS version, both are
 * long-standing API, it is that they must be set together, because with
 * confinement off the expiry does not reliably reach Universal Clipboard.
 *
 * **Android: no, on every version.** There is no device-confinement flag and no
 * per-item expiry at any API level. What exists is `EXTRA_IS_SENSITIVE`
 * (API 33+), which redacts the paste PREVIEW and does not stop a clipboard
 * manager reading the value, plus a clear this app schedules. That is enough for
 * Tier 2 (the account number, which alone opens nothing) and not for Tier 1
 * (the phrase, which alone reconstructs the vault).
 *
 * The consumer is a RENDER gate, not a runtime check wrapped around a call:
 * where this answers `false`, the Copy control is not drawn at all. An
 * affordance that appears and then explains why it is weaker is still an
 * affordance implying a guarantee.
 *
 * Asked here rather than sniffed from `navigator`, for the reason
 * `devicePlatform` itself gives: one source, so the two clients cannot drift
 * into two heuristics.
 */
export async function canHoldSecretOnClipboard(): Promise<boolean> {
  if (!IOS_PASTEBOARD_VERIFIED) return false;
  return (await devicePlatform()) === "ios";
}

/**
 * Has the iOS pasteboard behaviour actually been OBSERVED on hardware?
 *
 * `false`, and the affordance stays hidden until it is not.
 *
 * The platform check above is written and correct. What is missing is evidence:
 * `.localOnly` and `.expirationDate` have been read in Apple's documentation and
 * never watched working. `design-notes/clients/0511-…` closes on "Blocked on a
 * hardware check", and `docs/dev/clipboard-sensitivity-verification.md` says in
 * as many words that if check 1 or check 2 fails, Tier 1 is reconsidered rather
 * than shipped with a caveat.
 *
 * Rendering the button meanwhile would have the product assert an unmeasured OS
 * behaviour to the user, about the one asset whose leak is total vault
 * reconstruction. `docs/threat-model.md` is normative and its §6 fixes the
 * order: never ship the copy and verify afterwards.
 *
 * TO UNBLOCK: run the runbook's three iOS checks, record the OS versions in the
 * feature's `progress.md`, and flip this to `true`. One line, deliberately -
 * which is why it is a constant a reviewer can see move rather than a comment
 * someone can read past.
 */
const IOS_PASTEBOARD_VERIFIED = false;

/**
 * Read the clipboard's text, or `null` when it holds none.
 *
 * OPTIONAL and MOBILE-ONLY, and both halves of that are deliberate.
 *
 * `readText` was REMOVED from the shared platform seam under myne#379, with the
 * reasoning recorded in `src/platform/clipboardManager.ts`: a write destroys the
 * user's clipboard, a read harvests whatever they last copied from a password
 * manager, and "an unused seam member is a door the next caller can reopen with
 * no ACL edit and no review". Putting it back there would reopen that door on
 * desktop and on web to serve one mobile screen.
 *
 * So it lives here, on the mobile seam alone, exported as an optional capability
 * the callers probe for. Desktop and web have no such export, so the Paste
 * affordance does not render there at all, the same shape `EditorHost`'s
 * `pickFiles?` already uses for a picker a host may not have: a host that cannot
 * do the thing omits the member, and the caller renders no affordance rather
 * than one that throws.
 *
 * The one caller is the recovery screen. Making someone type twenty-four words
 * on a phone is not a neutral alternative: it pushes them to screenshot their
 * recovery phrase instead, which is strictly worse and which the screen-guard
 * plugin exists to prevent. On iOS 16 and later this read triggers the system
 * "Allow Paste?" prompt, so the user confirms per read and the app holds no
 * ambient access to the clipboard.
 *
 * Returns `null` rather than `""` when the clipboard holds no text, so a Paste
 * cannot clear a field the user has already started filling.
 */
export async function readText(): Promise<string | null> {
  const res = await invoke<{ value?: string | null }>(
    "plugin:sensitive-clipboard|read_text",
  );
  return res.value ?? null;
}
