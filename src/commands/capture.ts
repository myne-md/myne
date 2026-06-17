// Rebind chord-capture validity (hotkeys epic, MYND-304; rebind-flow). The
// capture widget records a raw KeyboardEvent → a canonical chord; this module
// decides whether that chord is a VALID user binding.
//
// Rule (grill Q1): a binding must carry ≥1 real modifier (Cmd/Ctrl/Alt — i.e.
// Mod/Ctrl/Alt/Meta), with a small F-key (F1–F24) allowlist as the modifier-free
// exception. Shift ALONE does not count (Shift+letter still types a character;
// the window dispatcher stays live in the editor, so a bare-key/Shift-only
// binding would fire on every keystroke). Bare keys are rejected with a reason
// the widget surfaces. Escape/Enter/Tab/Arrow drive the widget itself and are
// rejected as bindings by this same rule (no modifier) — the widget treats a
// bare Escape as "cancel capture", not a chord (UI concern, not here).

import { eventToChord, normalizeChord, splitChord, isMacPlatform, type ChordEvent } from "./chord";

const REAL_MODIFIERS = new Set(["Mod", "Ctrl", "Alt", "Meta"]);
const F_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

/** Whether a canonical chord is a valid user binding (≥1 real modifier, or an F-key). */
export function isValidBindableChord(chord: string): boolean {
  const { mods, key } = splitChord(normalizeChord(chord));
  if (mods.some((m) => REAL_MODIFIERS.has(m))) return true;
  if (F_KEY.test(key)) return true;
  return false;
}

export type CaptureResult =
  | { ok: true; chord: string }
  | { ok: false; reason: string };

/** Human-facing rejection reason for an invalid captured chord (load-bearing copy lives elsewhere). */
export const INVALID_CHORD_REASON =
  "Add a modifier (⌘, Ctrl, or Alt) — a key on its own can't be a shortcut.";

/**
 * Validate a captured KeyboardEvent as a bindable chord. Returns the canonical
 * chord on success, or a rejection reason. A bare modifier press (no key yet)
 * returns `null`-equivalent rejection so the widget keeps listening rather than
 * committing — the caller distinguishes "still capturing" from "invalid".
 */
export function captureChordFromEvent(
  e: ChordEvent,
  mac: boolean = isMacPlatform(),
): CaptureResult {
  const chord = eventToChord(e, mac);
  if (chord === null) {
    // Bare modifier held — not a complete chord yet.
    return { ok: false, reason: "" };
  }
  if (!isValidBindableChord(chord)) {
    return { ok: false, reason: INVALID_CHORD_REASON };
  }
  return { ok: true, chord };
}
