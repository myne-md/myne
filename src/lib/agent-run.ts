// The thin TS binding for the `agent` plugin (myne-md/myne#529): agentic note
// editing: the AI proposes changes to note bodies inside a scope the user
// approved, and nothing reaches the vault until the user approves a diff.
//
// This module holds NO policy. Scope, the `ai_excluded_folders` clamp and the
// request class are all decided host-side and none of them is sent from here.
// That is deliberate and it is the rule `docs/decisions/ai/0462` states: "'the
// caller behaved' is not a property of a seam". A future edit that starts
// computing a scope here, or sending an excluded-folder list, has moved a
// security control into the WebView.
//
// What crosses this boundary is AS1-class: note titles, note bodies and the
// model's proposed replacements are the user's own plaintext. None of it is
// logged here, and none of it survives a vault lock: the host drops the run
// table and the transcript on teardown, so a proposal the user never approved
// simply ceases to exist.

import { invoke } from "../platform/core";

/** What the user approved as a scope. Mirrors the Rust `ScopeGrant`.
 *
 *  Two shapes and no third. There is deliberately no tag or saved-search form:
 *  a predicate is a permission whose contents change after it was granted, and
 *  the agent can write the very tag that would widen its own scope. */
export type ScopeGrant =
  | { kind: "notes"; value: string[] }
  | { kind: "folder"; value: string };

/** One anchored edit the model proposed. Mirrors the Rust `ProposedEdit`. */
export interface ProposedEdit {
  noteId: string;
  /** Text the model copied out of the note, verbatim. It must occur exactly
   *  once or the edit is refused; there is no fuzzy matching anywhere. */
  anchor: string;
  replacement: string;
}

/** A note the model proposed creating. Mirrors the Rust `ProposedNote`. */
export interface ProposedNote {
  title: string;
  body: string;
  folder: string | null;
}

/** Everything one run has proposed so far. */
export interface Proposal {
  edits: ProposedEdit[];
  newNotes: ProposedNote[];
  /** The model's own summary, shown above the diff. Note content can steer it,
   *  so the surface presents it as the model's claim rather than as a fact. */
  summary: string;
}

/** The run, as the surface shows it. Mirrors the Rust `AgentRunView`. */
export interface AgentRunView {
  runId: string;
  /** How many notes the run may currently read and change.
   *
   *  Load-bearing rather than informational: the design carries no cap on how
   *  far a scope may grow, so this number is what bounds accumulation across
   *  repeated approvals. It must be shown continuously, not on demand. */
  scopeTotal: number;
  userGrants: number;
  modelGrants: number;
  cancelled: boolean;
}

/** Why the loop stopped. Mirrors the Rust `LoopEnd`. */
export type LoopEnd =
  | { kind: "finished" }
  | { kind: "awaitingScope"; folder: string; reason: string }
  | { kind: "cancelled" }
  | { kind: "exhaustedIterations" };

/** What a start or a resume produced. */
export interface AgentStepResult {
  view: AgentRunView;
  proposal: Proposal;
  end: LoopEnd;
  /** Model round-trips so far. Feeds the post-run summary, which is the only
   *  place an uncapped remote run becomes visible to the user. */
  iterations: number;
  notesRead: number;
  /** Characters that left the device across this step's requests, or `null`
   *  when none did.
   *
   *  `null` and `0` are deliberately different: the first says the run stayed on
   *  the machine, the second would say a request went out carrying nothing. The
   *  summary shows a figure only for the first case, and the design carries no
   *  volume bound on the remote arm, so this is the only place a user learns the
   *  size of what happened. */
  charsOffDevice: number | null;
  /** How many notes the excluded-folder clamp removed from the grant that
   *  produced this step. Shown on the approval screen with the count, never
   *  dropped silently. */
  excludedCount: number;
}

/** Why one edit did not land. Mirrors the Rust `EditRejection`. */
export type EditRejection =
  | "anchorNotFound"
  | "anchorAmbiguous"
  | "anchorEmpty"
  | "outOfScope"
  /** The note could not be read at apply time. Refuses that note's edits and
   *  leaves the rest of the batch alone. */
  | "readFailed"
  /** A proposed new note's title or folder contains a newline, so writing it
   *  into frontmatter would emit fields nothing validated. */
  | "unsafeFrontmatter"
  /** A proposed new note names an AI-excluded folder. */
  | "excludedFolder"
  /** A proposed new note could not be written. Reported as a refusal rather
   *  than failing the apply, because a create runs after the edit batch is
   *  already committed: failing there would discard the run's restore points
   *  and leave the applied edits with no undo. */
  | "createFailed"
  /** The edit would trash a note and arrived inside a bulk approval. The user
   *  can still apply it by approving it on its own. */
  | "trashNeedsOwnAct";

export interface RefusedEdit {
  noteId: string;
  /** The edit's index in the approved list, so the row the user actually
   *  looked at can be marked rather than guessed at by content. */
  index: number;
  reason: EditRejection;
}

/** One proposed new note that was not created, and why. Its own list rather
 *  than a `RefusedEdit`, because the two index spaces are different: a refused
 *  edit at index 0 and a refused new note at index 0 are different rows. */
export interface RefusedNewNote {
  index: number;
  reason: EditRejection;
}

/** What an apply did. Mirrors the Rust `ApplyOutcome`. */
export interface AgentApplyResult {
  applied: number;
  refused: RefusedEdit[];
  refusedNewNotes: RefusedNewNote[];
  notesWritten: string[];
  /** Notes the run created. Separate from `notesWritten` because a create has no
   *  restore point: there is nothing to revert to, and undoing one means
   *  trashing it rather than restoring a snapshot. */
  notesCreated: string[];
  /** `[noteId, snapshotId]` per written note, so the whole run reverts as one
   *  action. Held for the session only; a lock drops it, like everything else
   *  about a run. */
  restorePoints: [string, string][];
}

/** One probe attempt's verdict. */
export type AttemptVerdict =
  | { kind: "passed" }
  | { kind: "failed"; detail: string };

/** Whether agent mode can run on the configured backend. */
export interface ProbeVerdict {
  passed: boolean;
  passes: number;
  threshold: {
    attempts: number;
    required: number;
    /** Whether the cut point was measured, or is still the recorded guess.
     *  Surfaced because a refusal is a claim about the user's model. */
    provisional: boolean;
  };
  attempts: AttemptVerdict[];
}

/** Start a run. The grant is the scope the user set; the host resolves and
 *  freezes it, applies the excluded-folder clamp, and drives the loop. */
export async function agentStart(
  task: string,
  grant: ScopeGrant,
): Promise<AgentStepResult> {
  return await invoke<AgentStepResult>("plugin:agent|agent_start", {
    task,
    grant,
  });
}

/** Approve a scope expansion the model asked for, and resume.
 *
 *  The grant is resolved and frozen at this moment. A note added to the folder
 *  afterwards is not inside what the user just approved. */
export async function agentApproveScope(
  runId: string,
  grant: ScopeGrant,
): Promise<AgentStepResult> {
  return await invoke<AgentStepResult>("plugin:agent|agent_approve_scope", {
    runId,
    grant,
  });
}

/** What a grant would resolve to. Every number is the host's.
 *
 *  Mirrors the Rust `GrantPreview`. */
export interface GrantPreview {
  /** How many notes the grant would add, already clamped. */
  noteCount: number;
  /** How many the AI-excluded-folders control removed. */
  excludedCount: number;
  /** Named ids the index does not know. They fail closed and are dropped. */
  unknownCount: number;
  /** What the run's total scope would become. A union, not a sum. */
  newTotal: number;
}

/** Resolve a grant WITHOUT committing it, so the approval screen can state the
 *  host's numbers.
 *
 *  This exists because the approval screen is the gate, and a gate that states a
 *  size the host will not honour is not one. Computing the count in the WebView
 *  would leave out the excluded-folder clamp and would add rather than union, so
 *  the user would approve against a number wrong in two directions.
 *
 *  A preview, not a reservation: the set is resolved again at approval, and the
 *  frozen set is that one. */
export async function agentPreviewGrant(
  grant: ScopeGrant,
  runId?: string,
): Promise<GrantPreview> {
  return await invoke<GrantPreview>("plugin:agent|agent_preview_grant", {
    runId: runId ?? null,
    grant,
  });
}

/** Cancel a run. The same flag the vault-lock teardown sets. */
export async function agentCancel(runId: string): Promise<boolean> {
  return await invoke<boolean>("plugin:agent|agent_cancel", { runId });
}

/** How the user approved. Mirrors the Rust `Approval`.
 *
 *  A fact about the click, not about the edits, which is why the host cannot
 *  derive it. `bulk` is what the host refuses to let a trashing edit ride in. */
export type Approval = "individual" | "bulk";

/** Apply the edits the user approved.
 *
 *  Only the approved subset is sent, and that is true of NEW NOTES as well:
 *  `approvedNewNotes` indexes the run's proposed list, and the host creates only
 *  what is named there. A create is a write, so it needs the same per-note
 *  approval every edit needs; handing over the whole proposal was the defect this
 *  parameter exists to prevent.
 *
 *  The host still refuses anything outside the run's scope, still re-checks every
 *  anchor against the note as it is now (so an edit whose note moved under a
 *  pending review is refused rather than applied to the wrong text), and, when
 *  `approval` is `"bulk"`, still refuses an edit that would trash a note. **The
 *  split below is the UI's convenience; the host's refusal is the rule.** */
export async function agentApply(
  runId: string,
  approved: ProposedEdit[],
  approvedNewNotes: number[],
  approval: Approval,
): Promise<AgentApplyResult> {
  return await invoke<AgentApplyResult>("plugin:agent|agent_apply", {
    runId,
    approved,
    approvedNewNotes,
    approval,
  });
}

/** What an undo did. Mirrors the Rust `AgentUndoResult`. */
export interface AgentUndoResult {
  /** How many notes were restored to their pre-apply text. */
  reverted: number;
  /** Notes whose snapshot would not restore. Named so the user can act. */
  failed: string[];
  /** How many notes the run CREATED and this undo therefore left in place. A
   *  create has no snapshot to restore to; undoing one means trashing it, which
   *  is a different act. Reporting the count is what keeps "the run was undone"
   *  from meaning more than it did. */
  notesCreatedNotReverted: number;
}

/** An applied run the user could still undo. Mirrors the Rust `AppliedRun`.
 *
 *  Identifiers only, never note text: a `[noteId, snapshotId]` pair names a
 *  blob, it does not carry one. */
export interface AppliedRun {
  runId: string;
  restorePoints: [string, string][];
  notesCreated: number;
}

/** Revert a whole agent run, as one action.
 *
 *  **Takes the run id, not the snapshot list.** The host stores the record under
 *  the run when the apply writes it, which is what makes undo reachable after
 *  this screen is gone, and what makes a second undo of the same run report
 *  `noSuchRun` rather than restoring the same snapshots over whatever the user
 *  has written since.
 *
 *  One command rather than N snapshot restores from here: "the whole run reverts
 *  as one action" is the property the restore point exists for, and a loop in the
 *  WebView is a property that holds only while nobody interrupts it. */
export async function agentUndo(runId: string): Promise<AgentUndoResult> {
  return await invoke<AgentUndoResult>("plugin:agent|agent_undo", { runId });
}

/** The run the user could still undo, or null.
 *
 *  Read on mount rather than remembered, so the affordance survives the review
 *  screen being closed and dies with the vault lock that clears the host's copy. */
export async function agentLastRun(): Promise<AppliedRun | null> {
  return await invoke<AppliedRun | null>("plugin:agent|agent_last_run");
}

/** Whether the configured backend can hold the anchored edit format. */
export async function agentCapability(): Promise<ProbeVerdict> {
  return await invoke<ProbeVerdict>("plugin:agent|agent_capability");
}

/** Whether an edit would move a note into the trash.
 *
 *  Trash in Myne is a `trashed:` frontmatter timestamp, so at the diff layer a
 *  deletion looks exactly like any other edit. This is the surface's half of
 *  keeping those apart: an edit whose replacement introduces the marker is
 *  excluded from bulk approve and always needs its own act.
 *
 *  Deliberately conservative: it looks at the replacement text rather than at
 *  the resulting note, so an edit that inserts the marker is caught even when
 *  this module cannot see the whole body. Over-flagging costs a click. Under-
 *  flagging costs nothing either, because the host refuses the write anyway: *  which is the point of doing the real check there rather than here. */
export function editWritesTrashMarker(edit: ProposedEdit): boolean {
  return hasTrashMarker(edit.replacement) && !hasTrashMarker(edit.anchor);
}

/** `trashed:` followed by an ISO-8601 instant whose calendar fields are in
 *  range.
 *
 *  A hand mirror of the Rust `fm_trashed_value_strict`, and the range check is
 *  the half that is easy to leave out: a shape-only pattern accepts
 *  `trashed: 2026-13-45T99:99:99Z`, which the Rust reader rejects. The Rust side
 *  is the one that decides: it re-runs the real check against the resulting
 *  note before writing, so a mismatch here is a UI-grouping bug and never a
 *  data-loss one. The mirror exists so the screen can flag the row, not so the
 *  screen can be trusted. */
function hasTrashMarker(text: string): boolean {
  const m = TRASHED_LINE.exec(text);
  if (m === null) return false;
  const [, year, month, day, hour, minute, second] = m;
  const n = (s: string) => Number.parseInt(s, 10);
  return (
    n(year) >= 1 &&
    n(month) >= 1 &&
    n(month) <= 12 &&
    n(day) >= 1 &&
    n(day) <= 31 &&
    n(hour) <= 23 &&
    n(minute) <= 59 &&
    // 60 for a leap second, matching what an ISO-8601 producer may emit.
    n(second) <= 60
  );
}

const TRASHED_LINE =
  /^\s*trashed:\s*(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\s*$/m;

/** Split an approved set into what a bulk action may carry and what it may not.
 *
 *  **Presentation only.** This decides which row gets its own button; it is not
 *  the enforcement. The host re-derives the same question from the note as it
 *  will actually be after the edit, and refuses a trashing edit inside a `"bulk"`
 *  approval regardless of what was sent. So this mirror is allowed to
 *  over-flag (that costs a click) and a divergence in the other direction
 *  costs nothing, because the host does not consult it. */
export function splitForBulkApproval(edits: ProposedEdit[]): {
  bulkApprovable: ProposedEdit[];
  needsOwnAct: ProposedEdit[];
} {
  const bulkApprovable: ProposedEdit[] = [];
  const needsOwnAct: ProposedEdit[] = [];
  for (const edit of edits) {
    (editWritesTrashMarker(edit) ? needsOwnAct : bulkApprovable).push(edit);
  }
  return { bulkApprovable, needsOwnAct };
}

/** How much text an edit removes, net, in characters.
 *
 *  Feeds the visual flag on a large deletion. A flag rather than a block: a
 *  threshold that refused a large cut would also refuse a legitimate "condense
 *  this note". */
export function netDeletion(edit: ProposedEdit): number {
  return Math.max(0, edit.anchor.length - edit.replacement.length);
}
