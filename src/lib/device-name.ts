// Device-name field support (MYND-548) — the suggested default, the length
// bound, and the one hook every enrollment form uses to render the field.
//
// The platform token comes from Rust (`std::env::consts::OS`), NOT from
// `navigator`: keeping one source means the two clients cannot drift into two
// different default-name heuristics, which is the whole reason device names live
// in a single synced map. The token → display word mapping lives in the i18n
// catalogue, so a translator can adapt it without touching the backend.
//
// The suggestion is only ever a SUGGESTION for an editable field. Whatever the
// user confirms is what gets stored.

import { useEffect, useState } from "react";
import i18n from "../i18n";
import { devicePlatform } from "./prefs";

/** The maximum device-name length the UI accepts. Purely a readability bound —
 *  the row has to stay legible in a narrow Settings panel. There is no Rust-side
 *  cap (the `label` precedent has none either); the prefs blob's own size ceiling
 *  is the real backstop. */
export const DEVICE_NAME_MAX_LEN = 40;

/** The display word for a platform token, falling back to a neutral label for a
 *  target the catalogue does not know (a new Tauri platform, or the browser dev
 *  shim where the command is unavailable). */
function deviceNameForPlatform(token: string): string {
  return i18n.t([`sync.devices.platform.${token}`, "sync.devices.platform.unknown"]);
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

/** The "Name this device" field's state, shared by every enrollment door so the
 *  doors cannot drift — a device that arrives nameless from one of them is a
 *  silent regression no other test would catch.
 *
 *  `resolved` is what to submit: the typed value, or the suggestion when the user
 *  cleared the field. It is never blank, which matters because the backend refuses
 *  a blank name outright. */
export function useDeviceNameField(): {
  value: string;
  setValue: (next: string) => void;
  /** The platform suggestion — also the field's placeholder. */
  suggestion: string;
  /** What to submit: `value` if non-blank, else `suggestion`. */
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
      // Functional update: a late-resolving suggestion must never clobber what
      // the user already typed.
      setValue((current) => (current === "" ? next : current));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { value, setValue, suggestion, resolved: value.trim() !== "" ? value.trim() : suggestion };
}
