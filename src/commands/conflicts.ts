// Keybinding conflict detection (hotkeys epic, MYND-304; SYNC-7). Pure read-side
// logic over the effective keymap + each command's scope/phase: a chord
// "conflicts" when two commands are bound to it AND could both be active at once
// AND share the dispatch phase. Surfaced (warn-only, never blocking — SYNC-7) at
// rebind-capture time (#4) and as a panel indicator (#3); this module is the
// single predicate both consume.
//
// Overlap is CONTAINMENT-aware (SYNC-2 grill Q1), not scope-tag equality: two
// commands overlap whenever SOME context activates both. The per-note / focus /
// modal flags only narrow WHEN a binding fires — there is always a context
// (e.g. a note selected) where a per-note command and a global one both fire —
// so they never make a pair disjoint. Only DIFFERENT explicit stages are
// disjoint. (CM-formatting chords are not in this keymap — SYNC-9 — so they are
// never scanned; the Mod-[/] capture-vs-bubble coexistence is not a conflict
// because the phases differ.)

import { normalizeChord } from "./chord";
import type { BindingScope } from "./scope";
import type { BindingPhase } from "./keybindEngine";

/** The metadata conflict detection needs about one bindable command. */
export interface ConflictDescriptor {
  id: string;
  scope: BindingScope;
  /** Dispatch phase; defaults to "bubble" when omitted. */
  phase?: BindingPhase;
}

/**
 * Whether two scopes can be active in the same context (containment-aware). Only
 * two DIFFERENT explicit stages are disjoint; an undefined stage is a wildcard
 * that overlaps any stage. The per-note/focus/modal gates never create
 * disjointness — there is always an overlapping context where both fire.
 */
export function scopesOverlap(a: BindingScope, b: BindingScope): boolean {
  if (a.stage !== undefined && b.stage !== undefined && a.stage !== b.stage) {
    return false;
  }
  return true;
}

const phaseOf = (d: ConflictDescriptor): BindingPhase => d.phase ?? "bubble";

/**
 * The ids of commands that CONFLICT with binding `chord` to `commandId`: a
 * different command whose effective chords (keymap) include the same normalized
 * chord, with the same phase and an overlapping scope. Excludes `commandId`
 * itself. Empty ⇒ no conflict. Never throws / never blocks (the caller decides
 * the affordance; SYNC-7 = warn-only).
 */
export function conflictsFor(
  chord: string,
  commandId: string,
  descriptors: readonly ConflictDescriptor[],
  keymap: Readonly<Record<string, string[]>>,
): string[] {
  const target = normalizeChord(chord);
  const self = descriptors.find((d) => d.id === commandId);
  const selfPhase = self ? phaseOf(self) : "bubble";
  const selfScope = self?.scope ?? {};

  const hits: string[] = [];
  for (const d of descriptors) {
    if (d.id === commandId) continue;
    if (phaseOf(d) !== selfPhase) continue;
    if (!scopesOverlap(d.scope, selfScope)) continue;
    const chords = keymap[d.id] ?? [];
    if (chords.some((c) => normalizeChord(c) === target)) hits.push(d.id);
  }
  return hits;
}

/**
 * Whole-keymap scan: every chord bound to >1 command (within a shared phase +
 * overlapping scope) → the set of command ids in that conflict. Drives the
 * persistent panel indicator (#3). Recomputed live; O(N) over the command set.
 */
export function allConflicts(
  descriptors: readonly ConflictDescriptor[],
  keymap: Readonly<Record<string, string[]>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const d of descriptors) {
    for (const chord of keymap[d.id] ?? []) {
      const others = conflictsFor(chord, d.id, descriptors, keymap);
      if (others.length > 0) {
        out[d.id] = Array.from(new Set([...(out[d.id] ?? []), ...others]));
      }
    }
  }
  return out;
}
