// The shared live-collaboration participant model (epic live-collab,
// `collab-presence-ui` task 1).
//
// One shape the awareness store, the "who's here" roster and the editor
// decorations all share, plus a deterministic id → `--group-*` colour mapping.
//
// # The colour hash is a PRESENTATION hash, not an identity hash
//
// `colorForParticipant` hashes the STABLE identity key carried in the awareness
// frame, the person id in a shared (`NTV6`) vault, the device id in a
// single-user vault, into the eight `--group-*` palette names. Two devices of one
// person therefore share a colour in a shared vault. This is deliberately NOT the
// authoritative id hash `SYNC-44` forbids (deriving e.g. the head-author id from
// public halves): the palette index is cosmetic, carries no security claim, and
// stays entirely client-side. The label, in contrast, is the backend RESOLVER's
// string, the frontend never derives an authoritative label from an id.

/** The eight group palette names, in the token sheet's order (`client-core/src/tokens.css`). */
export const GROUP_COLORS = [
  "olive",
  "fern",
  "teal",
  "denim",
  "indigo",
  "violet",
  "orchid",
  "rose",
] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

/**
 * A live-collaboration participant, the single shape the awareness store, the
 * roster and the decorations all read.
 */
export interface Participant {
  /** The stable identity key: person id (shared vault) or device id (single-user). */
  id: string;
  /** The note this participant is editing, a participant bound to another note
   *  renders nothing. */
  noteId: string;
  /** The RESOLVER's resolved display label (device name / roster person). Never
   *  derived in the frontend from `id`. */
  label: string;
  /** True when the session's signed assertion did not verify: the id is trusted for
   *  colour only and the surface renders the degraded label. */
  unAttributed: boolean;
  /** Caret offset in UTF-16 code units from the document start, or `null` when the
   *  peer has no caret. UTF-16 (not Unicode scalars) because it is what the editor
   *  reports and dispatches; `participant.ts`'s consumers map it straight onto a
   *  CodeMirror selection. */
  caret: number | null;
  /** Selection as `(anchor, head)` scalar offsets, or `null`. */
  selection: { anchor: number; head: number } | null;
  /** The `--group-*` palette index, `0..7` (`colorForParticipant(id)`). */
  color: number;
}

/**
 * Map a stable participant id deterministically into the eight group colours.
 * Same id → same index across calls, devices and sessions; past eight distinct ids
 * the palette wraps. A 32-bit FNV-1a over the UTF-16 code units, a presentation
 * hash only.
 */
export function colorForParticipant(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % GROUP_COLORS.length;
}

/** The CSS `var(--group-*)` for a participant id, never a literal colour. */
export function colorVarForParticipant(id: string): string {
  return `var(--group-${GROUP_COLORS[colorForParticipant(id)]})`;
}

/** The CSS `var(--group-*)` for a participant's already-resolved `color` index. */
export function colorVarForIndex(color: number): string {
  return `var(--group-${GROUP_COLORS[color % GROUP_COLORS.length]})`;
}

/** A participant plus its derived colour index. */
export function participantWithColor(
  p: Omit<Participant, "color">,
): Participant {
  return { ...p, color: colorForParticipant(p.id) };
}
