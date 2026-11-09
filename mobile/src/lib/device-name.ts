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
import { computeSizeClass, isRegularSizeClass } from "../formfactor/SizeClassContext";

/** The maximum device-name length the UI accepts (MYND-548) — a readability
 *  bound, mirroring the desktop constant. There is no Rust-side cap; the prefs
 *  blob's own size ceiling is the real backstop. */
export const DEVICE_NAME_MAX_LEN = 40;

/** The display word for a platform token, falling back to a neutral label for a
 *  target the catalogue does not know (or the browser dev shim, where the command
 *  is unavailable). */
export function deviceNameForPlatform(token: string, tablet: boolean): string {
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
    // `isRegularSizeClass`, not `!== "compact"`: the folded band (myne-md/myne#918)
    // is a phone-class device in one column, so "this is not the phone layout" is
    // the wrong question and suggested an iPad for an unfolded iPhone.
    return deviceNameForPlatform(token, isRegularSizeClass(computeSizeClass()));
  } catch {
    return i18n.t("common.thisdevice");
  }
}

/** The suggestion as a NAME to write unattended, or `null` when it is not one.
 *
 *  `suggestedDeviceName` falls back to the neutral "we do not know this
 *  platform" label, which is fine as a pre-filled field a human then edits and
 *  wrong as a name written without them: it would print the same words in the
 *  row's title and in the "This device" badge beside it (myne-md/myne#973). The
 *  self-naming path therefore writes nothing in that case and the row keeps its
 *  id-derived label. */
export async function nameableDeviceSuggestion(): Promise<string | null> {
  const name = await suggestedDeviceName();
  return name === i18n.t("common.thisdevice") ? null : name;
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
  // Seeded synchronously with the neutral label, NOT "": `resolved` must never be
  // blank, or a submit landing before the platform IPC resolves would send an
  // empty name and the device would arrive with the id-derived fallback.
  const [suggestion, setSuggestion] = useState(() => i18n.t("common.thisdevice"));

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
