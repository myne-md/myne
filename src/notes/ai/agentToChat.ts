// Agent run → chat-transcript orchestration.
//
// The sibling of `aiToChat.ts`, and it exists for the same reason: a capability
// that used to render into a surface of its own now renders into the one
// transcript. `design-notes/ai/0515` already said the entry point was chat
// ("A run starts from chat with the open note as the default scope"); what
// shipped put a second composer beside the chat one instead, so the tab offered
// two places to type. This module is the half of closing that which does not
// belong in a component: appending the run's turns, starting it, and mirroring
// each settled step onto its turn.
//
// **`settleRunIntoChat` is the ONE place a step settles**, and that is the point
// rather than a convenience. The mirror used to live in a render effect on the
// turn, which meant a cross-store write whose correctness rested on an
// over-broad dependency array being absorbed by an equality check. It also had
// to be written where it could see BOTH callers of `settleStep`: this module's
// own start, and the scope-approval resume in `AgentProgress`. Putting the
// mirror in the settle function covers both by construction, which is what the
// effect was approximating.
//
// **It deliberately does not own the capability probe.** The verdict gates
// whether Send is offered at all, and it must not fire until the user actually
// sends, because on a remote provider the probe issues `threshold.attempts`
// third-party requests (TB13, `design-notes/ai/0515`). Firing it here would
// make "start a run" and "find out whether a run is possible" the same call,
// which is how a mount effect grows back. That the verdict now LIVES in
// `agentStore` rather than in the composer's own state (myne-md/myne#568)
// changes nothing about this: where an answer is kept and who is allowed to ask
// the question are separate decisions, and only the second one is this
// paragraph's.
//
// Both stores hold AS1-class RAM, dropped on lock: the transcript through
// `clearChat`, the proposal through `clearAgentForLock`. Settled transcript
// turns additionally persist into the encrypted conversation store
// (myne-md/myne#675); the live proposal never does. Nothing here logs the
// task, which is the user's own words.

import { flushBeforeFrontmatterWrite } from "../flushBeforeFrontmatterWrite";
import { offeredSettingIds } from "../agent/settingCatalogue";
import type { RunAttachment } from "../../lib/agent-run-core";
import {
  agentApply,
  agentStart,
  splitForBulkApproval,
  type AgentStepResult,
  type ScopeGrant,
} from "../../lib/agent-run";
import {
  engineErrorTag,
  normalizeProviderError,
  type ProviderErrorCause,
} from "../../lib/engine-error";
import {
  approvedNewNoteIndices,
  beginAutoApply,
  beginRun,
  currentRunEpoch,
  endAutoApply,
  failRun,
  getAgent,
  landedEditIndices,
  landedNewNoteIndices,
  openRun,
  reportRunProgress,
  settleApply,
  markConversationUnread,
  settleStep,
} from "../agent/agentStore";
import { visibleHistory } from "./chatHistory";
import { setPendingAnchorFolderId, setPendingAnchorNoteId } from "./chatStore";
import { ensureConversation, settleTurnInConversation } from "./chatPersist";
import { maybeGenerateConversationTitle } from "./conversationTitle";
import {
  failAgentTurn,
  getActiveConversationId,
  getChat,
  sendAgentTurn,
  settleAgentTurn,
  type AgentTurnSummary,
} from "./chatStore";

/** The already-localized strings the run's turns render.
 *
 *  Passed in rather than resolved here: this module is not a component, and
 *  `src/AGENTS.md` bans freezing a resolved string at module scope (it would
 *  capture the boot language). The caller has a `t` in hand. */
/**
 * The sentences a FAILED leg can owe the user, resolved by the caller.
 *
 * **One mapping, because the alternative is what shipped**: the scope-approval
 * resume reported EVERY failure of the approved leg as "The scope could not be
 * widened", so a user who had just pressed Allow on the dialog was told their
 * permission had not been taken while the real cause, a provider that refused
 * the request, a leg that timed out, an engine that failed, was discarded
 * (myne-md/myne#848, on the user's report). The host already tags the failure;
 * this is the one place that turns a tag into a sentence, and both call sites
 * use it.
 */
export interface LegFailureCopy {
  /** The provider refused THIS request (HTTP 400). A fault in what Myne sent. */
  providerRejected: string;
  /** The scope resolved empty under `ai_excluded_folders`. */
  scopeExcluded: string;
  /**
   * The host refused a folder grant that canonises to the vault root
   * (`AgentError::RootGrant`): the ONE failure whose sentence is about the
   * scope at all, and the only place "the scope could not be widened" is true.
   */
  rootGrant: string;
  /** Nothing more specific is known. */
  generic: string;
  /**
   * The shared taxonomy's sentence for a cause the host NAMED inside a refusal.
   *
   * A gate refusal is a cause, not a tag: "no credential", "consent missing",
   * "not ready" all arrive as `AgentError::GateRefused { cause }`, and each of
   * those sentences names the control that fixes it. Without this arm the run
   * reported "The agent could not start.", which names nothing, sends nobody
   * anywhere, and is what a user saw for a run the host had refused for a
   * reason it had already told the WebView (myne-md/myne#848).
   *
   * A function rather than a resolved string, because the caller cannot know
   * which cause it is holding until the failure arrives.
   */
  byCause: (cause: ProviderErrorCause) => string;
}

/**
 * Which sentence a failed leg owes, from the HOST's own tag.
 *
 * The tag is the host's, so a new `AgentError` variant lands in `generic` rather
 * than being reported as whatever the last author happened to be looking at.
 */
export function legFailureSentence(
  failure: unknown,
  copy: LegFailureCopy,
): string {
  const tag = engineErrorTag(failure);
  if (tag === "RootGrant") return copy.rootGrant;
  if (tag === "EmptyGrant") return copy.scopeExcluded;
  if (tag === "ProviderRejected") return copy.providerRejected;
  // The shared taxonomy next, for the failures whose FIX it names, a gate
  // refusal above all, since the host already said which gate it was and the
  // generic sentence throws that away.
  const cause = normalizeProviderError(failure);
  if (cause !== "failed") return copy.byCause(cause);
  return copy.generic;
}

export interface AgentRunCopy {
  /** What the user turn's scope chip says: "This note", or the folder name. */
  scopeLabel: string;
  /** The sentence for a start that never landed. */
  startFailed: string;
  /** The sentence for a leg that stopped after it started. */
  legFailed: string;
  /** The sentence for a folder grant the host refused as the vault root. */
  rootGrant: string;
  /** The taxonomy's sentence for a cause the host named (see
   *  {@link LegFailureCopy.byCause}). */
  byCause: (cause: ProviderErrorCause) => string;
  /** The sentence for an automatic apply that failed outright. */
  autoApplyFailed: string;
  /** The sentence for a start the PROVIDER refused (HTTP 400).
   *
   *  Separate because the two send the user to different places, and the
   *  generic one used to be shown for both: a rejected request is a fault in
   *  what Myne sent, so telling the user to check their setup is telling them
   *  to fix something that is not broken (myne-md/myne#547). */
  providerRejected: string;
  /** The sentence for a start the HOST refused because the scope resolved
   *  empty under `ai_excluded_folders` (`AgentError::EmptyGrant`).
   *
   *  Separate for the same reason `providerRejected` is: the generic sentence
   *  names no control and no fix, while this one names the list and where it
   *  lives. Resolved by the caller through `providerErrorKey("empty_grant")`
   *  rather than a second key, so the chat turn and the mobile run-failure
   *  banner read the same sentence by construction (myne-md/myne#675). */
  scopeExcluded: string;
}

/**
 * Settle a step into the run store AND onto its transcript turn.
 *
 * Every path that settles a step goes through here. A run that stopped to ASK
 * has not settled in the sense the turn cares about: its step returned, so
 * `running` is false, but the loop is paused on a question the scope dialog is
 * putting to the user, and freezing there would print "the agent proposed no
 * changes" underneath a dialog about to make it propose some.
 *
 * The turn takes the counts AND the model's closing summary. It takes the
 *  proposal too, FROZEN: a plain-data copy of the anchors, replacements and
 *  new notes as they stood at settle time (myne-md/myne#675). The live
 *  proposal still stays in `agentStore` (which every vault-leaving path
 *  clears); the frozen copy is what history renders, read-only, after the
 *  live one is gone.
 *
 * **The summary has to come here, and that is the half one mode was missing**
 * (myne-md/myne#568). The agent answers a question through `finish`, so in one
 * mode the summary IS the answer; the only surface rendering it was the review
 * screen, so asking "how many tasks are in this note" put the answer inside a
 * "Review changes" dialog next to the words "the agent proposed no changes".
 * Ask used to write its answer into the transcript, and when Ask was removed
 * nothing took that over.
 */
export function settleRunIntoChat(result: AgentStepResult, epoch: number): void {
  // A step that landed after the vault was left is dropped by the run store,
  // and its counts must not reach the transcript either.
  if (!settleStep(result, epoch)) return;
  const agent = getAgent();
  // **A result that lands is a thing to read** (myne-md/myne#848), and the mark
  // goes in BEFORE the two early returns below, because both of them are cases
  // where the user has more reason to look, not less: a run that stopped to ask
  // for more scope is BLOCKED on them, and one with no view at all still
  // finished. Whether they are looking at it is answered by the surface that
  // displays the conversation, which clears the mark; guessing here from the
  // active id got the closed-surface case wrong.
  if (agent.runConversationId !== null) {
    markConversationUnread(agent.runConversationId);
  }
  if (agent.view === null || agent.end?.kind === "awaitingScope") return;
  const summary: AgentTurnSummary = {
    runId: agent.view.runId,
    summary: agent.proposal.summary,
    edits: agent.proposal.edits.length,
    newNotes: agent.proposal.newNotes.length,
    notesRead: agent.notesRead,
    iterations: agent.iterations,
    charsOffDevice: agent.charsOffDevice,
    memoryUpdated: agent.memoryUpdated,
    // How long the run took (myne-md/myne#848). Absent rather than zero when the
    // start was never recorded, so the footprint can say "unknown" instead of
    // claiming the run was instant.
    durationMillis:
      agent.startedAtMillis === null
        ? undefined
        : Math.max(0, Date.now() - agent.startedAtMillis),
    end: agent.end?.kind ?? "finished",
    // The frozen proposal rides the turn (myne-md/myne#675): the store copies
    // it to plain data on settle, so history keeps what the run proposed even
    // after `agentStore` drops the live copy on lock. Read-only there: the
    // review screen stays the only surface that can apply anything.
    proposal: { edits: agent.proposal.edits, newNotes: agent.proposal.newNotes },
    // The setting half of "did this run produce anything" (myne-md/myne#850,
    // from the 2026-10-14 review): without it a settings-only run reads as an
    // empty one on the strip and the hub.
    settings: agent.proposal.settings?.length ?? 0,
  };
  // **The run outlives the view, so its result goes to its own conversation**
  // (myne-md/myne#848). The live transcript is one slot; if the user navigated
  // to another conversation while this run was in flight, settling into it
  // would write a run's counts and summary onto whatever they are reading now.
  // The rule is narrower than "the ids differ", deliberately: an unbound run
  // (`null`, the persist that would have created the conversation failed) has
  // no better home than the live transcript, and refusing would drop the
  // result entirely.
  const active = getActiveConversationId();
  if (agent.runConversationId !== null && active !== agent.runConversationId) {
    void settleTurnInConversation(agent.runConversationId, summary);
    return;
  }
  settleAgentTurn(summary);
}

/**
 * Start an agent run **as a chat turn**: append the user's task (carrying the
 * scope it was sent under) plus the agent turn the run renders into, then drive
 * the first step.
 *
 * Resolves once that step settles. A run that stops to ask for more scope is a
 * settled step like any other. `AgentProgress` owns the dialog and the resume,
 * and the turn keeps rendering it, so there is no second entry point here.
 */
export async function startAgentRun(
  task: string,
  grant: ScopeGrant,
  copy: AgentRunCopy,
  /** The user's interface language, as a BCP-47 tag, or `null`.
   *
   *  A separate parameter rather than a field on `AgentRunCopy`, even though
   *  both come from the same `useTranslation()` call: that type is documented as
   *  "the already-localized strings the run's turns render", and a language tag
   *  is not one of those. Widening it would make the name false for the sake of
   *  one fewer argument. */
  language: string | null,
  /** Called with the ids of notes an automatic apply wrote, so the open pane
   *  re-reads them. Absent when the caller has nothing to tell. */
  onNotesWritten?: (noteIds: readonly string[]) => void,
  /** The note to ANCHOR the conversation to, when the run is about one note
   *  (myne-md/myne#771). The anchor is written at conversation-create time, so
   *  it must be set before the first persist; a vault-general run passes
   *  `null`. */
  anchorNoteId?: string | null,
  /** The documents this run may read, already read from the vault
   *  (myne-md/myne#913). Empty for an ordinary run. */
  attachments: readonly RunAttachment[] = [],
): Promise<void> {
  // **Captured BEFORE the turn is appended**, which is the ordering that makes
  // this the conversation so far rather than the conversation including the
  // message being sent. `sendAgentTurn` pushes the user's task and an empty
  // agent turn; seeding after it would send the task twice, once as history and
  // once as the task itself, and seed an empty assistant turn with it.
  const history = visibleHistory(getChat().turns);
  // Anchor the conversation to the note this run is about, if any, BEFORE the
  // turn is appended: the first persist creates the conversation and reads the
  // pending anchor (myne-md/myne#771).
  setPendingAnchorNoteId(anchorNoteId ?? null);
  // The OTHER anchor kind (myne-md/myne#848): a run whose scope is a folder
  // records the folder, and a run anchored to a note records the note. These
  // two are read by the create path and travel onto the catalog row, which is
  // what lets the Hub say what a conversation is about without opening it.
  setPendingAnchorFolderId(grant.kind === "folder" ? grant.value : null);
  // The turn carries the files it sent (myne-md/myne#913), so a transcript read
  // back later shows WHAT the question was about instead of only the question.
  sendAgentTurn(
    task,
    copy.scopeLabel,
    attachments
      .filter((doc) => doc.id !== undefined)
      .map((doc) => ({
        id: doc.id!,
        name: doc.name,
        contentType: doc.contentType ?? "",
      })),
  );
  // **The conversation exists from the first user message** (myne-md/myne#848),
  // and the run is bound to it before the first step is driven. The id is
  // awaited rather than read later: `beginRun` records ownership, and ownership
  // that is resolved at settle time is ownership of whatever is on screen then,
  // which is the defect this closes. `null` is the honest answer when the write
  // failed, the queue still owes it, and the settle falls back to the live
  // transcript.
  const conversationId = await ensureConversation();
  beginRun(conversationId);
  // **The title, behind the write rather than inside it** (myne-md/myne#848).
  // `chats_create` is synchronous and model-free, so the derived truncation
  // title is already in the catalog; a local model may replace it, asynchronously
  // and never through a provider (the ambient class refuses one host-side).
  // Deliberately not awaited: the run starts now, and a title is housekeeping.
  void maybeGenerateConversationTitle(conversationId, task);
  // Captured BEFORE the await, so a vault lock during the call invalidates what
  // comes back rather than being raced by it.
  const epoch = currentRunEpoch();
  try {
    const result = await agentStart(
      task,
      grant,
      language,
      history,
      // What the agent may change, resolved here and re-derived host-side
      // (myne-md/myne#850). Built at run start rather than cached: the catalogue
      // is a read of a static registry, and a run that outlived a rebuild would
      // otherwise offer a setting the current tree no longer carries.
      offeredSettingIds(),
      attachments,
      (view) => {
        // The run has an id now, minutes before this call resolves. Same epoch
        // as the settle below, so a run the user let go of mid-flight cannot
        // mount a progress strip for itself behind them.
        openRun(view, epoch);
      },
      // What the run has cost so far, once per model round-trip
      // (myne-md/myne#456). Same epoch, for the same reason and one that is
      // sharper here: the off-device figure is the compensating control
      // `design-notes/ai/0515` names for the uncapped remote arm, so a
      // stale run's report landing on a live one is a false statement about
      // how much text left the device rather than a cosmetic mix-up.
      (progress) => {
        reportRunProgress(progress, epoch);
      },
    );
    // **Raised BEFORE the step settles**, which is the ordering the flag exists
    // for: the review dialog derives its open state from a settled run, so a
    // flag set afterwards lets the screen it is meant to skip open for a few
    // frames and then close. Read from the store rather than from a parameter,
    // so the mode in force is the one at the moment the run ends.
    const auto = getAgent().autoApply;
    if (auto) beginAutoApply();
    settleRunIntoChat(result, epoch);
    if (auto) await autoApplyRun(epoch, copy, onNotesWritten);
  } catch (failure) {
    // **The same epoch check the success path gets, spelled out.** On the
    // success path it is transitive: `settleRunIntoChat` returns early when
    // `settleStep` rejects the epoch, so the transcript write never happens.
    // The failure path had no equivalent, and `failAgentTurn` writes onto
    // whatever `lastAgentIndex` finds, so run one's "the agent could not start"
    // was stamped as an error onto run two's live turn while run two was still
    // working, and `failRun` cleared the newer run's `running` with it.
    //
    // Guarded here rather than by giving `failRun` a required epoch: its other
    // two call sites are the apply and undo failures in `AgentReview`, which are
    // user-initiated after the run settled and would have to pass
    // `currentRunEpoch()`, comparing the epoch to itself. That is the shape
    // `settleStep`'s own doc warns about, so the guard belongs at the leg that
    // actually captured an epoch.
    if (epoch !== currentRunEpoch()) return;
    // Two stores, one failure, and both need it. `failRun` clears `running` and
    // records the message for a run that HAS a view; a start that never landed
    // has none, because `beginRun()` nulled it, so the progress strip does not
    // mount and `failAgentTurn` is what the user actually reads.
    // Which sentence, from the host's own tag. `AgentError` serializes with a
    // `kind` field, and the three failures a user can tell apart are "the
    // provider would not take this request", "the scope fell entirely inside
    // the excluded folders", and everything else.
    const sentence = legFailureSentence(failure, {
      ...copy,
      // The start's own generic: a leg that never landed has not "stopped", it
      // never started.
      generic: copy.startFailed,
    });
    failRun(sentence);
    failAgentTurn(sentence);
  }
}

/** Apply a finished run without a second act (myne-md/myne#551).
 *
 *  **Three bounds, and two of them are mechanisms that already existed.**
 *
 *  The scope is the one the user approved when the run started; nothing here
 *  widens it. The approval label is `"bulk"`, which is not cosmetic: the host
 *  re-derives, from the note as it will actually be, whether an edit takes the
 *  note out of the working set — `trashed:`, `deleted:`, `archived:`,
 *  `template:`, `conflict:` — and refuses one inside a bulk approval whatever
 *  the caller sent. So a removal still needs its own act, in automatic mode as
 *  in manual, and the refusals come back to be shown rather than dropped. And
 *  the mode itself is session-scoped, dropped on lock and on vault switch.
 *
 *  The proposal is read from the store rather than passed in, because
 *  `settleStep` is what put it there and the epoch guard on that call is what
 *  decides whether this run is still the one the surface is showing.
 */
async function autoApplyRun(
  epoch: number,
  copy: AgentRunCopy,
  onNotesWritten?: (noteIds: readonly string[]) => void,
): Promise<void> {
  try {
    const agent = getAgent();
    // A step the epoch guard dropped leaves no view, and a run that stopped to
    // ask has one but is not finished. Neither is a run to apply.
    if (agent.view === null || agent.end?.kind === "awaitingScope") return;
    const { bulkApprovable } = splitForBulkApproval(agent.proposal.edits);
    const newNotes = approvedNewNoteIndices(agent);
    if (bulkApprovable.length === 0 && newNotes.length === 0) return;
    // Positions in the FULL proposal, which is what `landedEditIndices` and the
    // applied-row bookkeeping are keyed on.
    const indices = bulkApprovable.map((e) => agent.proposal.edits.indexOf(e));
    // **The flush first, for the reason `AgentReview`'s manual path states**: an
    // apply is a read-patch-write over whole note blobs, and an automatic one can
    // land while the user is typing inside the default whole-vault scope.
    await flushBeforeFrontmatterWrite();
    const outcome = await agentApply(
      agent.view.runId,
      bulkApprovable,
      newNotes,
      // **Settings are deliberately absent from the automatic path**
      // (myne-md/myne#850). Automatic apply exists to skip the review screen for
      // note edits inside a grant the user already made; a setting sits inside
      // no grant, so the bound that makes the automatic path safe has nothing to
      // attach to here. A setting change therefore always goes to the review
      // screen, which is also what `apply_settings_approved`'s bulk carve-out
      // enforces host-side: this is the client half of one rule, not a second
      // rule.
      [],
      "bulk",
    );
    // The creates are passed for the same reason the edits are: this path DOES
    // send them (`agentApply` above), so a defaulted-empty argument here left a
    // created note in the actionable set on the automatic route, the defect the
    // review screen's own call site fixed, surviving on its twin.
    if (
      !settleApply(
        outcome,
        landedEditIndices(indices, outcome),
        epoch,
        [],
        landedNewNoteIndices(newNotes, outcome),
      )
    ) {
      return;
    }
    const changed = [...outcome.notesWritten, ...outcome.notesCreated];
    if (changed.length > 0) onNotesWritten?.(changed);
  } catch {
    // Same epoch check the success path gets. A failure here leaves the run in
    // the store, so the review screen still opens and the user can apply by
    // hand: an automatic apply that fails degrades to the manual path rather
    // than losing the proposal.
    if (epoch !== currentRunEpoch()) return;
    failRun(copy.autoApplyFailed);
  } finally {
    endAutoApply();
  }
}
