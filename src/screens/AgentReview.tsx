// The agent review card (myne-md/myne#529, tasks 10, 11 and 13).
//
// **A card inside the conversation, under the turn that proposed it**
// (myne-md/myne#894, superseding myne-md/myne#549's placement). #549 took the
// review out of a full-window takeover and put it in a dialog of its own, on the
// argument that approving is a separate, attention-requiring act. The argument
// holds and the surface did not: the proposal belongs to the message that caused
// it, and a dialog renders it somewhere the user did not come from, next to none
// of the conversation. What #549 was protecting is kept, and it is what this
// file is: the review is not dismissable by a stray Escape or a backdrop click,
// it cannot be collapsed away while it holds an unapproved proposal, the running
// scope total is always on screen, and every act that writes is per-row.
//
// The model's own prose is NOT here. It stays on the turn (`ChatMarkdown`), and
// the refusals that contradict it are lifted ABOVE that prose by
// `ConversationSurface` (myne-md/myne#848, restored by myne-md/myne#894's review:
// they were briefly the card's first block, which put the claim back on top). This
// file owns the decision surface: what is proposed, what it would write, and the
// controls.
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
// about how a diff looks is invented here. Approving a change asks "what is this
// replacing?", and a column is the better answer to that than a gutter marker is
// (myne-md/myne#664), so the card renders `split` whenever it has the width for
// it. It no longer always does: the same card sits in the agent tab's wide centre
// pane and in the right panel's ~380px AI chat, and two columns of note text need
// about 560px (`reviewCardLayout.ts`), so below that threshold the component's own
// `unified` mode takes over. That clause supersedes the always-split half of
// myne-md/myne#664 (see `decisions/ai/0715`). The labels come from here rather
// than from the component, because `<DiffView>` renders note text and never copy
// of its own. There is no user-facing mode toggle: the width decides, which is
// what keeps one mode a decision rather than a surface to own.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DiffView } from "../notes/components/DiffView";
import { applyFailureMessage } from "../notes/agent/applyFailure";
import { useReviewCardNarrow } from "../notes/agent/reviewCardLayout";
import { Button } from "../components/primitives/Button";
import { Icon } from "../components/primitives/Icon";
import { IconButton } from "../components/primitives/IconButton";
import { changedLineCount, diffWithSegments } from "../dialect";
import { flushBeforeFrontmatterWrite } from "../notes/flushBeforeFrontmatterWrite";
import {
  removalFlagLabel,
  agentApply,
  agentUndo,
  editHidesNoteAs,
  isMove,
  netDeletion,
  splitForBulkApproval,
  type AgentApplyResult,
  type AppliedSetting,
  type Approval,
  type HidingField,
  type ProposedEdit,
  type ProposedNote,
  type ProposedSetting,
} from "../lib/agent-run";
import { bumpPrefsNonce } from "../notes/prefsNonce";
import {
  approvedNewNoteIndices,
  currentRunEpoch,
  failRun,
  keptEdits,
  rejectAll,
  setUndoable,
  landedEditIndices,
  landedSettingIndices,
  settleApply,
  toggleEdit,
  toggleNewNote,
  toggleSetting,
  useAgent,
} from "../notes/agent/agentStore";
import { currentSettingValue, settingChangeLine } from "../notes/agent/settingCatalogue";
import { SETTINGS_SEARCH_INDEX } from "../components/settings/search/settingsSearchIndex";
import { usePrefs } from "../hooks/usePrefs";


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

/**
 * Whether the run wrote anything an undo could put back.
 *
 * **`restorePoints` alone is not the answer** (myne-md/myne#850, from review).
 * A run that changed settings and no notes has none by construction, and the
 * gate here was that alone, so the review screen offered no Undo for exactly the
 * change it had just watched land, while the host held a record for it on
 * purpose (`apply_from_host` records when `settings_changed` is non-empty) so
 * that the undo would survive the screen closing. The chat strip could still
 * reach it, which made this an inconsistency rather than a total loss.
 */
function hasAnythingToUndo(applied: AgentApplyResult): boolean {
  return (
    applied.restorePoints.length > 0 ||
    (applied.settingsChanged?.length ?? 0) > 0
  );
}

export function AgentReview({
  onClose,
  onNotesWritten,
  onDecision,
  titleOf,
  folderOf,
}: {
  onClose: () => void;
  /** What the reader decided, once they have decided (`"applied"` or
   *  `"rejected"`).
   *
   * **Reported rather than written here** (myne-md/myne#894): the outcome is a
   * fact about the TRANSCRIPT, and this component's two collaborators are its
   * parent and the agent store. The parent (`ConversationSurface`) is the surface
   * that already holds both the transcript and the run, so the write is one call
   * there instead of a chat-store import in a screen. */
  onDecision?: (outcome: "applied" | "rejected") => void;
  /** Called with the ids of notes an apply CHANGED on disk.
   *
   *  **Not cosmetic, and not optional in practice.** An apply writes through the
   *  backend, out of band of any pane's own autosave loop, so the open pane goes
   *  on holding the pre-apply buffer. Two things follow: the editor keeps
   *  showing text that is no longer on disk, and the pane's next autosave writes
   *  that stale buffer back, silently reverting the edit the user just approved
   *  and bumping the note's sync version while doing it. The task-write path
   *  (`TASK_WRITE_EVENT`) already solved exactly this; this is the same solution
   *  reached through a prop rather than a global event, because this surface has
   *  a parent to tell. */
  onNotesWritten?: (noteIds: readonly string[]) => void;
  /** Resolve a note id to its title. Without it the review shows a diff and
   *  never says which note receives it, which is not informed approval.
   *
   *  **Still a prop rather than a store read here** (myne-md/myne#894). The card
   *  moved out of `Editor.tsx`'s takeover and into a transcript turn, and the
   *  tempting shortcut was to have this component read the resident note set
   *  itself, but that store needs `SidebarStateProvider`, so it would have made
   *  every mount of this component (including its unit tests) provider-bound to
   *  answer a question about two strings. The resolution happens one level up,
   *  where the providers are. */
  titleOf: (noteId: string) => string | null;
  /** The folder a note sits in, for a move row's starting point. */
  folderOf: (noteId: string) => string | null;
}) {
  const { t } = useTranslation();
  const agent = useAgent();
  const [busy, setBusy] = useState(false);
  // The card's own width, so a split diff only renders where two columns of note
  // text fit (myne-md/myne#894). The conversation is 380px in the right sidebar
  // and most of a centre pane in the agent tab, and one of those two cannot hold
  // a split diff at all.
  const { ref: cardRef, narrow } = useReviewCardNarrow<HTMLDivElement>();
  const [undoReport, setUndoReport] = useState<{
    reverted: number;
    failed: string[];
    notesCreatedNotReverted: number;
    settingsReverted: number;
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
    // Asked of the payload the bulk action actually builds, INCLUDING the rows
    // that already landed. The filter this replaced read `!rejected` and
    // `removes === null` but not `!appliedEdits`, so a second Approve-all after a
    // partial apply left the button enabled over an EMPTY list and `apply()`
    // returned early: no write, no report, no message (myne-md/myne#894 review).
    () => splitForBulkApproval(kept).bulkApprovable.length,
    [kept],
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
    settings: ProposedSetting[] = [],
  ) {
    if (!agent.view) return;
    // NOT `edits.length === 0`: a run may propose only new notes, and an early
    // return on the edit count made those uncreatable in one direction while the
    // old whole-proposal hand-off created them unreviewed in the other. A
    // settings-only run is the same case one field over (myne-md/myne#850).
    if (edits.length === 0 && newNoteIndices.length === 0 && settings.length === 0) {
      return;
    }
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
        settings,
        approval,
      );
      // The indices that actually LANDED, not the ones that were sent. The
      // subtraction lives in `landedEditIndices` rather than here, because this
      // is where it was missing and a call site is not testable.
      const settingIndices = landedSettingIndices(
        agent.proposal.settings ?? [],
        settings,
        outcome,
      );
      if (
        !settleApply(
          outcome,
          landedEditIndices(indices, outcome),
          epoch,
          settingIndices,
        )
      ) {
        return;
      }
      // The host's list, not the one that was sent: an edit can be refused at
      // apply time, so the notes that actually changed are the ones to reload.
      const changed = [...outcome.notesWritten, ...outcome.notesCreated];
      if (changed.length > 0) onNotesWritten?.(changed);
      // The transcript's counts line stops saying "proposed" from here on. A
      // partial apply is still `applied`: what landed is what the line reports,
      // and the card stays open over its refusal block.
      onDecision?.("applied");
    } catch (err) {
      // **Named by cause rather than "could not be applied"** (myne-md/myne#894).
      // The error object used to be discarded here, so a dozen distinct
      // whole-call causes, the run consumed, the vault locked, the write
      // refused, the restore point failing, all read as one sentence, and the
      // report could not be acted on or even diagnosed. `applyFailureMessage`
      // reads the tag; the host logs the same tag on its side.
      failRun(applyFailureMessage(err, t));
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
    if (!runId || !result || !hasAnythingToUndo(result)) return;
    setBusy(true);
    try {
      const restored = result.restorePoints.map(([noteId]) => noteId);
      const undone = await agentUndo(runId);
      // The same reason the apply path bumps it: the undo restores preferences
      // host-side, so nothing on this side learns the value moved and Settings
      // keeps rendering the agent's value (myne-md/myne#850, from review).
      if (undone.settingsReverted > 0) bumpPrefsNonce();
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

  /** Whether the proposal holds anything at all, across all three verbs. The
   *  bulk approve counts edits and new notes because a setting is applied on its
   *  own by construction; the EXIT cannot be gated that narrowly, or a run that
   *  proposed only a setting has no way out. */
  const anythingProposed =
    rows.length > 0 ||
    agent.proposal.newNotes.length > 0 ||
    (agent.proposal.settings?.length ?? 0) > 0;

  /** Everything the proposal holds, across all three verbs: what "Reject all"
   *  discards and what the footer's own count is about. */
  const proposedTotal =
    // What is still DECIDABLE, not what was proposed: a row that already landed
    // cannot be discarded, so counting it made "Reject all (3)" claim a discard of
    // a row that is already on disk (review finding).
    kept.length +
    approvedNewNoteIndices(agent).length +
    (agent.proposal.settings ?? []).filter(
      (_, i) => !agent.appliedSettings.has(i) && !agent.rejectedSettings.has(i),
    ).length;

  /** Which arm of the headline is showing, as one value.
   *
   *  Read by the tile's tint as well as by the text, so the colour and the
   *  sentence cannot come from two different conditions (the class of bug the
   *  refusal block's count had, one surface over). */
  const headlineState: "waiting" | "failed" | "review" =
    agent.error !== null ? "failed" : agent.applied === null ? "waiting" : "review";

  /** What an apply has landed so far, in one number.
   *
   *  The card used to print three separate report lines for this ("N changes
   *  applied", "N settings changed", "N notes created"), which the compact shape
   *  folds into the headline: the per-row "Applied" flags already say WHICH, and
   *  the refusal block says what did not land. */
  const appliedTotal = agent.applied === null
    ? 0
    : agent.applied.applied +
      agent.applied.notesCreated.length +
      (agent.applied.settingsChanged?.length ?? 0);

  return (
    <div
      ref={cardRef}
      data-testid="agentReview.screen"
      // **The card's arrival, and the fact that it is waiting on you**
      // (myne-md/myne#894). The class carries the entrance animation, the wash
      // and the status row's tone; all three are argued in
      // `src/styles/tokens.css`.
      className="myne-review-card"
      data-state={headlineState}
      // A named group rather than a bare div: the card is a decision with a
      // beginning and an end, and a screen reader reaching it should say what it
      // is before reading forty diff rows. `agent.review.title` is the name,
      // which is also why the key survives a header that no longer prints it.
      role="group"
      aria-label={t("agent.review.title")}
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--paper)",
        // **Room above and below, inside the bubble** (myne-md/myne#894, on the
        // user's read: "increase the proposal card's top and bottom margins").
        // The card is the one object in the transcript that interrupts the
        // reading flow, a message, then a decision, then the run's own line,
        // and a card butted against the paragraph above it reads as part of it.
        marginBlock: "var(--space-3)",
        // A card, not a screen: it sits inside the assistant's bubble, so it
        // reads as an object in the conversation rather than as a place the app
        // navigated to. `overflow: hidden` is what keeps the body's scroll inside
        // the rounded corners.
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-2)",
        overflow: "hidden",
        color: "var(--fg-1)",
      }}
    >
      {/* **The header is the zero state's anatomy, not the old dialog's.**
          (myne-md/myne#894, on the user's read: "this should be something built
          from scratch that looks like a new zero state and sits there nicely
          interactive"). It used to be a dialog heading: "Review changes" in
          `--text-xl`, a Close button, then a status row and a scope line under
          it, three rows of chrome that said what the dialog was called. A card
          in a conversation owes the reader something different: what is being
          asked of them, how big it is, and a way out. So it borrows the shape
          the zero state settled on, a glyph tile, a headline, a body line,
          and the headline IS the state rather than a name, which is what makes
          one block do the work of three.

          The acts deliberately stay in the FOOTER rather than moving up here,
          and that is not symmetry: the body scrolls and the footer does not, so
          the two buttons are on screen the whole time a reader works down forty
          rows. Putting a copy at the top as well would be the same control twice
          with two states to keep in step. */}
      {/* The wash, from the zero state's own recipe. First child, decorative,
          and written before anything it sits behind. */}
      <span className="myne-empty__wash" aria-hidden="true" />
      <header
        className="myne-review-region"
        style={{
          display: "flex",
          // **Centred against the tile, not top-aligned to it** (myne-md/myne#894,
          // on the user's read: "centre the two lines"). The header is a tile and
          // two short lines beside it, so top-aligning the pair left the tile's
          // optical centre sitting between them; centring is what makes the three
          // pieces read as one row.
          alignItems: "center",
          gap: "var(--space-3)",
          // **Even insets, and a little more of them.** The first compact pass
          // used `space-3` on the top and bottom against `space-4` on the sides,
          // which reads as a header that was squeezed rather than laid out; this
          // is the same padding on all four sides, matching the rows and the
          // footer so the card has one vertical rhythm instead of three.
          padding: "var(--space-4)",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <span
          aria-hidden="true"
          className="myne-empty__glyph myne-review-tile"
          data-state={headlineState}
        >
          {/* `pencil`, because the card is about proposed CHANGES to notes: the
              zero state's rule for picking a glyph is to name the thing rather
              than a mood, and "a list", "a check" and "an eye" each name
              something else. */}
          <Icon name="pencil" size={14} />
        </span>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-1)",
            flex: 1,
            minWidth: 0,
          }}
        >
          {/* The headline. Three arms, and each is a different sentence because
              each is a different situation: waiting on a decision, a failure the
              reader has to understand, and an apply that landed with something
              refused (where the refusal block on the turn ABOVE this card carries
              the count, so the headline only has to be the card's name). */}
          {agent.error !== null ? (
            <span
              className="myne-review-status"
              data-state="failed"
              data-testid="agentReview.status"
            >
              <span data-testid="agentReview.error">{agent.error}</span>
            </span>
          ) : agent.applied === null ? (
            <span
              className="myne-review-status"
              data-state="waiting"
              data-testid="agentReview.status"
            >
              {t("agent.review.statusWaiting")}
            </span>
          ) : (
            <span
              className="myne-review-status"
              data-state="review"
              data-testid="agentReview.status"
            >
              <span data-testid="agentReview.appliedCount">
                {t("agent.review.appliedCount", { count: appliedTotal })}
              </span>
            </span>
          )}
          {/* The facts line, where the zero state puts its body: what the run
              was allowed to touch. Always on screen, never behind a disclosure:
              with no cap on scope growth this is the only thing bounding
              accumulation. */}
          <span
            data-testid="agentReview.scopeTotal"
            style={{ color: "var(--fg-3)", fontSize: "var(--text-xs)" }}
          >
            {t("agent.review.scopeTotal", { count: agent.view?.scopeTotal ?? 0 })}
          </span>
        </div>
      </header>

      {/* **No refusal block here any more** (myne-md/myne#894, from the review).
          It was the card's first body region, which put the model's claim above it:
          the summary renders on the TURN (`ai.agent-answer`), and the card mounts
          under that. `ConversationSurface` now lifts the refusals above the prose
          it contradicts, which is what myne-md/myne#848 asked for in the first
          place, and what this file's own header says happens. One copy, on the
          surface that owns the reading order. */}

      {/* The body scrolls, capped, so the card's own actions stay reachable.
          A proposal can be forty edits; a card that grew to their full height
          would push its own Approve button off screen and turn a decision into a
          scroll to the bottom of the transcript. The cap is a fraction of the
          viewport rather than a pixel count so it tracks the window, with a pixel
          ceiling for a very tall one. */}
      <div
        className="myne-review-region"
        style={{
          overflowY: "auto",
          overscrollBehavior: "contain",
          maxHeight: "min(52vh, 420px)",
        }}
      >
        {byNote.length === 0 &&
        agent.proposal.newNotes.length === 0 &&
        (agent.proposal.settings?.length ?? 0) === 0 ? (
          <p
            data-testid="agentReview.empty"
            style={{
              margin: 0,
              padding: "var(--space-3)",
              color: "var(--fg-2)",
              fontSize: "var(--text-sm)",
            }}
          >
            {t("agent.review.noChanges")}
          </p>
        ) : null}

        {byNote.map(([noteId, noteRows]) => (
          <NoteGroup
            key={noteId}
            noteId={noteId}
            title={titleOf(noteId)}
            folderOf={folderOf}
            rows={noteRows}
            narrow={narrow}
            rejected={agent.rejected}
            applied={agent.appliedEdits}
            busy={busy}
            onToggle={toggleEdit}
            onApplyOne={(edit) => void apply([edit], [], "individual")}
          />
        ))}

        {agent.proposal.newNotes.length > 0 ? (
          <NewNotesGroup
            notes={agent.proposal.newNotes}
            rejected={agent.rejectedNewNotes}
            onToggle={toggleNewNote}
          />
        ) : null}

        {(agent.proposal.settings?.length ?? 0) > 0 ? (
          <SettingsGroup
            settings={agent.proposal.settings ?? []}
            rejected={agent.rejectedSettings}
            applied={agent.appliedSettings}
            appliedSettings={agent.applied?.settingsChanged ?? []}
            busy={busy}
            onToggle={toggleSetting}
            onApplyOne={(setting) => void apply([], [], "individual", [setting])}
          />
        ) : null}

        {undoReport ? (
          <p
            data-testid="agentReview.undoReport"
            style={{
              margin: 0,
              padding: "var(--space-2) var(--space-3)",
              color: "var(--fg-2)",
              fontSize: "var(--text-xs)",
            }}
          >
            {t("agent.review.undoReport", {
              reverted: undoReport.reverted,
              kept: undoReport.notesCreatedNotReverted,
            })}
            {undoReport.settingsReverted > 0
              ? ` ${t("agent.review.undoReportSettings", {
                  count: undoReport.settingsReverted,
                })}`
              : ""}
            {undoReport.failed.length > 0
              ? ` ${t("agent.review.undoReportFailed", {
                  count: undoReport.failed.length,
                })}`
              : ""}
          </p>
        ) : null}

        {/* No apply report here any more. Which rows landed
            is on the rows themselves (`agentReview.appliedFlag`), the headline
            states the total, and the undo report has rendered on the turn as
            `ai.undo-result` since myne-md/myne#741, three surfaces for one fact
            was most of what made this card look like a dialog. */}

      </div>

      <footer
        className="myne-review-region"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-3)",
          borderTop: "1px solid var(--line-1)",
        }}
      >
        {/* **The acts, and nothing else.** The run's cost line used to sit here
            too, which is the third place the same figures appeared: the turn's
            own footprint already reports the run (myne-md/myne#848 moved it
            there for the settled and the running case alike), and a second copy
            in the footer made a decision card carry the run's discharge as well.
            A reader who wants the figures opens them on the line that owns
            them. */}
        {agent.applied && hasAnythingToUndo(agent.applied) ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void undo()}
            data-testid="agentReview.undo"
          >
            {t("agent.review.undo")}
          </Button>
        ) : null}
        <span style={{ flex: 1 }} />
        <Button
          variant="ghost"
          // **Gated on "the proposal holds anything", not on the edit rows**
          // (myne-md/myne#894, from the review). `rows` is edits only, and the ×
          // that used to be the always-enabled way out is gone, so a settings-only
          // proposal (which this surface renders on purpose, myne-md/myne#850)
          // painted Reject all disabled, "Approve 0 changes" disabled, and nothing
          // else: a decision card whose every control was dead.
          disabled={busy || !anythingProposed}
          /* **Reject all IS the exit** (myne-md/myne#894, on the user's read:
             "drop the ×, reject all will do that job"). The card has exactly two
             ways out, approve, or reject, and a third control that only
             dismissed the proposal was the one that needed the rule "closing
             discards a proposal you have not applied" spelled out beside it. So
             rejecting everything and closing are one act, and the rule is
             unchanged: the run is dropped, nothing is written. */
          onClick={() => {
            // Every verb, not the edits alone: "reject all" that left a proposed
            // new note or setting untouched would be a control whose name is
            // false. The per-row toggles are current at render, so this only
            // touches the ones still kept.
            rejectAll(rows.map((r) => r.index));
            agent.proposal.newNotes.forEach((_, i) => {
              if (!agent.rejectedNewNotes.has(i)) toggleNewNote(i);
            });
            (agent.proposal.settings ?? []).forEach((_, i) => {
              if (!agent.rejectedSettings.has(i)) toggleSetting(i);
            });
            // Before the close, because closing drops the run: the outcome has to
            // be recorded while the card still knows which run it is about.
            onDecision?.("rejected");
            onClose();
          }}
          data-testid="agentReview.rejectAll"
        >
          {/* **The count, like the sibling control has** (myne-md/myne#894, from
              review). This is the one act that drops the whole proposal, it is
              now the only exit, and "Reject all" understated what one click
              discards: the number is the reader's only notice of the size.
              A digit beside the label rather than a plural inside the catalog
              string, which is what a `{{count}}` here would cost 31 catalogs. */}
          {t("agent.review.rejectAll")}
          <span
            data-testid="agentReview.rejectAllCount"
            style={{ color: "var(--fg-3)", fontVariantNumeric: "tabular-nums" }}
          >
            {proposedTotal}
          </span>
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
  narrow,
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
  /** Too narrow for a two-column diff. `unified` is the mode that fits. */
  narrow: boolean;
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
        padding: "var(--space-2) var(--space-3)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* **The note's own name, and one line per change under it**
          (myne-md/myne#894, second pass). The first version of this card was the
          dialog's body: a bordered box per change, a two-column diff rendered
          inline for every row, a flag beside each verb, a count, a heading per
          group. Forty of those is a document, and the user's read was exact,
          "it still looks like the big one, only smaller". What a reader needs
          before deciding is WHICH note and WHAT KIND of change; the text of the
          change is a question they ask about one row at a time, so it is behind
          that row's own disclosure. */}
      <h3
        data-testid="agentReview.noteTitle"
        style={{
          margin: 0,
          padding: "var(--space-1) 0",
          fontSize: "var(--text-sm)",
          fontWeight: "var(--weight-semibold)",
          display: "flex",
          alignItems: "baseline",
          gap: "var(--space-2)",
        }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title ?? t("agent.review.untitledNote")}
        </span>
        <span
          data-testid="agentReview.noteChangeCount"
          style={{ color: "var(--fg-3)", fontWeight: "var(--weight-regular)", flex: "none" }}
        >
          {t("agent.review.noteHeading", { count: rows.length })}
        </span>
      </h3>
      {rows.map((row) => (
        <EditRowView
          key={row.index}
          row={row}
          narrow={narrow}
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
  narrow,
  sourceFolder,
  rejected,
  applied,
  busy,
  onToggle,
  onApplyOne,
}: {
  row: EditRow;
  /** Too narrow for a two-column diff (myne-md/myne#894). */
  narrow: boolean;
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
  /** Whether this row's own change is showing. Session state, like every other
   *  disclosure on this card: a reader who opened it is reading it now. */
  const [open, setOpen] = useState(false);
  const { diff, changedLines } = useMemo(() => {
    const d = diffWithSegments(row.edit.anchor, row.edit.replacement);
    return { diff: d, changedLines: changedLineCount(d) };
  }, [row.edit.anchor, row.edit.replacement]);

  // **One sentence per row, and it says what the change DOES** rather than which
  // flag it carries. The verb was three separate labels before (moves to another
  // folder / adds to the end / N lines), each its own span with its own testid,
  // and the reader assembled the meaning from them.
  const change = isMove(row.edit)
    ? t("agent.review.rowMove", {
        folder:
          row.edit.replacement === ""
            ? t("agent.review.vaultRoot")
            : row.edit.replacement,
      })
    : row.edit.kind === "append"
      ? t("agent.review.rowAppend")
      : t("agent.review.rowReplace", { count: changedLines });

  return (
    <article
      data-testid="agentReview.edit"
      /* Replace, append or move. The diff renders the first two similarly (an
         append diffs an empty anchor against the new text, so every line reads
         as an addition, which is exactly what it is), so this attribute is what
         lets a scenario tell the shapes apart. A literal, never a runtime
         expression carrying content. */
      data-kind={row.edit.kind ?? "replace"}
      data-rejected={rejected ? "true" : "false"}
      data-applied={applied ? "true" : "false"}
      style={{ opacity: rejected ? 0.55 : 1 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-1) 0",
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "var(--text-sm)",
            color: "var(--fg-1)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {change}
        </span>
        {/* A removal is never part of the bulk action, so its row says so AND
            carries its own act. The label names WHICH removal, because one
            sentence cannot be true for all five markers. */}
        {row.removes !== null ? (
          <span
            data-testid="agentReview.removalFlag"
            style={{
              flex: "none",
              fontSize: "var(--text-xs)",
              color: "var(--fg-1)",
              fontWeight: "var(--weight-semibold)",
            }}
          >
            {removalFlagLabel(row.removes, t)}
          </span>
        ) : null}
        {/* The visual-only flag for a very large cut, kept because it is the one
            signal a reader cannot get from the line's verb. */}
        {row.largeDeletion && row.removes === null ? (
          <span
            data-testid="agentReview.largeDeletion"
            style={{ flex: "none", fontSize: "var(--text-xs)", color: "var(--fg-3)" }}
          >
            {t("agent.review.largeDeletion")}
          </span>
        ) : null}
        {applied ? (
          <span
            data-testid="agentReview.appliedFlag"
            style={{ flex: "none", fontSize: "var(--text-xs)", color: "var(--fg-3)" }}
          >
            {t("agent.review.alreadyApplied")}
          </span>
        ) : null}
        <span style={{ flex: "none", display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
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
          <IconButton
            icon={open ? "chevron-up" : "chevron-down"}
            iconSize={12}
            label={t(open ? "agent.review.hideChange" : "agent.review.showChange")}
            tooltip
            expanded={open}
            testId="agentReview.toggleDiff"
            onClick={() => setOpen((v) => !v)}
          />
        </span>
      </div>
      {/* The change itself, on request. A move renders as its own pair of
          folders rather than as a diff (a diff would draw an empty left column
          under "in the note now" and a folder on the right, which describes
          nothing: a folder is not note text). */}
      {open ? (
        isMove(row.edit) ? (
          <div
            data-testid="agentReview.moveBody"
            style={{
              display: "flex",
              gap: "var(--space-5)",
              padding: "var(--space-2) 0 var(--space-3)",
              color: "var(--fg-2)",
              fontSize: "var(--text-sm)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <span>{t("agent.review.diffCurrent")}</span>
              <span data-testid="agentReview.moveFrom" style={{ color: "var(--fg-1)" }}>
                {sourceFolder ?? t("agent.review.vaultRoot")}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
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
            // **The mode follows the card's width** (myne-md/myne#894). The split
            // is the better answer to "what is this replacing?" wherever it fits,
            // and it was the only mode this component ever rendered because it
            // always rendered in a 1200px dialog. In a 380px chat column two
            // columns are 170px each, which is narrower than a sentence, so the
            // unified mode, the component's own default, takes over there.
            mode={narrow ? "unified" : "split"}
            leftLabel={t("agent.review.diffCurrent")}
            rightLabel={t("agent.review.diffProposed")}
          />
        )
      ) : null}
    </article>
  );
}

/** The setting changes a run proposed (myne-md/myne#850).
 *
 * **The row's whole job is the delta**: "the agent changed a setting" is not
 * reviewable, and "the weekly notes folder goes from Journals/Weekly to
 * Reviews/Weekly" is. That is why it reads the current value and shows both on
 * one line.
 *
 * The current value comes from the client's own prefs read and **never reaches
 * the model**: the request the loop builds carries the intent's id and the value
 * asked for, and nothing about what the setting holds now.
 *
 * A setting is applied on its own, never in a batch, because it sits inside no
 * note grant. That rule is enforced host-side (`apply_settings_approved`'s bulk
 * carve-out); the button here just does not offer the other shape.
 */
function SettingsGroup({
  settings,
  rejected,
  applied,
  appliedSettings,
  busy,
  onToggle,
  onApplyOne,
}: {
  settings: ProposedSetting[];
  rejected: ReadonlySet<number>;
  applied: ReadonlySet<number>;
  /** The settings the host recorded as landed, so a row that has been applied can
   *  show the value it REPLACED rather than re-deriving one from live prefs. */
  appliedSettings: readonly AppliedSetting[];
  busy: boolean;
  onToggle: (index: number) => void;
  onApplyOne: (setting: ProposedSetting) => void;
}) {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  return (
    <section
      data-testid="agentReview.settingsGroup"
      // **The card's own row anatomy, not the dialog's** (myne-md/myne#894, from
      // review). This group kept the shape the rest of the card argues against: a
      // bordered box per row, a heavier heading, and 0.5 where the other rows use
      // 0.55. One card, one row shape, or the settings read as a different kind of
      // object inside the same decision.
      style={{
        borderBottom: "1px solid var(--line-1)",
        padding: "var(--space-2) var(--space-3)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <h3
        style={{
          margin: 0,
          padding: "var(--space-1) 0",
          fontSize: "var(--text-sm)",
          fontWeight: "var(--weight-semibold)",
        }}
      >
        {t("agent.review.settingsHeading", { count: settings.length })}
      </h3>
      {settings.map((setting, index) => {
        const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === setting.intentId);
        // The id is the fallback rather than the row being hidden: an entry the
        // index has lost must still be reviewable, and showing the raw id is
        // what makes the gap visible instead of silent.
        // **The period heading alone does not name the setting** (myne-md/myne#850,
        // from review). Nine of the twelve intents carry a period heading as their
        // `titleKey`, so a run proposing the weekly folder and the weekly title
        // format rendered two rows both headed "Weekly notes" with no way to tell
        // which change was which. The per-setting name is the index's
        // `descriptionKey`, which is what the settings panel itself renders as the
        // control's label, so the row shows both: the period, then the setting.
        const label = entry ? t(entry.titleKey) : setting.intentId;
        const subLabel = entry?.descriptionKey
          ? t(entry.descriptionKey)
          : null;
        const current = currentSettingValue(setting.intentId, prefs);
        const isRejected = rejected.has(index);
        const isApplied = applied.has(index);
        // **The delta comes from the RECORD once the row has landed.** Reading it
        // from live prefs re-runs `settingChangeLine` against the value the write
        // just stored, so an applied row rendered "Archived/Weekly becomes
        // Archived/Weekly" (or "not set", for a landed clear) beside a button
        // reading "Applied": the row's whole job is the delta, and it showed none.
        //
        // **And the folder half, which was invisible for the one setting that has
        // two fields** (2026-10-13 review): the row diffed only the mode, so a
        // change that moved the folder while the mode stayed `specific` rendered
        // "specific becomes specific". `previousFolder` exists for this pair and
        // went unread. One lookup serves both halves, because both read the same
        // record.
        const recorded = appliedSettings.find(
          (a) => a.intentId === setting.intentId,
        );
        const from = isApplied ? (recorded?.previous ?? null) : current;
        const recordedFolder = isApplied ? recorded?.previousFolder : undefined;
        return (
          <article
            key={index}
            data-testid="agentReview.settingChange"
            data-setting-id={setting.intentId}
            data-rejected={isRejected ? "true" : "false"}
            data-applied={isApplied ? "true" : "false"}
            style={{
              padding: "var(--space-1) 0",
              opacity: isRejected ? 0.55 : 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--space-3)",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
                minWidth: 0,
              }}
            >
              <span style={{ fontWeight: "var(--weight-semibold)" }}>{label}</span>
              {subLabel ? (
                <span
                  data-testid="agentReview.settingChange.label"
                  style={{ color: "var(--fg-2)", fontSize: "var(--text-sm)" }}
                >
                  {subLabel}
                </span>
              ) : null}
              <span
                data-testid="agentReview.settingChange.value"
                style={{
                  color: "var(--fg-2)",
                  fontSize: "var(--text-sm)",
                  overflowWrap: "anywhere",
                }}
              >
                {settingChangeLine(setting, from, (key, opts) => t(key, opts))}
              </span>
              {setting.folder != null ? (
                <span
                  data-testid="agentReview.settingChange.folder"
                  style={{
                    color: "var(--fg-2)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-sm)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {isApplied && recordedFolder !== undefined
                    ? t("agent.review.settingFolderFrom", {
                        from: recordedFolder ?? t("agent.review.settingAlreadyUnset"),
                        to: setting.folder,
                      })
                    : t("agent.review.settingFolder", { folder: setting.folder })}
                </span>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}>
              {/* **Nothing to reject once it has landed**, which is the same rule
                  the edit row beside it enforces by rendering no toggle at all
                  (2026-10-13 review). Offering it let a change already on disk be
                  clicked into "Rejected" and dimmed to half opacity, contradicting
                  the "Applied" label on the button next to it. */}
              {isApplied ? null : (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => onToggle(index)}
                data-testid="agentReview.settingReject"
              >
                {isRejected ? t("agent.review.restoreEdit") : t("agent.review.rejectEdit")}
              </Button>
              )}
              <Button
                variant="secondary"
                disabled={busy || isRejected || isApplied}
                onClick={() => onApplyOne(setting)}
                data-testid="agentReview.settingApply"
              >
                {isApplied
                  ? t("agent.review.alreadyApplied")
                  : t("agent.review.applySetting")}
              </Button>
            </div>
          </article>
        );
      })}
    </section>
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
  notes: readonly ProposedNote[];
  rejected: ReadonlySet<number>;
  onToggle: (index: number) => void;
}) {
  const { t } = useTranslation();
  /* One row per note, in the same shape as an edit row: the title and where it
     lands are what the decision turns on, and the body, which can be pages,
     is behind that row's own disclosure. */
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  return (
    <section
      data-testid="agentReview.newNotesGroup"
      style={{
        borderBottom: "1px solid var(--line-1)",
        padding: "var(--space-2) var(--space-3)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <h3
        style={{
          margin: 0,
          padding: "var(--space-1) 0",
          fontSize: "var(--text-sm)",
          fontWeight: "var(--weight-semibold)",
        }}
      >
        {t("agent.review.newNotesHeading", { count: notes.length })}
      </h3>
      {notes.map((note, index) => (
        <article
          key={index}
          data-testid="agentReview.newNote"
          data-rejected={rejected.has(index) ? "true" : "false"}
          style={{ opacity: rejected.has(index) ? 0.55 : 1 }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "var(--space-1) 0",
            }}
          >
            <span
              data-testid="agentReview.newNoteTitle"
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: "var(--text-sm)",
                fontWeight: "var(--weight-medium)",
              }}
            >
              {note.title}
            </span>
            <span style={{ flex: "none", fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
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
            <IconButton
              icon={open.has(index) ? "chevron-up" : "chevron-down"}
              iconSize={12}
              label={t(
                open.has(index)
                  ? "agent.review.hideChange"
                  : "agent.review.showChange",
              )}
              tooltip
              expanded={open.has(index)}
              testId="agentReview.toggleNewNoteBody"
              onClick={() =>
                setOpen((prev) => {
                  const next = new Set(prev);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  return next;
                })
              }
            />
          </div>
          {open.has(index) ? (
            /* The whole body, not an excerpt: the user is approving a write, and
               a create has no restore point to fall back on. */
            <pre
              data-testid="agentReview.newNoteBody"
              style={{
                margin: 0,
                padding: "var(--space-2) 0 var(--space-3)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-sm)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "var(--fg-2)",
              }}
            >
              {note.body}
            </pre>
          ) : null}
        </article>
      ))}
    </section>
  );
}

export function RefusalBlock({ result }: { result: AgentApplyResult }) {
  const { t } = useTranslation();
  // **All three kinds, and the settings were missing from both halves** (from
  // review). A refused setting change therefore rendered a block reading "0
  // changes could not be applied" over an empty list, while the row for that same
  // change read "Applied" and was disabled. The count is what the host's
  // `hasRefusals` predicate decides on, so the two had come to disagree about
  // whether the block even exists.
  const refusedSettings = result.refusedSettings ?? [];
  const count =
    result.refused.length + result.refusedNewNotes.length + refusedSettings.length;
  return (
    <section
      data-testid="agentReview.refusedBlock"
      style={{
        padding: "var(--space-2) var(--space-3)",
        borderBottom: "1px solid var(--line-1)",
        background: "var(--paper-2)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-1)",
      }}
    >
      <p
        data-testid="agentReview.refusedCount"
        style={{
          margin: 0,
          fontSize: "var(--text-xs)",
          color: "var(--danger)",
          fontWeight: "var(--weight-semibold)",
        }}
      >
        {t("agent.review.refusedCount", { count })}
      </p>
      <ul
        data-testid="agentReview.refusedList"
        style={{
          margin: 0,
          paddingInlineStart: "var(--space-3)",
          color: "var(--fg-2)",
          fontSize: "var(--text-xs)",
        }}
      >
        {result.refused.map((r) => (
          <li key={`e-${r.noteId}-${r.index}`}>{t(`agent.review.refused.${r.reason}`)}</li>
        ))}
        {result.refusedNewNotes.map((r) => (
          <li key={`n-${r.index}`}>{t(`agent.review.refused.${r.reason}`)}</li>
        ))}
        {refusedSettings.map((r) => (
          <li key={`s-${r.intentId}-${r.index}`}>
            {/* **Its own namespace, not the edits'.** The two enums are different
                Rust types with different reasons, and sharing
                `agent.review.refused.*` broke `editRejectionMirror.test.ts`, which
                exists precisely to hold that namespace equal to `EditRejection` one
                way and the catalog the other (2026-10-13 review). */}
            {t(`agent.review.refusedSetting.${r.reason}`)}
          </li>
        ))}
      </ul>
    </section>
  );
}
