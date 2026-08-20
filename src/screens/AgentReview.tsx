// The agent review screen (myne-md/myne#529, tasks 10, 11 and 13).
//
// A full screen rather than a side panel or a modal, and that is not a layout
// preference. Half the decisions this feature rests on assume approval is a
// separate, attention-requiring act: the scope model, the no-cap answer and the
// SYNC-17 restatement all lean on the user actually reading what they approve. A
// panel at the edge of the editor makes it a thing beside the work; a modal
// makes it something to dismiss.
//
// Three things here are load-bearing rather than presentational.
//
//   1. **Bulk approve structurally cannot carry a removal.** Every way Myne
//      takes a note out of the note list is a frontmatter field (`trashed:`,
//      `deleted:`, `archived:`, `template:`, `conflict:`), so at the diff layer
//      it is indistinguishable from any other edit, and "the agent only edits
//      bodies" would quietly become "a silent removal inside a forty-edit
//      approve-all". The split is done by `splitForBulkApproval`, and the bulk
//      path is handed only the approvable half: it has no way to reach the
//      other one. The row says WHICH removal, because one sentence cannot be
//      true for all five.
//   2. **The running scope total is always on screen.** With no cap on scope
//      growth, this number is what bounds accumulation.
//   3. **Refused edits are shown with their cause.** An edit the host could not
//      place must never be mistaken for one that was not needed.
//
// The diff itself is the existing `<DiffView>` over `diffWithSegments`; nothing
// about how a diff looks is invented here.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DiffView } from "../notes/components/DiffView";
import { RunCostLine } from "../notes/agent/components/RunCostLine";
import { Button } from "../components/primitives/Button";
import { changedLineCount, diffWithSegments } from "../dialect";
import {
  agentApply,
  agentUndo,
  editHidesNoteAs,
  netDeletion,
  splitForBulkApproval,
  type AgentApplyResult,
  type Approval,
  type HidingField,
  type ProposedEdit,
  type ProposedNote,
} from "../lib/agent-run";
import {
  approvedNewNoteIndices,
  currentRunEpoch,
  failRun,
  keptEdits,
  rejectAll,
  setUndoable,
  landedEditIndices,
  settleApply,
  toggleEdit,
  toggleNewNote,
  useAgent,
} from "../notes/agent/agentStore";

/** What approving this removal on its own will do, in the user's words.
 *
 *  **A `switch` over literal keys rather than a template key**, and that is not
 *  style. `scripts/check-i18n.mjs` scans static `t("…")` literals by design (an
 *  expression-aware scanner is a scanner with a bypass), so
 *  ``t(`agent.review.removalFlag.${field}`)`` would put five user-facing
 *  sentences outside every check in this repository — the exact hole
 *  `tests/lib/editRejectionMirror.test.ts` had to be written to close for the
 *  refusal strings. Written this way, a missing key is a `check-i18n` failure
 *  in `pre-commit`.
 *
 *  Exhaustive over `HidingField`, so a sixth marker fails to typecheck here
 *  rather than rendering an empty flag beside a destructive button. */
function removalFlagLabel(field: HidingField, t: (key: string) => string): string {
  switch (field) {
    case "trashed":
      return t("agent.review.removalFlag.trashed");
    case "deleted":
      return t("agent.review.removalFlag.deleted");
    case "archived":
      return t("agent.review.removalFlag.archived");
    case "template":
      return t("agent.review.removalFlag.template");
    case "conflict":
      return t("agent.review.removalFlag.conflict");
  }
}

/** A deletion this large gets a visual flag.
 *
 *  A flag rather than a block, and rather than an exclusion from bulk approve: a
 *  threshold that refused a large cut would also refuse a legitimate "condense
 *  this note", which is ordinary work the feature exists to do. The `trashed:`
 *  exclusion is the structural rule; this is the visual one, and the two are
 *  deliberately different in kind. */
const LARGE_DELETION_CHARS = 240;

interface EditRow {
  edit: ProposedEdit;
  index: number;
  /** Which working-set marker this edit introduces, or `null`. */
  removes: HidingField | null;
  largeDeletion: boolean;
}

export function AgentReview({
  onClose,
  onNotesWritten,
  titleOf,
}: {
  onClose: () => void;
  /** Called with the ids of notes an apply CHANGED on disk.
   *
   *  **Not cosmetic, and not optional in practice.** An apply writes through the
   *  backend, out of band of any pane's own autosave loop, so the open pane goes
   *  on holding the pre-apply buffer. Two things follow: the editor keeps
   *  showing text that is no longer on disk, and the pane's next autosave writes
   *  that stale buffer back, silently reverting the edit the user just approved
   *  and bumping the note's sync version while doing it. The task-write path
   *  (`TASK_WRITE_EVENT`) already solved exactly this; this is the same solution
   *  reached through a prop rather than a global event, because this screen has
   *  a parent to tell. */
  onNotesWritten?: (noteIds: readonly string[]) => void;
  /** Resolve a note id to its title. Without it the review screen shows a diff
   *  and never says which note receives it, which is not informed approval. */
  titleOf: (noteId: string) => string | null;
}) {
  const { t } = useTranslation();
  const agent = useAgent();
  const [busy, setBusy] = useState(false);
  const [undoReport, setUndoReport] = useState<{
    reverted: number;
    failed: string[];
    notesCreatedNotReverted: number;
  } | null>(null);

  const rows: EditRow[] = useMemo(
    () =>
      // `editHidesNoteAs` rather than membership of `splitForBulkApproval`'s
      // `needsOwnAct`: `editHidesNote` IS `editHidesNoteAs(…) !== null`, so the
      // two can never disagree, and asking twice could. A row the split excluded
      // but this call reported `null` for would render no flag AND no
      // separate-act button, which is the one state that leaves an edit the
      // user can neither approve nor understand.
      agent.proposal.edits.map((edit, index) => ({
        edit,
        index,
        removes: editHidesNoteAs(edit),
        largeDeletion: netDeletion(edit) >= LARGE_DELETION_CHARS,
      })),
    [agent.proposal.edits],
  );

  const byNote = useMemo(() => {
    const map = new Map<string, EditRow[]>();
    for (const row of rows) {
      const list = map.get(row.edit.noteId) ?? [];
      list.push(row);
      map.set(row.edit.noteId, list);
    }
    return [...map.entries()];
  }, [rows]);

  const kept = useMemo(() => keptEdits(agent), [agent]);
  // Derived from `rows`, which already classified every edit. Re-partitioning
  // here would re-run five marker regexes over every anchor and replacement on
  // every render, purely to render a count.
  const bulkApprovableCount = useMemo(
    () => rows.filter((r) => r.removes === null && !agent.rejected.has(r.index)).length,
    [rows, agent.rejected],
  );
  /** Whether Approve-all has anything to send.
   *
   *  **Counts BOTH verbs**, because `approveAll` sends both and `apply()`
   *  guards on both. The button used to ask `kept.length === 0`, which counts
   *  edits only, so a run that proposed only new notes (or one whose edits were
   *  all rejected) left the button dead and its notes uncreatable, with no
   *  second route: `NewNotesGroup` offers reject/restore only, and `onApplyOne`
   *  always sends an empty new-note list. `apply()`'s own comment records that
   *  an edit-count-only early return had already caused exactly this once, in
   *  core; the button reintroduced it one layer up.
   *
   *  **And it counted the wrong edits, one layer up again.** `kept` is every
   *  non-rejected edit; `approveAll` sends only the bulk-approvable half, so a
   *  proposal whose only kept edit TRASHES a note enabled a button that then
   *  sent an empty list, which `apply()` returns early on. Pressing it did
   *  nothing at all: no write, no report, no message, next to a label already
   *  reading "Approve all (0)". Asked of the payload the bulk action actually
   *  builds, so the button cannot promise what the action will not do. */
  const hasApprovedWork = useMemo(
    () => bulkApprovableCount > 0 || approvedNewNoteIndices(agent).length > 0,
    [bulkApprovableCount, agent],
  );

  async function apply(
    edits: ProposedEdit[],
    newNoteIndices: number[],
    approval: Approval,
  ) {
    if (!agent.view) return;
    // NOT `edits.length === 0`: a run may propose only new notes, and an early
    // return on the edit count made those uncreatable in one direction while the
    // old whole-proposal hand-off created them unreviewed in the other.
    if (edits.length === 0 && newNoteIndices.length === 0) return;
    setBusy(true);
    const indices = edits.map((e) => agent.proposal.edits.indexOf(e));
    try {
      const outcome = await agentApply(
        agent.view.runId,
        edits,
        newNoteIndices,
        approval,
      );
      // The indices that actually LANDED, not the ones that were sent. The
      // subtraction lives in `landedEditIndices` rather than here, because this
      // is where it was missing and a call site is not testable.
      settleApply(outcome, landedEditIndices(indices, outcome));
      // The host's list, not the one that was sent: an edit can be refused at
      // apply time, so the notes that actually changed are the ones to reload.
      const changed = [...outcome.notesWritten, ...outcome.notesCreated];
      if (changed.length > 0) onNotesWritten?.(changed);
    } catch {
      // A whole-call failure is strictly worse than a per-edit refusal and was
      // the one outcome with no report: `busy` cleared and the screen looked
      // exactly as it did before the click.
      failRun(t("agent.review.applyFailed"));
    } finally {
      setBusy(false);
    }
  }

  /** The bulk action.
   *
   *  It is handed the approvable half AND tells the host this was a bulk
   *  approval. The second half is what makes the rule real: the host re-derives
   *  whether each edit takes a note out of the working set, from the note as it
   *  will actually be, and refuses one inside a `"bulk"` approval regardless of
   *  what this function sent. So a future edit that changed this to
   *  `apply(kept, "bulk")` would be refused by the host rather than silently
   *  removing a note. */
  async function approveAll() {
    const { bulkApprovable } = splitForBulkApproval(kept);
    await apply(bulkApprovable, approvedNewNoteIndices(agent), "bulk");
  }

  async function undo() {
    // The run id, not the snapshot list: the host stored the record under it
    // when the apply wrote, which is what lets the same undo be offered after
    // this screen is closed, and what makes a second press report `noSuchRun`
    // rather than restoring the same snapshots over later edits.
    const runId = agent.view?.runId;
    const result = agent.applied;
    if (!runId || !result || result.restorePoints.length === 0) return;
    setBusy(true);
    try {
      const restored = result.restorePoints.map(([noteId]) => noteId);
      const undone = await agentUndo(runId);
      setUndoReport(undone);
      // The host consumed its record, so the offer elsewhere goes with it.
      setUndoable(null, currentRunEpoch());
      // Same reason as the apply path: an undo rewrites notes behind the pane.
      if (restored.length > 0) onNotesWritten?.(restored);
    } catch {
      failRun(t("agent.review.undoFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="agentReview.screen"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--paper)",
        color: "var(--fg-1)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--space-4)",
          padding: "var(--space-4) var(--space-5)",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <h1
          data-testid="agentReview.title"
          style={{
            margin: 0,
            fontSize: "var(--text-xl)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          {t("agent.review.title")}
        </h1>
        {/* Always on screen, never behind a disclosure: with no cap on scope
            growth this is the only thing bounding accumulation. */}
        <span data-testid="agentReview.scopeTotal" style={{ color: "var(--fg-2)" }}>
          {t("agent.review.scopeTotal", { count: agent.view?.scopeTotal ?? 0 })}
        </span>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={onClose} data-testid="agentReview.close">
          {t("agent.review.close")}
        </Button>
      </header>

      {agent.proposal.summary ? (
        <p
          data-testid="agentReview.summary"
          style={{
            margin: 0,
            padding: "var(--space-3) var(--space-5)",
            color: "var(--fg-2)",
            borderBottom: "1px solid var(--line-1)",
          }}
        >
          {agent.proposal.summary}
        </p>
      ) : null}

      <div style={{ flex: 1, overflow: "auto" }}>
        {byNote.length === 0 ? (
          <p
            data-testid="agentReview.empty"
            style={{ padding: "var(--space-5)", color: "var(--fg-2)" }}
          >
            {t("agent.review.noChanges")}
          </p>
        ) : (
          byNote.map(([noteId, noteRows]) => (
            <NoteGroup
              key={noteId}
              noteId={noteId}
              title={titleOf(noteId)}
              rows={noteRows}
              rejected={agent.rejected}
              applied={agent.appliedEdits}
              busy={busy}
              onToggle={toggleEdit}
              onApplyOne={(edit) => void apply([edit], [], "individual")}
            />
          ))
        )}

        {agent.proposal.newNotes.length > 0 ? (
          <NewNotesGroup
            notes={agent.proposal.newNotes}
            rejected={agent.rejectedNewNotes}
            onToggle={toggleNewNote}
          />
        ) : null}

        {agent.applied ? <ApplyReport result={agent.applied} /> : null}

        {agent.error ? (
          <p
            data-testid="agentReview.error"
            style={{ padding: "var(--space-5)", color: "var(--danger)" }}
          >
            {agent.error}
          </p>
        ) : null}

        {undoReport ? (
          <p
            data-testid="agentReview.undoReport"
            style={{ padding: "var(--space-5)", color: "var(--fg-2)" }}
          >
            {t("agent.review.undoReport", {
              reverted: undoReport.reverted,
              kept: undoReport.notesCreatedNotReverted,
            })}
          </p>
        ) : null}
      </div>

      <footer
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          padding: "var(--space-4) var(--space-5)",
          borderTop: "1px solid var(--line-1)",
        }}
      >
        {/* The post-run summary. With no volume bound on the remote arm, this is
            where an uncapped run becomes a visible one. Shared with the
            transcript turn, which says the same thing about a run whose
            proposal has since been dropped. */}
        <RunCostLine
          testId="agentReview.runSummary"
          iterations={agent.iterations}
          notesRead={agent.notesRead}
          charsOffDevice={agent.charsOffDevice}
          style={{ color: "var(--fg-2)" }}
        />
        <span style={{ flex: 1 }} />
        {/* Undo the whole run as one action. Only offered once something has
            been written, because there is nothing to revert before that. */}
        {agent.applied && agent.applied.restorePoints.length > 0 ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void undo()}
            data-testid="agentReview.undo"
          >
            {t("agent.review.undo")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          disabled={busy || rows.length === 0}
          onClick={() => rejectAll(rows.map((r) => r.index))}
          data-testid="agentReview.rejectAll"
        >
          {t("agent.review.rejectAll")}
        </Button>
        <Button
          variant="primary"
          disabled={busy || !hasApprovedWork}
          onClick={() => void approveAll()}
          data-testid="agentReview.approveAll"
        >
          {t("agent.review.approveAll", { count: bulkApprovableCount })}
        </Button>
      </footer>
    </div>
  );
}

function NoteGroup({
  noteId,
  title,
  rows,
  rejected,
  applied,
  busy,
  onToggle,
  onApplyOne,
}: {
  noteId: string;
  title: string | null;
  rows: EditRow[];
  rejected: ReadonlySet<number>;
  applied: ReadonlySet<number>;
  busy: boolean;
  onToggle: (index: number) => void;
  onApplyOne: (edit: ProposedEdit) => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      data-testid="agentReview.noteGroup"
      style={{
        borderBottom: "1px solid var(--line-1)",
        padding: "var(--space-4) var(--space-5)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
      }}
    >
      <h2
        data-testid="agentReview.noteTitle"
        style={{
          margin: 0,
          fontSize: "var(--text-md)",
          fontWeight: "var(--weight-semibold)",
        }}
      >
        {/* The note's own name, not just a count. Approving an anchored
            replacement without knowing which note receives it is not informed
            approval, which is the whole premise of this screen. */}
        {title ?? t("agent.review.untitledNote")}{" "}
        <span
          data-testid="agentReview.noteChangeCount"
          style={{ color: "var(--fg-2)", fontWeight: "var(--weight-regular)" }}
        >
          {t("agent.review.noteHeading", { count: rows.length })}
        </span>
      </h2>
      {rows.map((row) => (
        <EditRowView
          key={row.index}
          row={row}
          rejected={rejected.has(row.index)}
          applied={applied.has(row.index)}
          busy={busy}
          onToggle={() => onToggle(row.index)}
          onApplyOne={() => onApplyOne(row.edit)}
        />
      ))}
      <span hidden data-testid="agentReview.noteId">
        {noteId}
      </span>
    </section>
  );
}

function EditRowView({
  row,
  rejected,
  applied,
  busy,
  onToggle,
  onApplyOne,
}: {
  row: EditRow;
  rejected: boolean;
  applied: boolean;
  busy: boolean;
  onToggle: () => void;
  onApplyOne: () => void;
}) {
  const { t } = useTranslation();
  const { diff, changedLines } = useMemo(() => {
    const d = diffWithSegments(row.edit.anchor, row.edit.replacement);
    return { diff: d, changedLines: changedLineCount(d) };
  }, [row.edit.anchor, row.edit.replacement]);
  return (
    <article
      data-testid="agentReview.edit"
      data-rejected={rejected ? "true" : "false"}
      data-applied={applied ? "true" : "false"}
      style={{
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-2)",
        opacity: rejected ? 0.5 : 1,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          padding: "var(--space-2) var(--space-3)",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <span style={{ color: "var(--fg-2)" }}>
          {t("agent.review.changedLines", { count: changedLines })}
        </span>
        {/* The structural carve-out, made visible. A removing edit is not part
            of the bulk action at all, so it says so, says WHICH removal, and
            carries its own act. */}
        {row.removes !== null ? (
          <span
            data-testid="agentReview.removalFlag"
            style={{ color: "var(--fg-1)", fontWeight: "var(--weight-semibold)" }}
          >
            {removalFlagLabel(row.removes, t)}
          </span>
        ) : null}
        {/* The visual-only flag. Deliberately weaker than the one above. */}
        {row.largeDeletion && row.removes === null ? (
          <span data-testid="agentReview.largeDeletion" style={{ color: "var(--fg-2)" }}>
            {t("agent.review.largeDeletion")}
          </span>
        ) : null}
        {applied ? (
          <span data-testid="agentReview.appliedFlag" style={{ color: "var(--fg-2)" }}>
            {t("agent.review.alreadyApplied")}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {applied ? null : (
          <Button variant="ghost" onClick={onToggle} data-testid="agentReview.toggleEdit">
            {rejected ? t("agent.review.restoreEdit") : t("agent.review.rejectEdit")}
          </Button>
        )}
        {row.removes !== null && !applied ? (
          <Button
            variant="danger"
            disabled={busy || rejected}
            onClick={onApplyOne}
            data-testid="agentReview.applyRemoval"
          >
            {t("agent.review.applyRemoval")}
          </Button>
        ) : null}
      </div>
      <DiffView diff={diff} mode="unified" />
    </article>
  );
}

/** The proposed new notes, reviewable.
 *
 *  This group did not exist once, and its absence was the feature's worst
 *  defect: `newNotes` went to the host with the rest of the proposal and every
 *  one of them was created, unshown and unapproved, on any apply. A create is
 *  also the one write with no restore point, so it was simultaneously the least
 *  reviewed and the least reversible path. Rejecting one here removes it from the
 *  index list the apply sends, and the host creates only what is named there. */
function NewNotesGroup({
  notes,
  rejected,
  onToggle,
}: {
  notes: ProposedNote[];
  rejected: ReadonlySet<number>;
  onToggle: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      data-testid="agentReview.newNotesGroup"
      style={{
        borderBottom: "1px solid var(--line-1)",
        padding: "var(--space-4) var(--space-5)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
      }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: "var(--text-md)",
          fontWeight: "var(--weight-semibold)",
        }}
      >
        {t("agent.review.newNotesHeading", { count: notes.length })}
      </h2>
      {notes.map((note, index) => (
        <article
          key={index}
          data-testid="agentReview.newNote"
          data-rejected={rejected.has(index) ? "true" : "false"}
          style={{
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-2)",
            opacity: rejected.has(index) ? 0.5 : 1,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
              padding: "var(--space-2) var(--space-3)",
              borderBottom: "1px solid var(--line-1)",
            }}
          >
            <strong data-testid="agentReview.newNoteTitle">{note.title}</strong>
            <span style={{ color: "var(--fg-2)" }}>
              {note.folder ?? t("agent.review.vaultRoot")}
            </span>
            <span style={{ flex: 1 }} />
            <Button
              variant="ghost"
              onClick={() => onToggle(index)}
              data-testid="agentReview.toggleNewNote"
            >
              {rejected.has(index)
                ? t("agent.review.restoreEdit")
                : t("agent.review.rejectEdit")}
            </Button>
          </div>
          {/* The whole body, not an excerpt: the user is approving a write, and
              a create has no restore point to fall back on. */}
          <pre
            data-testid="agentReview.newNoteBody"
            style={{
              margin: 0,
              padding: "var(--space-3) var(--space-5)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "var(--fg-2)",
            }}
          >
            {note.body}
          </pre>
        </article>
      ))}
    </section>
  );
}

function ApplyReport({ result }: { result: AgentApplyResult }) {
  const { t } = useTranslation();
  return (
    <section
      data-testid="agentReview.applyReport"
      style={{
        padding: "var(--space-4) var(--space-5)",
        borderTop: "1px solid var(--line-1)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
      }}
    >
      <p style={{ margin: 0 }} data-testid="agentReview.appliedCount">
        {t("agent.review.appliedCount", { count: result.applied })}
      </p>
      {result.notesCreated.length > 0 ? (
        <p style={{ margin: 0 }} data-testid="agentReview.createdCount">
          {t("agent.review.createdCount", { count: result.notesCreated.length })}
        </p>
      ) : null}
      {/* Refusals are shown with their cause. A change that could not be placed
          must never look like a change that was not needed. */}
      {result.refused.length > 0 || result.refusedNewNotes.length > 0 ? (
        <ul
          data-testid="agentReview.refusedList"
          style={{ margin: 0, paddingInlineStart: "var(--space-5)", color: "var(--fg-2)" }}
        >
          {result.refused.map((r) => (
            <li key={`e-${r.noteId}-${r.index}`}>
              {t(`agent.review.refused.${r.reason}`)}
            </li>
          ))}
          {result.refusedNewNotes.map((r) => (
            <li key={`n-${r.index}`}>{t(`agent.review.refused.${r.reason}`)}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
