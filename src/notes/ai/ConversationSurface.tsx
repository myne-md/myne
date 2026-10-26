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

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { ChatMarkdown } from "./ChatMarkdown";
import { EmptyState } from "../../components/primitives/EmptyState";
import { SeedMemoryCard } from "../components/SeedMemoryCard";
import { restingBody, restingLabel, type RestingId } from "./restingCause";
import type { MentionTarget } from "./noteMentions";
import { IconButton } from "../../components/primitives/IconButton";
import { ModalShell } from "../../components/primitives/ModalShell";
import { ScrollArea } from "../../components/primitives/ScrollArea";
import { copyText } from "../../lib/clipboard";
import { writeText as clipboardWriteText } from "../../platform/clipboardManager";
import { agentLastRun, agentUndo, hasRefusals } from "../../lib/agent-run";
import type { AgentApplyResult, AgentUndoResult } from "../../lib/agent-protocol";
import { providerErrorKey } from "../../lib/engine-error";
import {
  getActiveConversationId,
  markAgentTurnOutcome,
  useChat,
  useConversationEpoch,
  type AgentRunOutcome,
  type AgentTurnEnd,
  type ChatTurn,
} from "./chatStore";
import type { AgentState } from "../agent/agentStore";
import {
  hydrateActiveConversation,
  installChatPersistence,
  isChatHydrateFailed,
  isChatPersistLagging,
  markOutcomeInConversation,
  subscribeChatPersistHealth,
} from "./chatPersist";
import { markConversationRead, clearAgent, reviewableRun, useAgent } from "../agent/agentStore";
import { AttachmentThumbnail } from "../../components/attachments/AttachmentThumbnail";
import { showAttachmentLightbox } from "../../editor/attachments/lightbox";
import { attachmentUrl } from "../attachmentRef";
import { useResolverNotes } from "../resolverNotes";
import { reviewCardBelongsToTurn } from "./reviewOwnership";
// This client's nonce, passed into the shared undo hook below.
import { bumpPrefsNonce } from "../prefsNonce";
import { AgentProgress, endStatusLabel } from "../agent/components/AgentProgress";
import { AgentFootprint } from "../agent/components/AgentFootprint";
import type { ChatComposerSurface } from "../components/ChatComposer";
import { undoResultText, useUndoLastRun } from "../agent/useUndoLastRun";
import { AnsweredByIndicator } from "../../components/AnsweredByIndicator";
import { CAPTION_STYLE } from "../components/sharedStyles";
import { ChatComposer } from "../components/ChatComposer";
import { ProposalDiffBody } from "../components/ProposalDiffBody";
import { AgentReview, RefusalBlock } from "../../screens/AgentReview";

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

/**
 * The verb for the counts line's edit half, by what the reader decided
 * (myne-md/myne#894).
 *
 * **A helper with literal `t()` arms, not a computed key**, and that is the same
 * rule `emptyRunLabel` below and `removalFlagLabel` in the agent protocol both
 * follow: `scripts/check-i18n.mjs` scans STATIC quoted-key call sites by design
 * (an expression-aware scanner is a scanner with a bypass), so a key assembled
 * from a variable is a sentence outside every check in this repository. The first
 * version of this was one `t(cond ? "b" : "c")` in the JSX, and the guard's own
 * count went DOWN by two, it could see neither sentence.
 *
 * Which sentence is true changes exactly once, when the reader acts: a proposal
 * awaits approval, so "proposed" is the honest word; after an apply or a
 * rejection that number is a record of what happened. A run nobody decided (a
 * lock, a reload, a conversation walked away from) keeps saying "proposed",
 * because that is still what it is.
 */
function editCountVerb(
  outcome: AgentRunOutcome | undefined,
  count: number,
  t: TFn,
): string {
  // **No number in the applied arm, and the reason is that the only number the
  // turn carries is the PROPOSED one** (myne-md/myne#894 review). A partial apply
  // is still `applied`, so "{{count}} changes applied" printed the proposal's size
  // over a result that may be smaller, on a synced turn that outlives the card:
  // the one permanent record of what the run did to the vault, claiming more than
  // it did. The landed split is not persisted, so the honest sentence is the one
  // that does not need it.
  if (outcome === "applied") return t("agent.review.appliedSummary");
  if (outcome === "rejected") return t("agent.review.rejectedCount", { count });
  return t("editor.chrome.rightPanel.aiChat.agentTurn.proposed", { count });
}

/** The new-note half of the same line, by the same rule. Only the rejection has
 *  its own sentence: a created note that landed is a create the reader kept, and
 *  "proposed" reads correctly for it in both of the other two states. */
function newNoteCountVerb(
  outcome: AgentRunOutcome | undefined,
  count: number,
  t: TFn,
): string {
  if (outcome === "rejected") return t("agent.review.rejectedNewNotes", { count });
  return t("editor.chrome.rightPanel.aiChat.agentTurn.newNotes", { count });
}

/** The settings half of the counts line, by the same rule as the edits.
 *
 *  **It was the one clause that ignored the decision** (myne-md/myne#894, from
 *  review): `settings` on the summary is the PROPOSED count, so a rejected
 *  settings-only proposal printed "1 setting changed." with nothing corrected
 *  beside it, which is the exact claim the fifth pass of this entry exists to
 *  stop making. A landed setting and a proposed one read the same in the applied
 *  case, so only the rejection has its own sentence. */
function settingCountVerb(
  outcome: AgentRunOutcome | undefined,
  count: number,
  t: TFn,
): string {
  if (outcome === "rejected") return t("agent.review.rejectedSettings", { count });
  // Same rule as the edits arm: a settings apply can be partial, and `count` here
  // is the proposed number.
  if (outcome === "applied") return t("agent.review.settingsApplied");
  return t("agent.review.settingsChanged", { count });
}

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

/** The header row every turn shares: who is talking, and what can be done with
 *  what they said. */
const TURN_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-1)",
};

/** **Copy a turn's words** (myne-md/myne#848, on the user's ask).
 *
 * The transcript is the one place in the app where the text is the POINT: an
 * answer to a question, or the task that produced it. Both are things a user
 * takes away (into a note, into a message, into a bug report) and the only
 * route out was selecting the bubble by hand, which drags in the speaker
 * caption, the footprint's figures and the markdown's rendered punctuation.
 *
 * ── What is copied, and it is the RAW text
 * For the agent, `turn.agentSummary.summary`, what the model wrote, markdown
 * included, because that is what it meant and a paste elsewhere can render it.
 * For the user, exactly what they typed. Not the rendered DOM: a copy that
 * depends on how the bubble happened to be drawn is a copy that changes when
 * the bubble does.
 *
 * ── The feedback, and why it is on the control
 * The `inline-icon` arm: the glyph becomes a check, or a warning, and the
 * accessible name follows it. A toast would need the frame's toast plumbing
 * threaded into a leaf that renders once per turn, for a confirmation the user
 * is looking at anyway, and `lib/clipboard.ts` exists so a copy names its
 * OUTCOME rather than rendering the value, which is what both arms do here. */
function TurnCopyButton({
  text,
  label,
  testId,
  t,
}: {
  text: string;
  /** The accessible name at rest, naming WHAT is copied. */
  label: string;
  testId: string;
  t: TFn;
}) {
  const [outcome, setOutcome] = useState<"idle" | "copied" | "failed">("idle");
  const reset = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reset.current), []);
  const settle = (next: "copied" | "failed"): void => {
    setOutcome(next);
    window.clearTimeout(reset.current);
    // The confirmation is transient. A control stuck on "Copied" has stopped
    // saying what it does, and the next press would read as a no-op.
    reset.current = window.setTimeout(() => setOutcome("idle"), 2000);
  };
  return (
    <IconButton
      icon={
        outcome === "copied" ? "check" : outcome === "failed" ? "circle-alert" : "copy"
      }
      label={
        outcome === "copied"
          ? t("editor.chrome.rightPanel.aiChat.copied")
          : outcome === "failed"
            ? t("editor.chrome.rightPanel.aiChat.copyFailed")
            : label
      }
      testId={testId}
      iconSize={14}
      onClick={() =>
        void copyText(clipboardWriteText, text, {
          onSuccess: { kind: "inline-icon", run: () => settle("copied") },
          onFailure: { kind: "inline-icon", run: () => settle("failed") },
        })
      }
    />
  );
}

/** What an agent run looks like in the transcript, once it has stopped.
 *
 *  **The live strip is NOT here.** Mounting `AgentProgress` inside the bubble put
 *  the scope-expansion dialog it carries inside the scrolling transcript, below
 *  whatever the reader had scrolled to. That dialog is the entire bound
 *  `docs/decisions/ai/0515` puts on model-originated scope growth. It also tied
 *  the strip's lifetime to a transcript turn, which "New chat" deletes.
 *
 *  What stays here is the run's OUTCOME, frozen onto the turn when it settled. */
function AgentTurnView({
  turn,
  live,
  refusals,
  reviewing,
  onNotesWritten,
  titleOf,
  folderOf,
  t,
  canRevert,
  onRequestRevert,
  revertBusy,
  undoReport,
  mentionTargets,
  onOpenNote,
}: {
  turn: ChatTurn;
  /** The live run store, when THIS turn is the one an in-flight run renders
   *  into, and `null` otherwise. Carried rather than a boolean because the
   *  working footprint shows the run's running figures, and a boolean would
   *  make the caller the place those figures are looked up (myne-md/myne#848). */
  live: AgentState | null;
  /** The apply's refusals for this turn's run, or `null`.
   *
   *  Carried rather than read here because the card is the only thing that knows
   *  the run is the open one, and the ORDER is this component's business: the
   *  host's fact is rendered above the model's answer. */
  refusals: AgentApplyResult | null;
  /** Whether the review card belongs to THIS turn (myne-md/myne#894).
   *
   *  A boolean rather than the store, because the rule that decides it is about
   *  which turn owns the open run, the live one, or the frozen one whose
   *  summary carries the same `runId`, and that is a question about the
   *  TRANSCRIPT. `AgentReview` reads the run itself, as it always has. */
  reviewing: boolean;
  onNotesWritten?: (noteIds: readonly string[]) => void;
  /** The review card's two note questions, resolved by the surface. Required,
   *  because the card cannot render a row's note without them. */
  titleOf: (noteId: string) => string | null;
  folderOf: (noteId: string) => string | null;
  t: TFn;
  canRevert: boolean;
  onRequestRevert: (runId: string) => void;
  revertBusy: boolean;
  undoReport: AgentUndoResult | null;
  mentionTargets?: readonly MentionTarget[];
  onOpenNote?: (noteUuid: string) => void;
}) {
  const working = live !== null;
  const s = turn.agentSummary;
  const hasProposal =
    s !== undefined &&
    s.proposal !== undefined &&
    (s.proposal.edits.length > 0 || s.proposal.newNotes.length > 0);
  /** Whether this turn is holding an unapproved proposal, i.e. the counts line
   *  below is describing an ACTION rather than a record (myne-md/myne#894).
   *
   *  `reviewing` and not the counts alone: a run whose proposal is gone (an older
   *  transcript) or already applied is history, and the tone is reserved for the
   *  state where the reader can still do something about it. */
  const proposalPending =
    reviewing &&
    s !== undefined &&
    (s.edits > 0 || s.newNotes > 0 || (s.settings ?? 0) > 0);
  /**
   * **The frozen proposal's diff opens HERE, under its own turn**
   * (myne-md/myne#913). The state used to live on the surface and the diff in a
   * full-width modal, so pressing the turn's own diff control painted it
   * somewhere the user had not come from, over the conversation that explains
   * it. Local state is what makes "under this turn" true rather than a
   * coincidence of there being one open conversation.
   *
   * Closed by default: the trigger is one line, and a settled proposal is a
   * record the user consults rather than a decision waiting on them (the live
   * one is the review card, which is not collapsible).
   */
  const [diffOpen, setDiffOpen] = useState(false);
  return (
    <div
      data-testid="ai.turn"
      data-role="assistant"
      data-kind="agent"
      data-streaming="false"
      data-working={working ? "true" : "false"}
      style={bubbleStyle(false)}
    >
      <div style={TURN_HEADER_STYLE}>
        <TurnSpeaker isUser={false} t={t} />
        {s !== undefined && !working ? (
          <div style={{ display: "flex", gap: "var(--space-1)", flexShrink: 0 }}>
            {/* The answer first, because it is what most copies are for. Only
                when there IS one: a run that proposed changes and said nothing
                has no words of its own, and a control that copies an empty
                string is worse than no control. */}
            {s.summary.trim().length > 0 ? (
              <TurnCopyButton
                text={s.summary}
                label={t("editor.chrome.rightPanel.aiChat.copyAnswer")}
                testId="ai.turn-copy"
                t={t}
              />
            ) : null}
            {hasProposal ? (
              <IconButton
                icon="columns-2"
                label={t("editor.chrome.rightPanel.aiChat.viewDiff")}
                testId="ai.turn-diff"
                iconSize={14}
                // A disclosure, so it says whether it is open. The modal it
                // replaced had nothing to report: it covered the screen or it
                // did not.
                expanded={diffOpen}
                active={diffOpen}
                onClick={() => setDiffOpen((open) => !open)}
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
      {/* **The run's entry, in transcript order** (myne-md/myne#848). While the
          run works this is its working line; once it settles the SAME line
          reports what happened and how long it took, and the figures behind it
          are one click away. It sits above the answer because it is the run's
          own record, and the answer is what the run produced. */}
      {working && live !== null ? (
        <AgentFootprint
          // A run paused on a scope question is not working; it is waiting for
          // the user, and the line says so rather than showing a spinner for a
          // dialog the user has not answered yet.
          // **`null` means WORKING, so a run that has stopped must say so.**
          // This used to read only the awaiting-scope case, so a run that failed
          // to start (or a turn whose settle never arrived) showed "Working"
          // under a check glyph for as long as the transcript was open, while the
          // error sentence sat inside the detail. The error IS the status here:
          // it is the sentence the user has to read.
          settledLabel={
            live.error !== null
              ? live.error
              : // **`end` is enough; the two extra tests were dead**
                // (myne-md/myne#848). `settleStep` writes the end and
                // `running: false` in one `set`, and `resumeRun` clears the end
                // before `running` goes true again, so an end implies "not
                // running", and the awaiting-scope case was already caught by
                // the arm below. Three nested ternaries for one question, with
                // the third arm unreachable.
                live.end !== null
                ? endStatusLabel(live.end.kind, t)
                : null
          }
          durationMillis={null}
          startedAtMillis={live.startedAtMillis}
          figures={{
            iterations: live.iterations,
            notesRead: live.notesRead,
            charsOffDevice: live.charsOffDevice,
            memoryUpdated: live.memoryUpdated,
          }}
          scopeTotal={live.view?.scopeTotal}
          userGrants={live.view?.userGrants}
          modelGrants={live.view?.modelGrants}
          error={live.error}
          failed={live.error !== null}
        />
      ) : null}
      {!working && s !== undefined ? (
        <AgentFootprint
          settledLabel={endStatusLabel(s.end, t)}
          durationMillis={s.durationMillis ?? null}
          figures={{
            iterations: s.iterations,
            notesRead: s.notesRead,
            charsOffDevice: s.charsOffDevice,
            memoryUpdated: s.memoryUpdated ?? 0,
          }}
          failed={s.end === "cancelled" || s.end === "stalled" || s.end === "exhaustedIterations"}
        />
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
      {/* **The host's fact goes ABOVE the model's claim** (myne-md/myne#848,
          and this is where it lives now: myne-md/myne#894 moved the card under
          the answer, so a refusal block inside the card would be read after the
          summary that a refused run tends to overstate. A manual pass found
          exactly that: ten folder moves refused, the summary reporting them as
          applied, and the user believing it until the refusal list at the bottom
          of a long diff. So the refusals render here, first, with their count;
          the prose stays visible below them rather than being hidden, because the
          point is to contradict the claim in front of the reader. */}
      {refusals !== null ? <RefusalBlock result={refusals} /> : null}
      {/* **The model's own words stay here, card or no card** (myne-md/myne#894,
          second pass). They were suppressed while the review card was up, because
          the card rendered the same paragraph itself, which cost the mention
          links their targets for exactly as long as the reader was deciding.
          The card no longer carries the summary (it is a decision card, not a
          document), so this is the one copy and it is always the real one. */}
      {s !== undefined && s.summary.trim().length > 0 ? (
        <ChatMarkdown
          testId="ai.agent-answer"
          text={s.summary}
          style={{ ...TURN_TEXT_STYLE, color: "var(--fg-1)", marginTop: "var(--space-1)" }}
          {...(mentionTargets === undefined ? {} : { mentionTargets })}
          {...(onOpenNote === undefined ? {} : { onOpenNote })}
        />
      ) : null}
      {s !== undefined ? (
        <div
          data-testid="ai.agent-summary"
          // **An unapproved proposal is an ACTION, and it says so in the
          // app's live-tone** (myne-md/myne#894: first "show it warning-toned",
          // then the correction, "make it accent, not orange"). `--warning` is
          // the colour a weak password and a lost session use; a proposal
          // waiting on the reader is the surface's whole purpose, and the
          // accent is what this app paints the live thing with. While the card
          // is waiting, this line and the card's wash are one colour (the failed
          // arm washes danger instead, and the applied arm keeps the accent on
          // this line because the number is still live). The card's tile stays
          // full ink by design (`src/styles/tokens.css`: at 14px inside a 26px
          // tile a tinted glyph reads as disabled), and the dot beside the
          // status sentence is gone. What matters here is the contrast: this
          // line is the last thing above the card that asks for a decision, and
          // it used to carry the model answer's own ink, so the one sentence on
          // the turn that expects the reader to do something read like prose.
          //
          // Tied to `reviewing` rather than to the counts alone, and the
          // difference matters in both directions: a proposal whose run is gone
          // (an older transcript, or one dropped by a lock) is a record and not
          // an action, and a proposal that has been applied is not one either,
          // so the tone follows the CARD, which exists exactly while something
          // is still decidable. `data-pending` carries the same fact for anything
          // that should assert it without reading a colour.
          data-pending={proposalPending ? "true" : undefined}
          style={{
            ...TURN_TEXT_STYLE,
            color: proposalPending ? "var(--accent)" : "var(--fg-1)",
            marginTop: "var(--space-1)",
          }}
        >
          <div>
            {s.edits === 0 && s.newNotes === 0 && (s.settings ?? 0) === 0
              ? s.summary.trim().length > 0
                ? null
                : emptyRunLabel(s.end, t)
              : [
                  s.edits > 0 ? editCountVerb(s.outcome, s.edits, t) : null,
                  s.newNotes > 0 ? newNoteCountVerb(s.outcome, s.newNotes, t) : null,
                  // **A setting change counts as output** (myne-md/myne#850,
                  // from the 2026-10-14 review): without this clause a run whose
                  // only proposal was a setting change rendered "The agent
                  // proposed no changes." directly above the review screen that
                  // showed one.
                  (s.settings ?? 0) > 0
                    ? settingCountVerb(s.outcome, s.settings ?? 0, t)
                    : null,
                ]
                  .filter((line) => line !== null)
                  .join(" ")}
          </div>
          {/* **The cost line, the memory marker and the end label MOVED to the
              footprint** (myne-md/myne#848). They are the run's chrome, not its
              prose: the prose (`ai.agent-summary`) says what the run decided:
              four edits, one new note, or why it had nothing to say. That is
              content the reader came for. The three figures are the
              disclosure `docs/decisions/ai/0515` requires, and they now live
              behind the one disclosure on the run's own line, in one place, for
              the settled run and the running one alike. */}
          {undoReport !== null ? (
            <div data-testid="ai.undo-result" style={CAPTION_STYLE}>
              {undoResultText(undoReport, t)}
            </div>
          ) : null}
        </div>
      ) : null}
      {/* **The decision, in the conversation** (myne-md/myne#894).
          It used to be a full-screen dialog mounted by `Editor`, which meant the
          proposal was rendered in a place the user did not come from and could
          not read beside the message that produced it, and, in the report this
          exists for, it was not seen at all until a click somewhere else
          repainted the window. Here it is part of the turn: the card arrives the
          moment the run settles, under the words that describe it, in the
          transcript the user is already reading.

          `onClose` drops the frontend's copy of the run, mirroring the host,
          which drops its half on lock: the two going out of step is how a
          surface ends up rendering a proposal whose run no longer exists. It is
          also what makes the card go away, so there is no second flag to keep in
          step with this one.

          **`aria-live="off"` on the wrapper, and that is not decoration.** The
          transcript is a polite live region, because a streaming answer has to be
          announced as it arrives. Interactive content inside one is the classic
          mistake: every row the user rejects, every refusal that lands and every
          label that flips between "Reject" and "Keep" is a mutation in a live
          region, so a screen reader reads the card's churn back at the person
          operating it. The nearest ancestor's value is the one that applies to a
          subtree, so this switches the card off inside the region it has to sit
          in for layout. Stated rather than asserted: no machine on this project
          runs a screen reader, so this is a reasoned attribute and a candidate
          for the manual roster's desktop-AT item, not a verified one. */}
      {reviewing ? (
        <div aria-live="off">
          <AgentReview
            onClose={clearAgent}
            // The run's own id: the outcome lands on the turn that names it,
            // whether or not the reader is looking at that conversation.
            // The run this card is about, from whichever side knows it: a live
            // turn has it on the store, a settled one on the frozen summary.
            onDecision={(outcome) => {
              const runId = live?.view?.runId ?? s?.runId ?? null;
              if (runId === null) return;
              // The active transcript first, then the run's OWN conversation. The
              // apply is awaited, so the reader may have navigated away by now; the
              // first call reports whether the turn was on screen (myne-md/myne#894
              // review), and a miss is routed the way a settle is.
              if (!markAgentTurnOutcome(runId, outcome)) {
                const conversationId = live?.runConversationId ?? null;
                if (conversationId !== null) {
                  void markOutcomeInConversation(conversationId, runId, outcome);
                }
              }
            }}
            {...(onNotesWritten === undefined ? {} : { onNotesWritten })}
            titleOf={titleOf}
            folderOf={folderOf}
          />
        </div>
      ) : null}
      {/* **The frozen proposal, in place** (myne-md/myne#913). Below the card
          rather than above it: the card is the live decision, and this is the
          record of what was proposed, which is what the card is asking about. */}
      {diffOpen && s?.proposal !== undefined ? (
        <ProposalDiffBody
          proposal={s.proposal}
          titleOf={titleOf}
        />
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
  mentionTargets,
  onOpenNote,
}: {
  turn: ChatTurn;
  onInsert?: (text: string) => void;
  t: TFn;
  mentionTargets?: readonly MentionTarget[];
  onOpenNote?: (noteUuid: string) => void;
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
      <div style={TURN_HEADER_STYLE}>
        <TurnSpeaker isUser={isUser} t={t} />
        {/* Not while it is streaming: a copy of half an answer is a copy the
            user would have to notice was half an answer. */}
        {!turn.streaming && turn.text.length > 0 ? (
          <TurnCopyButton
            text={turn.text}
            label={
              isUser
                ? t("editor.chrome.rightPanel.aiChat.copyYourMessage")
                : t("editor.chrome.rightPanel.aiChat.copyAnswer")
            }
            testId="ai.turn-copy"
            t={t}
          />
        ) : null}
      </div>
      {turn.scopeLabel !== undefined ? (
        <div data-testid="ai.turn-scope" style={CAPTION_STYLE}>
          {t("agent.composer.scopeLabel")}: {turn.scopeLabel}
        </div>
      ) : null}
      {/* **What the message carried** (myne-md/myne#913). The chips used to live
          only above the composer and were cleared on send, so a transcript read
          back later showed a question about a document with no sign of which
          document and no way to open it. The file belongs to the message: it is
          drawn here, and a click opens it.

          `attachment://` serves the bytes on demand, so this is a reference and
          not a second copy. The thumbnail primitive is the library's own, so a
          PDF shows its first page rather than an invented icon. */}
      {isUser && turn.attachments !== undefined && turn.attachments.length > 0 ? (
        <div
          data-testid="ai.turn-attachments"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-1)",
            marginTop: "var(--space-1)",
          }}
        >
          {turn.attachments.map((file) => (
            <Button
              key={file.id}
              variant="ghost"
              type="button"
              data-testid="ai.turn-attachment"
              data-attachment-id={file.id}
              title={file.name}
              onClick={() =>
                showAttachmentLightbox({
                  url: attachmentUrl(file.id),
                  alt: file.name,
                  kind: file.contentType.startsWith("application/pdf")
                    ? "pdf"
                    : "image",
                  id: file.id,
                })
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-1)",
                padding: "2px var(--space-2) 2px 2px",
                background: "var(--bg-2)",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--radius-1)",
                color: "var(--fg-2)",
                fontSize: "var(--text-xs)",
                maxWidth: "100%",
                cursor: "zoom-in",
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 24,
                  height: 24,
                  borderRadius: "var(--radius-1)",
                  overflow: "hidden",
                }}
              >
                <AttachmentThumbnail
                  id={file.id}
                  contentType={file.contentType}
                  filename={file.name}
                  size={24}
                />
              </span>
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {file.name}
              </span>
            </Button>
          ))}
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
          <ChatMarkdown
            text={turn.text}
            testId="ai.turn-text"
            {...(mentionTargets === undefined ? {} : { mentionTargets })}
            {...(onOpenNote === undefined ? {} : { onOpenNote })}
          />
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
  /**
   * Which surface this is (myne-md/myne#848).
   *
   * Required rather than defaulted: the composer's zero state says different
   * things here, and a default would let a third mount inherit the wrong
   * sentence without anything naming it. The two are the agent pane, where the
   * user came looking for an agent and has to pick what it works on, and the
   * sidebar chat, where a note is open beside the box and the scope is simply
   * that note.
   */
  surface: ChatComposerSurface;
  /** Explicit "Insert into note" action for a ready summary. */
  onInsert?: (text: string) => void;
  /** The open note: the agent's default scope in the composer. */
  openNoteId?: string | null;
  /** That note's display name, when the caller knows it (myne-md/myne#913): the
   *  run's `Working on:` line names the note instead of pointing at "this one". */
  openNoteTitle?: string | null;
  /**
   * The note the SESSION is anchored to, when it was opened from one
   * (myne-md/myne#848): the composer pins its scope to it and renders no picker.
   * See `ChatComposer`'s prop for why this is not `openNoteId`. */
  anchoredNoteId?: string | null;
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
  /** The resting cause the frame computed, carried down so the empty transcript
   *  can name the state and expose `data-ai-cause`. The frame owns the host
   *  reads that decide it; the surface owns the region that shows it.
   *
   *  Typed as the id `restingCause.ts` owns rather than as a bare string, so the
   *  name this surface renders and the name the header chip renders come from
   *  ONE function (myne-md/myne#867): they were two switches that agreed by
   *  hand, and a chip naming a fault the transcript explained differently is
   *  what that shape costs. */
  restingCause?: RestingId;
  /** Whether that cause is one of the degraded ones (no model / not answering /
   *  no local AI), so the surface can mark the empty transcript accordingly. */
  degraded?: boolean;
  /**
   * Strings that name a note, from `buildMentionTargets`, and where a press on
   * one lands. Both are optional and travel together: absent means every name in
   * the transcript stays plain text, which is what a caller with no note-set
   * gets, and what every existing test and caller still gets.
   */
  mentionTargets?: readonly MentionTarget[];
  onOpenNote?: (noteUuid: string) => void;
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
  surface,
  onInsert,
  openNoteId = null,
  openNoteTitle = null,
  anchoredNoteId = null,
  folders = NO_FOLDERS,
  onNotesWritten,
  onRunUndone,
  onRunActiveChange,
  onStatusChange,
  confirmRevertRunId = null,
  onConfirmRevertConsumed,
  restingCause,
  degraded = false,
  mentionTargets,
  onOpenNote,
  testId,
}: ConversationSurfaceProps) {
  const { t } = useTranslation();
  const chat = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  // **The surface showing a conversation is what makes it read**
  // (myne-md/myne#848). A run outlives the view, so its result can land while
  // the user is elsewhere; the rail marks that conversation, and this is the
  // other half, the mark clears when the conversation is actually being
  // displayed, and not when some id comparison guesses that it might be.
  const unread = useAgent().unreadConversations;
  // The epoch rather than `getActiveConversationId()` as a dependency: the id
  // is a plain module read with no notification of its own, while the epoch is
  // the boundary the store already publishes for exactly this ("a component
  // holding state that belongs to ONE conversation keys an effect on it").
  const conversationEpoch = useConversationEpoch();
  useEffect(() => {
    const id = getActiveConversationId();
    if (id !== null && unread.includes(id)) markConversationRead(id);
  }, [conversationEpoch, unread]);

  // ONE subscription to the run store, at the surface rather than one per agent
  // turn: the transcript's turns render frozen counts, which need no live read.
  const agent = useAgent();
  // The last-run undo lives here rather than in a strip under the composer
  // (myne-md/myne#741): one mount for the surface, with the offer and report
  // matched onto turns by `runId`.
  const undo = useUndoLastRun({
    agentLastRun,
    agentUndo,
    bumpPrefsNonce,
    ...(onRunUndone === undefined ? {} : { onReverted: onRunUndone }),
  });
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

  // **The run the review card belongs to, and the turn that shows it**
  // (myne-md/myne#894). The rule that decides whether a run is reviewable at all
  // lives in the store (`reviewableRun`), moved there from the old takeover so
  // there is one copy of it. What is decided HERE is only WHICH turn renders it:
  // the live one (no summary frozen onto it yet, the race between `settleStep`
  // and `AGENT_SETTLE`), or the frozen turn whose summary carries the same
  // `runId`. A card rendered by the wrong turn would hang under the wrong
  // message the moment the user sends another one.
  const review = reviewableRun(agent);
  // **The two note questions the review card asks, resolved where the providers
  // are** (myne-md/myne#894). It used to be `Editor.tsx` that answered them (it
  // was the mount point of the takeover); the card now renders inside a
  // transcript turn, and this surface is the nearest ancestor that already holds
  // the resident note set, `AiChatTab` reads the same hook four lines up for
  // note mentions. A map rather than two `find`s per row: a proposal can be forty
  // edits across forty notes, and this is rebuilt once per index change rather
  // than once per lookup.
  const resolverNotes = useResolverNotes();
  const noteById = useMemo(() => {
    const map = new Map<string, { title: string | null; folder: string | null }>();
    for (const note of resolverNotes) {
      map.set(note.noteUuid, { title: note.title, folder: note.folder });
    }
    return map;
  }, [resolverNotes]);
  const titleOf = useCallback(
    (noteId: string): string | null => noteById.get(noteId)?.title ?? null,
    [noteById],
  );
  const folderOf = useCallback(
    (noteId: string): string | null => noteById.get(noteId)?.folder ?? null,
    [noteById],
  );

  // **Stick to the bottom by OBSERVING the content, not by listing causes**
  // (myne-md/myne#894, on the user's report: "it does not scroll down when a new
  // message arrives, neither while working nor when the message completes, it
  // stays aligned with the message I sent").
  //
  // What was here listed two dependencies, `turns.length` and the last turn's
  // text length, and both are blind to an AGENT turn: its text never streams into
  // the bubble (the answer arrives as a settled summary), the footprint's figures
  // tick in place, and the review card appears and grows inside the turn. Every
  // one of those changes the transcript's HEIGHT without changing either
  // dependency, so the reader sat at the bottom of a box that had grown
  // underneath them.
  //
  // A `ResizeObserver` on the content is the version that cannot miss a cause: an
  // attachment finishing its decode, a figure re-rendering, a card expanding, a
  // refusal block arriving, all of them are a size change, and that is the fact
  // being tracked. The `atBottom` latch is unchanged and still the only thing
  // that decides: a reader who has scrolled up is never yanked back down.
  //
  // Feature-detected for the reason `useScrollEdges` states: an unguarded
  // `new ResizeObserver(...)` throws in a host that ships without one, and a
  // transcript that scrolls slightly wrong is not worth a blank screen.
  const atBottomRef = useRef(true);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const pin = (): void => {
      if (!atBottomRef.current) return;
      // Checked rather than assigned blindly: the observer fires on the size
      // CHANGE, and assigning `scrollTop` can itself produce another (a scrollbar
      // appearing), so this makes the second pass a no-op instead of a loop.
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 1) return;
      scroller.scrollTop = scroller.scrollHeight;
    };
    // The first pin is not an observation: a hydrated conversation may already be
    // taller than the box on mount, and nothing will resize for it.
    pin();
    if (typeof ResizeObserver !== "function") {
      // The window fallback still catches the case that matters most on a host
      // without one, and the scroll listener catches the rest.
      window.addEventListener("resize", pin);
      return () => window.removeEventListener("resize", pin);
    }
    const ro = new ResizeObserver(pin);
    // **Re-observe on every childList change, and that is the half that made the
    // first version of this do nothing** (the user's report, one round later:
    // "the chat stays where it is"). The transcript is not the scroller's child
    // at mount: the conversation hydrates asynchronously, so the element that
    // exists when this effect runs is the loading shim, and it is REPLACED by the
    // transcript a moment later. An observer bound to the child that was there at
    // mount is bound to a node that has left the document, and the box it was
    // supposed to watch grew with nobody looking. This is the same discipline
    // `ScrollArea` uses for its own thumb, for the same reason, and it now names
    // the failure it prevents.
    const observeAll = (): void => {
      ro.disconnect();
      // The scroller itself is watched too: a viewport that shrinks has to
      // re-pin as much as content that grows.
      ro.observe(scroller);
      for (const child of Array.from(scroller.children)) ro.observe(child);
    };
    observeAll();
    const mo =
      typeof MutationObserver === "function"
        ? new MutationObserver(() => {
            observeAll();
            pin();
          })
        : null;
    mo?.observe(scroller, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo?.disconnect();
    };
  }, []);

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

      {/* The one scrolling region. Everything below it stays put.
          **`ScrollArea`, not a bare `overflowY`** (myne-md/myne#848, on the
          user's read): the native bar is hidden and the indicator is a real
          element, and that is the only way this scroller gets a correct one.
          A `var()` inside `::-webkit-scrollbar-thumb` does not resolve against
          the scrolled element's cascade, it takes the ROOT's value, which in
          this app is the LIGHT theme's, so the transcript drew a pale bar down
          a dark surface, and that bar paints over the messages beside it
          (myne-md/myne#727, which this region never got). The real thumb is
          inset from the edge, themed, and appears only while the reader is
          actually scrolling. */}
      <ScrollArea
        style={{ flex: 1, minHeight: 0 }}
        scrollerRef={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el === null) return;
          atBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        contentStyle={
          // A flex column only while empty, so the zero state below can FILL the
          // region and centre in it rather than sitting as a card pinned to the
          // top with the composer a screen away. A populated transcript keeps
          // the plain block flow it has always had.
          chat.turns.length === 0
            ? { display: "flex", flexDirection: "column" }
            : undefined
        }
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
                  {...(mentionTargets === undefined ? {} : { mentionTargets })}
                  {...(onOpenNote === undefined ? {} : { onOpenNote })}
                  {...(onNotesWritten === undefined ? {} : { onNotesWritten })}
                  // The LIVE turn is the one the store's run belongs to and that
                  // has nothing frozen onto it yet: that is "running now" AND
                  // "paused on a question", which is why the condition is
                  // `agentSummary === undefined` rather than `running`
                  // (myne-md/myne#848). A run that stopped to ask is not running,
                  // and its turn must still carry the entry that says so.
                  live={
                    turn.agentSummary === undefined && turn.id === liveAgentTurnId
                      ? agent
                      : null
                  }
                  // The card is this turn's when the run it names is this turn's
                  // (myne-md/myne#894). The rule is pure and lives in
                  // `reviewOwnership.ts`, because getting it wrong puts a
                  // proposal under the wrong message.
                  refusals={
                    review !== null &&
                    agent.applied !== null &&
                    hasRefusals(agent.applied) &&
                    reviewCardBelongsToTurn(
                      turn.id,
                      turn.agentSummary?.runId,
                      liveAgentTurnId,
                      review.runId,
                    )
                      ? agent.applied
                      : null
                  }
                  reviewing={
                    review !== null &&
                    reviewCardBelongsToTurn(
                      turn.id,
                      turn.agentSummary?.runId,
                      liveAgentTurnId,
                      review.runId,
                    )
                  }
                  titleOf={titleOf}
                  folderOf={folderOf}
                  t={t}
                  canRevert={
                    undo.run !== null &&
                    turn.agentSummary !== undefined &&
                    turn.agentSummary.runId === undo.run.runId
                  }
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
                <ChatTurnView
                  key={turn.id}
                  turn={turn}
                  onInsert={onInsert}
                  t={t}
                  {...(mentionTargets === undefined ? {} : { mentionTargets })}
                  {...(onOpenNote === undefined ? {} : { onOpenNote })}
                />
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
          // `fill`: the state IS the empty transcript, centred in the space
          // above the composer, not a bordered card at the top of it
          // (docs/decisions/ui/0643). The same component serves the narrow
          // right panel and the agent tab, and filling is what fits both.
          <>
          <EmptyState
            variant={degraded ? "error" : "firstRun"}
            icon={degraded ? "circle-alert" : "message-square"}
            size="sm"
            fill
            title={
              degraded
                ? restingLabel(restingCause ?? "not_ready", t)
                : t("editor.chrome.rightPanel.aiChat.emptyTitle")
            }
            body={
              degraded
                ? restingBody(restingCause ?? "not_ready", t)
                : t("editor.chrome.rightPanel.aiChat.empty")
            }
            testId={degraded ? "ai.status-no-model" : "ai.empty-transcript"}
            rest={
              restingCause === undefined
                ? undefined
                : ({ "data-ai-cause": restingCause } as Record<string, string>)
            }
          />
          {/* The once-only seed offer (myne-md/myne#915). It renders only in the
              healthy zero state: a degraded surface is already saying what is
              wrong, and an offer on top of it would be advice for a feature that
              cannot run. */}
          {degraded ? null : <SeedMemoryCard />}
          </>
        )}
      </ScrollArea>

      {/* The live run: its status, its running scope total, its Stop, and the
          scope-expansion dialog it carries. OUTSIDE the scrolling region and tied
          to the run rather than to a transcript turn, deliberately. */}
      {runOpen ? <AgentProgress /> : null}

      <ChatComposer
        surface={surface}
        openNoteId={openNoteId}
        openNoteTitle={openNoteTitle}
        anchoredNoteId={anchoredNoteId}
        folders={folders}
        onNotesWritten={onNotesWritten}
      />

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
