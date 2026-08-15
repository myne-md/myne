// Vault-name display fallback, plus the device-local hide-vault-names option
// that governs whether a real name may reach the LOCKED picker at all
// (myne-md/myne#411).
//
// The two halves belong in one file because they are one question asked twice:
// what does this device call a vault it cannot open. The fallback answers it
// when there is no name; the option below is what removes every name there is.
//
// The store itself (`MYL1`, `protocol.md` § 9.22) is `myne_core::vault_label`.
// Nothing here reads or writes a label: the only value that crosses either way
// is a boolean.

import i18n from "@myne/i18n";
import { invoke } from "../platform/core";

/** Display name for a vault. Pass `ordinal` in multi-vault lists so unnamed
 *  vaults stay distinguishable ("Vault 2").
 *
 *  **`ordinal` is a stable per-vault number, never a row position.** Callers get
 *  it from `stableVaultNumber` in `./vault-list` (myne-md/myne#411): it used to
 *  be `index + 1` over a last-unlock-ordered list, so the name a user was asked
 *  to remember moved every time they opened a vault. Passing an index here is
 *  the defect, not a shortcut.
 *
 *  **Both fallbacks resolve through the catalog, and both keys already carry all
 *  32 translations.** They were a hardcoded English literal until
 *  myne-md/myne#411 made this branch the PRIMARY rendering rather than a rare
 *  one: the hide-vault-names option erases every stored name at once, and on
 *  Android `platform_keychain` returns `UnavailableKeychain` unconditionally, so
 *  every row on that platform is a fallback always. A Turkish user would have
 *  read "Vault 2" on the phone and "Kasa 2" on the laptop, which is the split
 *  `./vault-list`'s own docstring calls worse than the defect it replaces.
 *  `scripts/check-i18n.mjs` cannot see a literal, so nothing would have said so.
 *
 *  Resolved at CALL time, never frozen at module top level, so a language switch
 *  reaches an already-rendered surface on the next render like every other
 *  string. The keys are the desktop client's own: `vaultPicker.vaultFallback`
 *  numbers a row in a list, `vaultSwitcher.chipFallback` names a single vault
 *  with no list to rank it against. */
export function vaultDisplayLabel(label: string | null | undefined, ordinal?: number): string {
  if (label != null) return label;
  return ordinal != null
    ? i18n.t("vaultPicker.vaultFallback", { n: ordinal })
    : i18n.t("vaultSwitcher.chipFallback");
}

// ── The device-local hide-vault-names option ────────────────────────────────

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
 * rejection, so a rejection means the question was not answered: a browser dev
 * session with no Tauri host, an ACL entry that never landed. Reading that as
 * "unavailable" would put a false explanation on screen and, worse, would be
 * the shape a plaintext fallback later hides behind.
 *
 * `"unavailable"` is a LIVE state here rather than an exotic one, which is the
 * one way mobile differs from the desktop: `platform_keychain` has an Apple
 * backend and returns `UnavailableKeychain` on every other target, so every
 * Android device is in it until an Android Keystore provider is wired behind the
 * `myne-core` seam. That is exactly why the third value has to stay distinct:
 * collapsing "we could not ask" into the state most Android phones are already
 * in would make the row's explanation unfalsifiable.
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
 * resolved i18n key so every `t()` call site stays a literal.
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
