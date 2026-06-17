// Chord normalization for the window-level keybinding engine (hotkeys epic,
// MYND-304; keybind-engine sub-feature). Converts a DOM KeyboardEvent to the
// canonical chord string (SYNC-1) and normalizes stored chord strings to the
// same comparable form, so dispatch is plain string equality.
//
// SCOPE (SYNC-9): this serves the ~9 WINDOW-LEVEL app commands (palette, new
// note, pane nav, find, settings, graph, back/forward). CodeMirror's own keymap
// owns the editor-formatting chords (Mod-b/i/e, Mod-Shift-h/7/8/m/l, Mod-a) and
// the shifted-punctuation base-key matching they need; this normalizer
// deliberately does NOT reimplement that surface.
//
// Canonical form: modifier tokens in the fixed order `Mod`, `Ctrl`, `Alt`,
// `Shift`, then the logical key, joined by `-`. `Mod` is the platform
// accelerator (Meta on macOS, Ctrl elsewhere); a literal Ctrl on macOS is
// `Ctrl`; a literal Meta (Windows/Super key) on non-mac is `Meta`. Single-
// character keys are lowercased, so Shift+G is `Mod-Shift-g` (key `g` + the
// Shift modifier), matching CodeMirror's `KeyBinding.key` human form.

import { keyName } from "w3c-keyname";

const MODIFIER_KEY_NAMES = new Set(["Control", "Alt", "Shift", "Meta"]);

/** Whether the host is macOS (where `Mod` = Meta/Cmd). Safe outside a browser. */
export function isMacPlatform(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      /Mac|iP(hone|[oa]d)/.test(navigator.platform)
    );
  } catch {
    return false;
  }
}

/** A KeyboardEvent shape narrow enough for tests to construct as a plain object. */
export interface ChordEvent {
  key?: string;
  keyCode?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

function buildChord(key: string, e: ChordEvent, mac: boolean): string {
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (mac && e.ctrlKey) parts.push("Ctrl");
  if (!mac && e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("-");
}

/**
 * Normalize a KeyboardEvent to the canonical chord string, or `null` for a bare
 * modifier press (so the dispatcher ignores Shift/Ctrl/Alt/Meta held alone).
 */
export function eventToChord(e: ChordEvent, mac: boolean = isMacPlatform()): string | null {
  const raw = keyName(e as KeyboardEvent);
  if (!raw || raw === "Unidentified" || MODIFIER_KEY_NAMES.has(raw)) return null;
  const key = raw.length === 1 ? raw.toLowerCase() : raw;
  return buildChord(key, e, mac);
}

const MOD_TOKENS: Record<string, "Mod" | "Ctrl" | "Alt" | "Shift" | "Meta"> = {
  mod: "Mod",
  ctrl: "Ctrl",
  control: "Ctrl",
  c: "Ctrl",
  alt: "Alt",
  a: "Alt",
  shift: "Shift",
  s: "Shift",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  m: "Meta",
};

const MOD_ORDER: readonly string[] = ["Mod", "Ctrl", "Alt", "Shift"];

/**
 * Split a chord string into its modifier tokens and final key, on `-` except a
 * trailing `-` (a literal `-` key), matching CodeMirror's `split(/-(?!$)/)`.
 * The single shared splitter used by `normalizeChord`, `formatChord`, and the
 * capture validator — so the dash-handling lives in exactly one place.
 */
export function splitChord(chord: string): { mods: string[]; key: string } {
  const parts = chord.split(/-(?!$)/);
  return { mods: parts.slice(0, -1), key: parts[parts.length - 1] };
}

/**
 * Normalize a stored chord string (`Mod-Shift-g`, `Mod-,`, `Ctrl-Tab`) to the
 * same canonical comparable form `eventToChord` emits: recognized modifier
 * tokens (case-insensitive) reordered to Mod/Ctrl/Alt/Shift, single-char key
 * lowercased. Throws on an unrecognized modifier token.
 */
export function normalizeChord(chord: string): string {
  const { mods: rawMods, key: rawKey } = splitChord(chord);
  const key = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
  const mods = new Set<string>();
  for (const raw of rawMods) {
    const token = MOD_TOKENS[raw.toLowerCase()];
    if (!token) throw new Error(`Unrecognized modifier in chord "${chord}": ${raw}`);
    mods.add(token);
  }
  const ordered = MOD_ORDER.filter((m) => mods.has(m));
  if (mods.has("Meta")) ordered.push("Meta");
  ordered.push(key);
  return ordered.join("-");
}

const MAC_GLYPHS: Record<string, string> = {
  Mod: "⌘",
  Meta: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
};

const KEY_GLYPHS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↵",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "Esc",
  " ": "Space",
  Tab: "⇥",
};

/**
 * Render a canonical chord string to a human display label (hotkeys epic,
 * MYND-304) — the SINGLE shared formatter consumed by the command palette, the
 * Hotkeys panel, and the rebind capture UI (replacing hand-typed `kbd` literals;
 * SYNC-3). On macOS, modifiers render as glyphs joined tight (`⌘⇧G`, matching
 * the prior `kbd` literals); elsewhere they render as words joined with `+`
 * (`Ctrl+Shift+G`). A single-character key is uppercased; named keys map to a
 * glyph/word where one exists.
 */
export function formatChord(chord: string, mac: boolean = isMacPlatform()): string {
  const { mods, key: rawKey } = splitChord(normalizeChord(chord));
  const keyLabel = KEY_GLYPHS[rawKey] ?? (rawKey.length === 1 ? rawKey.toUpperCase() : rawKey);
  if (mac) {
    const modGlyphs = mods.map((m) => MAC_GLYPHS[m] ?? m).join("");
    return modGlyphs + keyLabel;
  }
  const modWords = mods.map((m) => (m === "Mod" ? "Ctrl" : m));
  return [...modWords, keyLabel].join("+");
}

/**
 * Resolve the command ids a chord triggers, given the effective keymap
 * (`command-id → chord[]`, from `effectiveKeymap`). The keymap's chords are
 * normalized for comparison, so a stored `Mod-Shift-g` matches an event-derived
 * `Mod-Shift-g`. Usually 0 or 1 id; >1 means a conflict (sibling #5's concern).
 */
export function commandIdsForChord(
  chord: string,
  effective: Record<string, string[]>,
): string[] {
  const target = normalizeChord(chord);
  const ids: string[] = [];
  for (const [id, chords] of Object.entries(effective)) {
    if (chords.some((c) => normalizeChord(c) === target)) ids.push(id);
  }
  return ids;
}
