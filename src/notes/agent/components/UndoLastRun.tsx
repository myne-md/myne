// Undoing the last agent run, from outside the review screen (myne-md/myne#529).
//
// **This exists because the review screen was the only place undo lived.** The
// screen owned the `[noteId, snapshotId]` record, closing it dropped that
// record, and "the whole run can be undone as one action" was therefore true
// only for as long as the user kept a screen open and false the moment they did
// the ordinary thing and closed it. The user guide had already published the
// guarantee.
//
// So the record moved host-side, keyed by the run id, and this strip reads it
// rather than remembering it. What that buys, beyond reachability: the offer
// disappears on its own when the host's record goes (the next apply supersedes
// it; a vault lock clears it), instead of this component having to model the
// lifetime of something it does not own.
//
// It is deliberately NOT a persistent history. One run, the most recent. The
// durable per-note path is the snapshots panel, which holds every one of these
// snapshots permanently and restores them one at a time.
//
// **The logic moved to `useUndoLastRun` and is shared with the mobile client**
// (myne-md/myne#456). What is left here is the rendering. That split is not
// tidiness: this component carried three recorded defect fixes (the apply
// COUNTER as the effect key, the report keyed to its run, the epoch captured
// before each await), each invisible until it happens to a user, and a second
// hand-typed copy would have been a second chance to get all three wrong. The
// hook's own header states them.

import { useTranslation } from "react-i18next";

import { Button } from "../../../components/primitives/Button";
import { agentLastRun, agentUndo } from "../../../lib/agent-run";
import { undoResultText, useUndoLastRun } from "../useUndoLastRun";

export interface UndoLastRunProps {
  /** Called after an undo changed notes on disk, so the caller can reload what
   *  it is showing. Without it the editor keeps rendering the applied text of a
   *  note that has just been reverted underneath it. */
  onReverted?: (noteIds: readonly string[]) => void;
}

export function UndoLastRun({ onReverted }: UndoLastRunProps) {
  const { t } = useTranslation();
  const { run, report, busy, undo } = useUndoLastRun({
    agentLastRun,
    agentUndo,
    ...(onReverted === undefined ? {} : { onReverted }),
  });

  if (run === null && report === null) return null;

  return (
    <div
      data-testid="agentUndoLast.root"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-2) var(--space-3)",
        borderBottom: "1px solid var(--line-1)",
        background: "var(--bg-2)",
        color: "var(--fg-2)",
        fontSize: "var(--text-sm)",
      }}
    >
      {report === null && run !== null ? (
        <>
          <span data-testid="agentUndoLast.summary" style={{ flex: 1 }}>
            {t("agent.undo.offer", { count: run.restorePoints.length })}
          </span>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void undo()}
            data-testid="agentUndoLast.undo"
          >
            {t("agent.undo.action")}
          </Button>
        </>
      ) : null}
      {report !== null ? (
        <span data-testid="agentUndoLast.result" style={{ flex: 1 }}>
          {undoResultText(report, t)}
        </span>
      ) : null}
    </div>
  );
}
