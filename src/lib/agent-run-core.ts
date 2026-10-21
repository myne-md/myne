// The agent plugin's IPC bindings, written ONCE for both Tauri clients
// (myne-md/myne#456).
//
// **Why a factory and not a module of top-level functions.** These bindings need
// `invoke` and `Channel`, and the one rule about those is that a tree may only
// reach them through its OWN platform seam (`scripts/check-platform-seam.mjs`,
// eight guarded roots). A shared module cannot import either, so the seam comes
// in as an argument and each client passes its own.
//
// What that buys is the thing worth protecting: the COMMAND NAMES and the
// ARGUMENT SHAPES. `plugin:agent|agent_apply` takes `approvedNewNotes` because
// handing the host the whole proposal was a real defect, and a second hand-typed
// copy of that call is a second chance to get it wrong in a way no compiler and
// no ACL guard can see (the ACL compares four Rust-side sources; the caller is
// on the other side of IPC). Ten commands, ten doc comments explaining why each
// argument exists, and one copy of all of it.
//
// This module holds NO policy, inherited verbatim from the file it came out of
// (`design-notes/ai/0462`): scope, the `ai_excluded_folders` clamp and the
// request class are decided host-side and none of them is sent from here. An
// edit that starts computing a scope in this file has moved a security control
// into the WebView, on both clients at once.
//
// What crosses this boundary is AS1-class: note titles, note bodies and the
// model's proposed replacements are the user's own plaintext. None of it is
// logged here, and none of it survives a vault lock.

import type { HistoryTurn } from "../notes/ai/chatHistory";
import type {
  AgentApplyResult,
  AgentRunView,
  AgentStepResult,
  AgentUndoResult,
  AppliedRun,
  Approval,
  GrantPreview,
  ProbeProgress,
  ProbeVerdict,
  ProposedEdit,
  ProposedSetting,
  RunProgress,
  ScopeGrant,
} from "./agent-protocol";

/** A message channel, structurally. Satisfied by `@tauri-apps/api/core`'s
 *  `Channel` as re-exported by either client's seam; declared structurally so
 *  this module names no Tauri type. */
export interface HostChannel<T> {
  onmessage: (message: T) => void;
}

/** The two host functions these bindings need, supplied by the caller's own
 *  platform seam. */
export interface AgentHost {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  Channel: new <T>() => HostChannel<T>;
}

/**
 * One document the user attached to a run (myne-md/myne#913).
 *
 * **Context, not scope.** The agent may read it; it can never write it, and it
 * carries no note id, so "the agent can see this file" cannot be mistaken for
 * "the agent can change this file". The host wraps the text as an untrusted
 * span: a document is somebody else's prose and can contain a paragraph
 * addressed to the model.
 */
export interface RunAttachment {
  /** The display name the user picked, shown in the composer and in the
   *  transcript's own scope line. */
  name: string;
  /** The extracted text, already read from the vault by the caller. */
  text: string;
}

/** Bind the agent commands to one client's seam. */
export function makeAgentRun({ invoke, Channel }: AgentHost) {
  /** Start a run. The grant is the scope the user set; the host resolves and
   *  freezes it, applies the excluded-folder clamp, and drives the loop. */
  async function agentStart(
    task: string,
    grant: ScopeGrant,
    /** The user's interface language, as a BCP-47 tag.
     *
     *  Sent because the host cannot read it: the chosen language lives in this
     *  side's `localStorage` (`src/i18n/index.ts`), not in `vault.prefs`. The host
     *  shape-checks it and drops anything that is not a tag, so this is not a
     *  channel into the system message.
     *
     *  A required parameter rather than an optional one, so a future call site
     *  cannot quietly omit it and reintroduce the English-answer defect. Pass
     *  `null` deliberately when there is genuinely no language to report. */
    language: string | null,
    /** The visible chat turns, oldest first.
     *
     *  Sent whole: the character budget is the HOST's, applied in
     *  `core/src/plugins/agent/history.rs`, because what reaches the model is
     *  policy and a caller that pre-trimmed would be deciding it. The IPC hop is
     *  in-process; the cost that matters is what crosses TB13, and that is
     *  bounded on the other side. */
    history: readonly HistoryTurn[],
    /** The settings this client offers the run (myne-md/myne#850).
     *
     *  **Ids only, never labels.** The host resolves each against its own intent
     *  table and renders the system block from the TABLE's ids, so a string this
     *  side sends never reaches the prompt; a label would be a second source of
     *  truth for the same list, and the review row already resolves its own.
     *
     *  Empty is the honest value for a client that has built no catalogue, and
     *  the host then refuses every setting change rather than accepting one into
     *  a proposal no surface could render. */
    settings: readonly string[],
    /** The documents the user attached to this run, or an empty list.
     *
     *  Sent as text rather than as attachment ids so the host never has to
     *  reach back into the vault mid-run: the read happens once, under the
     *  unlock the user already granted, and a vault that locks afterwards ends
     *  the run rather than half-reading a file. The host caps each document and
     *  the count, and tags every character of it untrusted (myne-md/myne#913). */
    attachments: readonly RunAttachment[],
    /** Called with the run's view as soon as the host has created it, which is
     *  long before this promise resolves.
     *
     *  A run's first leg used to be unaddressable: this call returns only when
     *  the loop has stopped, and its reply was the only thing that ever carried a
     *  run id, so for minutes the surface had a `running` run with no id, no
     *  scope total and no Stop (myne-md/myne#544). */
    /** Called with the run's view as soon as the host has created it, which is
     *  long before this promise resolves.
     *
     *  A run's first leg used to be unaddressable: this call returns only when
     *  the loop has stopped, and its reply was the only thing that ever carried a
     *  run id, so for minutes the surface had a `running` run with no id, no
     *  scope total and no Stop (myne-md/myne#544). */
    onOpen?: (view: AgentRunView) => void,
    /** The run's cost as it accrues, once per model round-trip
     *  (myne-md/myne#456).
     *
     *  This call returns only when the loop has STOPPED, so its reply is
     *  disclosure after the fact. `design-notes/ai/0515` rests the remote arm's
     *  lack of a volume bound on that disclosure, and a run that is cancelled:
     *  or that dies with the foreground on a phone, discloses nothing at all
     *  while having paid for every round-trip it made. */
    onProgress?: (progress: RunProgress) => void,
  ): Promise<AgentStepResult> {
    const channel = new Channel<AgentRunView>();
    if (onOpen !== undefined) channel.onmessage = onOpen;
    const progress = new Channel<RunProgress>();
    if (onProgress !== undefined) progress.onmessage = onProgress;
    return await invoke<AgentStepResult>("plugin:agent|agent_start", {
      task,
      grant,
      language,
      history,
      settings,
      attachments,
      onOpen: channel,
      onProgress: progress,
    });
  }


  /** Approve a scope expansion the model asked for, and resume.
   *
   *  The grant is resolved and frozen at this moment. A note added to the folder
   *  afterwards is not inside what the user just approved. */
  async function agentApproveScope(
    runId: string,
    grant: ScopeGrant,
    /** Same channel as `agentStart`'s, for the same reason. Without it the
     *  figures would freeze the moment a run asked to widen its scope, which is
     *  exactly when a user most wants to see them moving. */
    onProgress?: (progress: RunProgress) => void,
  ): Promise<AgentStepResult> {
    const progress = new Channel<RunProgress>();
    if (onProgress !== undefined) progress.onmessage = onProgress;
    return await invoke<AgentStepResult>("plugin:agent|agent_approve_scope", {
      runId,
      grant,
      onProgress: progress,
    });
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
  async function agentPreviewGrant(
    grant: ScopeGrant,
    runId?: string,
  ): Promise<GrantPreview> {
    return await invoke<GrantPreview>("plugin:agent|agent_preview_grant", {
      runId: runId ?? null,
      grant,
    });
  }

  /** Cancel a run. The same flag the vault-lock teardown sets. */
  async function agentCancel(runId: string): Promise<boolean> {
    return await invoke<boolean>("plugin:agent|agent_cancel", { runId });
  }


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
  async function agentApply(
    runId: string,
    approved: ProposedEdit[],
    approvedNewNotes: number[],
    /** The setting changes the user approved (myne-md/myne#850). A selection like
     *  `approvedNewNotes`, and for the same reason: a setting write is a write,
     *  so it needs its own approval. Sent as the proposed pairs rather than as
     *  indices because the host re-derives both the writability and the value's
     *  shape at the write, so an index would buy nothing it does not already
     *  do. */
    approvedSettings: ProposedSetting[],
    approval: Approval,
  ): Promise<AgentApplyResult> {
    return await invoke<AgentApplyResult>("plugin:agent|agent_apply", {
      runId,
      approved,
      approvedNewNotes,
      approvedSettings,
      approval,
    });
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
  async function agentUndo(runId: string): Promise<AgentUndoResult> {
    return await invoke<AgentUndoResult>("plugin:agent|agent_undo", { runId });
  }

  /** The run the user could still undo, or null.
   *
   *  Read on mount rather than remembered, so the affordance survives the review
   *  screen being closed and dies with the vault lock that clears the host's copy. */
  async function agentLastRun(): Promise<AppliedRun | null> {
    return await invoke<AppliedRun | null>("plugin:agent|agent_last_run");
  }


  /** Whether the configured backend can hold the anchored edit format.
   *
   *  `onAttempt` is called before each request goes out. This call was measured at
   *  40 seconds on a remote provider, and until it reported progress the surface
   *  showed one unchanging label for the whole of it, which reads as a hang. */
  async function agentCapability(
    onAttempt?: (progress: ProbeProgress) => void,
  ): Promise<ProbeVerdict> {
    const channel = new Channel<ProbeProgress>();
    if (onAttempt !== undefined) channel.onmessage = onAttempt;
    return await invoke<ProbeVerdict>("plugin:agent|agent_capability", {
      onAttempt: channel,
    });
  }

  return {
    agentStart,
    agentApproveScope,
    agentPreviewGrant,
    agentCancel,
    agentApply,
    agentUndo,
    agentLastRun,
    agentCapability,
  };
}
