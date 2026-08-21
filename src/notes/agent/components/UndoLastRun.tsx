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

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../../components/primitives/Button";
import {
  agentLastRun,
  agentUndo,
  type AgentUndoResult,
} from "../../../lib/agent-run";
import { currentRunEpoch, setUndoable, useAgent } from "../agentStore";

export interface UndoLastRunProps {
  /** Called after an undo changed notes on disk, so the caller can reload what
   *  it is showing. Without it the editor keeps rendering the applied text of a
   *  note that has just been reverted underneath it. */
  onReverted?: (noteIds: readonly string[]) => void;
}

export function UndoLastRun({ onReverted }: UndoLastRunProps) {
  const { t } = useTranslation();
  const agent = useAgent();
  const [busy, setBusy] = useState(false);
  // The report, and WHICH run it describes. The run id is not decoration: an
  // earlier version kept only the report, so after one undo this strip showed
  // that report forever and the NEXT run's undo offer never rendered, since the
  // two arms below are mutually exclusive. Keying the report to its run is what
  // lets a new run supersede it.
  const [result, setResult] = useState<{
    runId: string;
    report: AgentUndoResult;
  } | null>(null);

  // Re-read whenever an apply lands, and on mount. The host is the owner, so
  // this asks rather than infers: an apply in another surface, or a lock that
  // cleared the record, both show up here on the next read without this
  // component modelling either event.
  const appliedTick = agent.applied?.applied ?? 0;
  useEffect(() => {
    let live = true;
    // Captured before the await: a reply landing after the vault was left must
    // not re-seed the offer with the previous vault's note ids. The unmount
    // this used to rely on is a rendering fact, not a guarantee.
    const epoch = currentRunEpoch();
    void agentLastRun()
      .then((run) => {
        if (!live) return;
        setUndoable(run, epoch);
        // A different run than the one the report describes means the report is
        // history. Dropping it here rather than on the undo is deliberate: the
        // report has to survive its own render, and the event that makes it
        // stale is a LATER run, not the undo that produced it.
        setResult((prev) =>
          prev !== null && run !== null && run.runId !== prev.runId ? null : prev,
        );
      })
      .catch(() => {
        // A failed read means the offer is not shown. Failing closed here is
        // right: an Undo button that cannot name a run would fail on press.
        if (live) setUndoable(null, epoch);
      });
    return () => {
      live = false;
    };
  }, [appliedTick]);

  const run = agent.undoable;
  if (run === null && result === null) return null;

  async function undo() {
    if (run === null || busy) return;
    setBusy(true);
    try {
      const r = await agentUndo(run.runId);
      setResult({ runId: run.runId, report: r });
      // The host consumed the record, so the offer goes with it rather than
      // waiting for the next read. A second press would report `noSuchRun`.
      setUndoable(null, currentRunEpoch());
      onReverted?.(run.restorePoints.map(([noteId]) => noteId));
    } catch {
      setResult(null);
      // Re-read rather than guessing: the run may be gone (a lock landed) or
      // the call may simply have failed, and those want different offers.
      const epoch = currentRunEpoch();
      await agentLastRun()
        .then((r) => setUndoable(r, epoch))
        .catch(() => setUndoable(null, epoch));
    } finally {
      setBusy(false);
    }
  }

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
      {result === null && run !== null ? (
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
      {result !== null ? (
        <span data-testid="agentUndoLast.result" style={{ flex: 1 }}>
          {t("agent.undo.reverted", { count: result.report.reverted })}
          {result.report.failed.length > 0
            ? ` ${t("agent.undo.failed", { count: result.report.failed.length })}`
            : ""}
          {/* The half an undo cannot do. Said every time rather than only when
              it would surprise someone, because "the run was undone" otherwise
              reads as covering the notes it created. */}
          {result.report.notesCreatedNotReverted > 0
            ? ` ${t("agent.undo.createdNotReverted", {
                count: result.report.notesCreatedNotReverted,
              })}`
            : ""}
        </span>
      ) : null}
    </div>
  );
}
