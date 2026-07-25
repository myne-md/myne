// Suggested device name (MYND-548) — what the enrollment forms pre-fill their
// "Name this device" field with.
//
// The platform token comes from Rust (`std::env::consts::OS`), NOT from
// `navigator`: keeping one source means the two clients cannot drift into two
// different default-name heuristics, which is the whole reason device names live
// in a single synced map. The token → display word mapping lives in the i18n
// catalogue, so a translator can adapt it without touching the backend.
//
// The result is only a SUGGESTION for an editable field. Whatever the user
// confirms is what gets stored.

import i18n from "../i18n";
import { devicePlatform } from "./prefs";

/** The display word for a platform token, falling back to a neutral label for a
 *  target the catalogue does not know (a new Tauri platform, or the browser dev
 *  shim where the command is unavailable). */
export function deviceNameForPlatform(token: string): string {
  const key = `sync.devices.platform.${token}`;
  const label = i18n.t(key, { defaultValue: "" });
  return label !== "" ? label : i18n.t("sync.devices.platform.unknown");
}

/** Resolve this device's suggested name. Never throws — outside Tauri (or if the
 *  command is unavailable) it degrades to the neutral label rather than blocking
 *  the enrollment form from rendering. */
export async function suggestedDeviceName(): Promise<string> {
  try {
    return deviceNameForPlatform(await devicePlatform());
  } catch {
    return i18n.t("sync.devices.platform.unknown");
  }
}
