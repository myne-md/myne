// The remote-merge drain, shared by the desktop pane and the mobile editor
// (myne-md/myne#849).
//
// # What it is for
//
// A sync pull or a live peer edit whose note has an OPEN live session is merged
// into the session rather than written to disk, and the editor is told so
// (`sync://remote-merged`, `sync://live-remote-merged`). Skip the drain and the
// editor keeps a stale buffer while the session holds the merge, so its next save
// writes the whole buffer THROUGH the session and the peer's revision leaves every
// converged copy, silently and with no conflict copy.
//
// # Why it reads the session rather than trusting the queued splices
//
// The core queues body splices for the editor, and they are the wrong input for a
// buffer that can differ from the session (myne-md/myne#849, D8/D9). They are
// clamped to the BODY, so a peer's rename, retag, move or trash never reaches the
// editor and every later body splice lands that many characters off; and they are
// offsets over a text the editor can only assume it agrees with. The desktop pane
// applied them raw on the argument that it autosaves, and round 4 of the review
// showed that argument covers the body only: a peer's frontmatter change never
// reached the desktop buffer at all, so its next autosave wrote the old
// frontmatter back over it. Both clients therefore run this one drain.
//
// So the drain treats the event as a signal and the session's own text as the
// truth. The editor keeps a MIRROR of what the session held when it last looked
// (what it loaded, every write that went through the session, each drain); a
// drain reads the session's current text, diffs the mirror against it to get the
// remote change, maps that change over the local diff (mirror to buffer) so it
// lands around the user's unsaved text, delivers it, and sets the mirror to what
// it read. A wrong mirror can therefore cost at most one misplaced edit, never a
// drift that compounds.
//
// # Every remote change reaches the buffer, or the buffer is rebuilt
//
// A change with no editor view mounted is applied to the buffer STRING. A change
// whose delivery throws goes to `resync`, which keeps the unsaved text as a
// separate copy and rebuilds the buffer from the session. A drain that finds the
// editor has moved to another note does nothing and loses nothing: the change is
// in that note's session, and leaving the note flushed it.
//
// # Why it is a module rather than an effect, and why `listen` is injected
//
// Both editor screens are expensive to mount, and neither client's flow tier can
// deliver a backend event, so an inline effect would be untestable. Everything
// the drain does is injected, the event subscription included: this package has
// no host (`scripts/check-platform-seam.mjs`), and each client hands in its own
// seam's `listen`.

import { ChangeSet, Text } from "@codemirror/state";
import type { LocalSplice } from "./live-bridge";

/**
 * One edit: replace the UTF-16 range `[from, to)` with `insert`. An ALIAS of the
 * shape `remoteDispatchSpec` takes, so it has exactly one home in this package.
 */
export type RemoteSplice = LocalSplice;

/** Unsubscribe one event listener. */
export type UnlistenFn = () => void;

/** What the drain needs from the screen, all injected. */
export interface RemoteMergeDeps {
  /** The client's own event subscription (its platform seam's `listen`). */
  listen(event: string, handler: (event: { payload: string }) => void): Promise<UnlistenFn>;
  /** The note the editor currently holds, or `null`. Read per event, not captured. */
  currentNoteId(): string | null;
  /**
   * The policy's drain. Called to EMPTY the queue the core keeps for the pane;
   * its contents are not used here (see the module comment).
   */
  takeSplices(noteId: string): Promise<RemoteSplice[]>;
  /** Resolves once this device's own in-flight writes through the session settle. */
  settled(noteId: string): Promise<void>;
  /**
   * How many of this device's writes through the session have STARTED. Read
   * before and after the session read: a write that started after `settled`
   * resolved can land inside the read, and its text would then be applied again.
   */
  patchEpoch(noteId: string): number;
  /** The session's current whole text, or `null` when no session owns the note. */
  readSession(noteId: string): Promise<string | null>;
  /** What this screen last knew the session held, or `null` when it does not know. */
  sessionText(noteId: string): string | null;
  /** Record what the session holds now. */
  setSessionText(noteId: string, text: string): void;
  /** The screen's current buffer, read per event. */
  buffer(): string;
  /**
   * Deliver splices expressed over `buffer()`: ONE editor transaction when a view
   * is mounted, a rewrite of the buffer string when none is. May throw; a throw
   * goes to `resync`.
   */
  deliver(splices: readonly RemoteSplice[]): void;
  /**
   * The change could not be placed. Keep any unsaved text as a separate copy,
   * rebuild the buffer from the session's own text, and tell the user.
   */
  resync(noteId: string): void;
}

/** The merge events, both carrying one note id. */
export const REMOTE_MERGE_EVENTS = ["sync://remote-merged", "sync://live-remote-merged"] as const;

/** Lines past this product fall back to one trimmed hunk rather than an LCS table. */
const LCS_CELL_BUDGET = 4_000_000;

/**
 * The splices that turn `before` into `after`, in UTF-16 offsets over `before`.
 *
 * Line-anchored, then trimmed to characters per hunk, so two edits in different
 * places come back as two splices rather than one span covering the text between
 * them. That matters for the mapping below: a single span would swallow the
 * user's own edit lying between two remote ones and move it to the span's edge.
 * The same shape as the core's `diff_splices` (`core/src/plugins/live/apply_remote.rs`).
 */
export function diffSplices(before: string, after: string): RemoteSplice[] {
  if (before === after) return [];
  const b = splitLines(before);
  const a = splitLines(after);
  let p = 0;
  while (p < b.length && p < a.length && b[p] === a[p]) p += 1;
  let s = 0;
  while (s < b.length - p && s < a.length - p && b[b.length - 1 - s] === a[a.length - 1 - s]) s += 1;
  const bMid = b.slice(p, b.length - s);
  const aMid = a.slice(p, a.length - s);
  const offsets = lineOffsets(b);
  const hunks =
    bMid.length * aMid.length > LCS_CELL_BUDGET
      ? [[0, bMid.length, 0, aMid.length] as const]
      : lcsHunks(bMid, aMid);
  return hunks.map(([bs, be, as, ae]) =>
    trimHunk(offsets[p + bs] ?? before.length, bMid.slice(bs, be).join(""), aMid.slice(as, ae).join("")),
  );
}

/** Whether `diffSplices(before, after)` builds a real LCS table rather than one range. */
function withinBudget(before: string, after: string): boolean {
  if (before === after) return true;
  const b = splitLines(before);
  const a = splitLines(after);
  let p = 0;
  while (p < b.length && p < a.length && b[p] === a[p]) p += 1;
  let s = 0;
  while (s < b.length - p && s < a.length - p && b[b.length - 1 - s] === a[a.length - 1 - s]) s += 1;
  return (b.length - p - s) * (a.length - p - s) <= LCS_CELL_BUDGET;
}

function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

function lineOffsets(lines: readonly string[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const line of lines) {
    out.push(at);
    at += line.length;
  }
  out.push(at);
  return out;
}

/** `[beforeStart, beforeEnd, afterStart, afterEnd]` for each differing run. */
function lcsHunks(b: readonly string[], a: readonly string[]): (readonly [number, number, number, number])[] {
  const n = b.length;
  const m = a.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = b[i] === a[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const hunks: (readonly [number, number, number, number])[] = [];
  let i = 0;
  let j = 0;
  let bi = 0;
  let ai = 0;
  while (i < n && j < m) {
    if (b[i] === a[j]) {
      if (bi < i || ai < j) hunks.push([bi, i, ai, j]);
      i += 1;
      j += 1;
      bi = i;
      ai = j;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  if (bi < n || ai < m) hunks.push([bi, n, ai, m]);
  return hunks;
}

function trimHunk(start: number, before: string, after: string): RemoteSplice {
  let cp = 0;
  while (cp < before.length && cp < after.length && before.charCodeAt(cp) === after.charCodeAt(cp)) cp += 1;
  let cs = 0;
  while (
    cs < before.length - cp &&
    cs < after.length - cp &&
    before.charCodeAt(before.length - 1 - cs) === after.charCodeAt(after.length - 1 - cs)
  ) {
    cs += 1;
  }
  // Never split a surrogate pair: back the prefix off a high surrogate, and the
  // suffix off a low one, so an inserted emoji is not cut in half.
  if (cp > 0 && isHigh(before.charCodeAt(cp - 1))) cp -= 1;
  if (cs > 0 && isLow(before.charCodeAt(before.length - cs))) cs -= 1;
  return { from: start + cp, to: start + before.length - cs, insert: after.slice(cp, after.length - cs) };
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

function changeSetOf(splices: readonly RemoteSplice[], length: number): ChangeSet {
  return ChangeSet.of(
    splices.map((s) => ({ from: s.from, to: s.to, insert: s.insert })),
    length,
  );
}

/**
 * Map the remote change (`base` to `session`) over the local one (`base` to
 * `buffer`), so it applies to `buffer`. Returns `null` only when the input cannot
 * form a change set, which the caller treats as "rebuild".
 */
export function rebaseOnto(base: string, session: string, buffer: string): RemoteSplice[] | null {
  // Past the LCS budget a diff is ONE range over the whole changed window, and
  // mapping over that moves inserts and revives deletions inside it (myne-md/myne#849
  // review round 5). Rebuild instead of placing a change approximately.
  if (!withinBudget(base, session) || !withinBudget(base, buffer)) return null;
  try {
    const remote = changeSetOf(diffSplices(base, session), base.length);
    const local = changeSetOf(diffSplices(base, buffer), base.length);
    const mapped = remote.map(local);
    const out: RemoteSplice[] = [];
    mapped.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      out.push({ from: fromA, to: toA, insert: inserted.toString() });
    });
    return out;
  } catch {
    return null;
  }
}

/** Apply splices (offsets over `text`, sorted, non-overlapping) to a string. */
export function applySplicesToText(text: string, splices: readonly RemoteSplice[]): string {
  return changeSetOf(splices, text.length).apply(Text.of(text.split("\n"))).toString();
}

/** The installed drain. */
export interface RemoteMergeDrain {
  /** Stop listening; a drain already running finishes and delivers nothing. */
  dispose(): void;
  /**
   * Drain `noteId` now, with no event. The screen calls this once the note's
   * session has opened: a durable pull that landed between the editor's read and
   * the session's open is in the session and fired no merge event, so without it
   * the buffer would sit behind the session until the next peer edit.
   */
  catchUp(noteId: string): void;
}

/**
 * Subscribe the drain. The caller installs it once for the mounted editor
 * screen, so the note id is read through `deps.currentNoteId()` rather than
 * captured.
 */
export function installRemoteMergeDrain(deps: RemoteMergeDeps): RemoteMergeDrain {
  let disposed = false;
  const unlisten: UnlistenFn[] = [];

  const drain = async (id: string): Promise<void> => {
    await deps.takeSplices(id).catch(() => []);
    let session: string | null = null;
    // This device's own write through the session, still in flight, would read
    // back as a peer's change and be applied a second time. Waiting for the ones
    // in flight is not enough on its own: a save that STARTS after the wait can
    // land inside the read (myne-md/myne#849 review round 4), so the epoch is
    // compared across the read and a moved one reads again. Bounded, because a
    // user typing through an autosave cadence must not hold a drain forever. A
    // read that never comes back clean delivers NOTHING (round 5: using it let the
    // save's own mirror update land behind the drain's and duplicate the peer's
    // text); the drain is queued again behind the save instead, and the save's
    // merge base keeps the peer's change in the session meanwhile.
    let clean = false;
    for (let attempt = 0; attempt < 3 && !clean; attempt += 1) {
      await deps.settled(id);
      if (disposed || deps.currentNoteId() !== id) return;
      const epoch = deps.patchEpoch(id);
      session = await deps.readSession(id);
      // No session: it closed, which flushed it, and the screen has left the note.
      if (session === null || disposed || deps.currentNoteId() !== id) return;
      clean = deps.patchEpoch(id) === epoch;
    }
    if (!clean) {
      void deps.settled(id).then(() => {
        if (!disposed && deps.currentNoteId() === id) enqueue(id);
      });
      return;
    }
    if (session === null) return;
    const base = deps.sessionText(id);
    if (base === null) {
      deps.resync(id);
      return;
    }
    // Drains for one note run one after another (`enqueue`), so the second of a
    // burst reads the mirror the first advanced, finds it equal to the session,
    // and delivers nothing.
    if (base === session) return;
    const splices = rebaseOnto(base, session, deps.buffer());
    if (splices === null) {
      deps.resync(id);
      return;
    }
    deps.setSessionText(id, session);
    if (splices.length === 0) return;
    try {
      deps.deliver(splices);
    } catch {
      // NOT best-effort: the mirror has advanced, so a delivery that failed leaves
      // the buffer behind the session and the next whole-markdown save would
      // delete the peer's text (myne-md/myne#849 review).
      deps.resync(id);
    }
  };

  // One drain at a time per note (myne-md/myne#849 review round 5). Two drains
  // side by side each await a session read, and nothing orders the replies: an
  // older text resolving after a newer one would be diffed against a mirror the
  // newer drain had already advanced, which sends the buffer a change that
  // REMOVES the peer's text and moves the mirror back.
  const tails = new Map<string, Promise<void>>();
  const enqueue = (id: string): void => {
    const run = (tails.get(id) ?? Promise.resolve()).then(() =>
      drain(id).catch(() => {
        // A failed session READ changed nothing: the mirror did not move, so the
        // next event for this note reads again and diffs against the same base.
      }),
    );
    tails.set(id, run);
    void run.then(() => {
      if (tails.get(id) === run) tails.delete(id);
    });
  };

  const onRemote = (event: { payload: string }): void => {
    const id = deps.currentNoteId();
    if (disposed || id === null || event.payload !== id) return;
    enqueue(id);
  };

  for (const name of REMOTE_MERGE_EVENTS) {
    void deps.listen(name, onRemote).then((fn) => {
      if (disposed) fn();
      else unlisten.push(fn);
    });
  }

  return {
    dispose: () => {
      disposed = true;
      for (const fn of unlisten) fn();
    },
    catchUp: (noteId) => {
      if (!disposed && deps.currentNoteId() === noteId) enqueue(noteId);
    },
  };
}
