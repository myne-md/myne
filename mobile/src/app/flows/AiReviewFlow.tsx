// The mobile agent review (myne-md/myne#456 task 12).
//
// **This is the screen that authorises writes to note bodies.** Everything
// below that reads as a layout choice is load-bearing; the three rules the
// desktop screen names are inherited whole, not re-derived:
//
//   1. **Bulk approve structurally cannot carry a removal.** Every way Myne
//      takes a note out of the note list is a frontmatter field (`trashed:`,
//      `deleted:`, `archived:`, `template:`, `conflict:`), so at the diff layer
//      it is indistinguishable from any other edit, and "the agent only edits
//      bodies" would quietly become "a silent removal inside a forty-edit
//      approve-all". `splitForBulkApproval` does the split and the bulk path is
//      handed ONLY the approvable half: it has no way to reach the other one.
//      Each removal says WHICH removal, because one sentence cannot be true for
//      all five. The host refuses a hiding edit under `approval: "bulk"` in any
//      case, so this is the screen agreeing with a rule rather than enforcing
//      one, which is the right direction.
//   2. **The running scope total is always on screen.** With no cap on scope
//      growth, this number is what bounds accumulation.
//   3. **Refused edits are shown with their cause.** An edit the host could not
//      place must never be mistaken for one that was not needed.
//
// **Summary first, diff behind a tap**, and that is a phone constraint rather
// than a preference. A unified diff of several notes does not read at 390px, and
// an unreadable diff turns a deliberate act into theatre: the user taps Apply
// because scrolling a wall of wrapped text is worse than trusting it. So the
// screen opens on a list of changed notes with counts, and one note's diff is a
// tap away.
//
// **It does not dismiss on the back gesture** (`design-notes/ai/0521`). On
// desktop that rule is about the backdrop and Escape; here it is Android's
// hardware back and iOS's edge-swipe, which are the same act. Closing discards a
// proposal the user has not applied, and a stray back that throws the model's
// work away would be a worse surface than no back at all. The back gesture
// closes an OPEN DIFF instead, which is a real navigation step, and does nothing
// at the top level.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { changedLineCount, lineDiff } from "@myne/dialect";
import type { DiffLine } from "@myne/dialect";
import { RunCostLine } from "@myne/run-cost-line";
import {
  currentRunEpoch,
  failRun,
  keptEdits,
  landedEditIndices,
  settleApply,
  useAgent,
} from "@myne/agent-store";
import {
  editHidesNoteAs,
  removalFlagLabel,
  hasRefusals,
  splitForBulkApproval,
  type AgentApplyResult,
  type ProposedEdit,
} from "@myne/agent-protocol";

import { agentApply } from "../../lib/agent-run";
import { Button } from "../../components/Button";


const HEADER: CSSProperties = {
  flex: "none",
  padding: "var(--space-3) var(--space-4)",
  borderBottom: "1px solid var(--line-1)",
  background: "var(--bg-1)",
};

const H_TITLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
};

const H_META: CSSProperties = {
  display: "block",
  marginTop: "var(--space-1)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

const ROW: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: "var(--space-1)",
  width: "100%",
  padding: "var(--space-3) var(--space-4)",
  border: "none",
  borderBottom: "1px solid var(--line-1)",
  background: "transparent",
  textAlign: "start",
  cursor: "pointer",
};

const ROW_TITLE: CSSProperties = {
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ROW_META: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

const FLAG: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--danger, var(--fg-1))",
};

const ACTIONS: CSSProperties = {
  flex: "none",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding:
    "var(--space-3) var(--space-4) calc(var(--space-3) + env(safe-area-inset-bottom, 0px))",
  borderTop: "1px solid var(--line-1)",
};

/** One diff line. Rendered as its own block with a marker column, never as a
 *  side-by-side pair: two columns of wrapped note text at 390px is the shape
 *  that made the diff unreadable in the first place.
 *
 *  Exported because the proposal diff sheet (myne-md/myne#741) renders the same
 *  line, and the testid namespace is a parameter so that second surface does not
 *  publish `ai.review-*` under a different screen. */
export function DiffLineView({
  line,
  testIdPrefix = "ai.review",
}: {
  line: DiffLine;
  testIdPrefix?: string;
}) {
  const tone =
    line.type === "add"
      ? { background: "var(--diff-add-bg, transparent)", color: "var(--fg-1)" }
      : line.type === "del"
        ? { background: "var(--diff-del-bg, transparent)", color: "var(--fg-2)" }
        : { color: "var(--fg-3)" };
  return (
    <div
      data-testid={`${testIdPrefix}-diff-${line.type}`}
      style={{
        display: "flex",
        gap: "var(--space-2)",
        padding: "var(--space-1) var(--space-3)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-sm)",
        lineHeight: "var(--leading-mono)",
        // Wrapping rather than a horizontal scroller. The page must never
        // scroll sideways, and a long line of prose is the common case here.
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        ...tone,
      }}
    >
      <span aria-hidden="true" style={{ flex: "none", color: "var(--fg-3)" }}>
        {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{line.text}</span>
    </div>
  );
}

export function AiReviewFlow({
  /** Resolve a note's title for display. The proposal carries ids. */
  titleOf,
  /** Read a note's current body, for the diff. `null` when it cannot be read. */
  bodyOf,
  onNotesWritten,
  onClose,
}: {
  titleOf: (noteId: string) => string | null;
  bodyOf: (noteId: string) => string | null;
  /** The host's list of notes that actually changed, so the surface behind this
   *  one can reload them. The HOST's list, not the one that was sent: an edit
   *  can be refused at apply time, so the notes that actually changed are the
   *  ones to reload. */
  onNotesWritten?: (noteIds: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const agent = useAgent();
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { bulkApprovable, needsOwnAct } = useMemo(
    () => splitForBulkApproval(keptEdits(agent)),
    // `keptEdits` reads the proposal, the rejections and the applied set; all
    // three are what change the answer. It is INSIDE the memo rather than
    // beside it, or the walk it does would run on every render while only the
    // split was cached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent.proposal, agent.rejected, agent.appliedEdits],
  );

  /** Changed lines per note, computed once per proposal rather than per render.
   *
   *  **`lineDiff`, not `diffWithSegments`.** `changedLineCount` reads only each
   *  line's `type`, and the segmented variant is `computeLineDiff` PLUS a
   *  second token-level LCS per corresponding del/add pair whose entire output
   *  is then discarded here. Unmemoized and segmented, a forty-edit proposal
   *  re-ran both tables on every store emit and every composer keystroke. */
  const changedLines = useMemo(() => {
    const by = new Map<string, number>();
    for (const e of bulkApprovable) {
      by.set(
        e.noteId,
        (by.get(e.noteId) ?? 0) + changedLineCount(lineDiff(e.anchor, e.replacement)),
      );
    }
    return by;
  }, [bulkApprovable]);

  /** The bulk-approvable edits grouped by note, in first-seen order. */
  const groups = useMemo(() => {
    const by = new Map<string, ProposedEdit[]>();
    for (const e of bulkApprovable) {
      const list = by.get(e.noteId);
      if (list === undefined) by.set(e.noteId, [e]);
      else list.push(e);
    }
    return [...by.entries()];
  }, [bulkApprovable]);

  // **The back gesture closes an open diff and nothing else.** Android's
  // hardware back and iOS's edge-swipe both arrive as a history pop, so a
  // history entry is pushed while this screen is up and the pop is consumed
  // here. Without it the pop would leave the screen, discarding a proposal the
  // user has not applied, which `design-notes/ai/0521` forbids on desktop for
  // exactly the same reason.
  useEffect(() => {
    // Counted, because the cleanup has to give back exactly what this component
    // took. Without that, every review left one dead entry behind and every
    // back press inside one left another: on Android, where Back is the primary
    // navigation and nothing else in this tree listens for `popstate`, those
    // presses are then silently swallowed, one for each review the session
    // opened.
    let owed = 0;
    const claim = () => {
      owed += 1;
      window.history.pushState({ myneAgentReview: true }, "");
    };
    claim();
    const onPop = () => {
      // The entry this handler consumed is gone, so one is owed back: without
      // it the NEXT back would leave the screen. `owed` is unchanged across the
      // pair, which is what keeps the ledger balanced.
      owed -= 1;
      claim();
      setOpenNote(null);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Give back every entry still outstanding. The listener is removed first,
      // so this `go` is not answered by the handler above.
      if (owed > 0) window.history.go(-owed);
    };
  }, []);

  const apply = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const runId = agent.view?.runId ?? null;
    if (runId === null) {
      setBusy(false);
      return;
    }
    // Where each sent edit sits in the run's own proposal, which is the space
    // the host's refusal indices are against.
    const indices = bulkApprovable.map((e) => agent.proposal.edits.indexOf(e));
    // Captured BEFORE the await: the outcome carries note ids of the vault it
    // describes, so a reply landing after a lock or a vault switch must be
    // dropped rather than written into a module-scope store.
    const epoch = currentRunEpoch();
    try {
      // **Only the bulk-approvable half is sent, AND the host is told this was
      // a bulk approval.** The second half is what makes the rule real: the
      // host re-derives whether each edit takes a note out of the working set,
      // from the note as it will actually be, and refuses one inside a `"bulk"`
      // approval regardless of what this function sent. So the filter here is
      // the screen agreeing with the rule, never the thing enforcing it.
      //
      // No new notes: creating one is a write with no restore point behind it,
      // and mobile does not offer that yet. An empty array rather than the
      // proposal's list, because handing over the whole proposal was the exact
      // defect `approvedNewNotes` exists to prevent.
      //
      // **And no setting changes, for the same shape of reason** (myne-md/myne#850):
      // this client never rendered a setting row, so nothing here could have been
      // approved, and `agent_start` offered no ids to begin with. An empty array
      // rather than the proposal's list, so a client that cannot show a setting
      // cannot approve one by accident.
      const outcome = await agentApply(runId, bulkApprovable, [], [], "bulk");
      // The indices that actually LANDED, not the ones that were sent.
      settleApply(outcome, landedEditIndices(indices, outcome), epoch);
      const changed = [...outcome.notesWritten, ...outcome.notesCreated];
      if (changed.length > 0) onNotesWritten?.(changed);
    } catch {
      // **This is also where a failed restore point lands**, and it is the one
      // branch that must never be quiet. `RestorePointTaker::capture` returns
      // an `Err` when a snapshot could not be taken, and its own contract says
      // an `Err` STOPS the apply: nothing was written. A whole-call failure is
      // strictly worse than a per-edit refusal and used to be the one outcome
      // with no report at all, with `busy` cleared and the screen looking
      // exactly as it did before the tap.
      if (epoch !== currentRunEpoch()) return;
      failRun(t("agent.review.applyFailed"));
    } finally {
      setBusy(false);
    }
  }, [busy, agent, bulkApprovable, onNotesWritten, t]);

  const applied: AgentApplyResult | null = agent.applied;

  if (openNote !== null) {
    const edits = groups.find(([id]) => id === openNote)?.[1] ?? [];
    const body = bodyOf(openNote);
    // Computed here rather than inside the `map` below: this IS the segmented
    // variant, which is the expensive one, and the render body runs on every
    // store emit and every keystroke in the composer still mounted above.
    // `lineDiff`, not `diffWithSegments`. `DiffLineView` renders `line.text`
    // and reads no `segments`, so the segmented variant's second token-level
    // LCS per corresponding del/add pair was computed and discarded, on a
    // render path that runs on every store emit and every composer keystroke.
    // The memo above says the same thing about the line counts.
    const lines = edits.map((e) => lineDiff(e.anchor, e.replacement));
    return (
      <div
        data-testid="ai.review-diff"
        style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
      >
        <div style={HEADER}>
          <h2 style={H_TITLE}>{titleOf(openNote) ?? t("agent.review.untitledNote")}</h2>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {body === null ? (
            <p data-testid="ai.review-unreadable" style={{ padding: "var(--space-4)" }}>
              {t("agent.review.refused.readFailed")}
            </p>
          ) : (
            edits.map((_e, i) => (
              <div key={i} style={{ borderBottom: "1px solid var(--line-1)" }}>
                {(lines[i] ?? []).map((line, j) => (
                  <DiffLineView key={j} line={line} />
                ))}
              </div>
            ))
          )}
        </div>
        <div style={ACTIONS}>
          <Button variant="secondary" data-testid="ai.review-back" onClick={() => setOpenNote(null)}>
            {t("agent.review.close")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="ai.review"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <div style={HEADER}>
        <h2 data-testid="ai.review-title" style={H_TITLE}>
          {t("agent.review.title")}
        </h2>
        {/* Rule 2: the running scope total, in the header, always. */}
        <span data-testid="ai.review-scope" style={H_META}>
          {t("agent.review.scopeTotal", { count: agent.view?.scopeTotal ?? 0 })}
        </span>
        <RunCostLine
          testId="ai.review-cost"
          iterations={agent.iterations}
          notesRead={agent.notesRead}
          charsOffDevice={agent.charsOffDevice}
          style={H_META}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {groups.length === 0 && needsOwnAct.length === 0 && (
          <p data-testid="ai.review-empty" style={{ padding: "var(--space-4)" }}>
            {t("agent.review.noChanges")}
          </p>
        )}

        {/* Summary first: one row per changed note, with its edit count. The
            diff is a tap away rather than inline. */}
        {groups.map(([noteId, edits]) => (
          <button
            key={noteId}
            data-testid="ai.review-note"
            data-note-id={noteId}
            style={ROW}
            onClick={() => setOpenNote(noteId)}
          >
            <span style={ROW_TITLE}>{titleOf(noteId) ?? t("agent.review.untitledNote")}</span>
            <span style={ROW_META}>
              {t("agent.review.noteHeading", { count: edits.length })}
              {" · "}
              {t("agent.review.changedLines", { count: changedLines.get(noteId) ?? 0 })}
            </span>
          </button>
        ))}

        {/* Rule 1: the removals, separately, each saying WHICH removal. They are
            not in the Apply above and cannot be: the host refuses a hiding edit
            under `"bulk"`, and this screen agrees with that rather than routing
            around it. */}
        {needsOwnAct.map((e, i) => {
          // Never null: `splitForBulkApproval` partitions on `editHidesNote`,
          // which IS `editHidesNoteAs(edit) !== null`. Defended with a fallback
          // rather than a branch, so the impossible case cannot render an empty
          // flag beside a destructive row.
          const field = editHidesNoteAs(e) ?? "trashed";
          return (
            <div key={i} data-testid="ai.review-removal" style={{ ...ROW, cursor: "default" }}>
              <span style={ROW_TITLE}>{titleOf(e.noteId) ?? t("agent.review.untitledNote")}</span>
              <span data-testid="ai.review-removal-flag" style={FLAG}>
                {removalFlagLabel(field, t)}
              </span>
            </div>
          );
        })}

        {/* Rule 3: refusals with their cause. An edit the host could not place
            must never be mistaken for one that was not needed. */}
        {agent.error !== null && (
          <p role="alert" data-testid="ai.review-error" style={{ padding: "var(--space-4)", ...ROW_META }}>
            {agent.error}
          </p>
        )}

        {applied !== null && hasRefusals(applied) && (
          <ul data-testid="ai.review-refused" style={{ margin: 0, padding: "var(--space-4)" }}>
            {applied.refused.map((r) => (
              <li key={`e-${r.noteId}-${r.index}`} style={ROW_META}>
                {t(`agent.review.refused.${r.reason}`)}
              </li>
            ))}
            {applied.refusedNewNotes.map((r) => (
              <li key={`n-${r.index}`} style={ROW_META}>
                {t(`agent.review.refused.${r.reason}`)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={ACTIONS}>
        <Button
          data-testid="ai.review-apply"
          disabled={busy || bulkApprovable.length === 0}
          onClick={() => void apply()}
        >
          {t("agent.review.approveAll", { count: bulkApprovable.length })}
        </Button>
        <Button variant="secondary" data-testid="ai.review-close" onClick={onClose}>
          {t("agent.review.close")}
        </Button>
      </div>
    </div>
  );
}
