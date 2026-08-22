// AI Chat right-panel tab body (local-ai epic, ai-ux-surface MYND-408, tasks
// 3 + 5).
//
// The canonical render target the AI capability siblings (note-summarization,
// semantic-search-qa) mount their output into. Auto-tag used to render its
// accept-chips here too; MYND-651 moved it to the inline suggestion band at the
// frontmatter boundary, which is now the only tag surface. Task 3 shipped
// the strip wiring + empty-state; task 5 adds the shared **"AI off / ready"
// chrome** — the header status reflects the `ai_enabled` pref so a user who
// switches to this tab with AI off sees why it's empty and where to turn it on.
// Because AI now ships in the default build as a runtime beta opt-in (decisions.md
// 2026-07-02), the status has THREE resting states: off (`ai_enabled` false),
// no-model (enabled but no generation model side-loaded — every infer would fail
// `NotReady`, so we point at Settings → Developer → AI), and ready. The "AI thinking…"
// busy state is wired when a sibling drives a blocking inference call (SYNC-7).
//
// Inference is local by default and remote only where the user has named a
// provider, consented and stored a key (#414/#415); the AI settings panel states
// the bounded guarantee.
//
// **Layout: this component owns the tab body's whole height.** Header and
// composer are fixed, only the transcript scrolls. That is what makes it read as
// a chat rather than as a page with an input somewhere down it, and it is what
// lets the composer stay where the user last left their hands.
//
// **One composer, two modes.** The agent's entry point is this composer's Edit
// mode, not a second form beside it. `design-notes/ai/0515` already put the
// entry point in chat; what shipped mounted `AgentComposer` as a sibling of this
// component, so the tab offered two inputs and two Send buttons and said nothing
// about which one to use. `ChatComposer` is now the single one; `AgentProgress`
// and the run's outcome render as a turn in this transcript.

import { memo, useEffect, useRef, type CSSProperties } from "react";
import { providerErrorKey } from "../../lib/engine-error";
import { useTranslation } from "react-i18next";

import { usePrefs } from "../../hooks/usePrefs";
import {
  useAiBackendClass,
  useAiRetrievalState,
  useAiSurfaceState,
} from "../../hooks/useAiModelReady";
import {
  clearChat,
  useChat,
  type ChatTurn,
} from "../ai/chatStore";
import { agentCancel } from "../../lib/agent-run";
import { aiChatHonestyNote } from "../../lib/load-bearing-copy";
import { AnsweredByIndicator } from "../../components/AnsweredByIndicator";
import { Button } from "../../components/primitives/Button";
import { providerLabelOf } from "../../lib/ai-capability";
import { CAPTION_STYLE, SECTION_HEADING_STYLE } from "./sharedStyles";
import { ChatComposer } from "./ChatComposer";
import { clearAgent, useAgent } from "../agent/agentStore";
import { AgentProgress, endStatusLabel } from "../agent/components/AgentProgress";
import { RunCostLine } from "../agent/components/RunCostLine";
import { UndoLastRun } from "../agent/components/UndoLastRun";

/** Why the chat surface is at rest, as a fixed identifier — never content
 *  (#191 task 3). `ready` covers both "working" and "still asking the host":
 *  a surface that flashed a degraded state while the one host read was in
 *  flight would tell the user something false for a frame. */
type TFn = (key: string, opts?: Record<string, unknown>) => string;

type RestingCause = "off" | "no-provider" | "unreachable" | "unavailable" | "ready";

/** Causes that mean *the thing you set up is not answering*, as distinct from
 *  *you have not set anything up*. Different sentence, different fix — which is
 *  the whole point of the slice. */
const NOT_ANSWERING: ReadonlySet<string> = new Set([
  "unreachable",
  "Unreachable",
  "timeout",
  "Timeout",
  "refused",
  "Refused",
]);

/** Total switches over the union rather than lookup tables, and the reason is
 *  `scripts/check-i18n.mjs`: it verifies **static `t("…")` call sites**, so a
 *  key sitting in a `Record` is a key no guard checks and a typo in it renders
 *  the raw key at the user. Written this way the compiler catches a missing
 *  cause and the guard catches a missing translation. */
function chipKey(cause: Exclude<RestingCause, "ready">, t: TFn): string {
  switch (cause) {
    case "off":
      return t("editor.chrome.rightPanel.aiChat.statusOff");
    case "no-provider":
      return t("editor.chrome.rightPanel.aiChat.statusNoModel");
    case "unreachable":
      return t("editor.chrome.rightPanel.aiChat.statusUnreachable");
    case "unavailable":
      return t("editor.chrome.rightPanel.aiChat.statusUnavailable");
  }
}

function bodyKey(cause: Exclude<RestingCause, "ready">, t: TFn): string {
  switch (cause) {
    case "off":
      return t("editor.chrome.rightPanel.aiChat.offHint");
    case "no-provider":
      return t("editor.chrome.rightPanel.aiChat.noModelHint");
    case "unreachable":
      return t("editor.chrome.rightPanel.aiChat.unreachableHint");
    case "unavailable":
      return t("editor.chrome.rightPanel.aiChat.unavailableHint");
  }
}

const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
};

/** Optional handlers the Editor wires; absent in isolation (e.g. tests). */
export interface AiChatTabProps {
  /** Explicit "Insert into note" action for a ready summary (task 5, SYNC-17).
   *  When absent, the insert affordance is not shown. */
  onInsert?: (text: string) => void;
  /** The open note: the agent's default scope in the composer's Edit mode. */
  openNoteId?: string | null;
  /** Folders the user can attach as an agent scope. */
  folders?: readonly string[];
  /** Called with the ids of notes an automatic apply wrote, so the open pane
   *  re-reads them (myne-md/myne#551). The manual path reaches the same
   *  callback through `AgentReviewTakeover`; this is the automatic one. */
  onNotesWritten?: (noteIds: readonly string[]) => void;
  /** Called after an agent-run undo reverted notes on disk, with their ids. */
  onRunUndone?: (noteIds: readonly string[]) => void;
}

const TURN_TEXT_STYLE: CSSProperties = { fontSize: "var(--text-sm)", lineHeight: 1.5 };

/** Stable empty list, so a caller that omits `folders` does not hand the
 *  composer a fresh array identity on every render. */
const NO_FOLDERS: readonly string[] = [];


/** The shared bubble every turn sits in. */
const bubbleStyle = (isUser: boolean): CSSProperties => ({
  alignSelf: isUser ? "flex-end" : "flex-start",
  maxWidth: "92%",
  background: isUser ? "var(--bg-2)" : "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "var(--space-1) var(--space-2)",
});

/** The speaker caption above a turn's body. */
function TurnSpeaker({ isUser, t }: { isUser: boolean; t: TFn }) {
  return (
    <div
      style={{
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-medium)",
        color: "var(--fg-3)",
      }}
    >
      {isUser
        ? t("editor.chrome.rightPanel.aiChat.you")
        : t("editor.chrome.rightPanel.aiChat.assistant")}
    </div>
  );
}

/** What an agent run looks like in the transcript, once it has stopped.
 *
 *  **The live strip is NOT here**, and that was a defect worth the extra
 *  component. Mounting `AgentProgress` inside the bubble put the scope-expansion
 *  dialog it carries inside the scrolling transcript, at 92% of a 280px sidebar,
 *  below whatever the reader had scrolled to. That dialog is the entire bound
 *  `design-notes/ai/0515` puts on model-originated scope growth, so a gate the
 *  user has to go looking for is weaker than the decision assumes. It also tied
 *  the strip's lifetime to a transcript turn, which "New chat" deletes, so
 *  clearing the transcript took the running scope total and the Stop control off
 *  screen while the host kept running.
 *
 *  What stays here is the run's OUTCOME, frozen onto the turn when it settled.
 *  That is what keeps a finished run readable after `clearAgent()`: closing the
 *  review screen drops the run, and without the freeze the turn would go blank
 *  for having done its work. */
function AgentTurnView({
  turn,
  working,
  t,
}: {
  turn: ChatTurn;
  /** Whether this turn's run is the one still working. See `working` below. */
  working: boolean;
  t: TFn;
}) {
  const s = turn.agentSummary;
  return (
    <div
      data-testid="ai.turn"
      data-role="assistant"
      data-kind="agent"
      data-streaming="false"
      data-working={working ? "true" : "false"}
      style={bubbleStyle(false)}
    >
      <TurnSpeaker isUser={false} t={t} />
      {/* **The first leg has nothing else to show.** `beginRun()` nulls the
          view and only a settled step sets it, so until the host answers there
          is no run id, no scope total and no strip: without this line the
          bubble rendered the word "Assistant" and nothing else, for minutes,
          as the only sign anything was happening. The running scope total
          appears in the pinned strip the moment the host reports one. */}
      {working && s === undefined && !turn.error ? (
        <p
          data-testid="ai.agent-working"
          style={{ ...TURN_TEXT_STYLE, color: "var(--fg-3)", margin: "var(--space-1) 0 0" }}
        >
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
      {/* **The model's own answer, above the counts** (myne-md/myne#568). In one
          mode a question is a run like any other and `finish` is how it is
          answered, so this is the reply the user asked for. It used to render
          only inside the review dialog, which is how a question about a note
          got answered inside a "Review changes" screen. Not `t()`-wrapped: it
          is model output, not copy. */}
      {s !== undefined && s.summary.trim().length > 0 ? (
        <p
          data-testid="ai.agent-answer"
          style={{ ...TURN_TEXT_STYLE, color: "var(--fg-1)", margin: "var(--space-1) 0 0" }}
        >
          {s.summary}
        </p>
      ) : null}
      {s !== undefined ? (
        <div
          data-testid="ai.agent-summary"
          style={{ ...TURN_TEXT_STYLE, color: "var(--fg-1)", marginTop: "var(--space-1)" }}
        >
          <div>
            {s.edits === 0 && s.newNotes === 0
              ? // **Suppressed when the model answered.** "The agent proposed no
                // changes" is the right line for an edit request that produced
                // nothing, and exactly the wrong one under an answer the user
                // asked for: it reads as a failure report on a reply that
                // succeeded.
                s.summary.trim().length > 0
                ? null
                : t("agent.review.noChanges")
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
          {/* The run's cost, in the same three figures the review screen
              reports, from the same component: the wording is the remote arm's
              compensating control, not a caption. */}
          <RunCostLine
            testId="ai.agent-run-cost"
            iterations={s.iterations}
            notesRead={s.notesRead}
            charsOffDevice={s.charsOffDevice}
            style={{ ...CAPTION_STYLE, display: "block" }}
          />
          {s.end !== "finished" ? (
            <div data-testid="ai.agent-run-end" style={CAPTION_STYLE}>
              {endStatusLabel(s.end, t)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One transcript turn (user or assistant). Assistant turns render the streaming
 *  caret, the error state, and the citation chips. Design uses design-token CSS
 *  variables only (no hex), per `src/CLAUDE.md`.
 *
 *  **Memoized, and the reason is the streaming path.** Each token arrives in its
 *  own task, so React does not batch them: one store dispatch, one tab render
 *  per token. `chatReducer`'s `replaceLast` keeps every earlier turn's identity,
 *  so without this the whole transcript reconciles at token rate and the cost
 *  grows with the length of the conversation. */
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
      // The turn's own kind, not the component's. This bubble also renders an
      // agent run's TASK, which is `kind: "agent"`; hardcoding "text" here made
      // the DOM contradict the store, and the exact regression this branch
      // fixed (a task built as `text` and fed to the ask model as history)
      // would have left every E2E assertion unchanged.
      data-kind={turn.kind}
      data-streaming={turn.streaming ? "true" : "false"}
      style={bubbleStyle(isUser)}
    >
      <TurnSpeaker isUser={isUser} t={t} />
      {/* The scope the message was sent under, on the user's own turn. A run
          reads back as "I asked this, over that", which is the pairing the
          approval gate is about. */}
      {turn.scopeLabel !== undefined ? (
        <div data-testid="ai.turn-scope" style={CAPTION_STYLE}>
          {t("agent.composer.scopeLabel")}: {turn.scopeLabel}
        </div>
      ) : null}
      <div
        data-testid="ai.turn-text"
        style={{ ...TURN_TEXT_STYLE, color: "var(--fg-1)", whiteSpace: "pre-wrap" }}
      >
        {turn.text}
        {turn.streaming && (
          <span data-testid="ai.turn-streaming" aria-hidden="true">
            ▍
          </span>
        )}
      </div>
      {/* Empty finalized answer (the model produced nothing) renders a friendly
          placeholder instead of a blank bubble.

          Two routes reach it and they converge BEFORE the store, not here. A
          local engine finalizes a turn with no text; a remote provider reports
          the same outcome as the typed failure `empty_completion`
          (myne-md/myne#466), because the transport has to distinguish it from a
          policy refusal and from a reply shape Myne does not model. `ai-chat.ts`
          finalizes that cause rather than failing it, so by the time a turn is
          rendered `error` means what it says and this condition reads one
          field. */}
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
          {/* Name the class and, through its own copy, the next action
              (myne-md/myne#440). Falls back to the generic sentence only when
              the failure carried no cause at all. */}
          {turn.errorCause
            ? t(providerErrorKey(turn.errorCause))
            : t("editor.chrome.rightPanel.aiChat.errorTurn")}
        </p>
      )}
      {/* Which backend produced this answer (#191 task 4, SYNC-13). Attached to
          the TURN, so switching provider does not retroactively re-label the
          answers that came before it — and only on a finalized turn, because a
          streaming one has not been answered by anyone yet. A caption in the
          same register as the citation chips beside it: no icon, no colour, no
          badge, no dismissal. Persistent rather than interruptive, because a
          dialog people see often is a dialog people stop reading. */}
      {!turn.streaming && turn.answeredBy !== undefined && (
        <div style={{ marginTop: "var(--space-1)" }}>
          <AnsweredByIndicator answeredBy={turn.answeredBy} testId="ai.turn-answered-by" />
        </div>
      )}
      {/* Per-turn "Insert into note" for a summary answer (task 10, SYNC-17). */}
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

export function AiChatTab({
  onInsert,
  openNoteId = null,
  folders = NO_FOLDERS,
  onNotesWritten,
  onRunUndone,
}: AiChatTabProps = {}) {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const aiEnabled = prefs.ai_enabled;
  // One host read, four states (#191 task 1) — replacing a private
  // `get_model_path` probe that could only say yes/no and defaulted to no.
  const backend = useAiSurfaceState(aiEnabled);
  // **Who is actually serving, asked of the HOST.** The chip and the honesty
  // note both name a backend, and naming one from `prefs.ai_provider` names
  // what the user INTENDED: `active()` falls back to the local arm on six other
  // conditions (no model chosen, consent or key missing, a preferences snapshot
  // from another vault), so a provider named and never finished reads as
  // "answered by OpenRouter" while every request goes in-process. That is
  // myne-md/myne#466's defect, and `AiPanel` already carries its fix. The NAME
  // still comes from the preferences, because only they carry it; it is shown
  // only for the class the host says is active, so the claim cannot outrun the
  // fact.
  const backendClass = useAiBackendClass(aiEnabled);
  const activeProviderName =
    backendClass === "remote" ? (providerLabelOf(prefs.ai_provider) ?? null) : null;
  // **Asking needs a second capability, and the header used to read only the
  // first** (myne-md/myne#545). `backend` above is the GENERATION row; asking is
  // retrieval-grounded, retrieval is refused a remote provider outright
  // (SYNC-16), and the embedding model is not bundled. So a user with a working
  // provider and no local search model saw the provider's name — which reads as
  // ready — on a surface that refused every turn.
  //
  // This also replaces a `gettingReady` PROP that no caller ever passed: the
  // "Preparing…" state was documented in the user guide and unreachable in
  // production, because its default was `false` and nothing overrode it. It is
  // derived here instead, from the same flag the host gates the turn on.
  const retrieval = useAiRetrievalState(aiEnabled);
  const noSearchModel =
    retrieval.embedding.kind === "unavailable" ||
    retrieval.embedding.kind === "absent";
  const gettingReady =
    !noSearchModel &&
    retrieval.embedding.kind === "available" &&
    !retrieval.indexReady;
  // …and one sentence per state (#191 task 3). The old copy said "No model
  // selected. Choose one in Settings" for ALL of them, which is wrong in two:
  // it tells a user whose runtime merely is not running to redo a setup they
  // already did, and it offers a settings page to a build that has no local AI
  // compiled in at all.
  const resting: RestingCause = !aiEnabled
    ? "off"
    : backend.kind === "absent"
      ? "unavailable"
      : backend.kind === "unavailable"
        ? NOT_ANSWERING.has(backend.cause ?? "")
          ? "unreachable"
          : "no-provider"
        : backend.kind === "checking"
          ? "ready"
          : "ready";
  const noModel = resting === "no-provider" || resting === "unreachable" || resting === "unavailable";
  const ready = aiEnabled && !noModel;
  const chat = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  // ONE subscription to the run store, at the tab rather than one per agent
  // turn: the transcript's turns render frozen counts, which need no live read.
  const agent = useAgent();
  // **A run, not merely a failure.** A start that never landed nulls the view,
  // and its message lives on the turn itself; rendering the strip for it too
  // printed the same sentence twice.
  const runOpen = agent.view !== null;
  // The newest agent turn, which is the only one a live run can belong to:
  // `agentStore` holds exactly one.
  let liveAgentTurnId: string | null = null;
  for (let i = chat.turns.length - 1; i >= 0; i -= 1) {
    const turn = chat.turns[i]!;
    if (turn.kind === "agent" && turn.role === "assistant") {
      liveAgentTurnId = turn.id;
      break;
    }
  }

  // Follow the newest turn, but only when the reader is already at the bottom.
  // Yanking the viewport away from someone who has scrolled up to read a cited
  // answer is the one thing a transcript must not do.
  //
  // **Recorded on scroll, not measured in the effect**, because by the time the
  // effect runs the DOM already carries the new turn: a reader who WAS at the
  // bottom is suddenly a whole bubble away from it, so measuring there stops
  // following on exactly the append the user is waiting to see. A streamed turn
  // grows a few pixels at a time and would have kept following, which is what
  // made the wrong version look right.
  //
  // Coalesced into a frame, because the trigger is per TOKEN and the reader
  // cannot perceive more than one scroll per frame: at 40 tokens a second that
  // is 40 layout touches doing the work of one.
  const atBottomRef = useRef(true);
  const frameRef = useRef(0);
  const lastTurn = chat.turns[chat.turns.length - 1];
  const turnCount = chat.turns.length;
  const tailLength = lastTurn?.text.length ?? 0;
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
      data-testid="ai.chat-tab"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
      }}
    >
      <div style={HEADER_ROW_STYLE}>
        <div style={SECTION_HEADING_STYLE}>
          {t("editor.chrome.rightPanel.tabs.aiChat")}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          {chat.turns.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              data-testid="ai.new-chat"
              onClick={() => {
                // **Stop what it is clearing, host side, before clearing it.**
                // Forgetting a run is not stopping one: an abandoned one still
                // settles later through `settleRunIntoChat`, which repopulates
                // the store and pops the review of a conversation the user just
                // deleted. The streaming half of this used to stop an Ask
                // generation too; Ask is gone (myne-md/myne#552) and the only
                // thing left to stop is the run.
                // A run's first leg USED to have no id to cancel with:
                // `beginRun()` nulls `view` and only a settled step set it, so
                // for the whole of `agentStart` the run was working and
                // unaddressable (myne-md/myne#544). It is addressable now — the
                // host sends the view through `agentStart`'s `onOpen` channel
                // before it drives the loop — but the null check stays, because
                // the window between `beginRun()` and that first message is
                // real, and a start that failed outright never has a view at
                // all. `clearAgent()` below does the half that is always
                // available: it bumps the run epoch, so a reply is dropped
                // instead of repopulating the store and opening a full-screen
                // review of a conversation that no longer exists.
                if (agent.view !== null) void agentCancel(agent.view.runId);
                // The transcript and the open run together: the two halves of
                // what this conversation produced. NOT `clearAgentForLock`. The
                // undo offer describes notes already written to the vault, and
                // starting a new conversation does not un-write them.
                clearChat();
                clearAgent();
              }}
            >
              {t("editor.chrome.rightPanel.aiChat.newChat")}
            </Button>
          ) : null}
          <span
            data-testid="ai.chrome-status"
            data-ai-enabled={aiEnabled ? "true" : "false"}
            data-ai-model-ready={aiEnabled ? (noModel ? "false" : "true") : ""}
            data-ai-cause={resting}
            style={{
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-medium)",
              color: aiEnabled && !noModel ? "var(--fg-2)" : "var(--fg-3)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-1)",
              padding: "1px var(--space-1)",
              whiteSpace: "nowrap",
            }}
          >
            {resting !== "ready"
              ? chipKey(resting, t)
              : noSearchModel
                ? t("editor.chrome.rightPanel.aiChat.statusNoSearchModel")
                : gettingReady
                  ? t("editor.chrome.rightPanel.aiChat.statusGettingReady")
                  : // At rest with a provider SERVING, the chip IS the attribution
                    // (#191 task 4): "Ready" would be true and uninformative, and
                    // the provider name is the one fact a user cannot get anywhere
                    // else without opening Settings. A proper noun, not i18n'd.
                    (activeProviderName ??
                    t("editor.chrome.rightPanel.aiChat.statusReady"))}
          </span>
        </div>
      </div>
      {/* Honest framing (task 13): rendered VERBATIM (load-bearing copy, never
          i18n'd) — a weak on-device model is fallible, so the user is told to
          verify against the cited notes. Must not over-claim / imply isolation. */}
      {ready && (
        <p
          data-testid="ai.honesty-note"
          style={{ fontSize: "var(--text-xs)", lineHeight: 1.4, color: "var(--fg-3)", margin: 0 }}
        >
          {aiChatHonestyNote(activeProviderName)}
        </p>
      )}

      {/* The one scrolling region. Everything above and below it stays put. */}
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
            {/* The RUN renders as an agent turn; the task the user sent is an
                ordinary bubble that happens to belong to the agent flow, so
                the switch is on the role rather than on the kind. */}
            {chat.turns.map((turn) =>
              turn.kind === "agent" && turn.role === "assistant" ? (
                <AgentTurnView
                  key={turn.id}
                  turn={turn}
                  working={agent.running && turn.id === liveAgentTurnId}
                  t={t}
                />
              ) : (
                <ChatTurnView
                  key={turn.id}
                  turn={turn}
                  onInsert={onInsert}
                  t={t}
                />
              ),
            )}
          </div>
        ) : (
          <p
            data-testid={noModel ? "ai.status-no-model" : undefined}
            data-ai-cause={resting}
            style={{
              fontSize: "var(--text-sm)",
              lineHeight: 1.5,
              color: "var(--fg-3)",
              margin: 0,
            }}
          >
            {resting !== "ready"
              ? bodyKey(resting, t)
              : noSearchModel
                ? t("editor.chrome.rightPanel.aiChat.noSearchModelHint")
                : gettingReady
                  ? t("editor.chrome.rightPanel.aiChat.gettingReadyHint")
                  : t("editor.chrome.rightPanel.aiChat.empty")}
          </p>
        )}
      </div>

      {/* The live run: its status, its running scope total, its Stop, and the
          scope-expansion dialog it carries. OUTSIDE the scrolling region and
          tied to the run rather than to a transcript turn, deliberately. The
          scope total is one of the four bounds `docs/threat-model.md` §7 names
          in place of the superseded no-tool-calling claim, and the dialog is the
          whole of what `design-notes/ai/0515` puts between the model and a
          wider scope. Neither may scroll out of the way, and neither may be
          unmounted by clearing the transcript. */}
      {runOpen ? <AgentProgress /> : null}

      {/* The previous run's undo, above the composer rather than only on the
          review screen: this is the surface that is still here after that screen
          has been closed. Renders nothing when the host holds no record. */}
      <UndoLastRun onReverted={onRunUndone} />

      {/* Shown whenever AI is on, and NOT gated on a side-loaded model, so it is
          reachable in the stub E2E build and in a no-model state (where a send
          surfaces the honest error turn). */}
      {aiEnabled && (
        <ChatComposer
          openNoteId={openNoteId}
          folders={folders}
          onNotesWritten={onNotesWritten}
        />
      )}
    </div>
  );
}
