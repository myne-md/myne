// Where each note was left, in DOCUMENT coordinates (myne-md/myne#600).
//
// # Why not a pixel
//
// The scroll position used to be remembered as the outer scroller's `scrollTop`,
// restored once inside a `requestAnimationFrame`. That is wrong twice.
//
// It is wrong in TIME: at that frame CodeMirror has not finished measuring and
// the late-resolving blocks (images, math, mermaid, attachment embeds) have not
// taken their height, so the document is shorter than it will be and the browser
// CLAMPS the assignment to the current `scrollHeight`. Nothing corrects it after.
//
// It is wrong in UNIT: after a pane split the pane is narrower, the text
// re-wraps, and the same pixel offset points at different content. A document
// position does not re-wrap (the line the reader was on is the same line at any
// width), so that is what gets remembered, plus how far below the viewport's top
// edge it was sitting.
//
// # Why module scope
//
// A split UNMOUNTS the pane (`PaneTree` renders `<PaneView>` for a leaf with no
// key, so a leaf becoming a split node replaces the component). Anything the
// pane owned goes with it, which is why the scroll used to be lost on exactly
// the gesture the reader is most likely to be mid-thought during. The order is a
// property of the session, not of a pane, so it lives here.
//
// Session-lived, deliberately: this is a convenience, and persisting it would
// mean writing per-note UI state into `vault.workspace` (§9.7). Nothing here is
// persisted, so nothing here reaches the vault.

// TYPE-only, deliberately: this module is imported by the vault-LEAVING paths
// (`src/lib/vault-unlock.ts`, `src/lib/vault-switch.ts`) for `resetScrollMemory`,
// and a value import of `@codemirror/view` here put the whole CodeMirror view
// stack into first load for a map clear. The one function that needs the
// `EditorView` value, `applyScrollAnchor`, lives in `./scrollAnchorApply`.
import type { EditorView } from "@codemirror/view";

/** A remembered reading position. */
export type ScrollAnchor = {
  /** The document offset of the line at the top of the viewport. */
  readonly pos: number;
  /** How far BELOW the viewport's top edge that line's own top sits, in px.
   *  Usually negative (the line is partly scrolled off), which is what keeps a
   *  restore from jumping by up to one line height. */
  readonly offsetPx: number;
};

const anchors = new Map<string, ScrollAnchor>();

/**
 * Notes whose remembered anchor is currently being RESTORED, and must therefore
 * not be re-remembered from the scroll that restore is producing (myne#651).
 *
 * # The loop this breaks
 *
 * `applyScrollAnchor` scrolls the pane. That scroll fires the pane's own scroll
 * listener, which remembers the position it lands at. So the restore writes its
 * own result back over the anchor it was restoring from.
 *
 * If a restore were exact that would be harmless: it would rewrite the same
 * value. It cannot be exact, and the reason is the reason the restore exists at
 * all. `readScrollAnchor` records a LINE plus the fraction of it scrolled off,
 * and a restore runs after the pane's width changed and re-wrapped the text ,
 * so the line is put back, and its sub-pixel offset within a viewport of
 * different line heights is not. The residue is small and it is written back,
 * so the next restore starts from the drifted anchor and adds its own residue.
 *
 * Toggling a sidebar is exactly that, once per toggle, which is why the note
 * walked one notch down the viewport per open/close and never walked back.
 *
 * # Why a suppression window rather than a flag around the call
 *
 * The scroll `applyScrollAnchor` causes does not happen during the call. It is
 * dispatched as a CodeMirror effect, lands after the next measure, and the
 * pane's listener coalesces on a trailing timer. A flag cleared when the
 * function returns would already be off by the time the write it is meant to
 * suppress arrives. The window has to outlive that whole chain.
 */
const restoring = new Map<string, number>();

/**
 * When the reader last moved note `noteId` themselves, in ms since the epoch.
 *
 * The one question a restore cannot answer from the anchor alone: is the pane
 * still where this anchor says, or has the reader moved since? A restore that
 * fires late (a scrollbar appearing narrows the pane, a width observation, a
 * body arriving) would otherwise drag them back to a position they have already
 * scrolled past, which reads as the view jumping upward mid-scroll.
 */
const readerMoves = new Map<string, number>();

/**
 * How long a restore suppresses re-remembering, in ms. Comfortably longer than
 * `PaneView`'s `SCROLL_SETTLE_MS` (120), because the write to suppress happens
 * on the trailing edge of that timer, one full settle AFTER the scroll lands.
 *
 * Being generous costs only that a genuine user scroll within the window is not
 * remembered; the next one is. Being tight costs the bug back.
 */
const RESTORE_SUPPRESSION_MS = 500;

/**
 * Mark `noteId` as being restored, so scroll writes are ignored for a moment.
 *
 * Exported for `tests/notes/scrollMemory.test.ts` and for a future restore path
 * that does not go through {@link applyScrollAnchor}. Every path today does, so
 * this has no production caller, said plainly rather than claiming one, which
 * an earlier version of this comment did.
 */
export function beginScrollRestore(noteId: string, now = Date.now()): void {
  restoring.set(noteId, now);
}

/** How long `noteId`'s restore window still has to run, in ms (0 when none).
 *
 *  Deliberately NOT exported: its one consumer is `restoreDelay` two hundred
 *  lines down, and an export with no caller outside this file is exactly what
 *  `check-export-callers.mjs` reports. It read as part of the module's public
 *  surface for no reason. */
function scrollRestoreRemaining(noteId: string, now = Date.now()): number {
  const started = restoring.get(noteId);
  if (started === undefined) return 0;
  const left = RESTORE_SUPPRESSION_MS - (now - started);
  return left > 0 ? left : 0;
}

/**
 * Whether the reader moved note `noteId` within the last `within` ms.
 *
 * A restore path asks this before it scrolls: an anchor recorded before the
 * reader's own scroll describes a position they left on purpose, and applying it
 * is the upward jump this guards (`rememberScroll` is called only from a scroll
 * listener, so this tracks real movement and never the restore's own dispatch).
 */
export function readerMovedRecently(
  noteId: string,
  within = 250,
  now = Date.now(),
): boolean {
  const at = readerMoves.get(noteId);
  return at !== undefined && now - at <= within;
}

/** Whether a restore of `noteId` is still settling. */
export function isRestoringScroll(noteId: string, now = Date.now()): boolean {
  const started = restoring.get(noteId);
  if (started === undefined) return false;
  if (now - started <= RESTORE_SUPPRESSION_MS) return true;
  restoring.delete(noteId);
  return false;
}

/**
 * Read the reading position out of a live view, or `null` when it cannot be
 * measured (a detached view, a pane with no height yet).
 */
export function readScrollAnchor(
  view: EditorView,
  scroller: HTMLElement,
): ScrollAnchor | null {
  const scrollerTop = scroller.getBoundingClientRect().top;
  const contentRect = view.contentDOM.getBoundingClientRect();
  // One pixel inside the viewport, and far enough from the left edge to land on
  // the line rather than in its padding.
  const pos = view.posAtCoords({ x: contentRect.left + 4, y: scrollerTop + 1 });
  if (pos === null) return null;
  let top: number;
  try {
    top = view.lineBlockAt(pos).top;
  } catch {
    // Measured, not assumed: the real `lineBlockAt` throws `RangeError:
    // Invalid position N in document of length M` for a position past the end,
    // which is what a coordinate read during a re-layout can produce. The
    // earlier wording here said "outside the measured height map", which was a
    // guess at the cause and named a different one.
    return null;
  }
  return { pos, offsetPx: contentRect.top + top - scrollerTop };
}

/** Remember `view`'s current reading position for `noteId`. No-op when it cannot
 *  be measured, so a bad moment never overwrites a good anchor, and no-op while
 *  a restore of this note is still settling, so the restore cannot write its own
 *  rounding error back over the anchor it came from (myne#651). */
export function rememberScroll(
  noteId: string,
  view: EditorView,
  scroller: HTMLElement,
): void {
  // SYNC-8: layout numbers only. Written before any early return so a
  // suppressed or unreadable pass still records where the pane actually was.
  scroller.dataset.scrollAnchorTop = String(Math.round(scroller.scrollTop));
  // Before the suppression early-return: this call IS the reader moving, which is
  // exactly what a restore needs to know, whether or not the anchor is written.
  readerMoves.set(noteId, Date.now());
  if (isRestoringScroll(noteId)) {
    scroller.dataset.scrollAnchorWrite = "suppressed";
    // **A suppressed write is DEFERRED, not dropped.** The suppression window
    // exists to keep a restore from writing its own rounding error back over the
    // anchor it came from, and it lasts 500 ms. A position the reader takes
    // inside that window is a real position, and the pane only calls this on a
    // scroll: drop it here and nothing runs again until the next scroll, so the
    // anchor stays at whatever the restore left.
    //
    // Measured 2026-10-25 on `scroll-memory` sm2, which is the reproduction: a
    // stale `pos: 0` restore finished three frames before the reader scrolled,
    // the settle remember arrived inside the window, and the note's anchor was
    // still `0` afterwards with `liveTop=1200` on screen — so the split that
    // follows opens at the top, which is the reported myne#600 symptom.
    scheduleDeferredRemember(noteId, view, scroller);
    return;
  }
  const anchor = readScrollAnchor(view, scroller);
  if (anchor !== null) {
    anchors.set(noteId, anchor);
    // SYNC-8 observability: layout/document numbers only, never note content.
    scroller.dataset.scrollAnchorPos = String(anchor.pos);
    scroller.dataset.scrollAnchorWrite = "ok";
  } else {
    scroller.dataset.scrollAnchorWrite = "unreadable";
  }
}

/**
 * One pending re-remember per scroller, for a write the restore window swallowed.
 *
 * Keyed on the SCROLLER rather than on the note: the retry captures that
 * element's position, and the same note can be mounted in two panes, each with
 * its own scroller and its own reading position.
 */
const deferredRemember = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function scheduleDeferredRemember(
  noteId: string,
  view: EditorView,
  scroller: HTMLElement,
): void {
  // A second suppressed write would only re-arm the same timer; the closure reads
  // the scroller live, so the latest position is what lands.
  if (deferredRemember.has(scroller)) return;
  // Relative to what is LEFT of the window, not to its full width: the write that
  // got suppressed usually arrives a few hundred ms into it (the pane coalesces
  // scroll on a trailing timer), and waiting the whole window again would land
  // the retry past the point a caller is entitled to see a position.
  const delay = scrollRestoreRemaining(noteId) + 32;
  const timer = setTimeout(() => {
    deferredRemember.delete(scroller);
    // The pane this was for may be gone by now: a swapped view, a closed tab, a
    // split that unmounted it. Reading a detached view's coordinates is how a
    // "remember" turns into a crash, and there is nothing to remember anyway.
    if (!scroller.isConnected || !view.dom.isConnected) return;
    if (isRestoringScroll(noteId)) {
      scheduleDeferredRemember(noteId, view, scroller);
      return;
    }
    const anchor = readScrollAnchor(view, scroller);
    if (anchor === null) {
      scroller.dataset.scrollAnchorWrite = "unreadable";
      return;
    }
    anchors.set(noteId, anchor);
    scroller.dataset.scrollAnchorPos = String(anchor.pos);
    scroller.dataset.scrollAnchorWrite = "deferred-ok";
  }, delay);
  deferredRemember.set(scroller, timer);
}

/** The anchor remembered for `noteId`, if any. */
export function recallScroll(noteId: string): ScrollAnchor | undefined {
  return anchors.get(noteId);
}

/** Forget `noteId`, for a closed tab whose reopen should start at the top. */
export function forgetScroll(noteId: string): void {
  anchors.delete(noteId);
  // Both maps, not just the anchors. `evictClosedTabs` routes here, so leaving
  // the suppression mark behind would accumulate one entry per note restored
  // and then closed, for the life of the session, with nothing able to read it
  // again. The note is gone; its mark cannot matter.
  restoring.delete(noteId);
  readerMoves.delete(noteId);
}

/**
 * Evict the notes a pane just CLOSED: open on the previous pass, gone now.
 *
 * The pane's own tab set is the input, and it has to be, which is the whole
 * reason this is a function rather than three lines at the call site. The first
 * version walked the per-note `EditorState` cache instead and evicted the keys
 * that were no longer open, which answers a different question: that cache holds
 * only notes the pane switched AWAY from, since the active note's state lives in
 * the editor itself, and it is emptied wholesale whenever an out-of-band change
 * (a sync pull, an external edit) invalidates it. So a tab closed without ever
 * having been left, and any tab closed after a sync pull, kept its reading
 * position for the rest of the session, and a reopen landed halfway down a note
 * nobody remembered scrolling.
 *
 * A SPLIT is deliberately not this case: it leaves the source pane's tab where
 * it is, so the id stays in `open` and the anchor survives, which is what makes
 * "reopen starts at the top" a statement about closing rather than about panes.
 *
 * `stateCache` is evicted alongside, so the two cannot disagree about which
 * notes this pane still has open. Returns the ids it forgot, for the caller's
 * tests and for nothing else.
 */
export function evictClosedTabs(
  previouslyOpen: Iterable<string>,
  open: ReadonlySet<string>,
  stateCache: Pick<Map<string, unknown>, "delete">,
): string[] {
  const closed: string[] = [];
  for (const id of previouslyOpen) {
    if (open.has(id)) continue;
    stateCache.delete(id);
    forgetScroll(id);
    closed.push(id);
  }
  return closed;
}

/**
 * Put `anchor`'s line back where it was — moved to `./scrollAnchorApply`, which
 * is the only module here allowed to value-import `EditorView`, because this one
 * is on the pre-unlock path (see the import note at the top). The doc comment
 * explaining the `scrollIntoView` dispatch and the required `noteId` moved with
 * it.
 */

/** Forget every remembered position.
 *
 * Called on both vault-leaving paths (`lockVault`, `leaveActiveVault`) and
 * asserted there by `scripts/check-frontend-lock-teardown.mjs`: this map is
 * module scope, no leaving path reloads the WebView, and the memory this
 * feature promises is scoped to the session a lock ends. Also the reset the
 * tests use between cases. */
export function resetScrollMemory(): void {
  anchors.clear();
  // The in-flight restore marks too (myne#651). Both maps are module scope and
  // no leaving path reloads the WebView, so a mark left behind here outlives the
  // vault it belongs to and silences the FIRST scroll write of the next
  // session's note with the same id. It cost a test before it could cost a user,
  // which is the cheap version of the same bug.
  restoring.clear();
  readerMoves.clear();
}
