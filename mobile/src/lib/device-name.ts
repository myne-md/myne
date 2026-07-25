// Suggested device name (MYND-548) — what the enrollment flows pre-fill their
// "Name this device" field with.
//
// The platform token comes from Rust (`std::env::consts::OS`), NOT from
// `navigator`: keeping one source means desktop and mobile cannot drift into two
// different default-name heuristics, which is the whole reason device names live
// in a single synced map. The token → display word mapping lives in the shared
// i18n catalogue.
//
// One mobile-only refinement: the OS constant reports `"ios"` for both iPhone and
// iPad (and `"android"` for phone and tablet alike), so this picks the tablet
// wording from the existing size class. That only chooses a better SUGGESTION for
// an editable field — the stored value is whatever the user confirms — so it does
// not reintroduce a second source of truth.

import i18n from "@myne/i18n";
import { devicePlatform } from "./prefs";
import { computeSizeClass } from "../platform/SizeClassContext";

/** The display word for a platform token, falling back to a neutral label for a
 *  target the catalogue does not know (or the browser dev shim, where the command
 *  is unavailable). */
export function deviceNameForPlatform(token: string, tablet: boolean): string {
  const key =
    tablet && token === "ios"
      ? "sync.devices.platform.ipad"
      : tablet && token === "android"
        ? "sync.devices.platform.androidTablet"
        : `sync.devices.platform.${token}`;
  const label = i18n.t(key, { defaultValue: "" });
  return label !== "" ? label : i18n.t("sync.devices.platform.unknown");
}

/** Resolve this device's suggested name. Never throws — outside Tauri it degrades
 *  to the neutral label rather than blocking the enrollment flow from rendering. */
export async function suggestedDeviceName(): Promise<string> {
  try {
    const token = await devicePlatform();
    return deviceNameForPlatform(token, computeSizeClass() !== "compact");
  } catch {
    return i18n.t("sync.devices.platform.unknown");
  }
}
