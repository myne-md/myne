// The host awareness store (`collab-presence-ui` task 3): the peers editing the open
// notes, fed from the live channel and pushed into the editor's `awareness` prop.
//
// The store is a pure state machine so its teardown rules are testable without a
// React mount: peers are kept PER NOTE (awareness for note A never reaches note B),
// clear immediately on lock / vault leave, and clear only AFTER a grace window on a
// stream drop (a reconnect must not flicker). It is MODULE-scope, which is what makes
// the lock-teardown roster row necessary: it outlives every pane, so a
// vault-leaving path that skips `clearAwareness` leaves the prior vault's peers
// resident into the next session.
//
// # Why peers are keyed by note rather than one bound `noteId`
//
// A single `noteId` field made the LAST pane to bind win: with two split panes on
// two notes, one pane's peers were dropped on every frame (the frame's note did not
// match the other pane's binding), and either pane's unmount cleared the survivor.

import { colorForParticipant, type Participant } from "./participant";
import type { IdentityLabel } from "./identityLabel";

/**
 * The grace window after a stream drop before the store clears. Aligned with the
 * transport's reconnect cadence so a reconnect does not flicker the cursors away.
 */
export const AWARENESS_GRACE_MS = 3000;

/** One presence frame as the host surfaces it (`AwarenessPresence` on the wire). */
export interface PresenceUpdate {
  noteId: string;
  actorId: string;
  /**
   * The peer's own advertised name, present on the wire and DELIBERATELY NOT READ
   * by `awarenessUpsert`. The label rule is `resolvePeerLabels` alone; see the
   * comment on `awarenessUpsert` for what breaks when a frame-supplied name reaches
   * the store. Kept in the type because it is the wire shape, not because anything
   * here may use it.
   */
  label: string | null;
  cursor: number | null;
  selection: { anchor: number; head: number } | null;
  frameType: "join" | "presence";
}

export interface AwarenessState {
  /** Peers per note: `noteId -> (actorId -> Participant)`. */
  peersByNote: ReadonlyMap<string, ReadonlyMap<string, Participant>>;
  /** When the live stream dropped (ms), or `null` while connected. */
  droppedAt: number | null;
}

const NO_PEERS: ReadonlyMap<string, Participant> = new Map();

export const EMPTY_AWARENESS: AwarenessState = {
  peersByNote: new Map(),
  droppedAt: null,
};

/** The peers editing `noteId`, read-only. Empty for `null` or an unknown note. */
export function awarenessNotePeers(
  state: AwarenessState,
  noteId: string | null,
): ReadonlyMap<string, Participant> {
  if (noteId === null) return NO_PEERS;
  return state.peersByNote.get(noteId) ?? NO_PEERS;
}

/**
 * Normalize a selection the wire may present two ways.
 *
 * The frame now serializes it as `{anchor, head}` (`AwarenessSelection` on the Rust
 * side). An EARLIER revision sent a positional tuple, i.e. a JSON array
 * `[anchor, head]`, and a stray shape must degrade to `null` rather than reach the
 * decoration builder: `p.selection.anchor` on an array is `undefined`, `Math.min`
 * then produces `NaN`, `Decoration.range(NaN, NaN)` throws inside the dispatch, and
 * ONE peer reporting a selection silently took down the whole awareness decoration
 * set.
 */
function normalizeSelection(selection: unknown): { anchor: number; head: number } | null {
  const pair = (anchor: unknown, head: unknown): { anchor: number; head: number } | null =>
    typeof anchor === "number" &&
    typeof head === "number" &&
    Number.isFinite(anchor) &&
    Number.isFinite(head)
      ? { anchor, head }
      : null;
  if (Array.isArray(selection)) {
    return pair(selection[0], selection[1]);
  }
  if (typeof selection === "object" && selection !== null) {
    const { anchor, head } = selection as { anchor?: unknown; head?: unknown };
    return pair(anchor, head);
  }
  return null;
}

/**
 * Add or replace a peer's presence, keyed by the FRAME's own note. A frame arriving
 * after a drop means the stream is back, so the drop is cleared too.
 *
 * Every peer enters UN-ATTRIBUTED, and the frame's own `label` is deliberately NOT
 * read (`member-devices` task 5). The wire does carry one, so this is a decision
 * rather than an oversight: the only label rule is `resolvePeerLabels`, which asks
 * the backend identity resolver which person a device is bound to, and that is the
 * same rule the version history runs. A frame-supplied name is a self-assertion by
 * the peer, and trusting it here breaks the joint claim two ways. It names one device
 * two ways, because the history never sees the frame and would print the resolved
 * member name while the roster printed whatever the peer sent. And writing it flips
 * `unAttributed` off, which is precisely the flag that makes `resolvePeerLabels` SKIP
 * a peer, so the resolver would never run for the peers whose name disagreed.
 */
export function awarenessUpsert(
  state: AwarenessState,
  update: PresenceUpdate,
): AwarenessState {
  const peers = new Map(state.peersByNote.get(update.noteId) ?? NO_PEERS);
  peers.set(update.actorId, {
    id: update.actorId,
    noteId: update.noteId,
    // NOT `update.label`: the resolver is the one writer (`presenceLabels.ts`).
    label: null,
    unAttributed: true,
    caret: typeof update.cursor === "number" ? update.cursor : null,
    selection: normalizeSelection(update.selection),
    color: colorForParticipant(update.actorId),
  });
  const peersByNote = new Map(state.peersByNote);
  peersByNote.set(update.noteId, peers);
  return { ...state, peersByNote, droppedAt: null };
}

/**
 * Fill in a peer's resolved label, from the backend identity resolver
 * (`collab-provenance` task 2), keeping their frame data. Once a peer is
 * attributed this is a no-op for them, so the caller may re-run it safely.
 *
 * Takes the DESCRIPTOR `resolvedIdentityLabel` returns, never a rendered string:
 * this entry is written once and never revisited, so a string here would pin the
 * language the peer appeared in (see `identityLabel.ts`).
 */
export function awarenessResolveLabel(
  state: AwarenessState,
  actorId: string,
  label: IdentityLabel,
): AwarenessState {
  let changed = false;
  const peersByNote = new Map(state.peersByNote);
  for (const [note, peers] of peersByNote) {
    const p = peers.get(actorId);
    if (p === undefined || !p.unAttributed) continue;
    const next = new Map(peers);
    next.set(actorId, { ...p, label, unAttributed: false });
    peersByNote.set(note, next);
    changed = true;
  }
  return changed ? { ...state, peersByNote } : state;
}

/**
 * Remove one peer from every note (a `leave`). Inert when the actor is absent.
 *
 * NO production caller and no protocol frame produces one: the awareness payload
 * carries `join` and `presence` only, and a peer that stops editing is dropped by
 * the stream-drop grace window (`awarenessSweep`). Kept because it is the store's
 * half of a `leave` frame the protocol may add, and because the tests pin that a
 * removal is per-actor across notes.
 */
export function awarenessDropPeer(
  state: AwarenessState,
  actorId: string,
): AwarenessState {
  let changed = false;
  const peersByNote = new Map(state.peersByNote);
  for (const [note, peers] of peersByNote) {
    if (!peers.has(actorId)) continue;
    const next = new Map(peers);
    next.delete(actorId);
    peersByNote.set(note, next);
    changed = true;
  }
  return changed ? { ...state, peersByNote } : state;
}

/** The live stream dropped: start the grace window. */
export function awarenessOnDrop(state: AwarenessState, now: number): AwarenessState {
  return state.droppedAt === null ? { ...state, droppedAt: now } : state;
}

/** Past the grace window since a drop, clear every note's peers; before it, hold. */
export function awarenessSweep(state: AwarenessState, now: number): AwarenessState {
  if (state.droppedAt === null) return state;
  if (now - state.droppedAt < AWARENESS_GRACE_MS) return state;
  return { ...state, peersByNote: new Map(), droppedAt: null };
}

/** Clear everything on lock / vault leave (the frontend lock-teardown class). */
export function awarenessClear(): AwarenessState {
  return EMPTY_AWARENESS;
}

// ── The module-scope store ───────────────────────────────────────────────────

let storeState: AwarenessState = EMPTY_AWARENESS;
const listeners = new Set<() => void>();

/** The current snapshot (stable reference until a write). */
export function getAwarenessSnapshot(): AwarenessState {
  return storeState;
}

/** Subscribe to store writes (for `useSyncExternalStore`). */
export function subscribeAwareness(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Write the store (a value or an updater) and notify subscribers. */
export function setAwareness(
  next: AwarenessState | ((prev: AwarenessState) => AwarenessState),
): void {
  storeState = typeof next === "function" ? next(storeState) : next;
  for (const l of listeners) l();
}

/** The `lockVault` / vault-leave teardown: drop every peer immediately. */
export function clearAwareness(): void {
  setAwareness(EMPTY_AWARENESS);
}
