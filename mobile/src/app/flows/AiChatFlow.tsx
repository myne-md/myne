// The mobile AI destination (myne-md/myne#457, myne-md/myne#456).
//
// **One composer and one mode.** There is no Ask/Edit control, because there is
// no Ask: `docs/decisions/ai/0524` collapsed the two into one, so every message
// starts an agent run and a question is answered by the run's finish summary.
// A mode switch here would be offering a choice the host does not have.
//
// **The run state is NOT this component's.** It lives in `@myne/agent-store`,
// which is module-scope and shared verbatim with desktop: the epoch guards, the
// leg-base accumulation and the rejection sets are rules, and a second copy of
// a rule is a second version of it. That the store outlives every unmount is
// what makes the lock teardown necessary rather than optional, a proposal
// holds anchors and replacements copied out of note bodies, so leaving this
// screen must not be what clears it and locking the vault must
// (`clearAgentForLock`, wired in task 14).
//
// **What this file owns is the surface**: the text field, the Send and Stop
// controls, and the reading of the store. Every refusal, every scope
// arithmetic and the excluded-folder clamp are host-side and none of them is
// computed here, the rule `docs/decisions/ai/0462` states, inherited through
// the shared bindings.
//
// The scope is the vault by folder-less default at this stage: task 11 adds the
// approval and expansion surface, and task 12 the review screen. Until those
// land a finished run's proposal is reported and not applied, which is the
// honest intermediate state rather than a silent write.

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@myne/i18n";

import { providerLabelOf } from "@myne/copy";
import { normalizeProviderError, providerErrorKey } from "@myne/engine-error";
import type { ProviderErrorCause } from "@myne/engine-error";
import { RunCostLine } from "@myne/run-cost-line";
import {
  beginRun,
  currentRunEpoch,
  failRun,
  openRun,
  clearAgent,
  reportRunProgress,
  resumeRun,
  settleStep,
  useAgent,
  getAgent,
  setProbeVerdict,
} from "@myne/agent-store";
import { scopeKey } from "@myne/agent-protocol";
import type { GrantPreview, ProbeVerdict, ScopeGrant } from "@myne/agent-protocol";
import { lineDiff } from "@myne/dialect";
import { undoResultText, useUndoLastRun } from "@myne/undo-last-run";

import {
  agentApproveScope,
  agentCancel,
  agentCapability,
  agentLastRun,
  agentPreviewGrant,
  agentStart,
  agentUndo,
} from "../../lib/agent-run";
import { chatsList, chatsRead } from "../../lib/chats";
import {
  flushPendingTranscript,
  isChatHistoryLagging,
  newestConversation,
  newTurnId,
  parseTranscript,
  stageTranscript,
  subscribeChatHistoryHealth,
  toHistorySeed,
  type AgentSummaryJson,
  type ChatTurnJson,
} from "../../lib/chatHistory";
import { AiHistorySheet } from "./AiHistorySheet";
import { MemorySheet } from "./MemorySheet";
import { usePrefs } from "../../lib/use-prefs";
// This client's own nonce, passed into the shared undo hook below.
import { bumpPrefsNonce } from "../../lib/prefsNonce";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { ScreenScroll } from "../../components/layout";
import { Sheet } from "../../components/misc";
import { AiReviewFlow, DiffLineView } from "./AiReviewFlow";
import { AiScopeSheet, type ProviderArm } from "./AiScopeSheet";

/** A settled turn's frozen proposal, as the transcript carries it. */
type FrozenProposal = NonNullable<AgentSummaryJson["proposal"]>;

/** The proposal a turn carries, or null when it has nothing to show. Kept out
 *  of the render body so the non-null narrowing survives to the click handler. */
function proposalOf(s: AgentSummaryJson | undefined): FrozenProposal | null {
  if (s?.proposal === undefined) return null;
  return s.proposal.edits.length > 0 || s.proposal.newNotes.length > 0
    ? s.proposal
    : null;
}

const COMPOSER_BAR: CSSProperties = {
  flex: "none",
  display: "flex",
  gap: "var(--space-2)",
  alignItems: "flex-end",
  padding: "var(--space-2) var(--space-3) calc(var(--space-2) + env(safe-area-inset-bottom, 0px))",
  borderTop: "1px solid var(--line-1)",
  background: "var(--bg-1)",
};

const INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  resize: "none",
  // Single-line height matches the Send button's 52 (`Button` primary
  // geometry) so the pair reads as one bar: border-box keeps padding and
  // the hairline inside the 52 whatever the theme sets them to.
  boxSizing: "border-box",
  minHeight: 52,
  // **Five lines, and then it scrolls** (myne-md/myne#848), the same rule as the
  // desktop composer. Written as `5 × leading × 1em` rather than as a px ceiling
  // because the leading here is the `--leading-normal` token (1.5), not the
  // desktop's literal 1.4, a number copied across would be five lines on one
  // client and four and a half on the other, and nothing would say so.
  maxHeight: "calc(5 * var(--leading-normal) * 1em)",
  padding: "var(--space-2)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-1)",
  background: "var(--bg-2)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
};

const BODY_TEXT: CSSProperties = {
  margin: "var(--space-2) 0 0",
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-1)",
};

const MUTED: CSSProperties = {
  ...BODY_TEXT,
  color: "var(--fg-3)",
};

/** A compact icon affordance on a settled turn's header row. Sized to the
 *  platform touch minimum (44px), not the icon's 14px box: at 28px it was the
 *  smallest interactive control on the screen. */
const TURN_ICON_BUTTON: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "var(--m-touch)",
  height: "var(--m-touch)",
  padding: 0,
  border: 0,
  borderRadius: "var(--radius-1)",
  background: "transparent",
  color: "var(--fg-3)",
  cursor: "pointer",
};

/** A sheet's own header: title left, dismiss right. */
const SHEET_HEADER: CSSProperties = {
  flex: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
  paddingBottom: "var(--space-2)",
};

const SHEET_TITLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
};

/** A small muted caption above a diff block. */
const CAPTION: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

const SCOPE_STRIP: CSSProperties = {
  flex: "none",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-2) var(--space-3)",
  borderTop: "1px solid var(--line-1)",
  background: "var(--bg-2)",
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
};

const COST: CSSProperties = {
  display: "block",
  marginTop: "var(--space-1)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

// Slim icon toolbar above the composer: history, memory, new chat. It used
// to be a text-button row at the top of the screen, far from where it acts.
const TOOLBAR: CSSProperties = {
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "var(--space-1) var(--space-3)",
  borderTop: "1px solid var(--line-1)",
  background: "var(--bg-1)",
};

/** One toolbar icon button: ghost, content-sized, 44px tall. */
const TOOLBAR_BUTTON_STYLE: CSSProperties = {
  padding: "0 var(--space-2)",
  height: 44,
};

// Chat bubbles, the desktop language: user right on bg-2, assistant left on
// paper-2. Plain full-width paragraphs made who-said-what hard to scan.
const BUBBLE_BASE: CSSProperties = {
  maxWidth: "92%",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-2) var(--space-3)",
};

const BUBBLE_USER: CSSProperties = {
  ...BUBBLE_BASE,
  alignSelf: "flex-end",
  background: "var(--bg-2)",
};

const BUBBLE_ASSISTANT: CSSProperties = {
  ...BUBBLE_BASE,
  alignSelf: "flex-start",
  background: "var(--paper-2)",
};

export function AiChatFlow({
  /** The scope every message runs under: the open note, or `null` when there
   *  is none. NOT a vault-wide fallback, because the host REFUSES one. See
   *  `defaultGrantFor` in `@myne/agent-protocol` for why. */
  grant,
  titleOf,
  bodyOf,
  onNotesWritten,
}: {
  grant: ScopeGrant | null;
  /** Resolve a note's title, for the review list. The proposal carries ids. */
  titleOf: (noteId: string) => string | null;
  /** Read a note's current body, for the review's diff. */
  bodyOf: (noteId: string) => string | null;
  onNotesWritten?: (noteIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const agent = useAgent();
  // The last-run undo lives here rather than in a strip under the composer
  // (myne-md/myne#741): one mount for the screen, with the offer and the report
  // matched onto settled turns by `runId`.
  const undo = useUndoLastRun({
    agentLastRun,
    agentUndo,
    // **This client's own nonce module**, not the desktop one the hook used to
    // import: see `UndoBindings::bumpPrefsNonce`.
    bumpPrefsNonce,
    ...(onNotesWritten === undefined
      ? {}
      : { onReverted: (ids: readonly string[]) => onNotesWritten([...ids]) }),
  });
  // The settled turn whose frozen proposal the diff sheet shows, and the run
  // whose revert is awaiting confirmation.
  const [diffProposal, setDiffProposal] = useState<FrozenProposal | null>(null);
  const [revertConfirmRunId, setRevertConfirmRunId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // The task the run in flight was started with, so the surface can show what
  // was asked while the answer is still coming. Not in the store: the store is
  // the RUN's state and this is the composer's memory of its own send.
  const [asked, setAsked] = useState<string | null>(null);
  const { prefs } = usePrefs();
  // What the scope the user is about to send actually covers, resolved by the
  // host. `null` when the call has not landed or failed.
  const [preview, setPreview] = useState<GrantPreview | null>(null);
  // The scope the model has asked to widen into, previewed the same way.
  const [expansion, setExpansion] = useState<GrantPreview | null>(null);
  // In flight only. The VERDICT is session state and lives in the run store, so
  // a remount does not pay for it twice and the lock teardown drops it.
  const [probing, setProbing] = useState(false);
  // The persisted conversation layer (myne-md/myne#675). `activeId` is the
  // conversation new turns append to (`null` = the next send creates);
  // `openTurns` is its transcript for display. Both are component state by
  // the same rule that keeps turns out of a module store on this client
  // (myne-md/myne#617), and the CONTINUATION behind them is derived, not
  // stored: mount opens the most-recently-updated conversation (the desktop
  // Task 8 definition), so there is no pointer state to sync, lose, or
  // disagree about.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openTurns, setOpenTurns] = useState<ChatTurnJson[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [memorySheetOpen, setMemorySheetOpen] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  // Persist health (myne-md/myne#675 review): a failed flush keeps the write
  // staged and raises this until a flush lands, so "shown but unsaved" never
  // looks exactly like saved.
  const [historyLagging, setHistoryLagging] = useState(isChatHistoryLagging());
  useEffect(
    () => subscribeChatHistoryHealth(() => setHistoryLagging(isChatHistoryLagging())),
    [],
  );

  // Continue-last, derived: mount lists the roster and opens the newest
  // conversation, so a returning user lands where they left off with no
  // stored pointer. A vault with no readable conversation is a fresh tab,
  // not an error surface. A send that settles inside the fetch window wins
  // over the hydrate (the desktop `hydrateActiveConversation` guards, same
  // rule): the functional updates below keep user-typed turns and their
  // binding over the fetched ones.
  useEffect(() => {
    let live = true;
    void chatsList()
      .then((rows) => {
        if (!live) return;
        const newest = newestConversation(rows);
        if (newest === null) return;
        return chatsRead(newest.id)
          .then((payload) => {
            if (!live) return;
            const turns = parseTranscript(payload);
            // A file that decrypts but does not parse is an unreadable
            // store, not an empty one: surface it like the explicit-open
            // arm does rather than rendering a fresh tab.
            if (turns === null) {
              if (live) setHistoryError(true);
              return;
            }
            setOpenTurns((cur) => (cur.length > 0 ? cur : turns));
            setActiveId((cur) => (cur ?? newest.id));
          })
          .catch(() => {
            if (live) setHistoryError(true);
          });
      })
      .catch(() => {
        if (live) setHistoryError(true);
      });
    return () => {
      live = false;
    };
  }, []);
  // **The arm is read from the prefs, not probed.** A probe is a third-party
  // request (TB13), and this line renders before the user has asked for
  // anything, so probing here would make opening a tab an act of egress.
  const provider = prefs.ai_provider;
  const arm: ProviderArm =
    provider === null || provider === "" ? "none" : "remote";
  const providerName = provider === null ? undefined : (providerLabelOf(provider) ?? provider);

  // **The disclosure BEFORE the first tool call.** The host resolves the grant
  // with the same code the run will use, so the number on screen is the number
  // the run will honour: computing it here would leave out the excluded-folder
  // clamp and would add rather than union, and the user would be approving
  // against a figure wrong in two directions.
  //
  // A preview, never a reservation: the set is resolved again when the run
  // starts, and the frozen set is that one.
  useEffect(() => {
    let live = true;
    setPreview(null);
    // Nothing to preview, and nothing to ask the host about. Skipping is not an
    // optimisation: the host REFUSES a root grant, so the call would spend a
    // round-trip to be told what this branch already knows.
    if (grant === null) return;
    void agentPreviewGrant(grant)
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch(() => {
        // Left null. The strip renders "could not be checked" rather than a
        // zero, because a zero is a claim and this is the absence of one.
        if (live) setPreview(null);
      });
    return () => {
      live = false;
    };
    // **Keyed on a STABLE string, not on the grant's fields.** `grant.value` is
    // a fresh array for the `notes` case, so every parent render re-fired this
    // effect: another `agent_preview_grant` round-trip, and the scope figure
    // blanking to "could not be checked" in between.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey(grant)]);

  // The expansion's numbers, fetched against the RUN so the total is the run's
  // new total rather than the folder's own size.
  const awaiting = agent.end?.kind === "awaitingScope" ? agent.end : null;
  const runId = agent.view?.runId ?? null;
  useEffect(() => {
    if (awaiting === null || runId === null) {
      setExpansion(null);
      return;
    }
    let live = true;
    void agentPreviewGrant({ kind: "folder", value: awaiting.folder }, runId)
      .then((p) => {
        if (live) setExpansion(p);
      })
      .catch(() => {
        if (live) setExpansion(null);
      });
    return () => {
      live = false;
    };
  }, [awaiting?.folder, runId]);

  /** The refusals that mean "this device is not configured to send", as opposed
 *  to "this model cannot hold the edit format".
 *
 *  Exactly the arms of `authorize_remote` plus the missing-model one, which is
 *  the same class from the user's side: something to change in settings, on a
 *  screen that exists, rather than a property of the backend. Anything else the
 *  probe can fail with is a transport or provider fault and belongs to the
 *  `failed` verdict. */
const GATE_REFUSALS: ReadonlySet<ProviderErrorCause> = new Set([
  "feature_off",
  "consent_missing",
  "no_credential",
  "not_ready",
  "barred",
]);

/** Whether the configured backend can hold the anchored edit format.
   *
   * **Fails CLOSED, and asks at most once per session.** The desktop twin's
   * module note carries the full argument for why the verdict lives in the run
   * store rather than in component state; the reason this client needs the gate
   * at all is narrower and was a real defect: without it agent mode was offered
   * on every backend, which is exactly the myne-md/myne#529 shape
   * `core/src/plugins/agent/edit.rs` and `probe.rs` BOTH name as the reason the
   * anchored format may refuse a near-miss rather than fuzzy-match it. Two
   * module docs were false on this client and every check was green.
   *
   * **On SEND, never on render.** A probe is a third-party request (TB13), so
   * firing it when the tab opens would make opening a tab an act of egress. The
   * user asking for a run is the consent this call rides on.
   *
   * Read through the store rather than this render's snapshot: a remount, or
   * the tab being reopened, may have paid for the answer already, and on a
   * remote provider re-probing costs `threshold.attempts` requests. */
  const ensureCapability = useCallback(async (): Promise<ProbeVerdict | null> => {
    const known = getAgent().probeVerdict;
    if (typeof known === "object" && known !== null) return known;
    setProbing(true);
    try {
      const v = await agentCapability();
      setProbeVerdict(v);
      return v;
    } catch (e) {
      // **A GATE refusal is not a failed probe, and collapsing the two is the
      // defect this arm exists to stop.** The probe reaches the provider, so it
      // passes through `authorize_remote` first: on a device that inherited the
      // provider and the key but has not consented LOCALLY, the probe is the
      // thing that gets refused, and reporting that as "we could not check your
      // model" names no fix while the fix is one tap away. It also undoes the
      // separation the error taxonomy was built for, where a missing key and a
      // missing consent are deliberately never merged.
      //
      // So a refusal the taxonomy recognizes is surfaced with ITS OWN message
      // and leaves the verdict UNASKED, which is what lets the user fix the
      // configuration and send again. Only an unclassifiable failure sets
      // `failed`, and that one fails closed: an unanswerable probe is not
      // evidence that the backend CAN hold the format.
      const cause = normalizeProviderError(e);
      if (GATE_REFUSALS.has(cause)) {
        failRun(t(providerErrorKey(cause)));
        return null;
      }
      setProbeVerdict("failed");
      return null;
    } finally {
      setProbing(false);
    }
  }, [t]);

  /** The settled run as a transcript turn: empty text with the summary and
   *  counts on `agentSummary` (the desktop turn shape), the proposal frozen
   *  to plain data so later mutations of the live run cannot rewrite history
   *  (the Task 9 discipline, mirrored here rather than imported: the chat
   *  store is not a `@myne/*` alias). */
  function assistantTurnFromAgent(): ChatTurnJson {
    const a = getAgent();
    return {
      id: newTurnId(),
      kind: "agent",
      role: "assistant",
      text: "",
      agentSummary: {
        runId: a.view?.runId ?? "",
        summary: a.proposal.summary,
        edits: a.proposal.edits.length,
        newNotes: a.proposal.newNotes.length,
        notesRead: a.notesRead,
        iterations: a.iterations,
        charsOffDevice: a.charsOffDevice,
        // The turn-end memory marker (myne-md/myne#697): the count comes
        // from the host store, never from a model claim.
        memoryUpdated: a.memoryUpdated ?? 0,
        end: a.end?.kind ?? "finished",
      proposal: JSON.parse(
        JSON.stringify({ edits: a.proposal.edits, newNotes: a.proposal.newNotes }),
      ) as {
        edits: { noteId: string; anchor: string; replacement: string }[];
        newNotes: { title: string; body: string; folder: string | null }[];
      },
      },
    };
  }

  /** Append a settled pair to the open transcript and persist it (create on
   *  first write). The whole transcript is the write unit: appends are
   *  state writes, not deltas, so the display update and the staged payload
   *  are built from the same array. */
  async function persistPair(pair: [ChatTurnJson, ChatTurnJson]): Promise<void> {
    const next = [...openTurns, ...pair];
    setOpenTurns(next);
    stageTranscript(activeId, next);
    const id = await flushPendingTranscript();
    // A null activeId that now has an id means the create landed: bind it so
    // the next send appends. Any other outcome keeps the current binding:
    // a failed append stays staged for the next flush rather than rebinding.
    if (activeId === null && id !== null) setActiveId(id);
  }

  const send = useCallback(async () => {
    const task = draft.trim();
    if (task.length === 0 || agent.running || grant === null) return;
    const verdict = await ensureCapability();
    // **The draft is cleared AFTER the gate, not before.** The refusal is
    // rendered by the notice below, and a user who switches provider and sends
    // again must not have to retype what they wrote.
    if (verdict === null || !verdict.passed) return;
    setDraft("");
    setAsked(task);
    // **`null`, deliberately** (myne-md/myne#848). The shared run store records
    // which conversation a run belongs to so a settle can land in the right one
    // after the user navigates away; this flow does not bind a conversation at
    // send time (mobile's transcript is its own module, not the shared
    // `chatStore`), and `null` is the documented value for "there is no
    // conversation to bind". It is NOT the same as an empty string: the store's
    // settle path reads it to decide whether to fall back to the live transcript,
    // which is exactly what this client wants.
    beginRun(null);
    // Captured BEFORE the await, which is the whole contract of the epoch: a
    // reply that lands after the user locked the vault, switched vault or
    // started another run must be dropped rather than repopulate the store.
    const epoch = currentRunEpoch();
    try {
      const result = await agentStart(
        task,
        grant,
        // The interface language, which the host cannot read for itself: the
        // choice lives in this side's storage rather than in `vault.prefs`
        // (myne-md/myne#618). Required rather than optional so a call site
        // cannot quietly omit it and put the model back on English answers.
        i18n.language ?? null,
        // The open conversation, when there is one: prior turns seed the run
        // the way the desktop's `visibleHistory` seeds its own. Empty when no
        // conversation is open (a run with no prior turns to refer to).
        toHistorySeed(openTurns),
        // **No settings offered, because this client renders no setting row**
        // (myne-md/myne#850). Mobile's review flow has no settings surface yet,
        // so offering the catalogue would let the model propose a change this
        // screen cannot show, approve or undo, and the host would accept it into
        // a proposal with no route to review it. `[]` is the value the parameter
        // documents for exactly that case: the host refuses every `set_setting`
        // with "that setting is not one you were offered in this session", which
        // keeps the verb inert rather than half-wired. The day a setting row
        // lands in `AiReviewFlow`, this becomes `offeredSettingIds()`.
        [],
        // The run becomes addressable here, long before the promise resolves.
        // Without it Stop has no id for the whole first leg.
        (view) => void openRun(view, epoch),
        // The live half of the cost disclosure. `agentStart` returns only when
        // the loop has STOPPED, so its reply is disclosure after the fact, and
        // a run cancelled: or killed with the foreground, which on a phone is
        // the ordinary case rather than the exotic one: would otherwise
        // disclose nothing at all while having paid for every round-trip.
        (progress) => void reportRunProgress(progress, epoch),
      );
      settleStep(result, epoch);
      // Persist the settled pair (myne-md/myne#675): the user turn plus the
      // assistant turn as the transcript will show them. Staged then flushed
      // in the same tick, so a backgrounding between staging and writing
      // still reaches the vault through `flushChatHistoryNow`: a run lost
      // to the pocket keeps its settled turns. The question moves into the
      // transcript with the pair, so `asked` clears rather than echoing it
      // twice.
      await persistPair([
        { id: newTurnId(), kind: "text", role: "user", text: task },
        assistantTurnFromAgent(),
      ]);
      setAsked(null);
    } catch (e) {
      // **The cause, named, rather than one sentence for everything.** The gate
      // refuses in four distinct ways and the network fails in several more,
      // and each has a different fix in a different place. Collapsed, the user
      // reads "that did not work" and has nowhere to go.
      //
      // Two of the four are deliberately never merged: `no_credential` means
      // there is nothing to send, `consent_missing` means you have not agreed
      // to send it. They were ONE Rust variant until this issue, which is how a
      // user who had never seen the consent screen was told "this kind of
      // request never goes to a provider".
      //
      // Nothing about the task is in the message. The task is the user's own
      // words, and the taxonomy is content-free by construction: a variant tag,
      // never a prompt, a note body or a provider's response.
      const sentence = t(providerErrorKey(normalizeProviderError(e)));
      failRun(sentence);
      // A failed send is a turn too (the desktop error-turn discipline): the
      // question and the refusal persist together, so history shows what was
      // asked and why nothing came back.
      await persistPair([
        { id: newTurnId(), kind: "text", role: "user", text: task },
        { id: newTurnId(), kind: "agent", role: "assistant", text: sentence, error: true },
      ]);
      setAsked(null);
    }
  }, [draft, agent.running, grant, t, ensureCapability, openTurns, activeId]);

  const stop = useCallback(() => {
    // The id may genuinely be null: the window between `beginRun()` and the
    // host's first message is real, and a start that failed outright never has
    // a view at all.
    if (agent.view !== null) void agentCancel(agent.view.runId);
  }, [agent.view]);

  // The summary is on the PROPOSAL, not on the end. `LoopEnd` says why the loop
  // stopped; `Proposal.summary` is the model's own words, which in one mode is
  // the answer to a question. Gated on the run having finished so a summary
  // from a previous message is not shown under the next one still running.
  const answered = agent.end !== null && !agent.running;
  const summary = answered ? agent.proposal.summary.trim() : "";

  // A run with something to review. `awaitingScope` is deliberately excluded:
  // a run that stopped to ask has not finished making its proposal, and opening
  // a review over the scope sheet would show a verdict on work in progress
  // while burying the question the run is waiting on.
  /** Before the first probe there is no verdict, so the send is offered and the
   *  check happens on Send. After one, it gates. */
  const probeVerdict = agent.probeVerdict;
  const refused =
    probeVerdict === "failed" ||
    (typeof probeVerdict === "object" && probeVerdict !== null && !probeVerdict.passed);

  const reviewable =
    answered &&
    agent.end?.kind !== "awaitingScope" &&
    (agent.proposal.edits.length > 0 || agent.proposal.newNotes.length > 0);

  // The host record's offer must stay reachable even when no open turn hosts it
  // (New chat, a switched conversation), because the record is host-side and
  // outlives the review screen. The turn icon is the primary surface; this
  // drives the fallback in the toolbar.
  const undoRunId = undo.run?.runId ?? null;
  const undoHosted =
    undoRunId !== null &&
    openTurns.some((turn) => turn.agentSummary?.runId === undoRunId);

  return (
    <>
      <ScreenScroll>
        <div
          data-testid="ai.chat"
          style={{
            padding: "var(--space-3)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
          }}
        >
          {/* The open conversation's settled turns, read-only and oldest-first.
              The live run below is the present; this is the past. Assistant
              turns show the run's own closing summary (the answer in one
              mode), never the proposal: applying is a live-session flow
              through the review screen, here as on desktop. */}
          {openTurns.map((turn) => {
            const s = turn.agentSummary;
            const proposal = proposalOf(s);
            const runId = s?.runId ?? null;
            const undoRun = undo.run;
            // The revert affordance is only for the host's CURRENT undoable
            // run: an older turn's run has been superseded and a second undo
            // would report `noSuchRun`.
            const canRevert =
              runId !== null && undoRun !== null && runId === undoRun.runId;
            const undoReport =
              runId !== null && undo.report !== null && runId === undo.reportRunId
                ? undo.report
                : null;
            return (
              <div
                key={turn.id}
                data-testid="ai.history-turn"
                data-role={turn.role}
                data-kind={turn.kind}
                style={turn.role === "user" ? BUBBLE_USER : BUBBLE_ASSISTANT}
              >
                {turn.role === "user" ? (
                  <p style={{ ...BODY_TEXT, margin: 0 }}>{turn.text}</p>
                ) : (
                  <>
                    {proposal !== null || canRevert ? (
                      <div
                        style={{
                          display: "flex",
                          gap: "var(--space-1)",
                          justifyContent: "flex-end",
                          marginBottom: "var(--space-1)",
                        }}
                      >
                        {proposal !== null ? (
                          <button
                            type="button"
                            data-testid="ai.turn-diff"
                            aria-label={t("editor.chrome.rightPanel.aiChat.viewDiff")}
                            title={t("editor.chrome.rightPanel.aiChat.viewDiff")}
                            onClick={() => setDiffProposal(proposal)}
                            style={TURN_ICON_BUTTON}
                          >
                            <Icon name="columns-2" size={14} />
                          </button>
                        ) : null}
                        {canRevert && runId !== null ? (
                          <button
                            type="button"
                            data-testid="ai.turn-revert"
                            aria-label={t("editor.chrome.rightPanel.aiChat.revertRun")}
                            title={t("editor.chrome.rightPanel.aiChat.revertRun")}
                            disabled={undo.busy}
                            onClick={() => setRevertConfirmRunId(runId)}
                            style={{
                              ...TURN_ICON_BUTTON,
                              ...(undo.busy
                                ? { opacity: 0.5, cursor: "not-allowed" }
                                : null),
                            }}
                          >
                            <Icon name="rotate-ccw" size={14} />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    <p style={{ ...BODY_TEXT, margin: 0 }}>
                      {s !== undefined && s.summary.length > 0 ? s.summary : turn.text}
                    </p>
                    {undoReport !== null ? (
                      <p data-testid="ai.undo-result" style={MUTED}>
                        {undoResultText(undoReport, t)}
                      </p>
                    ) : null}
                  </>
                )}
                {(turn.agentSummary?.memoryUpdated ?? 0) > 0 ? (
                  <p data-testid="ai.memory-updated" style={MUTED}>
                    {t("editor.chrome.rightPanel.aiChat.agentTurn.memoryUpdated", {
                      count: turn.agentSummary?.memoryUpdated ?? 0,
                    })}
                  </p>
                ) : null}
              </div>
            );
          })}
          {historyError ? (
            <p data-testid="ai.history-error" style={MUTED}>
              {t("editor.chrome.rightPanel.aiChat.historyError")}
            </p>
          ) : null}
          {historyLagging ? (
            <p data-testid="ai.persist-warning" style={MUTED}>
              {t("editor.chrome.rightPanel.aiChat.persistWarning")}
            </p>
          ) : null}
          {/* **The empty state, which the tab had none of.** Opening a
              destination and finding a blank area above a text box reads as a
              screen that failed to load, not as one waiting for you. Desktop's
              chat tab has carried this line since it shipped and mobile
              reuses the key rather than inventing a second sentence for the
              same moment.

              Found by the flow scenario: the container rendered with zero
              height, so `ai.chat` was in the DOM and invisible, and no unit
              test can see that because jsdom computes no layout. */}
          {/* Derived from the RUN, not from `asked`. `asked` is component state
              and the answer lives in a module-scope store, so leaving the tab
              and coming back rendered "nothing here yet" above the previous
              answer, with the question it belongs to gone. Suppressed once the
              transcript holds turns: the question lives there now. */}
          {agent.end === null &&
            !agent.running &&
            agent.error === null &&
            agent.iterations === 0 &&
            openTurns.length === 0 && (
              <p data-testid="ai.chat-empty" style={MUTED}>
                {t("editor.chrome.rightPanel.aiChat.empty")}
              </p>
            )}

          {asked !== null && (
            // The user's own words, echoed so the answer below has something to
            // be an answer to.
            <div data-testid="ai.chat-asked" style={BUBBLE_USER}>
              <p style={{ ...BODY_TEXT, margin: 0 }}>{asked}</p>
            </div>
          )}

          {agent.running && (
            <p data-testid="ai.agent-working" style={MUTED}>
              {t("agent.progress.working")}
            </p>
          )}

          {/* The model's own answer. Not `t()`-wrapped: it is model output, not
              copy. In one mode a question is a run like any other, so the
              summary IS the reply the user asked for rather than a caption over
              a diff. Presented as the model's claim: note content can steer
              it. */}
          {summary.length > 0 && (
            <div data-testid="ai.agent-answer" style={BUBBLE_ASSISTANT}>
              <p style={{ ...BODY_TEXT, margin: 0 }}>{summary}</p>
            </div>
          )}

          {agent.error !== null && (
            <p role="alert" data-testid="ai.turn-error" style={MUTED}>
              {agent.error}
            </p>
          )}

          {/* **Rendered while the run is in flight, not only after it.** That is
              the whole of what task 5 added on the desktop side and the reason
              the host reports per round-trip at all: the figure this line
              carries is the compensating control for the remote arm having no
              volume bound, and a control that only appears once the spending
              has stopped is disclosure after the fact. Shown whenever a run has
              begun, so a cancelled run still says what it cost. */}
          {(agent.running || answered || agent.iterations > 0) && (
            <RunCostLine
              testId="ai.run-cost"
              iterations={agent.iterations}
              notesRead={agent.notesRead}
              charsOffDevice={agent.charsOffDevice}
              style={COST}
            />
          )}
        </div>
      </ScreenScroll>

      {/* **The scope and what approving it discloses, on the same screen as the
          button that sends it.** `docs/decisions/ai/0528`: the run opens with
          its scope and the disclosure figure counts. On a phone "the same
          screen" is the load-bearing half, because a figure one tap away is a
          figure nobody read. */}
      <div data-testid="ai.scope-strip" style={SCOPE_STRIP}>
        <span data-testid="ai.scope-label">
          {t("agent.composer.scopeLabel")}{" "}
          {grant === null
            ? t("agent.composer.scopeNone")
            : preview === null
              ? t("agent.composer.scopeCountUnavailable")
              : t("agent.composer.scopeCount", { count: preview.newTotal })}
        </span>
        {/* Stated even at zero: an absent line would have to be read as "no
            exclusions" or as "we did not check", and those are different. */}
        {preview !== null && (
          <span data-testid="ai.scope-excluded">
            {t("agent.scope.excluded", { count: preview.excludedCount })}
          </span>
        )}
        {/* The egress fact, before the first tool call rather than after it. A
            run ships the note-id and title roster of its approved scope before
            it has read anything (docs/threat-model.md TB13, 2026-08-16
            amendment), so "these leave the device" is true from the first
            round-trip and has to be readable before the send, not after. */}
        {arm === "remote" && (
          <span data-testid="ai.scope-egress">
            {t("agent.scope.egressRemote", { provider: providerName ?? "" })}
          </span>
        )}
      </div>

      {/* **The one place a user finds out agent mode is unavailable on the model
          they chose.** Two different failures get two different sentences: a
          verdict that came back failing MEASURED the model, while an
          unanswerable probe measured nothing, and telling that user their model
          is incapable is a diagnosis the inputs cannot support (their provider
          may simply have been unreachable for a moment). */}
      {refused && (
        <p data-testid="ai.composer-unsupported" style={MUTED}>
          {probeVerdict === "failed"
            ? t("agent.composer.unchecked")
            : t("agent.composer.unsupported")}
        </p>
      )}

      {/* History / memory / new chat, where they act: directly above the
          composer rather than a screen away at the top. Slim icon row, the
          labels kept as accessible names. */}
      <div style={TOOLBAR}>
        <Button
          variant="ghost"
          full={false}
          data-testid="ai.history-button"
          aria-label={t("editor.chrome.rightPanel.aiChat.historyTitle")}
          onClick={() => setSheetOpen(true)}
          style={TOOLBAR_BUTTON_STYLE}
        >
          <Icon name="clock" size={22} />
        </Button>
        {/* The memory entry point (myne-md/myne#697): the desktop popover
            has no phone posture, so it opens the memory sheet instead. */}
        <Button
          variant="ghost"
          full={false}
          data-testid="ai.memory-button"
          aria-label={t("editor.chrome.rightPanel.aiChat.memory")}
          onClick={() => setMemorySheetOpen(true)}
          style={TOOLBAR_BUTTON_STYLE}
        >
          <Icon name="bookmark" size={22} />
        </Button>
        {openTurns.length > 0 || activeId !== null || asked !== null ? (
          <Button
            variant="ghost"
            full={false}
            data-testid="ai.new-chat"
            aria-label={t("editor.chrome.rightPanel.aiChat.newChat")}
            onClick={() => {
              // Desktop's New chat stops host-side before forgetting: an
              // abandoned run settles later and repopulates the transcript
              // of a conversation the user just left.
              stop();
              clearAgent();
              setAsked(null);
              setActiveId(null);
              setOpenTurns([]);
            }}
            style={TOOLBAR_BUTTON_STYLE}
          >
            <Icon name="plus" size={22} />
          </Button>
        ) : null}
        {/* The fallback revert offer (myne-md/myne#741). Shown only when the
            host holds an undoable record that no open turn can host, which is
            New chat and a switched conversation; the turn icon is the primary
            surface. Without it the record's offer is live but unreachable. */}
        {undoRunId !== null && !undoHosted ? (
          <Button
            variant="ghost"
            full={false}
            data-testid="ai.revert-fallback"
            aria-label={t("editor.chrome.rightPanel.aiChat.revertRun")}
            onClick={() => setRevertConfirmRunId(undoRunId)}
            style={TOOLBAR_BUTTON_STYLE}
          >
            <Icon name="rotate-ccw" size={22} />
          </Button>
        ) : null}
      </div>

      <div style={COMPOSER_BAR}>
        <textarea
          data-testid="ai.composer-input"
          // A placeholder is not an accessible name: it disappears on input,
          // and this field is the only entry point to the whole AI surface.
          // The desktop twin carries both.
          aria-label={t("agent.composer.placeholder")}
          style={INPUT}
          rows={1}
          value={draft}
          placeholder={t("agent.composer.placeholder")}
          onChange={(e) => setDraft(e.target.value)}
        />
        {agent.running ? (
          <Button
            variant="secondary"
            full={false}
            data-testid="ai.composer-stop"
            onClick={stop}
            style={{ flex: "none" }}
          >
            {t("agent.progress.cancel")}
          </Button>
        ) : (
          <Button
            data-testid="ai.composer-send"
            full={false}
            disabled={draft.trim().length === 0 || grant === null || probing || refused}
            onClick={() => void send()}
            style={{ flex: "none" }}
          >
            {t("editor.chrome.rightPanel.aiChat.send")}
          </Button>
        )}
      </div>
      {/* **The review OPENS when the run has something to review, and it is
          DERIVED rather than raised as an event.** A run that stopped to ASK is
          not a run to review, and every future path that settles a run would
          otherwise have to remember to open it: the resume after a scope
          approval is a second such path and would have been missed. Closing is
          not a second piece of state either, because `clearAgent()` drops the
          run, which is what makes the rule false again. */}
      {reviewable && (
        <AiReviewFlow
          titleOf={titleOf}
          bodyOf={bodyOf}
          {...(onNotesWritten === undefined ? {} : { onNotesWritten })}
          onClose={() => clearAgent()}
        />
      )}

      {/* NOT gated on a successful preview. The sheet is the only way to answer
          a run that is waiting, and gating it on the fetch would hide the
          decline button too, leaving the run stuck on an answer the user had no
          way to give. */}
      {awaiting !== null && runId !== null && (
        <AiScopeSheet
          folder={awaiting.folder}
          noteCount={expansion?.noteCount ?? null}
          excludedCount={expansion?.excludedCount ?? null}
          newTotal={expansion?.newTotal ?? null}
          reason={awaiting.reason}
          arm={arm}
          providerName={providerName}
          onApprove={() => {
            resumeRun();
            // Captured before the await, so a vault lock during the approval
            // invalidates the reply rather than being raced by it.
            const epoch = currentRunEpoch();
            void agentApproveScope(
              runId,
              { kind: "folder", value: awaiting.folder },
              // The approved leg reports its cost too, or the figures would
              // freeze the moment a run widened its scope, which is precisely
              // when a user most wants to see them moving: widening is what
              // makes a run expensive.
              (progress) => void reportRunProgress(progress, epoch),
            )
              .then((result) => settleStep(result, epoch))
              .catch(() => {
                // Epoch-checked: the success path is guarded transitively by
                // `settleStep`, and a failure that lands after the run was let
                // go of would otherwise clear a NEWER run's `running`.
                if (epoch !== currentRunEpoch()) return;
                failRun(t("agent.progress.expandFailed"));
              });
          }}
          // Declining ENDS the run rather than continuing it narrower. The
          // model asked because it could not finish inside what it had, so
          // "carry on without it" is a promise neither client can keep.
          onDecline={() => void agentCancel(runId)}
        />
      )}
      {sheetOpen ? (
        <AiHistorySheet
          activeId={activeId}
          onOpen={(id) => {
            void chatsRead(id)
              .then((payload) => {
                const turns = parseTranscript(payload);
                if (turns === null) {
                  setHistoryError(true);
                  return;
                }
                setActiveId(id);
                setOpenTurns(turns);
                setSheetOpen(false);
              })
              .catch(() => setHistoryError(true));
          }}
          onNew={() => {
            setActiveId(null);
            setOpenTurns([]);
          }}
          onDeleted={(id) => {
            if (activeId === id) {
              setActiveId(null);
              setOpenTurns([]);
            }
          }}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
      {memorySheetOpen ? (
        <MemorySheet onDeleted={() => {}} onClose={() => setMemorySheetOpen(false)} />
      ) : null}

      {/* The frozen proposal, read-only (myne-md/myne#741). It replaces the
          inline Before/After blocks that put two note bodies in a 280px bubble
          on every open. Nothing here writes: a frozen proposal may quote a note
          that has since changed, been trashed or moved folders, so the only
          affordance is close. */}
      {diffProposal !== null ? (
        <Sheet
          onClose={() => setDiffProposal(null)}
          style={{ maxHeight: "82%", display: "flex", flexDirection: "column" }}
        >
          {(close) => (
            <div
              data-testid="ai.proposal-diff"
              style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
            >
              <div style={SHEET_HEADER}>
                <h2 style={SHEET_TITLE}>
                  {t("editor.chrome.rightPanel.aiChat.diffTitle")}
                </h2>
                <Button
                  variant="ghost"
                  full={false}
                  data-testid="ai.proposal-diff-close"
                  onClick={close}
                >
                  {t("common.close")}
                </Button>
              </div>
              <div
                data-testid="ai.proposal-diff-body"
                style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
              >
                {diffProposal.edits.map((edit, i) => (
                  <div
                    key={`e${i}`}
                    data-testid="ai.proposal-edit"
                    data-note-id={edit.noteId}
                    style={{ borderBottom: "1px solid var(--line-1)" }}
                  >
                    {lineDiff(edit.anchor, edit.replacement).map((line, j) => (
                      <DiffLineView key={j} line={line} testIdPrefix="ai.proposal" />
                    ))}
                  </div>
                ))}
                {diffProposal.newNotes.map((note, i) => (
                  <div
                    key={`n${i}`}
                    data-testid="ai.proposal-new-note"
                    style={{ borderBottom: "1px solid var(--line-1)" }}
                  >
                    <div style={{ ...CAPTION, padding: "var(--space-2) 0 0" }}>
                      {t("editor.chrome.rightPanel.aiChat.historyProposalNewNote")}:{" "}
                      {note.title}
                    </div>
                    {lineDiff("", note.body).map((line, j) => (
                      <DiffLineView key={j} line={line} testIdPrefix="ai.proposal" />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Sheet>
      ) : null}

      {/* Revert is a write, so it confirms first. The sentence states the one
          asymmetry the offer always carries: edits go back, creates stay. */}
      {revertConfirmRunId !== null ? (
        <Sheet onClose={() => setRevertConfirmRunId(null)}>
          {(close) => (
            <div
              data-testid="ai.revert-confirm"
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
            >
              <h2 style={SHEET_TITLE}>
                {t("editor.chrome.rightPanel.aiChat.revertConfirmTitle")}
              </h2>
              <p style={{ ...MUTED, margin: 0 }}>
                {t("editor.chrome.rightPanel.aiChat.revertConfirmBody")}
              </p>
              {/* The session-scoped disclosure `0561` requires, carried forward
                  into the confirm rather than dropped with the strip: the offer
                  is lost on lock or close, and the version history is the
                  durable path. */}
              <p style={{ ...MUTED, margin: 0 }}>{t("agent.undo.sessionOnly")}</p>
              <Button variant="secondary" data-testid="ai.revert-cancel" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="secondary"
                data-testid="ai.revert-confirm-undo"
                disabled={undo.busy || undo.run?.runId !== revertConfirmRunId}
                onClick={() => {
                  void undo.undo();
                  close();
                }}
              >
                {t("agent.undo.action")}
              </Button>
            </div>
          )}
        </Sheet>
      ) : null}
    </>
  );
}
