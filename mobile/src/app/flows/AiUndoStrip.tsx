// The mobile last-run undo (myne-md/myne#456 task 13).
//
// **The offer outlives the review screen** (`docs/decisions/ai/0518`). The
// record lives host-side keyed by the run id, so this strip READS it rather
// than remembering it, and the offer disappears on its own when the host's copy
// goes: the next apply supersedes it, a vault lock clears it. It is not a
// persistent history and one run deep, the most recent.
//
// The logic is `useUndoLastRun`, shared verbatim with desktop, because it
// carries three recorded defect fixes that a second copy would be a second
// chance to get wrong. What is here is the rendering, and one sentence desktop
// does not have.
//
// **That sentence is the point of this file.** The record goes with the run:
// it is in the same in-memory state, so locking the vault, switching vault or
// letting the OS reclaim the app all take it. Persisting it would put verbatim
// note plaintext on disk and reverse the argument `docs/decisions/ai/0515`
// rests on, so the record's lifetime is not a thing to fix, it is a thing to
// SAY. And snapshot metadata records no origin, so the record cannot be
// reconstructed from the snapshot store afterwards either: "which snapshots
// belonged to that run" is not a question the store can answer.
//
// So the copy states the limit and NAMES the durable path in the same breath.
// A user who is told "this expires" and not told what replaces it has been
// warned about a loss rather than pointed at a remedy, and the per-note version
// history holds every one of these snapshots permanently.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { undoResultText, useUndoLastRun } from "@myne/undo-last-run";

import { agentLastRun, agentUndo } from "../../lib/agent-run";
import { Button } from "../../components/Button";

const STRIP: CSSProperties = {
  flex: "none",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding: "var(--space-3) var(--space-4)",
  borderTop: "1px solid var(--line-1)",
  background: "var(--bg-2)",
  color: "var(--fg-2)",
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
};

const NOTE: CSSProperties = {
  margin: 0,
  color: "var(--fg-3)",
};

export function AiUndoStrip({
  onReverted,
  /** Open the per-note version history. Omitted where there is nowhere to send
   *  the user, in which case the sentence still states the limit but makes no
   *  offer it cannot honour. */
  onOpenHistory,
}: {
  onReverted?: (noteIds: readonly string[]) => void;
  onOpenHistory?: () => void;
}) {
  const { t } = useTranslation();
  const { run, report, busy, undo } = useUndoLastRun({
    agentLastRun,
    agentUndo,
    ...(onReverted === undefined ? {} : { onReverted }),
  });

  if (run === null && report === null) return null;

  return (
    <div data-testid="ai.undo" style={STRIP}>
      {report === null && run !== null && (
        <>
          <span data-testid="ai.undo-summary">
            {t("agent.undo.offer", { count: run.restorePoints.length })}
          </span>
          <Button
            variant="secondary"
            disabled={busy}
            data-testid="ai.undo-action"
            onClick={() => void undo()}
          >
            {t("agent.undo.action")}
          </Button>
        </>
      )}

      {report !== null && (
        <span data-testid="ai.undo-result">{undoResultText(report, t)}</span>
      )}

      {/* Rendered under BOTH arms. After an undo the sentence is still the
          honest one about what is left: the run's record is spent either way,
          and the version history is what remains. */}
      <p data-testid="ai.undo-session-only" style={NOTE}>
        {t("agent.undo.sessionOnly")}
      </p>
      {onOpenHistory !== undefined && (
        <Button
          variant="secondary"
          data-testid="ai.undo-history"
          onClick={onOpenHistory}
        >
          {t("agent.undo.sessionOnlyLink")}
        </Button>
      )}
    </div>
  );
}
