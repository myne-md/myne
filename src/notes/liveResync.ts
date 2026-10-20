// The desktop pane's live resync (myne-md/myne#849 review round 5).
//
// It runs when the shared merge drain (`@myne/editor/live-remote-merge`) could
// not place a remote change: the pane did not know what the session held, or the
// delivery threw. It is the branch where text is lost if anything is wrong, so it
// is a module with injected deps rather than an inline closure, for the same
// reason the mobile twin (`mobile/src/lib/liveResync.ts`) is: the inline version
// was reachable by no test, and its failure arm said nothing.
//
// The two clients differ in one place, and on purpose. The pane autosaves and
// already owns a keep-both handler (the §11.3 rejection path), which saves the
// unsaved text as a copy and only then adopts the session's text, so a dirty
// buffer goes there rather than through a second copy routine.

export interface PaneResyncDeps {
  /** Whether the pane still shows the note the resync is for. */
  stillOn(): boolean;
  /** Whether the buffer holds text no save has carried yet. */
  hasPendingWork(): boolean;
  /** The keep-both handler: copy the unsaved buffer, then adopt the session. */
  keepBoth(): Promise<void>;
  /** The session's text, or `null` when no session owns the note any more. */
  readSession(): Promise<string | null>;
  /** Re-baseline the autosave to `text`, show it, and set the mirror to it. */
  adopt(text: string): void;
  /**
   * Forget what the session held. The next save then merges against the text the
   * autosave last wrote or loaded, which is what the buffer derives from while
   * the drain is placing nothing.
   */
  forgetMirror(): void;
  /** Tell the user the note could not be brought up to date. */
  reportFailure(): void;
}

export type PaneResyncOutcome = "keptBoth" | "reloaded" | "sessionGone" | "readFailed";

/** Run one resync. Never rejects; a failure is reported and changes no text. */
export async function runPaneResync(deps: PaneResyncDeps): Promise<PaneResyncOutcome | null> {
  if (!deps.stillOn()) return null;
  if (deps.hasPendingWork()) {
    try {
      await deps.keepBoth();
      return "keptBoth";
    } catch {
      deps.forgetMirror();
      deps.reportFailure();
      return "readFailed";
    }
  }
  let text: string | null;
  try {
    text = await deps.readSession();
  } catch {
    deps.forgetMirror();
    deps.reportFailure();
    return "readFailed";
  }
  // The session closed, which flushed it; the pane is leaving the note and the
  // ordinary reload path owns what it shows next.
  if (text === null) return "sessionGone";
  if (!deps.stillOn()) return null;
  // Typing started during the read: the buffer now holds unsaved text, so it
  // takes the keep-both route rather than being replaced.
  if (deps.hasPendingWork()) return runPaneResync(deps);
  deps.adopt(text);
  return "reloaded";
}
