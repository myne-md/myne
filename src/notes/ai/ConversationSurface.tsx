// The conversation surface (myne-md/myne#771): transcript, composer, live run
// strip and every modal a conversation owns, extracted out of `AiChatTab` so the
// light right-panel tab and the agent tab's Hub/Focus render ONE implementation
// rather than two that drift.
//
// ── Why this exists as its own module ───────────────────────────────────────
// The panel and the agent tab show the same thing: a transcript, a composer, the
// live run's status and Stop, the review entry and the last-run undo. The first
// version of the agent tab would have been a second copy of `AiChatTab`'s body,
// and story 23 of the PRD ("the panel's composer, transcript, cost line and stop
// control behave exactly as the Hub's do") would then have held by review alone.
// Extracting the body is what makes it true by construction.
//
// ── What stays OUT, and deliberately ────────────────────────────────────────
// The panel's chrome: the section heading, the history/memory/new-chat buttons,
// the status chip, the honesty note and the persist warning. Those are the light
// surface's own furniture (`decisions/ai` 0524's "one mode" and 0613's turn
// affordances are about the CONVERSATION, not the panel frame), and the agent
// tab carries its own frame across its two views. So this component renders the
// reading-and-writing half and takes no view of its own.
//
// ── Layout contract ─────────────────────────────────────────────────────────
// It owns the whole height it is given: the transcript scrolls, the run strip and
// the composer are pinned. A caller must size it (flex: 1, minHeight: 0); it does
// not invent a height of its own, because the panel and the tab give it different
// ones.

import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { ChatMarkdown } from "./ChatMarkdown";
import { EmptyState } from "../../components/primitives/EmptyState";
import { IconButton } from "../../components/primitives/IconButton";
import { ModalShell } from "../../components/primitives/ModalShell";
import { agentLastRun, agentUndo } from "../../lib/agent-run";
import type { AgentUndoResult, Proposal } from "../../lib/agent-protocol";
import { providerErrorKey } from "../../lib/engine-error";
import { useChat, type AgentTurnEnd, type ChatTurn } from "./chatStore";
import {
  hydrateActiveConversation,
  installChatPersistence,
  isChatHydrateFailed,
  isChatPersistLagging,
  subscribeChatPersistHealth,
} from "./chatPersist";
import { useAgent } from "../agent/agentStore";
import { AgentProgress, endStatusLabel } from "../agent/components/AgentProgress";
import { AgentRunOrb } from "../agent/AgentRunOrb";
import { RunCostLine } from "../agent/components/RunCostLine";
import { undoResultText, useUndoLastRun } from "../agent/useUndoLastRun";
import { AnsweredByIndicator } from "../../components/AnsweredByIndicator";
import { CAPTION_STYLE } from "../components/sharedStyles";
import { ChatComposer } from "../components/ChatComposer";
import { ProposalDiffModal } from "../components/ProposalDiffModal";

/** The translation function shape every helper here takes. */
type TFn = (key: string, opts?: Record<string, unknown>) => string;

const TURN_TEXT_STYLE: CSSProperties = { fontSize: "var(--text-sm)", lineHeight: 1.5 };

/** Stable empty list, so a caller that omits `folders` does not hand the
 *  composer a fresh array identity on every render. */
const NO_FOLDERS: readonly string[] = [];

/** The shared bubble every turn sits in.
 *
 *  **The user's side wears the accent** (myne-md/myne#771). It was `--bg-2`
 *  against the assistant's `--paper-2`: two adjacent greys, on a 280px column,
 *  distinguished further only by an alignment that a long turn wrapping to full
 *  width erases. So a transcript read quickly was a column of near-identical
 *  blocks, and the one distinction that matters — what YOU said against what a
 *  model said about your notes — was the weakest signal on the surface.
 *
 *  The accent is the app's one "this is yours" colour, and it goes on the user's
 *  side rather than the model's deliberately: tinting the model's output would
 *  lend it the emphasis the accent carries everywhere else, on the one surface
 *  whose own honesty note says the output may be wrong. */
const bubbleStyle = (isUser: boolean): CSSProperties => ({
  alignSelf: isUser ? "flex-end" : "flex-start",
  maxWidth: "92%",
  background: isUser ? "var(--accent-soft)" : "var(--paper-2)",
  border: `1px solid ${isUser ? "var(--accent)" : "var(--line-1)"}`,
  borderRadius: "var(--radius-1)",
  padding: "var(--space-1) var(--space-2)",
});

/** What a run that proposed nothing AND answered nothing says (myne-md/myne#574).
 *
 *  A total switch rather than a lookup table, for the reason `AiChatTab`'s own
 *  note gives: `scripts/check-i18n.mjs` verifies **static** `t("…")` call
 *  sites, so a key assembled from a variable is a key it cannot see. */
function emptyRunLabel(end: AgentTurnEnd, t: TFn): string {
  switch (end) {
    case "stalled":
    case "exhaustedIterations":
      return t("editor.chrome.rightPanel.aiChat.agentTurn.noAnswer");
    case "finished":
    case "cancelled":
    case "awaitingScope":
      return t("agent.review.noChanges");
  }
}

/** The empty-transcript sentence for a degraded resting cause. A total switch
 *  rather than a lookup table, for the reason this file's helpers give:
 *  `scripts/check-i18n.mjs` verifies static `t("…")` call sites. The frame
 *  computes the cause; the surface, which owns the region, names it. */
function degradedBodyKey(cause: string, t: TFn): string {
  switch (cause) {
    case "off":
      return t("editor.chrome.rightPanel.aiChat.offHint");
    case "no-provider":
      return t("editor.chrome.rightPanel.aiChat.noModelHint");
    case "unreachable":
      return t("editor.chrome.rightPanel.aiChat.unreachableHint");
    case "unavailable":
      return t("editor.chrome.rightPanel.aiChat.unavailableHint");
    default:
      return t("editor.chrome.rightPanel.aiChat.noModelHint");
  }
}

/** The NAME of a degraded resting cause — the fault, before the sentence that
 *  explains it. The header's status chip carried this alone, one glance away
 *  from the body text, so the transcript region said why without saying what.
 *  A total switch for the same reason `degradedBodyKey` is one. */
function degradedTitleKey(cause: string, t: TFn): string {
  switch (cause) {
    case "off":
      return t("editor.chrome.rightPanel.aiChat.statusOff");
    case "no-provider":
      return t("editor.chrome.rightPanel.aiChat.statusNoModel");
    case "unreachable":
      return t("editor.chrome.rightPanel.aiChat.statusUnreachable");
    case "unavailable":
      return t("editor.chrome.rightPanel.aiChat.statusUnavailable");
    default:
      return t("editor.chrome.rightPanel.aiChat.statusNoModel");
  }
}

/** The speaker caption above a turn's body, with the glyph for who is talking.
 *
 *  `aria-hidden` on the icon: the word beside it already names the speaker, and
 *  a screen reader announcing "image, robot, Assistant" is the same fact twice
 *  with a guess in the middle. */
function TurnSpeaker({ isUser, t }: { isUser: boolean; t: TFn }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-1)",
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-medium)",
        color: isUser ? "var(--accent)" : "var(--fg-3)",
      }}
    >
      <span aria-hidden="true" style={{ display: "inline-flex" }}>
        <Icon name={isUser ? "user" : "bot"} size={12} />
      </span>
      {isUser
        ? t("editor.chrome.rightPanel.aiChat.you")
        : t("editor.chrome.rightPanel.aiChat.assistant")}
    </div>
  );
}

/** What an agent run looks like in the transcript, once it has stopped.
 *
 *  **The live strip is NOT here.** Mounting `AgentProgress` inside the bubble put
 *  the scope-expansion dialog it carries inside the scrolling transcript, below
 *  whatever the reader had scrolled to. That dialog is the entire bound
 *  `design-notes/ai/0515` puts on model-originated scope growth. It also tied
 *  the strip's lifetime to a transcript turn, which "New chat" deletes.
 *
 *  What stays here is the run's OUTCOME, frozen onto the turn when it settled. */
function AgentTurnView({
  turn,
  working,
  t,
  canRevert,
  onOpenDiff,
  onRequestRevert,
  revertBusy,
  undoReport,
}: {
  turn: ChatTurn;
  working: boolean;
  t: TFn;
  canRevert: boolean;
  onOpenDiff: (proposal: Pick<Proposal, "edits" | "newNotes">) => void;
  onRequestRevert: (runId: string) => void;
  revertBusy: boolean;
  undoReport: AgentUndoResult | null;
}) {
  const s = turn.agentSummary;
  const hasProposal =
    s !== undefined &&
    s.proposal !== undefined &&
    (s.proposal.edits.length > 0 || s.proposal.newNotes.length > 0);
  return (
    <div
      data-testid="ai.turn"
      data-role="assistant"
      data-kind="agent"
      data-streaming="false"
      data-working={working ? "true" : "false"}
      style={bubbleStyle(false)}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-1)",
        }}
      >
        <TurnSpeaker isUser={false} t={t} />
        {s !== undefined && !working ? (
          <div style={{ display: "flex", gap: "var(--space-1)", flexShrink: 0 }}>
            {hasProposal ? (
              <IconButton
                icon="columns-2"
                label={t("editor.chrome.rightPanel.aiChat.viewDiff")}
                testId="ai.turn-diff"
                iconSize={14}
                onClick={() => onOpenDiff(s.proposal!)}
              />
            ) : null}
            {canRevert ? (
              <IconButton
                icon="rotate-ccw"
                label={t("editor.chrome.rightPanel.aiChat.revertRun")}
                testId="ai.turn-revert"
                iconSize={14}
                disabled={revertBusy}
                onClick={() => onRequestRevert(s.runId)}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {/* **The run indicator's real home** (myne-md/myne#771).

          This line is what an in-flight agent turn shows, and it was the word
          "Working" in grey and nothing else: the one place the user is
          certainly looking during a run, and the only place on the surface
          with no sign of life in it. The orb sat in the pane's top row and in
          the tab instead — both true, both peripheral — so an indicator built
          to report a multi-minute wait was, in practice, never seen.

          It also settles the motion exemption's terms better than either of
          those (`design-notes/ai/0621`): the requirement is that the run's
          status be stated in WORDS beside the shape, and here the words are
          not merely nearby, they are the same line. */}
      {working && s === undefined && !turn.error ? (
        <p
          data-testid="ai.agent-working"
          style={{
            ...TURN_TEXT_STYLE,
            color: "var(--fg-3)",
            margin: "var(--space-1) 0 0",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
          }}
        >
          <AgentRunOrb />
          {t("agent.progress.working")}
        </p>
      ) : null}
      {turn.error ? (
        <p
          role="alert"
          data-testid="ai.turn-error"
          style={{ ...TURN_TEXT_STYLE, color: "var(--fg-3)", margin: "var(--space-1) 0 0" }}
        >
          {turn.text}
        </p>
      ) : null}
      {s !== undefined && s.summary.trim().length > 0 ? (
        <ChatMarkdown
          testId="ai.agent-answer"
          text={s.summary}
          style={{ ...TURN_TEXT_STYLE, color: "var(--fg-1)", marginTop: "var(--space-1)" }}
        />
      ) : null}
      {s !== undefined ? (
        <div
          data-testid="ai.agent-summary"
          style={{ ...TURN_TEXT_STYLE, color: "var(--fg-1)", marginTop: "var(--space-1)" }}
        >
          <div>
            {s.edits === 0 && s.newNotes === 0
              ? s.summary.trim().length > 0
                ? null
                : emptyRunLabel(s.end, t)
              : [
                  s.edits > 0
                    ? t("editor.chrome.rightPanel.aiChat.agentTurn.proposed", {
                        count: s.edits,
                      })
                    : null,
                  s.newNotes > 0
                    ? t("editor.chrome.rightPanel.aiChat.agentTurn.newNotes", {
                        count: s.newNotes,
                      })
                    : null,
                ]
                  .filter((line) => line !== null)
                  .join(" ")}
          </div>
          <RunCostLine
            testId="ai.agent-run-cost"
            iterations={s.iterations}
            notesRead={s.notesRead}
            charsOffDevice={s.charsOffDevice}
            style={{ ...CAPTION_STYLE, display: "block" }}
          />
          {(s.memoryUpdated ?? 0) > 0 ? (
            <div data-testid="ai.agent-memory-updated" style={CAPTION_STYLE}>
              {t("editor.chrome.rightPanel.aiChat.agentTurn.memoryUpdated", {
                count: s.memoryUpdated ?? 0,
              })}
            </div>
          ) : null}
          {s.end !== "finished" ? (
            <div data-testid="ai.agent-run-end" style={CAPTION_STYLE}>
              {endStatusLabel(s.end, t)}
            </div>
          ) : null}
          {undoReport !== null ? (
            <div data-testid="ai.undo-result" style={CAPTION_STYLE}>
              {undoResultText(undoReport, t)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One transcript turn (user or assistant).
 *
 *  **Memoized, and the reason is the streaming path.** Each token arrives in its
 *  own task, so React does not batch them: one store dispatch, one render per
 *  token. `chatReducer`'s `replaceLast` keeps every earlier turn's identity, so
 *  without this the whole transcript reconciles at token rate. */
const ChatTurnView = memo(function ChatTurnView({
  turn,
  onInsert,
  t,
}: {
  turn: ChatTurn;
  onInsert?: (text: string) => void;
  t: TFn;
}) {
  const isUser = turn.role === "user";
  return (
    <div
      data-testid="ai.turn"
      data-role={turn.role}
      data-kind={turn.kind}
      data-streaming={turn.streaming ? "true" : "false"}
      style={bubbleStyle(isUser)}
    >
      <TurnSpeaker isUser={isUser} t={t} />
      {turn.scopeLabel !== undefined ? (
        <div data-testid="ai.turn-scope" style={CAPTION_STYLE}>
          {t("agent.composer.scopeLabel")}: {turn.scopeLabel}
        </div>
      ) : null}
      {/* **A model's answer is markdown, always** (myne-md/myne#771). It was
          rendered as `pre-wrap` plain text, so the asterisks, the backticks and
          the list markers were all on screen as themselves — on the one surface
          whose own honesty note asks the user to read the answer carefully.

          The USER's side stays plain: what they typed is what they meant, and
          re-interpreting it would mean a message containing `*` coming back
          italic. Only the model's output is parsed, because only the model
          wrote markdown on purpose. */}
      {isUser ? (
        <div
          data-testid="ai.turn-text"
          style={{ ...TURN_TEXT_STYLE, color: "var(--fg-1)", whiteSpace: "pre-wrap" }}
        >
          {turn.text}
        </div>
      ) : (
        <div style={{ ...TURN_TEXT_STYLE, color: "var(--fg-1)" }}>
          <ChatMarkdown text={turn.text} testId="ai.turn-text" />
          {turn.streaming && (
            <span data-testid="ai.turn-streaming" aria-hidden="true">
              ▍
            </span>
          )}
        </div>
      )}
      {!isUser && !turn.streaming && turn.text.length === 0 && !turn.error && (
        <p
          data-testid="ai.no-answer"
          style={{ ...TURN_TEXT_STYLE, color: "var(--fg-3)", fontStyle: "italic", margin: 0 }}
        >
          {t("editor.chrome.rightPanel.aiChat.noAnswer")}
        </p>
      )}
      {turn.error && (
        <p
          role="alert"
          data-testid="ai.turn-error"
          style={{ ...TURN_TEXT_STYLE, color: "var(--fg-3)", margin: "var(--space-1) 0 0" }}
        >
          {turn.errorCause
            ? t(providerErrorKey(turn.errorCause))
            : t("editor.chrome.rightPanel.aiChat.errorTurn")}
        </p>
      )}
      {!turn.streaming && turn.answeredBy !== undefined && (
        <div style={{ marginTop: "var(--space-1)" }}>
          <AnsweredByIndicator answeredBy={turn.answeredBy} testId="ai.turn-answered-by" />
        </div>
      )}
      {turn.insertable && onInsert && !turn.streaming && turn.text.length > 0 && (
        <div style={{ marginTop: "var(--space-2)" }}>
          <Button
            type="button"
            variant="secondary"
            data-testid="ai.insert-turn"
            onClick={() => onInsert(turn.text)}
          >
            {t("editor.chrome.rightPanel.aiChat.insert")}
          </Button>
        </div>
      )}
    </div>
  );
});

/** The body a conversation renders: its transcript, its live-run strip, its
 *  composer, and the modals a conversation owns (diff, revert confirm, history,
 *  memory are the CALLER's frame and stay there). */
export interface ConversationSurfaceProps {
  /** Explicit "Insert into note" action for a ready summary. */
  onInsert?: (text: string) => void;
  /** The open note: the agent's default scope in the composer. */
  openNoteId?: string | null;
  /** Folders the user can attach as an agent scope. */
  folders?: readonly string[];
  /** Called with the ids of notes an automatic apply wrote. */
  onNotesWritten?: (noteIds: readonly string[]) => void;
  /** Called after an agent-run undo reverted notes on disk, with their ids. */
  onRunUndone?: (noteIds: readonly string[]) => void;
  /** Called when the run store opens a run, so a caller can reveal chrome that
   *  depends on "a run is working" (the agent tab's orb, for one). Fires with
   *  `true` when a run opens and `false` when it settles or clears. */
  onRunActiveChange?: (active: boolean) => void;
  /** Called with the two frame-level facts the surface owns but should not
   *  dress: whether the conversation store is lagging behind a failed persist,
   *  and whether the host holds an undoable run that no turn in the open
   *  transcript can host (so the caller's header owes a fallback offer).
   *
   *  Lifted rather than rendered here because the panel shows both IN ITS
   *  HEADER while the agent tab does not: the two hosts dress the same facts
   *  differently, and a surface that painted them would force one frame. */
  onStatusChange?: (status: ConversationSurfaceStatus) => void;
  /** Ask the surface to open its revert confirm for this run. The header's
   *  fallback offer (myne-md/myne#741) lives in the frame but the confirm is the
   *  surface's, so the frame signals through this prop rather than mounting a
   *  second copy. `null` means "no request"; the caller clears it after. */
  confirmRevertRunId?: string | null;
  /** Called once the surface has consumed `confirmRevertRunId`, so the frame
   *  can reset it to `null` and a second click on the fallback re-opens. */
  onConfirmRevertConsumed?: () => void;
  /** The resting cause the frame computed (`off` / `no-provider` /
   *  `unreachable` / `unavailable` / `ready`), carried down so the empty
   *  transcript can name the state and expose `data-ai-cause`. The frame owns
   *  the host reads that decide it; the surface owns the region that shows it. */
  restingCause?: string;
  /** Whether that cause is one of the degraded ones (no model / not answering /
   *  no local AI), so the surface can mark the empty transcript accordingly. */
  degraded?: boolean;
  /** Testid on the outer box, so each host can name its own surface. */
  testId?: string;
}

/** The frame-level facts a caller needs to dress its own chrome around the
 *  conversation. See {@link ConversationSurfaceProps.onStatusChange}. */
export interface ConversationSurfaceStatus {
  /** A persist attempt failed and the store is behind; the panel warns. */
  persistLagging: boolean;
  /** The host's undoable run, when one exists. `null` when none does. */
  undoRunId: string | null;
  /** Whether that undoable run has a turn in the open transcript. When false,
   *  the caller's frame is the only place the offer can be reached. */
  undoHosted: boolean;
}

export function ConversationSurface({
  onInsert,
  openNoteId = null,
  folders = NO_FOLDERS,
  onNotesWritten,
  onRunUndone,
  onRunActiveChange,
  onStatusChange,
  confirmRevertRunId = null,
  onConfirmRevertConsumed,
  restingCause,
  degraded = false,
  testId,
}: ConversationSurfaceProps) {
  const { t } = useTranslation();
  const chat = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  // ONE subscription to the run store, at the surface rather than one per agent
  // turn: the transcript's turns render frozen counts, which need no live read.
  const agent = useAgent();
  // The last-run undo lives here rather than in a strip under the composer
  // (myne-md/myne#741): one mount for the surface, with the offer and report
  // matched onto turns by `runId`.
  const undo = useUndoLastRun({
    agentLastRun,
    agentUndo,
    ...(onRunUndone === undefined ? {} : { onReverted: onRunUndone }),
  });
  const [diffProposal, setDiffProposal] = useState<Pick<
    Proposal,
    "edits" | "newNotes"
  > | null>(null);
  const [revertConfirmRunId, setRevertConfirmRunId] = useState<string | null>(null);
  const runOpen = agent.view !== null;

  // The frame's fallback offer (myne-md/myne#741) asks the surface to open its
  // confirm. Consume the request and reset the caller's slot so a second click
  // re-opens (a prop that stayed set would look already-consumed).
  useEffect(() => {
    if (confirmRevertRunId === null) return;
    setRevertConfirmRunId(confirmRevertRunId);
    onConfirmRevertConsumed?.();
  }, [confirmRevertRunId, onConfirmRevertConsumed]);

  // Tell the host whether a run is live. A caller uses this for chrome that
  // exists only while a run does (the agent tab's orb); the panel ignores it.
  useEffect(() => {
    onRunActiveChange?.(runOpen);
  }, [runOpen, onRunActiveChange]);

  let liveAgentTurnId: string | null = null;
  for (let i = chat.turns.length - 1; i >= 0; i -= 1) {
    const turn = chat.turns[i]!;
    if (turn.kind === "agent" && turn.role === "assistant") {
      liveAgentTurnId = turn.id;
      break;
    }
  }

  const undoRunId = undo.run?.runId ?? null;
  const undoHosted =
    undoRunId !== null &&
    chat.turns.some((turn) => turn.agentSummary?.runId === undoRunId);

  // Follow the newest turn, but only when the reader is already at the bottom.
  // The position is RECORDED on scroll rather than measured in the effect,
  // because by the time the effect runs the DOM already carries the new turn.
  // Coalesced into a frame, because the trigger is per token.
  const atBottomRef = useRef(true);
  const frameRef = useRef(0);
  const lastTurn = chat.turns[chat.turns.length - 1];
  const turnCount = chat.turns.length;
  const tailLength = lastTurn?.text.length ?? 0;

  const [persistLagging, setPersistLagging] = useState(isChatPersistLagging());
  const [hydrateFailed, setHydrateFailedState] = useState(isChatHydrateFailed());
  useEffect(
    () =>
      subscribeChatPersistHealth(() => {
        setPersistLagging(isChatPersistLagging());
        setHydrateFailedState(isChatHydrateFailed());
      }),
    [],
  );

  // Report the frame-level facts up. A caller's header dresses them (the panel
  // warns about a lagging persist and offers a fallback revert); the agent tab
  // ignores them.
  useEffect(() => {
    onStatusChange?.({ persistLagging, undoRunId, undoHosted });
  }, [onStatusChange, persistLagging, undoRunId, undoHosted]);

  // Persistence wiring (myne-md/myne#675): install the store's settle listener
  // once, then re-hydrate the last active conversation. Both are idempotent.
  useEffect(() => {
    installChatPersistence();
    void hydrateActiveConversation();
  }, []);
  useEffect(() => {
    if (!atBottomRef.current) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el !== null) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frameRef.current);
  }, [turnCount, tailLength]);

  return (
    <div
      data-testid={testId ?? "ai.conversation-surface"}
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
      }}
    >
      {/* The unreadable conversation store: an empty transcript must not read as
          "no conversations yet" when the roster refused to open. */}
      {hydrateFailed && chat.turns.length === 0 ? (
        <p
          data-testid="ai.hydrate-error"
          style={{ fontSize: "var(--text-xs)", lineHeight: 1.4, color: "var(--danger)", margin: 0 }}
        >
          {t("editor.chrome.rightPanel.aiChat.historyError")}
        </p>
      ) : null}

      {/* The one scrolling region. Everything below it stays put. */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        {chat.turns.length > 0 ? (
          <div
            data-testid="ai.transcript"
            aria-live="polite"
            aria-atomic="false"
            style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
          >
            {chat.turns.map((turn) =>
              turn.kind === "agent" && turn.role === "assistant" ? (
                <AgentTurnView
                  key={turn.id}
                  turn={turn}
                  working={agent.running && turn.id === liveAgentTurnId}
                  t={t}
                  canRevert={
                    undo.run !== null &&
                    turn.agentSummary !== undefined &&
                    turn.agentSummary.runId === undo.run.runId
                  }
                  onOpenDiff={setDiffProposal}
                  onRequestRevert={setRevertConfirmRunId}
                  revertBusy={undo.busy}
                  undoReport={
                    undo.report !== null &&
                    turn.agentSummary !== undefined &&
                    turn.agentSummary.runId === undo.reportRunId
                      ? undo.report
                      : null
                  }
                />
              ) : (
                <ChatTurnView key={turn.id} turn={turn} onInsert={onInsert} t={t} />
              ),
            )}
          </div>
        ) : (
          // The shared zero state rather than a bare sentence in `--fg-3`
          // (task 11 of myne-md/myne#771). Two situations were rendering as one
          // shape: "nothing has happened yet", which is the resting state of a
          // working panel, and "this cannot work", which is a fault the user
          // may be able to clear. A paragraph cannot tell them apart, and the
          // second one needs a name for the fault before the sentence
          // explaining it — which is what the status chip in the header was
          // carrying alone, one glance away from the text that explains it.
          //
          // `rest` puts `data-ai-cause` on the same element as the testid: the
          // degradation E2E reads the cause AND the body text off one node.
          <EmptyState
            variant={degraded ? "error" : "firstRun"}
            icon={degraded ? "circle-alert" : "message-square"}
            size="sm"
            title={
              degraded
                ? degradedTitleKey(restingCause ?? "no-provider", t)
                : t("editor.chrome.rightPanel.aiChat.emptyTitle")
            }
            body={
              degraded
                ? degradedBodyKey(restingCause ?? "no-provider", t)
                : t("editor.chrome.rightPanel.aiChat.empty")
            }
            testId={degraded ? "ai.status-no-model" : "ai.empty-transcript"}
            rest={
              restingCause === undefined
                ? undefined
                : ({ "data-ai-cause": restingCause } as Record<string, string>)
            }
          />
        )}
      </div>

      {/* The live run: its status, its running scope total, its Stop, and the
          scope-expansion dialog it carries. OUTSIDE the scrolling region and tied
          to the run rather than to a transcript turn, deliberately. */}
      {runOpen ? <AgentProgress /> : null}

      <ChatComposer
        openNoteId={openNoteId}
        folders={folders}
        onNotesWritten={onNotesWritten}
      />

      {diffProposal !== null ? (
        <ProposalDiffModal
          open
          onClose={() => setDiffProposal(null)}
          proposal={diffProposal}
        />
      ) : null}
      {/* Revert is a write, so it confirms first. The sentence states the one
          asymmetry the offer always carries: edits go back, creates stay. */}
      {revertConfirmRunId !== null ? (
        <ModalShell
          open
          onClose={() => setRevertConfirmRunId(null)}
          title={t("editor.chrome.rightPanel.aiChat.revertConfirmTitle")}
          labelId="ai-revert-confirm-title"
          width={420}
          closeLabel={t("common.close")}
          testId="ai.revert-confirm"
        >
          <div
            style={{
              padding: "var(--space-4) var(--space-5)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
            }}
          >
            <p style={{ ...TURN_TEXT_STYLE, color: "var(--fg-2)", margin: 0 }}>
              {t("editor.chrome.rightPanel.aiChat.revertConfirmBody")}
            </p>
            {/* The session-scoped disclosure `0561` requires, carried forward
                into the confirm rather than dropped with the strip. */}
            <p style={{ ...TURN_TEXT_STYLE, color: "var(--fg-3)", margin: 0 }}>
              {t("agent.undo.sessionOnly")}
            </p>
            <div
              style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}
            >
              <Button
                type="button"
                variant="ghost"
                data-testid="ai.revert-cancel"
                onClick={() => setRevertConfirmRunId(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={undo.busy || undo.run?.runId !== revertConfirmRunId}
                data-testid="ai.revert-confirm-undo"
                onClick={() => {
                  setRevertConfirmRunId(null);
                  void undo.undo();
                }}
              >
                {t("agent.undo.action")}
              </Button>
            </div>
          </div>
        </ModalShell>
      ) : null}
    </div>
  );
}
