// Effective-binding resolution — the SINGLE source of truth for "what chords
// trigger a command" (hotkeys epic, MYND-304; SYNC-4). Consumers (the keybind
// engine, the Hotkeys settings panel, conflict detection) read bindings through
// here, NEVER through the display-only `CommandAction.kbd` field.
//
// Resolution is `effective = userOverride ?? [default]`:
//   - a user override in `vault.prefs.keymap` shadows the code default;
//   - an override of `[]` is an EXPLICIT UNBIND (the command has no shortcut) —
//     distinct from an absent override, and honored verbatim;
//   - with no override, the command's in-code `defaultBinding` applies (as a
//     single-element array), or `[]` if it has no default.
//
// Chord strings are the canonical spec-owned, CodeMirror-`KeyBinding.key`-
// compatible form (`Mod-Shift-g`); this module does not parse or format them
// (that is the keybind engine's `formatChord`, sibling sub-feature).

import type { CommandAction } from "./registry";

/** The fields of a command this module needs to resolve its binding. */
type BindingSource = Pick<CommandAction, "id" | "defaultBinding">;

/**
 * The effective key bindings (chord strings) for one command, given the user
 * keymap from `vault.prefs`. Returns the override when present (including the
 * empty-array explicit-unbind), else the in-code default as a single-element
 * array, else an empty array.
 */
export function effectiveBinding(
  action: BindingSource,
  keymap: Record<string, string[]>,
): string[] {
  const override = keymap[action.id];
  if (override !== undefined) {
    return override; // includes [] = explicit unbind, honored verbatim
  }
  return action.defaultBinding ? [action.defaultBinding] : [];
}

/**
 * Build the full `command-id → effective-chords` projection over a set of
 * commands. This is the read API the panel / engine / conflict detection
 * consume; it never reflects `kbd`.
 */
export function effectiveKeymap(
  actions: readonly BindingSource[],
  keymap: Record<string, string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const action of actions) {
    out[action.id] = effectiveBinding(action, keymap);
  }
  return out;
}

/**
 * The effective chords for one command id given an array-keyed default map (the
 * catalog / dispatcher form, where defaults are already `string[]`). Same
 * `override ?? default` rule as {@link effectiveBinding}: an override (including
 * `[]` explicit-unbind) wins; else the id's default; else `[]`.
 */
export function effectiveChords(
  id: string,
  defaults: Readonly<Record<string, string[]>>,
  overrides: Readonly<Record<string, string[]>>,
): string[] {
  return overrides[id] ?? defaults[id] ?? [];
}

/**
 * Merge an array-keyed default map with the user override map into the effective
 * `id → chords` keymap (`override ?? default` per id) — the single merge used by
 * the keybind dispatcher and the Hotkeys panel (replaces their former inline
 * copies). An override on an id with no default still applies (future-proof).
 */
export function mergeKeymap(
  defaults: Readonly<Record<string, string[]>>,
  overrides: Readonly<Record<string, string[]>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of Object.keys(defaults)) out[id] = overrides[id] ?? defaults[id];
  for (const id of Object.keys(overrides)) {
    if (!(id in out)) out[id] = overrides[id];
  }
  return out;
}
