// The device-local hide-vault-names option (myne-md/myne#411): the types the
// backend answers with, the narrowing that reads its error tag, and the three
// command wrappers.
//
// **Same relative path as `mobile/src/lib/vault-label.ts`, deliberately.** Every
// declaration here was born inside `src/components/settings/PrivacyPanel.tsx`
// and duplicated near-verbatim into the mobile module, which meant
// `scripts/check-twin-drift.mjs` could not see the pair: it discovers twins by
// identical relative path or by its curated list, and a component file matched
// neither. So one side could learn a fifth `kind` tag while the other kept
// classifying it as a generic save failure, and nothing would warn. Living here
// makes the pair discoverable by path, and it stops a component module
// exporting helpers purely so a test can import them.
//
// The store itself (`MYL1`, `protocol.md` § 9.22) is `myne_core::vault_label`.
// Nothing here reads or writes a label: the only value that crosses either way
// is a boolean.

import { invoke } from "../platform/core";

/** Mirrors `myne_core::vault_label::commands::HideVaultNamesView`. */
interface HideVaultNamesView {
  /** `true` when vault names are hidden on this device. */
  hidden: boolean;
}

/** Mirrors `myne_core::vault_label::commands::KeychainStatusView`. */
interface KeychainStatusView {
  /** `true` when the device keychain answered, whether or not it holds anything. */
  available: boolean;
}

/** Mirrors `myne_core::vault_label::commands::HideVaultNamesError`'s `kind` tag. */
export type HideVaultNamesErrorKind =
  | "Io"
  | "Parse"
  | "KeychainUnavailable"
  | "EraseIncomplete";

/** Narrow an unknown thrown value to the backend error's `kind` tag. */
export function hideVaultNamesErrorKind(e: unknown): HideVaultNamesErrorKind | null {
  const kind = (e as { kind?: unknown } | null)?.kind;
  return kind === "Io" ||
    kind === "Parse" ||
    kind === "KeychainUnavailable" ||
    kind === "EraseIncomplete"
    ? kind
    : null;
}

/**
 * What this device can do with vault names.
 *
 * Three values because a failed PROBE is not an unavailable KEYCHAIN. The
 * backend's unavailable case is a value (`{ available: false }`), never a
 * rejection, so a rejection means the question was not answered: a dev context
 * with no host, a client that has not ported the command. Reading that as
 * "unavailable" would put a false explanation on screen and, worse, would be
 * the shape a plaintext fallback later hides behind.
 */
export type KeychainStatus = "available" | "unavailable" | "unknown";

/** Read the device-local flag. Reachable pre-unlock, which is the only moment
 *  it matters. */
export async function readHideVaultNames(): Promise<boolean> {
  const view = await invoke<HideVaultNamesView>("plugin:vault-label|hide_vault_names");
  return view.hidden;
}

/** Write the device-local flag. Turning it ON performs the erase in the same
 *  operation: every per-vault wrap key destroyed and every sealed file removed
 *  BEFORE the flag is persisted, so a failed write leaves names gone and the row
 *  reading "shown" rather than the reverse. Turning it off restores nothing. */
export async function setHideVaultNames(hidden: boolean): Promise<boolean> {
  const view = await invoke<HideVaultNamesView>("plugin:vault-label|set_hide_vault_names", {
    hidden,
  });
  return view.hidden;
}

/**
 * Ask whether this device has a usable keychain at all.
 *
 * A rejection resolves to `"unknown"`, never to `"unavailable"`: the backend
 * reports unavailability as a value, so a rejection means something other than
 * the question was answered, and inferring a security state from it would be a
 * guess. See {@link KeychainStatus}.
 */
export async function readKeychainStatus(): Promise<KeychainStatus> {
  try {
    const view = await invoke<KeychainStatusView>(
      "plugin:vault-label|vault_label_keychain_status",
    );
    return view.available ? "available" : "unavailable";
  } catch {
    return "unknown";
  }
}

/**
 * Which notice is on screen after a failed write. A discriminant rather than a
 * resolved i18n key so every `t()` call site stays a literal:
 * `scripts/check-i18n.mjs` only sees static ones, and a key it cannot see is a
 * key nothing checks.
 */
export type HideNamesNotice = "read" | "save" | "erase";

/**
 * The notice a failed write leaves on screen.
 *
 * `EraseIncomplete` gets its own line because the backend erases FIRST and
 * persists second: a key that survived the sweep means the flag was deliberately
 * not written, so the row still reads "shown" and that is the truth. Collapsing
 * it into a generic save failure would drop the one fact the user needs, which
 * is that the names are still readable.
 *
 * `KeychainUnavailable` is deliberately absent from the return type: it is not a
 * transient failure to report and retry, it is the device's standing state, and
 * the row already carries a line for it.
 */
export function hideNamesWriteNotice(
  kind: HideVaultNamesErrorKind | null,
): HideNamesNotice | null {
  if (kind === "KeychainUnavailable") return null;
  if (kind === "EraseIncomplete") return "erase";
  return "save";
}
