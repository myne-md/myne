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
// wording from the existing size class. That class models the WINDOW, not the
// hardware, so it guesses wrong for an iPad in Slide Over — accepted, because this
// only chooses a better starting SUGGESTION for an editable field. A real
// form-factor signal would have to come from the same command as the token.

import { useEffect, useState } from "react";
import i18n from "@myne/i18n";
import { devicePlatform } from "./prefs";
import { computeSizeClass } from "../platform/SizeClassContext";

/** The maximum device-name length the UI accepts (MYND-548) — a readability
 *  bound, mirroring the desktop constant. There is no Rust-side cap; the prefs
 *  blob's own size ceiling is the real backstop. */
export const DEVICE_NAME_MAX_LEN = 40;

/** The display word for a platform token, falling back to a neutral label for a
 *  target the catalogue does not know (or the browser dev shim, where the command
 *  is unavailable). */
function deviceNameForPlatform(token: string, tablet: boolean): string {
  const tabletKey =
    token === "ios" ? "sync.devices.platform.ipad" : "sync.devices.platform.androidTablet";
  return i18n.t([
    ...(tablet ? [tabletKey] : []),
    `sync.devices.platform.${token}`,
    "sync.devices.platform.unknown",
  ]);
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

/** The "Name this device" field's state, shared by both mobile enrollment doors so
 *  they cannot drift. `resolved` is what to submit — never blank, which matters
 *  because the backend refuses a blank name outright. */
export function useDeviceNameField(): {
  value: string;
  setValue: (next: string) => void;
  suggestion: string;
  resolved: string;
} {
  const [value, setValue] = useState("");
  const [suggestion, setSuggestion] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await suggestedDeviceName();
      if (cancelled) return;
      setSuggestion(next);
      // Functional update: a late-resolving suggestion must never clobber what the
      // user already typed.
      setValue((current) => (current === "" ? next : current));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { value, setValue, suggestion, resolved: value.trim() !== "" ? value.trim() : suggestion };
}
