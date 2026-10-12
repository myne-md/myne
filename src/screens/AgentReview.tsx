// The agent review screen (myne-md/myne#529, tasks 10, 11 and 13).
//
// A dialog of its own rather than a panel at the edge of the editor or a
// dismissable modal (myne-md/myne#549), and that is not a layout preference.
// Half the decisions this feature rests on assume approval is a
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
// about how a diff looks is invented here. It renders in `split` mode
// (myne-md/myne#664): approving a change asks "what is this replacing?", and
// `<DiffView>`'s own header already records that a gutter marker is the worse
// answer to that question than a column is. The two columns are labelled from
// here rather than by the component, because `<DiffView>` renders note text and
// never copy of its own. There is no unified/split toggle: one mode is a
// decision, a toggle is a surface to own.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DiffView } from "../notes/components/DiffView";
import { RunCostLine } from "../notes/agent/components/RunCostLine";
import { Button } from "../components/primitives/Button";
import { changedLineCount, diffWithSegments } from "../dialect";
import { flushBeforeFrontmatterWrite } from "../notes/flushBeforeFrontmatterWrite";
import {
  removalFlagLabel,
  agentApply,
  agentUndo,
  editHidesNoteAs,
  hasRefusals,
  isMove,
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

/** Roughly what three lines of the modal's own width hold. Past it the summary
 *  is clamped behind a disclosure; below it the paragraph is shown whole,
 *  because a disclosure over something already visible is a control that does
 *  nothing. */
const SUMMARY_CLAMP_CHARS = 320;

export function AgentReview({
  onClose,
  onNotesWritten,
  titleOf,
  folderOf,
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
  /** The folder a note sits in, for a move row's starting point. */
  folderOf: (noteId: string) => string | null;
}) {
  const { t } = useTranslation();
  const agent = useAgent();
  const [busy, setBusy] = useState(false);
  /** Whether the model's summary is expanded. Session state, like every other
   *  disclosure on this screen: a reader who opened it is reading it now. */
  const [summaryOpen, setSummaryOpen] = useState(false);
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
    // Captured BEFORE the await, for the reason the undo path below and
    // `agentToChat.ts` both state: the outcome carries note ids of the vault it
    // describes, so a reply landing after a lock or a vault switch must be
    // dropped rather than written into a module-scope store.
    const epoch = currentRunEpoch();
    try {
      // **The pane's pending autosave goes to disk FIRST** (review finding). An
      // apply reads each note's body from disk, patches it (the move verb
      // rewrites `folder:`) and writes the whole blob back with no compare and
      // swap, so a dirty pane that has not autosaved yet has two silent losers:
      // the autosave lands after the write and reverts the field, or it lands
      // between the read and the write and the apply overwrites the typing.
      // `ctx.reloadOpenNote()` cannot cover it, because it returns early while a
      // pane has pending work, which is exactly this case. Same first line the
      // other frontmatter writers use (`notes/setNoteCover.ts`,
      // `notes/templates.ts`, `notes/trashNote.ts`).
      await flushBeforeFrontmatterWrite();
      const outcome = await agentApply(
        agent.view.runId,
        edits,
        newNoteIndices,
        approval,
      );
      // The indices that actually LANDED, not the ones that were sent. The
      // subtraction lives in `landedEditIndices` rather than here, because this
      // is where it was missing and a call site is not testable.
      if (!settleApply(outcome, landedEditIndices(indices, outcome), epoch)) return;
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

  const summaryClamped =
    !summaryOpen && agent.proposal.summary.length > SUMMARY_CLAMP_CHARS;

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

      {/* **The host's fact goes above the model's claim** (myne-md/myne#848).
          A run's summary is the model's own words, and "informed approval" is
          this screen's whole premise, so the two must not be read in the order
          that flatters the model. A manual pass found the opposite: ten folder
          moves were refused and the summary still reported them as applied, and
          the user believed it until they reached the refusal list at the BOTTOM
          of the diff. So refusals are lifted out of the bottom, pinned here, and
          counted. The summary stays visible BELOW them rather than being
          hidden: the point is to contradict it in front of the user, not to
          censor it. */}
      {agent.applied && hasRefusals(agent.applied) ? (
        <RefusalBlock result={agent.applied} />
      ) : null}

      {agent.proposal.summary ? (
        <div
          style={{
            padding: "var(--space-3) var(--space-5)",
            borderBottom: "1px solid var(--line-1)",
          }}
        >
          {/* **Clamped, because a summary is not what this screen is for**
              (myne-md/myne#848, on the user's read: "too much of a top text…
              this should be only something about the diff"). A run that moved
              twenty-three notes answers with the whole itinerary, and a wall of
              prose above the diff makes the diff the small print.

              Kept rather than hidden: the paragraph above argues that the
              model's claim must stay in front of the user so a REFUSAL can
              contradict it, and hiding it outright is a spec change rather than
              a polish one. Three lines and a disclosure is the version that
              serves both, the claim is on screen, the diff is what the screen
              is about. */}
          <p
            data-testid="agentReview.summary"
            data-clamped={summaryClamped ? "true" : undefined}
            style={{
              margin: 0,
              color: "var(--fg-2)",
              ...(summaryClamped
                ? {
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical" as const,
                    WebkitLineClamp: 3,
                    overflow: "hidden",
                  }
                : {}),
            }}
          >
            {agent.proposal.summary}
          </p>
          {/* Only when there is something to reveal: for a one-line summary a
              disclosure is a control that does nothing. */}
          {agent.proposal.summary.length > SUMMARY_CLAMP_CHARS ? (
            <Button
              variant="ghost"
              data-testid="agentReview.summary-toggle"
              aria-expanded={summaryOpen}
              onClick={() => setSummaryOpen((open) => !open)}
              style={{
                marginTop: "var(--space-1)",
                padding: 0,
                fontSize: "var(--text-sm)",
                color: "var(--fg-3)",
              }}
            >
              {t(
                summaryOpen
                  ? "agent.review.summaryShorten"
                  : "agent.review.summaryShowAll",
              )}
            </Button>
          ) : null}
        </div>
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
              folderOf={folderOf}
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
  folderOf,
}: {
  noteId: string;
  title: string | null;
  rows: EditRow[];
  rejected: ReadonlySet<number>;
  applied: ReadonlySet<number>;
  busy: boolean;
  onToggle: (index: number) => void;
  onApplyOne: (edit: ProposedEdit) => void;
  /** The folder the note sits in, for a move row's starting point. */
  folderOf: (noteId: string) => string | null;
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
          sourceFolder={folderOf(noteId)}
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
  sourceFolder,
  rejected,
  applied,
  busy,
  onToggle,
  onApplyOne,
}: {
  row: EditRow;
  /** The folder the note is in now, for a move row's left column. `null` when
   *  the note list does not know the note, in which case the destination is
   *  shown alone rather than a source being invented. */
  sourceFolder: string | null;
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
      /* Replace or append. The diff renders identically for both (an append
         diffs an empty anchor against the new text, so every line reads as an
         addition, which is exactly what it is), so this attribute is the only
         thing that lets a scenario tell the two shapes apart. A literal, never
         a runtime expression carrying content. */
      data-kind={row.edit.kind ?? "replace"}
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
        {/* A move has no changed lines to count: its `replacement` is a folder,
            not text. Counting a diff of "" against a folder path would put a
            meaningless number beside the row whose whole point is that it moves
            something (myne-md/myne#848). */}
        {isMove(row.edit) ? (
          <span data-testid="agentReview.moveFlag" style={{ color: "var(--fg-2)" }}>
            {t("agent.review.moveFlag")}
          </span>
        ) : (
          <span style={{ color: "var(--fg-2)" }}>
            {t("agent.review.changedLines", { count: changedLines })}
          </span>
        )}
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
        {/* Which VERB this row is, made visible. The diff renders an append
            and a replacement identically (an append diffs an empty anchor
            against the new text, so every line reads as an addition), and
            "informed approval" is this screen's whole premise: an append is
            unanchored and lands after the frontmatter block, which is a
            different write from replacing text the reader can see in front of
            them. `data-kind` above tells a SCENARIO the two apart; this tells
            the person approving. */}
        {row.edit.kind === "append" ? (
          <span data-testid="agentReview.appendFlag" style={{ color: "var(--fg-2)" }}>
            {t("agent.review.appendFlag")}
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
      {/* An append diffs an empty anchor against the new text, so its left
          column is empty under a heading reading "in the note now". That is the
          honest answer for an append rather than a layout defect: it replaces
          nothing. */}
      {/* **A move renders as its own row, not as a diff** (myne-md/myne#848).
          A diff would draw an empty left column under "in the note now" and a
          folder under "after this change", which describes nothing: a folder is
          not note text. So the row shows the folder the note is in and the folder
          it would land in, the pair a reader needs to judge the excluded-folder
          clamp by eye. The source is resolved by the caller from the same note
          list `titleOf` reads. */}
      {isMove(row.edit) ? (
        <div
          data-testid="agentReview.moveBody"
          style={{
            display: "flex",
            gap: "var(--space-5)",
            padding: "var(--space-3)",
            color: "var(--fg-2)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <span>{t("agent.review.diffCurrent")}</span>
            <span data-testid="agentReview.moveFrom" style={{ color: "var(--fg-1)" }}>
              {sourceFolder ?? t("agent.review.vaultRoot")}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <span>{t("agent.review.diffProposed")}</span>
            <span data-testid="agentReview.moveTo" style={{ color: "var(--fg-1)" }}>
              {row.edit.replacement === ""
                ? t("agent.review.vaultRoot")
                : row.edit.replacement}
            </span>
          </div>
        </div>
      ) : (
        <DiffView
          diff={diff}
          mode="split"
          leftLabel={t("agent.review.diffCurrent")}
          rightLabel={t("agent.review.diffProposed")}
        />
      )}
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

/** The refusals, pinned ABOVE the model's summary.
 *
 *  **Why it is not inside `ApplyReport` any more** (myne-md/myne#848). A run on
 *  the first structured manual pass reported ten folder moves as applied while
 *  every one had been refused, and the user believed the summary until they
 *  reached the refusal list at the bottom of a 68-note diff. The host's fact now
 *  precedes the model's claim, and it carries a count because the reader's
 *  question is "did all of it land" rather than "which line failed".
 *
 *  Both kinds are counted together: a refused edit and a refused new note index
 *  two different spaces, which is why they are two arrays on the wire, but to the
 *  person reading they are one experience. The count is what the host's own
 *  `hasRefusals` predicate decides on, so the two cannot disagree about whether
 *  this block exists. */
function RefusalBlock({ result }: { result: AgentApplyResult }) {
  const { t } = useTranslation();
  const count = result.refused.length + result.refusedNewNotes.length;
  return (
    <section
      data-testid="agentReview.refusedBlock"
      style={{
        padding: "var(--space-3) var(--space-5)",
        borderBottom: "1px solid var(--line-1)",
        background: "var(--paper-2)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
      }}
    >
      <p
        data-testid="agentReview.refusedCount"
        style={{ margin: 0, color: "var(--fg-1)", fontWeight: "var(--weight-semibold)" }}
      >
        {t("agent.review.refusedCount", { count })}
      </p>
      <ul
        data-testid="agentReview.refusedList"
        style={{ margin: 0, paddingInlineStart: "var(--space-5)", color: "var(--fg-2)" }}
      >
        {result.refused.map((r) => (
          <li key={`e-${r.noteId}-${r.index}`}>{t(`agent.review.refused.${r.reason}`)}</li>
        ))}
        {result.refusedNewNotes.map((r) => (
          <li key={`n-${r.index}`}>{t(`agent.review.refused.${r.reason}`)}</li>
        ))}
      </ul>
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
      {/* Refusals are NOT here any more. They render in `RefusalBlock`, above the
          model's own summary, because a summary that claimed refused work was
          applied was read first and the refusal list last (myne-md/myne#848). The
          `hasRefusals` predicate still decides whether this surface keeps the
          dialog OPEN (`applyWasCleanAndComplete`, myne-md/myne#596), which is why
          it stays one function rather than being inlined in either place. */}
    </section>
  );
}
