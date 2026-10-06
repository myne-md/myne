// Central keybinding dispatcher core (hotkeys epic, MYND-304; keybind-engine).
// Hand-rolled (no keymap library — minimal-deps). Resolves a KeyboardEvent to
// the single command that should run, given: the effective keymap
// (`command-id → chord[]`, from commands/keymap.ts), each command's activation
// scope + phase, and the current "when" context (commands/scope.ts).
//
// PHASE (SYNC-8): a binding is `"capture"` or `"bubble"` (default). The engine
// is fed by TWO window listeners — a capture-phase one (for the Cmd-[/] chords
// that must beat CodeMirror's indentLess/indentMore before it consumes them)
// and a bubble-phase one (everything else). Only `nav.back`/`nav.forward` carry
// `"capture"` (fixed allowlist) — the capture-shadow-beats-CM rule is NOT
// generalized to arbitrary user bindings (a user chord that collides with a CM
// chord loses to CM inside the editor; sibling #5 warns).
//
// Lookup uses commands/chord.ts + scope.ts; this module adds phase routing +
// most-specific-wins precedence. It binds only over a closed entry list — there
// is no runtime chord→callback registration (no plugin surface).

import { recordCommandRun } from "../lib/commandRecency";
import { eventToChord, normalizeChord, isMacPlatform, type ChordEvent } from "./chord";
import {
  isBindingActive,
  scopeSpecificity,
  type BindingScope,
  type WhenContext,
} from "./scope";

export type BindingPhase = "capture" | "bubble";

/**
 * One dispatchable keybinding. `run` is supplied by the caller (the Editor wires
 * workspace-bound handlers; global commands wire CommandContext callbacks), so
 * the engine stays generic and side-effect-free itself.
 */
export interface KeybindEntry {
  /** Command id — also the keymap key for the user override (SYNC-4). */
  id: string;
  /** Activation scope (stage / per-note / plain-input / modal gates). */
  scope: BindingScope;
  /** Dispatch phase. Defaults to `"bubble"`. */
  phase?: BindingPhase;
  /** The action to run when this binding fires. */
  run: () => void;
}

/**
 * Resolve the single entry that should fire for `event` in `phase`, or `null`.
 * An entry qualifies when: its phase matches; it is active in `ctx`
 * (`isBindingActive`); and one of its effective chords (`keymap[id]`, the
 * user override else the entry's caller-supplied default already folded into
 * the keymap) equals the event's normalized chord. Among qualifiers, the
 * most-specific scope wins (SYNC-2); ties keep the earliest entry (stable).
 */
export function resolveKeybind(
  event: ChordEvent,
  phase: BindingPhase,
  ctx: WhenContext,
  entries: readonly KeybindEntry[],
  keymap: Record<string, string[]>,
  mac: boolean = isMacPlatform(),
): KeybindEntry | null {
  const chord = eventToChord(event, mac);
  if (chord === null) return null;
  const target = normalizeChord(chord);

  let best: KeybindEntry | null = null;
  let bestScore = -1;
  for (const entry of entries) {
    if ((entry.phase ?? "bubble") !== phase) continue;
    if (!isBindingActive(entry.scope, ctx)) continue;
    const chords = keymap[entry.id] ?? [];
    if (!chords.some((c) => normalizeChord(c) === target)) continue;
    const score = scopeSpecificity(entry.scope);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Dispatch an event in a phase: resolve the winning entry and run it. Returns
 * true if a command ran (the caller then `preventDefault`/`stopPropagation`s —
 * the latter is what lets a capture-phase binding shadow CodeMirror).
 */
export function dispatchKeybind(
  event: ChordEvent,
  phase: BindingPhase,
  ctx: WhenContext,
  entries: readonly KeybindEntry[],
  keymap: Record<string, string[]>,
  mac: boolean = isMacPlatform(),
): boolean {
  const entry = resolveKeybind(event, phase, ctx, entries, keymap, mac);
  if (!entry) return false;
  // A chord is the third way a command runs (after the palette and the rail),
  // and the one power users lean on, so it counts toward recency too.
  recordCommandRun(entry.id);
  entry.run();
  return true;
}
