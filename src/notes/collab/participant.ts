// The shared live-collaboration participant model (epic live-collab,
// `collab-presence-ui` task 1).
//
// One shape the awareness store, the "who's here" roster and the editor
// decorations all share, plus a deterministic id → `--group-*` colour mapping.
//
// # The colour hash is a PRESENTATION hash, not an identity hash
//
// `colorForParticipant` hashes the key the awareness frame carries, and that key is
// this device's AUTOMERGE ACTOR: the enrolled `device_id` bytes VERBATIM (`SYNC-42`,
// `crdt_doc::note_actor_bytes`), or a fresh CSPRNG draw in a vault with no device
// identity. It is a device id in EVERY vault, shared ones included, never a person
// id. One person on two devices is therefore two actors, which is why the two do
// NOT share a colour and why the roster's header counts sessions rather than people
// (`locales/en/common.json` -> `editor.chrome.presence.title`). Resolving an actor to
// the person behind it is the BACKEND resolver's job (`member-devices` task 5,
// `resolveIdentity`), which is also where every label comes from; the frontend never
// derives an authoritative label, or a person id, from an actor. This is deliberately
// NOT the authoritative id hash `SYNC-44` forbids (deriving e.g. the head-author id
// from public halves): the palette index is cosmetic, carries no security claim, and
// stays entirely client-side.

import type { IdentityLabel } from "./identityLabel";

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
  /** The awareness actor for this peer: this device's Automerge actor, i.e. its
   *  enrolled `device_id` bytes (`SYNC-42`), in EVERY vault including shared ones.
   *  Deliberately not a person id, so one person on two devices is two
   *  participants and the roster counts sessions rather than people. */
  id: string;
  /** The note this participant is editing, a participant bound to another note
   *  renders nothing. */
  noteId: string;
  /** The RESOLVER's resolved display label (device name / roster person), held as
   *  the DESCRIPTOR `identityLabel.ts` hands back rather than as a rendered string,
   *  or `null` when the frame carried none. Never derived in the frontend from
   *  `id`, and never resolved here: this store outlives every render, so a string
   *  written into it would freeze the language the peer appeared in. Each surface
   *  renders it with `identityLabelText(label, t)` at its own render. */
  label: IdentityLabel | null;
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
