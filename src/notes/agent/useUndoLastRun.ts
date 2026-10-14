// The last-run undo's LOGIC, shared by both Tauri clients (myne-md/myne#456).
//
// **Extracted rather than copied, and the reason is what is in here.** This is
// not glue: it carries three recorded defect fixes that a second hand-typed
// copy would be a second chance to get wrong, and each one is invisible until
// it happens to a user.
//
//   1. The re-read is keyed on the apply COUNTER, not on `applied?.applied`. A
//      clean, complete apply settles and drops the run inside one `settleApply`
//      call, so a store subscription only ever sees the final state: `applied`
//      back to null and the old key reading 0 to 0, so the effect never fired
//      and the strip never appeared after the very applies it exists for. The
//      old key also could not tell "no apply yet" from "an apply that landed
//      nothing because every edit was refused", since both read 0.
//   2. The report is keyed to the RUN it describes. Keeping only the report
//      meant that after one undo the strip showed that report forever and the
//      next run's offer never rendered, because the two arms are mutually
//      exclusive.
//   3. The epoch is captured BEFORE each await. A reply landing after the vault
//      was left must not re-seed the offer with the previous vault's note ids.
//      The unmount this used to rely on is a rendering fact, not a guarantee.
//
// **The bindings arrive as arguments** for the same reason `agent-run-core.ts`
// takes a seam: each client reaches IPC through its own `platform/` directory
// (`scripts/check-platform-seam.mjs`, eight guarded roots), so a shared module
// cannot import either client's `agent-run`.
//
// It is deliberately NOT a persistent history. One run, the most recent. The
// durable per-note path is the snapshots panel, which holds every one of these
// snapshots permanently and restores them one at a time.

import { useEffect, useState } from "react";

import type { AgentUndoResult, AppliedRun } from "../../lib/agent-protocol";
import { currentRunEpoch, setUndoable, useAgent } from "./agentStore";

export interface UndoBindings {
  /** The run the user could still undo, or null. */
  agentLastRun: () => Promise<AppliedRun | null>;
  /** Revert a whole agent run, as one action. */
  agentUndo: (runId: string) => Promise<AgentUndoResult>;
  /** Advance THIS client's prefs-changed nonce.
   *
   *  **A binding rather than an import, and the difference is a live bug on the
   *  other client** (2026-10-13 review). This hook is shared and aliased into the
   *  mobile tree, but the nonce is per client: desktop's `usePrefs` subscribes to
   *  `src/notes/prefsNonce`, mobile's to `mobile/src/lib/prefsNonce`, and they are
   *  different modules. Importing one from here bumped the desktop module on both,
   *  so on mobile the undo would restore `vault.prefs` while every mounted reader
   *  kept rendering the value it replaced. Inert today only because mobile offers
   *  no settings, which is the same reasoning `AiChatFlow`'s empty offer list
   *  gives, and the day that changes this is the bug it prevents. */
  bumpPrefsNonce: () => void;
}

export interface UndoLastRunState {
  /** The offer, or null when there is nothing to undo. */
  run: AppliedRun | null;
  /** The report of the undo that just happened, or null. */
  report: AgentUndoResult | null;
  /** Which run `report` describes, so a caller can attach the result to that
   *  turn. Null when there is no report. */
  reportRunId: string | null;
  busy: boolean;
  /** Revert the offered run. A no-op when there is no offer or one is running. */
  undo: () => Promise<void>;
}

/**
 * What an undo did, as one sentence.
 *
 * **The over-claim guard is the reason this is shared.** "The run was undone"
 * reads as covering the notes the run CREATED, and it never does: a create has
 * no earlier version to go back to. So the created-not-reverted clause is
 * appended every time rather than only when somebody might be surprised, and
 * that rule was written out identically in both clients' strips, comment
 * included. The hook already exists so the three recorded defect fixes have one
 * home; this is the fourth thing that had two.
 *
 * Takes `t` as a parameter, so it stays pure and can be called from either
 * client's renderer.
 */
export function undoResultText(
  report: AgentUndoResult,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const parts = [t("agent.undo.reverted", { count: report.reverted })];
  // **The settings are counted apart from the notes** (myne-md/myne#850), which is
  // what decision 0676 promises and what the host has returned since the feature
  // landed. Without this clause a settings-only undo read as "0 notes restored"
  // with no mention of the change that was actually put back, which understates
  // the verb in exactly the way this function's own header warns against.
  if (report.settingsReverted > 0) {
    parts.push(
      t("agent.undo.revertedSettings", { count: report.settingsReverted }),
    );
  }
  if (report.failed.length > 0) {
    parts.push(t("agent.undo.failed", { count: report.failed.length }));
  }
  if (report.notesCreatedNotReverted > 0) {
    parts.push(
      t("agent.undo.createdNotReverted", { count: report.notesCreatedNotReverted }),
    );
  }
  return parts.join(" ");
}

export function useUndoLastRun({
  agentLastRun,
  agentUndo,
  bumpPrefsNonce,
  onReverted,
}: UndoBindings & {
  /** Called after an undo changed notes on disk, so the caller can reload what
   *  it is showing. Without it the surface keeps rendering the applied text of
   *  a note that has just been reverted underneath it. */
  onReverted?: (noteIds: readonly string[]) => void;
}): UndoLastRunState {
  const agent = useAgent();
  const [busy, setBusy] = useState(false);
  // Defect 2: the report AND which run it describes.
  const [result, setResult] = useState<{
    runId: string;
    report: AgentUndoResult;
  } | null>(null);

  // Defect 1: the apply counter. Re-read whenever an apply lands, and on mount.
  // The host is the owner, so this asks rather than infers: an apply in another
  // surface, or a lock that cleared the record, both show up here on the next
  // read without this hook modelling either event.
  const appliedTick = agent.applySeq;
  useEffect(() => {
    let live = true;
    // Defect 3.
    const epoch = currentRunEpoch();
    void agentLastRun()
      .then((run) => {
        if (!live) return;
        setUndoable(run, epoch);
        // A different run than the one the report describes means the report is
        // history. Dropped here rather than on the undo, deliberately: the
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
    // `agentLastRun` is a stable module binding on both clients; keying on it
    // would re-read on every render of a caller that inlines the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedTick]);

  const run = agent.undoable;

  async function undo() {
    if (run === null || busy) return;
    setBusy(true);
    try {
      const r = await agentUndo(run.runId);
      // **The undo writes preferences host-side, so this side has to say so**
      // (myne-md/myne#850, from review). `usePrefs` and the open editor learn a
      // preference moved only from the nonce, and `settleApply` bumps it on the
      // apply path for exactly this reason; the undo wrote through the same
      // host-side setters and bumped nothing, so every mounted reader kept
      // rendering the value the undo had just replaced, on the screen where the
      // user is watching for it to change back.
      if (r.settingsReverted > 0) bumpPrefsNonce();
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

  return {
    run,
    report: result?.report ?? null,
    reportRunId: result?.runId ?? null,
    busy,
    undo,
  };
}
