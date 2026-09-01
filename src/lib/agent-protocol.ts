// The agent protocol: the wire TYPES both clients speak, and the pure
// predicates over them (myne-md/myne#456).
//
// **Split out of `agent-run.ts` so mobile can share it rather than retype it.**
// That file opens IPC channels through the desktop platform seam, and a seam is
// per client by construction, so a mobile client importing it would be reaching
// through desktop's `@tauri-apps` boundary instead of its own. What is here has
// no host reach at all: type declarations, a marker table and four functions
// over their own arguments.
//
// **This module holds NO policy**, and the rule is inherited verbatim from the
// file it came out of (`design-notes/ai/0462`): scope, the
// `ai_excluded_folders` clamp and the request class are all decided host-side,
// and an edit that starts computing one of them here has moved a security
// control into the WebView. The predicates below are deliberately advisory:
// `editHidesNote` looks at the replacement text rather than the resulting note,
// over-flags on purpose, and the host refuses the write regardless.
//
// What the types describe is AS1-class: note titles, note bodies and the
// model's proposed replacements are the user's own plaintext. None of it is
// logged here, and none of it survives a vault lock.

/** What the user approved as a scope. Mirrors the Rust `ScopeGrant`.
 *
 *  Two shapes and no third. There is deliberately no tag or saved-search form:
 *  a predicate is a permission whose contents change after it was granted, and
 *  the agent can write the very tag that would widen its own scope. */
export type ScopeGrant =
  | { kind: "notes"; value: string[] }
  | { kind: "folder"; value: string };

/**
 * The scope a run gets when the user has set none: the open note, or nothing.
 *
 * **`null` rather than "the whole vault", and the host is why.** A folder grant
 * with an empty path IS the vault root, and
 * `core/src/plugins/agent/scope.rs::is_root_grant` exists so a caller refuses
 * one before resolving: `start_run` and `preview_grant` both return
 * `AgentError::RootGrant`, and `resolve_grant`'s own comment says reaching it
 * with an empty key "would silently grant everything, so resolve it to nothing
 * instead". So `{ kind: "folder", value: "" }` is not a wide scope, it is a
 * refused one, and a client that builds it offers a Send that cannot work and a
 * scope figure that reads "could not be checked".
 *
 * Shared because both clients answer this question and the mobile one answered
 * it the other way for a review round. Desktop's composer already returned
 * `null` here; this is that rule with a name, so the next client inherits it
 * rather than re-deciding.
 */
export function defaultGrantFor(openNoteId: string | null): ScopeGrant | null {
  return openNoteId === null ? null : { kind: "notes", value: [openNoteId] };
}

/** A stable dependency key for a grant.
 *
 * A `ScopeGrant` is built as an object literal at its call site, so its
 * identity changes on every render and a React effect keyed on it re-fires
 * forever. That is not theoretical here: the mobile scope strip re-issued
 * `agent_preview_grant` on every parent render, blanking the disclosure figure
 * `design-notes/ai/0528` requires to be on screen each time.
 */
export function scopeKey(grant: ScopeGrant | null): string {
  if (grant === null) return "";
  return grant.kind === "folder" ? `f:${grant.value}` : `n:${grant.value.join("\u0000")}`;
}

/** Which shape of write an edit is. Mirrors the Rust `EditKind`.
 *
 *  A discriminator on the one edit type rather than a second list on the
 *  proposal, so the bulk-approval split, the applied-row bookkeeping and the
 *  review screen all cover an append by construction rather than by a second
 *  wiring nobody would notice was missing. */
export type EditKind = "replace" | "append";

/** One edit the model proposed. Mirrors the Rust `ProposedEdit`. */
export interface ProposedEdit {
  noteId: string;
  /** Replace or append. Optional on the wire for the same reason the Rust field
   *  carries `#[serde(default)]`: a payload written before the append verb
   *  existed is the replace it always was. */
  kind?: EditKind;
  /** Text the model copied out of the note, verbatim. It must occur exactly
   *  once or the edit is refused; there is no fuzzy matching anywhere. Empty
   *  for an append, which has nothing to anchor to. */
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
  | { kind: "exhaustedIterations" }
  /** The model stopped making progress: three replies in a row produced no
   *  action, or only tool calls the run had already made. A different end from
   *  `exhaustedIterations` because the user's next move is different, a model
   *  that cannot hold the format, rather than a run that ran out of room. */
  | { kind: "stalled"; barrenIterations: number };

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
  /** The edit would take a note OUT of the working set and arrived inside a
   *  bulk approval. The user can still apply it by approving it on its own.
   *  Named for the field class rather than for `trashed:`, see
   *  {@link editHidesNote}. */
  | "removalNeedsOwnAct"
  /** The note's folder was excluded from AI while the run was open or the
   *  review was pending. SYNC-14 carries no in-flight carve-out, so the newest
   *  answer decides and the edit is refused rather than applied. */
  | "excludedNow"
  /** The edit is not one the host recorded the model proposing. Reported rather
   *  than dropped, so a row the user pressed Apply on never silently does
   *  nothing. */
  | "notProposed"
  /** The edit would move the note to a different folder. Refused under EVERY
   *  approval label, unlike `removalNeedsOwnAct`, because `folder:` is what the
   *  AI-excluded-folder control is keyed on: the clamp reads it before the
   *  batch runs, so an edit rewriting that line would relocate a note past a
   *  control that had already made its decision. */
  | "noteMoved"
  /** An append carried nothing to append. Its own reason rather than
   *  `anchorEmpty`, which would describe a rule an append does not have. */
  | "appendEmpty"
  /** An append into a note with neither frontmatter nor body would have
   *  authored a frontmatter block. Appended text normally lands after the
   *  block, which makes that impossible; an entirely empty note is the one case
   *  positioning cannot cover, and it is refused rather than silently
   *  rewritten. */
  | "appendWouldWriteFrontmatter";

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

/** Whether an edit would take a note OUT of the working set.
 *
 *  Every way Myne removes a note from the note list is a frontmatter field, so
 *  at the diff layer a removal looks exactly like any other edit. This is the
 *  surface's half of keeping those apart: an edit whose replacement introduces
 *  one of the markers is excluded from bulk approve and always needs its own
 *  act.
 *
 *  **Five fields, and the roster is not hand-picked.** It is exactly what
 *  `isLiveNote` reads (`editor/src/host/notes/selectors.ts`), which is the one
 *  authority for "this note is in the working set". This function used to read
 *  `trashed:` alone, which left `deleted:`, the marker that hides a note from
 *  Trash as well as from the sidebar, in the bulk-approvable pile
 *  (myne-md/myne#531 review round five).
 *
 *  Deliberately conservative: it looks at the replacement text rather than at
 *  the resulting note, so an edit that inserts a marker is caught even when
 *  this module cannot see the whole body. Over-flagging costs a click. Under-
 *  flagging costs nothing either, because the host refuses the write anyway:
 *  which is the point of doing the real check there rather than here. */
export function editHidesNote(edit: ProposedEdit): boolean {
  return editHidesNoteAs(edit) !== null;
}

/** WHICH marker the edit introduces, or `null` for an ordinary edit.
 *
 *  The screen needs the field and not only the boolean: the row's flag says
 *  what approving it will do, and one sentence cannot be true for all five.
 *  "Moves this note to Trash" over an edit that writes `archived:` is a false
 *  statement to the user at the moment they are deciding.
 *
 *  First match wins, in `isLiveNote` order. An edit that introduces two markers
 *  at once is pathological and already refused; naming the first is better than
 *  naming none. */
export function editHidesNoteAs(edit: ProposedEdit): HidingField | null {
  // **An append cannot hide a note, so flagging one is a false statement.**
  // Appended text lands in the BODY, after the note's frontmatter block, so a
  // `trashed:` line inside it is prose rather than a marker. The host agrees:
  // its own check reads the resulting frontmatter and correctly sees nothing,
  // which `apply::tests::an_append_cannot_hide_a_note_because_its_text_lands_in_the_body`
  // pins. Without this arm the screen would put "moves this note to Trash" over
  // a row that does no such thing, and route it out of the bulk approve for a
  // reason that is not true.
  //
  // The over-flagging licence the rest of this function relies on does not
  // stretch this far: it is an argument for flagging when the OUTCOME is
  // uncertain, and here the outcome is known.
  if (isAppend(edit)) return null;
  const hit = HIDING_MARKERS.find(
    (marker) => marker.test(edit.replacement) && !marker.test(edit.anchor),
  );
  return hit?.field ?? null;
}

/** The frontmatter fields `isLiveNote` reads. */
export type HidingField =
  | "trashed"
  | "deleted"
  | "archived"
  | "template"
  | "conflict";

/** One working-set marker, and how to recognise it value-strict. */
interface HidingMarker {
  /** The frontmatter key, for the roster test and the row label to read. */
  readonly field: HidingField;
  test(text: string): boolean;
}

/** A `<field>:` line carrying an ISO-8601 instant whose calendar fields are in
 *  range.
 *
 *  A hand mirror of the Rust `fm_timestamp_value_strict`, and the range check is
 *  the half that is easy to leave out: a shape-only pattern accepts
 *  `trashed: 2026-13-45T99:99:99Z`, which the Rust reader rejects. The Rust side
 *  is the one that decides: it re-runs the real check against the resulting
 *  note before writing, so a mismatch here is a UI-grouping bug and never a
 *  data-loss one. The mirror exists so the screen can flag the row, not so the
 *  screen can be trusted. */
function timestampMarker(field: HidingField): HidingMarker {
  const re = new RegExp(
    `^\\s*${field}:\\s*(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})\\s*$`,
    "m",
  );
  return {
    field,
    test(text: string): boolean {
      const m = re.exec(text);
      if (m === null) return false;
      const [, year, month, day, hour, minute, second] = m;
      const n = (v: string) => Number.parseInt(v, 10);
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
    },
  };
}

/** A `<field>:` line carrying the literal, unquoted `true`.
 *
 *  Mirrors the Rust `fm_template_value_strict` / `fm_conflict_value_strict`:
 *  `template: "true"` / `template: 1` / `template: True` are a user's own field
 *  and do not mark. */
function booleanMarker(field: HidingField): HidingMarker {
  const re = new RegExp(`^\\s*${field}:\\s*true\\s*(?:#.*)?$`, "m");
  return { field, test: (text: string) => re.test(text) };
}

/** The roster, in `isLiveNote` order. Exported for the mirror test, which reads
 *  the Rust side's roster and asserts the two name the same fields. */
export const HIDING_MARKERS: readonly HidingMarker[] = [
  timestampMarker("trashed"),
  timestampMarker("deleted"),
  timestampMarker("archived"),
  booleanMarker("template"),
  booleanMarker("conflict"),
];

/** Split an approved set into what a bulk action may carry and what it may not.
 *
 *  **Presentation only.** This decides which row gets its own button; it is not
 *  the enforcement. The host re-derives the same question from the note as it
 *  will actually be after the edit, and refuses a removing edit inside a
 *  `"bulk"` approval regardless of what was sent. So this mirror is allowed to
 *  over-flag (that costs a click) and a divergence in the other direction
 *  costs nothing, because the host does not consult it. */
/** Whether an apply outcome carries a refusal of either kind
 *  (myne-md/myne#596).
 *
 *  One fact, one function, because two places decide on it and they must not
 *  disagree: `AgentReview`'s `ApplyReport` renders `agentReview.refusedList`
 *  when it holds, and `applyWasCleanAndComplete` keeps the review dialog OPEN
 *  when it holds. If those drifted apart the dialog would dismiss itself over
 *  the refusal list it was about to draw, which is the one outcome that screen
 *  exists to put in front of the user.
 *
 *  Both lists, not just `refused`: a refused NEW NOTE is indexed against a
 *  different space and is easy to leave out of a condition written from the
 *  edit side. */
export function hasRefusals(
  result: Pick<AgentApplyResult, "refused" | "refusedNewNotes">,
): boolean {
  return result.refused.length > 0 || result.refusedNewNotes.length > 0;
}

/** What approving this removal on its own will do, in the user's words.
 *
 *  **A `switch` over literal keys rather than a template key**, and that is not
 *  style. `scripts/check-i18n.mjs` scans static `t("…")` literals by design (an
 *  expression-aware scanner is a scanner with a bypass), so
 *  ``t(`agent.review.removalFlag.${field}`)`` would put five user-facing
 *  sentences outside every check in this repository.
 *
 *  Exhaustive over {@link HidingField}, so a sixth marker fails to typecheck
 *  here rather than rendering an empty flag beside a destructive button.
 *
 *  **Here rather than once per review screen.** Both clients had this function
 *  byte for byte, doc comment included, and it is the sentence shown next to a
 *  per-row approve that takes a note out of the user's note list: one client
 *  could have reworded or re-keyed it alone. It takes `t` as a parameter, so it
 *  stays pure and this module keeps its no-imports property.
 */
export function removalFlagLabel(
  field: HidingField,
  t: (key: string) => string,
): string {
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

export function splitForBulkApproval(edits: ProposedEdit[]): {
  bulkApprovable: ProposedEdit[];
  needsOwnAct: ProposedEdit[];
} {
  const bulkApprovable: ProposedEdit[] = [];
  const needsOwnAct: ProposedEdit[] = [];
  for (const edit of edits) {
    (editHidesNote(edit) ? needsOwnAct : bulkApprovable).push(edit);
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

/* ---- Types declared beside their binding, moved here whole ---------------
 *
 * These six sat interleaved with the `agent-run.ts` bindings that return them,
 * each next to its own caller, which reads well until a second client needs the
 * type and not the binding. They are wire shapes with no host reach, so they
 * belong on this side of the split; each keeps its doc comment verbatim.
 */

/** What a run has cost so far, for the leg currently running.
 *
 *  Mirrors the Rust `RunProgress`. RUNNING TOTALS, not deltas: a receiver that
 *  had to sum would under-report forever after dropping one message, and the
 *  off-device figure is the one number that must never read low. */
export interface RunProgress {
  /** Model round-trips so far. */
  iterations: number;
  /** Distinct notes read in full so far. */
  notesRead: number;
  /** Characters that have left the device, or `null` when the run has been
   *  answered entirely on this device. `null` and `0` are different statements
   *  and stay apart all the way to the screen. */
  charsOffDevice: number | null;
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

/** How the user approved. Mirrors the Rust `Approval`.
 *
 *  A fact about the click, not about the edits, which is why the host cannot
 *  derive it. `bulk` is what the host refuses to let a trashing edit ride in. */
export type Approval = "individual" | "bulk";

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

/** Which probe attempt is in flight (myne-md/myne#575). Counts only. */
export interface ProbeProgress {
  /** 1-based. */
  attempt: number;
  /** The most that will be asked; the probe stops earlier once the verdict is
   *  settled, so this is an allowance rather than a promise. */
  of: number;
}

/** Whether an edit appends rather than replaces.
 *
 *  A helper rather than a bare comparison because the field is optional on the
 *  wire, so `edit.kind === "append"` is the only correct test and
 *  `edit.kind !== "replace"` is a bug waiting for an absent field. */
export function isAppend(edit: ProposedEdit): boolean {
  return edit.kind === "append";
}

/** The largest chat-history seed budget the host will store, in characters.
 *
 *  **The Rust constant is the authority**, not this one: the clamp lives at the
 *  write (`core/src/plugins/agent/history.rs::MAX_HISTORY_BUDGET`), and this
 *  copy exists only so the settings input can render a `max` attribute. A UI
 *  that agreed with the host by accident rather than by construction is a shape
 *  this repo keeps finding, so `tests/lib/chatHistoryBudget.test.ts` reads the
 *  Rust file and fails when the two drift.
 *
 *  Deliberately NOT used to reject a value before sending: the host clamps, and
 *  a second clamp here would read as the control and hide the day the real one
 *  stopped working. */
export const CHAT_HISTORY_BUDGET_MAX = 12_000;
