// AI Chat right-panel tab body (local-ai epic, ai-ux-surface MYND-408, tasks
// 3 + 5).
//
// The canonical render target the AI capability siblings (note-summarization,
// semantic-search-qa) mount their output into. Auto-tag used to render its
// accept-chips here too; MYND-651 moved it to the inline suggestion band at the
// frontmatter boundary, which is now the only tag surface.
//
// **This file is now the FRAME and nothing else** (myne-md/myne#771 task 1). The
// transcript, the composer, the live run strip and the conversation's own modals
// live in `ConversationSurface`, shared with the agent tab's Hub and Focus views
// so the two surfaces cannot drift. What stays here is the panel's furniture: the
// heading, the history / new-chat buttons, the status chip, the honesty
// note and the persist warning.
//
// Because AI ships in the default build as a runtime beta opt-in (decisions.md
// 2026-07-02), the status has THREE resting states: off (`ai_enabled` false),
// no-model (enabled but no generation model side-loaded, so every infer would
// fail `NotReady`, pointing at Settings → Developer → AI), and ready. The
// "AI thinking…" busy state is the live run strip the surface renders.
//
// Inference is local by default and remote only where the user has named a
// provider, consented and stored a key (#414/#415); the AI settings panel states
// the bounded guarantee.
//
// **Layout: this component owns the tab body's whole height.** Header is fixed,
// and the surface below it sizes to the rest. That is what makes it read as a
// chat rather than as a page with an input somewhere down it, and it is what lets
// the composer stay where the user last left their hands.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { usePrefs } from "../../hooks/usePrefs";
import {
  useAiBackendClass,
  useAiSurfaceState,
} from "../../hooks/useAiModelReady";
import { reviewableRun, useAgent } from "../agent/agentStore";
import { useChat } from "../ai/chatStore";
import {
  conversationNoteId,
  keepConversationPinned,
  requestNoteSwitch,
  setConversationNote,
  setKeepConversationPinned,
  takeNoteSwitch,
} from "../ai/conversationBinding";
import { buildMentionTargets } from "../ai/noteMentions";
import { useResolverNotes } from "../resolverNotes";
import { useWorkspace } from "../workspaceContext";
import { aiChatHonestyNote } from "../../lib/load-bearing-copy";
import { IconButton } from "../../components/primitives/IconButton";
import { Tooltip } from "../../components/primitives/Tooltip";
import {
  restingBody,
  restingIdOf,
  restingIsDegraded,
  restingLabel,
  type RestingId,
} from "../ai/restingCause";
import { startNewConversation } from "../ai/startNewConversation";
import { providerLabelOf } from "../../lib/ai-capability";
import { SECTION_HEADING_STYLE } from "./sharedStyles";
import { ChatHistoryModal } from "./ChatHistoryModal";
import {
  ConversationSurface,
  type ConversationSurfaceStatus,
} from "../ai/ConversationSurface";

const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
  flexWrap: "wrap",
  rowGap: "var(--space-1)",
};

const HEADER_ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  flex: 1,
  minWidth: 0,
  flexWrap: "wrap",
  gap: "var(--space-1)",
  rowGap: "var(--space-1)",
};


/** Optional handlers the Editor wires; absent in isolation (e.g. tests). */
export interface AiChatTabProps {
  /** Explicit "Insert into note" action for a ready summary (task 5, SYNC-17).
   *  When absent, the insert affordance is not shown. */
  onInsert?: (text: string) => void;
  /** The open note: the agent's default scope in the composer's scope picker. */
  openNoteId?: string | null;
  /** Folders the user can attach as an agent scope. */
  folders?: readonly string[];
  /** Called with the ids of notes an automatic apply wrote, so the open pane
   *  re-reads them (myne-md/myne#551). */
  onNotesWritten?: (noteIds: readonly string[]) => void;
  /** Called after an agent-run undo reverted notes on disk, with their ids. */
  onRunUndone?: (noteIds: readonly string[]) => void;
  /**
   * Open Settings, optionally on a panel and scrolled to a setting.
   *
   * Used by the memory popover's "Manage in Settings" link (no arguments: the
   * default landing is right for it) and by the status chip, which names a
   * fault and needs to land ON the control that clears it rather than at the
   * top of a panel. Absent in isolation (e.g. tests): the popover's link then
   * just closes it, and the chip is not a button at all.
   */
  onOpenSettings?: (panel?: string, anchor?: string) => void;
  /** Move from the light panel to the agent tab, on the open note's Focus view
   *  (myne-md/myne#771). The panel-to-deep-surface exit. Absent in isolation:
   *  the button is not rendered. */
  onFocusAgent?: () => void;
}

export function AiChatTab({
  onOpenSettings,
  onInsert,
  openNoteId = null,
  folders,
  onNotesWritten,
  onRunUndone,
  onFocusAgent,
}: AiChatTabProps = {}) {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const aiEnabled = prefs.ai_enabled;
  // **Note mentions in an answer** (myne-md/myne#867). The vault's own note set,
  // projected to the strings that name a note, plus where a press lands. The
  // projection is memoized on the note set's identity, which is what
  // `useResolverNotes` already stabilises; `openNewTabInFocused` is the SAME
  // call the workspace's own "open in a new tab" makes, so a mention opens a tab
  // exactly as the sidebar would, and neither this surface nor the renderer
  // performs a navigation of its own.
  const ws = useWorkspace();
  const resolverNotes = useResolverNotes();
  const mentionTargets = useMemo(
    () => buildMentionTargets(resolverNotes),
    [resolverNotes],
  );
  const openMention = useCallback(
    (noteUuid: string) => ws.openNewTabInFocused(noteUuid),
    [ws],
  );
  // The open note's name for the run's `Working on:` line (myne-md/myne#913),
  // read from the resolver set the mentions already carry.
  const openNoteTitle =
    openNoteId === null || openNoteId === ""
      ? null
      : (resolverNotes.find((note) => note.noteUuid === openNoteId)?.title ?? null);
  // One host read, four states (#191 task 1) — replacing a private
  // `get_model_path` probe that could only say yes/no and defaulted to no.
  const backend = useAiSurfaceState(aiEnabled);
  // **Who is actually serving, asked of the HOST.** The chip and the honesty
  // note both name a backend, and naming one from `prefs.ai_provider` names
  // what the user INTENDED: `active()` falls back to the local arm on six other
  // conditions, so a provider named and never finished reads as "answered by
  // OpenRouter" while every request goes in-process. That is myne-md/myne#466's
  // defect. The NAME still comes from the preferences, because only they carry
  // it; it is shown only for the class the host says is active.
  const backendClass = useAiBackendClass(aiEnabled);
  const activeProviderName =
    backendClass === "remote" ? (providerLabelOf(prefs.ai_provider) ?? null) : null;
  // **The host names the cause; this only decides whether there is one.** Every
  // arm reaches `restingCause.ts`, which the chip, its tooltip and the
  // transcript's empty state all share, so they cannot name the same fault two
  // ways (myne-md/myne#867). The bucket that used to live here turned consent
  // missing, no credential, no model chosen and "nothing named at all" into one
  // sentence, "No provider", on a vault whose provider was named.
  const restingId: RestingId = !aiEnabled
    ? "off"
    : backend.kind === "absent"
      ? "unavailable"
      : backend.kind === "unavailable"
        ? restingIdOf(backend.cause)
        : "ready";
  const degraded = restingIsDegraded(restingId);
  const ready = aiEnabled && !degraded;

  const chat = useChat();
  const agent = useAgent();
  /**
   * **A conversation belongs to the note it was started on** (myne-md/myne#913).
   *
   * The panel held ONE transcript whatever the editor had open, so moving to
   * the next note left the previous note's conversation sitting beside it: the
   * turns named a note the user was no longer looking at, and the next message
   * was a continuation of a thread about something else. Switching notes now
   * starts a fresh conversation, which is what makes the panel feel attached to
   * the note rather than to the app.
   *
   * The escape hatch is `keepConversation`: an EXPLICIT pin, because the case it
   * serves (driving one conversation across two notes in a split pane) is a
   * deliberate act, and a default that kept the conversation is the behaviour
   * this change removes.
   *
   * Session state, not a preference: it is about this working session, and a
   * user who pinned a conversation yesterday did not ask for yesterday's
   * conversation to survive a restart.
   */
  // **Held in `conversationBinding`, not here** (myne-md/myne#913, review round
  // two): this component unmounts on every right-panel tab switch, so a
  // `useState` pin silently reset and a `useRef` deferred switch was dropped.
  // Both are session facts, and the session outlives the tab.
  const [keepConversation, setKeepConversationState] = useState(
    keepConversationPinned,
  );
  const setKeepConversation = useCallback((next: boolean) => {
    setKeepConversationPinned(next);
    setKeepConversationState(next);
  }, []);
  /**
   * The note whose conversation the panel is showing, and the transcript's size,
   * both read through refs so the effect that compares notes does not re-run
   * when the transcript grows (each streamed turn would otherwise look like a
   * note switch).
   *
   * **It tracks the last note that HAD a conversation, not the last note the
   * panel saw.** The first version updated it on every change, including the
   * move to "no note open", so closing note A and then opening note B looked
   * like a first mount and B kept A's transcript.
   */
  const lastConversationNoteRef = useRef<string | null>(conversationNoteId());
  const turnsRef = useRef(0);
  turnsRef.current = chat.turns.length;
  const runningRef = useRef(false);
  runningRef.current = agent.running;

  useEffect(() => {
    // No destination yet: closing the last note is not a switch, and there is
    // nothing to compare until a note is open again.
    if (openNoteId === null || openNoteId === "") return;
    const previous = lastConversationNoteRef.current;
    if (previous === null) {
      // First note of the session; the remembering effect above takes over as
      // soon as the conversation has a turn in it.
      return;
    }
    if (previous === openNoteId) return;
    lastConversationNoteRef.current = openNoteId;
    setConversationNote(openNoteId);
    if (keepConversation) return;
    // Nothing to abandon yet.
    if (turnsRef.current === 0) return;
    // **A run in flight is DEFERRED, not dropped** (myne-md/myne#913). Cancelling
    // it here would throw away work the user asked for, but returning without a
    // record was the same defect one step later: the switch never happened, so
    // the next message continued the OLD note's conversation beside the new one,
    // which is the behaviour this change exists to remove. The flag makes the
    // switch happen when the run settles.
    if (runningRef.current) {
      requestNoteSwitch();
      return;
    }
    startNewConversation();
  }, [keepConversation, openNoteId]);

  // **Declared AFTER the switch effect, not before it** (myne-md/myne#913): both
  // run on the same render, and a remembering effect that advanced the ref first
  // made the switch effect compare the new note against itself, so nothing was
  // ever cleared. Declaration order is the ordering here.
  //
  // It remembers the note as soon as its conversation has something in it, so a
  // later switch has something to compare against.
  useEffect(() => {
    if (openNoteId === null || openNoteId === "") return;
    if (chat.turns.length === 0) return;
    lastConversationNoteRef.current = openNoteId;
    setConversationNote(openNoteId);
  }, [chat.turns.length, openNoteId]);

  /**
   * The switch a note change asked for while a run was in flight.
   *
   * **A proposal waiting for review is the one case that keeps the
   * conversation.** Clearing it would destroy an unapplied proposal the user has
   * not seen, worse than a transcript about the previous note, and the review
   * screen is the only surface that can apply or reject it. The flag is taken
   * either way so a later settle cannot come back and clear it by surprise.
   */
  useEffect(() => {
    if (agent.running) return;
    if (!takeNoteSwitch()) return;
    if (keepConversation) return;
    if (reviewableRun(agent) !== null) return;
    startNewConversation();
  }, [agent, keepConversation]);
  // Conversation history modal (myne-md/myne#675): tab-local boolean, mounted
  // only while open so every opening re-fetches the roster.
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * Whether the user has expanded the honesty note back open.
   *
   * Session state, not a pref: the note is clamped because a reader has just
   * read it, and "just" resets when the panel is remounted. Persisting a
   * dismissal would make the claim something a user turns off once, which is
   * not what a threat-model-bounded sentence is for.
   */
  const [honestyOpen, setHonestyOpen] = useState(false);
  /**
   * Clamped exactly when there is a conversation AND the user has not opened it
   * back up. An empty transcript is the moment the claim is being made, so it
   * is never clamped there — which is also why no persisted dismissal exists.
   */
  const honestyClamped = chat.turns.length > 0 && !honestyOpen;

  /**
   * Whether the chip names something the user can act on, and the sentence
   * saying how.
   *
   * A total switch rather than a lookup, for the reason every helper on this
   * surface gives: `scripts/check-i18n.mjs` verifies STATIC `t("…")` call
   * sites, so a key assembled from a variable is a key it cannot see. `off` is
   * deliberately absent — AI being switched off is a state the user chose, and
   * a chip offering to undo a deliberate choice is nagging.
   */
  //
  // The sentence for a host cause is the taxonomy's own (`providerError.*`),
  // and it is the SAME one the transcript renders, so the tooltip and the
  // transcript are one statement rather than two that have to be kept in step.
  const STATUS_HINT = degraded ? restingBody(restingId, t) : "";
  // `unavailable` is a build without local AI and `off` is the user's own
  // switch: neither has a setting that would change it, so neither gets a
  // click target. Offering one would be a control that goes somewhere and
  // changes nothing.
  const actionableStatus = STATUS_HINT !== "" && onOpenSettings !== undefined;
  // The surface reports the frame facts the header dresses. Lifted rather than
  // rendered in the surface, because the agent tab does not show either of them.
  const [surfaceStatus, setSurfaceStatus] = useState<ConversationSurfaceStatus>({
    persistLagging: false,
    undoRunId: null,
    undoHosted: false,
  });
  // The header's fallback revert hands the run id down to the surface's confirm.
  const [fallbackRevertRunId, setFallbackRevertRunId] = useState<string | null>(null);

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
        <div style={HEADER_ACTIONS_STYLE}>
          <IconButton
            icon="clock"
            label={t("editor.chrome.rightPanel.aiChat.history")}
            tooltip
            expanded={historyOpen}
            testId="ai.history-button"
            onClick={() => setHistoryOpen(true)}
          />
          {/* **The memory button used to sit here, and it is gone**
              (myne-md/myne#1020, the owner's call): one icon in the chat header
              opening "what the assistant remembers", a surface Settings > AI >
              Memory already owns in full (list, edit, delete, clear,
              personality). A second, narrower door onto the same rows was one
              affordance too many in the one strip that has to stay quiet while
              a conversation is being read. */}
          {onFocusAgent !== undefined ? (
            <IconButton
              icon="maximize-2"
              label={t("editor.chrome.rightPanel.aiChat.focusAgent")}
              tooltip
              testId="ai.focus-agent"
              onClick={onFocusAgent}
            />
          ) : null}
          {chat.turns.length > 0 ? (
            <IconButton
              testId="ai.new-chat"
              icon="plus"
              label={t("editor.chrome.rightPanel.aiChat.newChat")}
              tooltip
              // The whole sequence — cancel the run host-side, then clear the
              // transcript and the store — lives in `startNewConversation`,
              // because the agent hub needs the same act and its ordering is
              // load-bearing. Two copies is how one of them loses the cancel.
              onClick={startNewConversation}
            />
          ) : null}
          {/* **Keep this conversation** (myne-md/myne#913). A pin rather than
              a menu entry: it is a state the panel is IN, and the state has to
              be visible after the press, because the whole point is that the
              next note switch will not throw the transcript away. `active` is
              what carries that, into `aria-pressed` and into the glyph's
              painted state, so it is not a colour a sighted user alone can see.
              Shown only beside a conversation: pinning an empty one would say
              the panel had something to keep. */}
          {chat.turns.length > 0 ? (
            <>
              <IconButton
                icon="pin"
                label={
                  keepConversation
                    ? t("agent.composer.keepConversationPinned")
                    : t("agent.composer.keepConversation")
                }
                tooltip
                active={keepConversation}
                testId="ai.keep-conversation"
                onClick={() => setKeepConversation(!keepConversation)}
              />
              {keepConversation ? (
                <span
                  data-testid="ai.keep-conversation-mark"
                  className="myne-pill"
                  style={{ fontSize: "var(--text-xs)" }}
                >
                  {t("agent.composer.keepConversationPinned")}
                </span>
              ) : null}
            </>
          ) : null}
          {/* The fallback revert offer (myne-md/myne#741). Shown only when the
              host holds an undoable record that no turn in the open transcript
              can host, which is New chat and a switched conversation. It hands
              the run id to the surface, which owns the confirm. */}
          {surfaceStatus.undoRunId !== null && !surfaceStatus.undoHosted ? (
            <IconButton
              testId="ai.revert-fallback"
              icon="rotate-ccw"
              label={t("editor.chrome.rightPanel.aiChat.revertRun")}
              tooltip
              onClick={() => setFallbackRevertRunId(surfaceStatus.undoRunId)}
            />
          ) : null}
          {surfaceStatus.persistLagging ? (
            <span
              data-testid="ai.persist-warning"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--danger)",
              }}
            >
              {t("editor.chrome.rightPanel.aiChat.persistWarning")}
            </span>
          ) : null}
          {/* **The chip says what is wrong; this is where it says what to do**
              (myne-md/myne#771).

              It was a `<span>`: a passive label naming a fault with no route
              out of it. The degraded chip is now a button carrying the
              taxonomy's own sentence as its tooltip and opening Settings on the
              models block. `check-i18n.mjs` cannot see a key that is never
              rendered — it verifies a USED key exists, not that an existing key
              is used — so the sentence and the control that clears the fault it
              names are one surface.

              The healthy chip stays a `<span>`: naming the provider that is
              answering is a statement, and a statement with a click target
              invites a press that would do nothing useful. */}
          {actionableStatus ? (
            <Tooltip label={STATUS_HINT}>
              <button
                type="button"
                data-testid="ai.chrome-status"
                data-ai-enabled={aiEnabled ? "true" : "false"}
                data-ai-model-ready={aiEnabled ? (degraded ? "false" : "true") : ""}
                data-ai-cause={restingId}
                data-actionable="true"
                onClick={() => onOpenSettings?.("ai", "ai.models")}
                className="myne-pill"
                data-interactive="true"
                data-tone={aiEnabled && !degraded ? "ready" : undefined}
              >
                {restingId !== "ready"
                  ? restingLabel(restingId, t)
                  : (activeProviderName ??
                    t("editor.chrome.rightPanel.aiChat.statusReady"))}
              </button>
            </Tooltip>
          ) : (
            <span
              data-testid="ai.chrome-status"
              data-ai-enabled={aiEnabled ? "true" : "false"}
              data-ai-model-ready={aiEnabled ? (degraded ? "false" : "true") : ""}
              data-ai-cause={restingId}
              className="myne-pill"
              data-tone={aiEnabled && !degraded ? "ready" : undefined}
            >
              {restingId !== "ready"
                ? restingLabel(restingId, t)
                : (activeProviderName ??
                  t("editor.chrome.rightPanel.aiChat.statusReady"))}
            </span>
          )}
        </div>
      </div>
      {/* Honest framing (task 13): rendered VERBATIM (load-bearing copy, never
          i18n'd) — a weak on-device model is fallible, so the user is told to
          verify against the cited notes. Must not over-claim.

          **It is clamped once there is a conversation, never hidden**
          (myne-md/myne#771). At panel width the sentence is three lines, and it
          sat above the transcript on every render: a permanent third of the
          surface spent re-telling a reader something they were told when they
          arrived. It stays FULLY EXPANDED while the transcript is empty, which
          is the moment the claim is being made, and clamps to one line after
          the first turn with a control that expands it again.

          The text is in the DOM either way — clamped, not conditionally
          rendered — so it is present to a screen reader, to a text search and
          to `tests/components/AiChatTab.test.tsx`, which asserts the exact
          wording. What is reduced is how much room a sentence the user has read
          takes from the thing they came for. */}
      {ready && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-1)" }}>
          {/* The claim, rendered verbatim (load-bearing copy, never i18n'd).

              It was a `<button>` that opened a popover restating what leaves,
              who receives it and how to revoke: four answers to a sentence the
              user had just read, in a box that pushed the transcript down and
              duplicated the consent surface's own enumeration
              (`CONSENT_WHAT_LEAVES` and its siblings in `@myne/copy`, which is
              where the full text lives and what the CTA below opens). The user
              reported it as redundancy (issue #970, item 6): one line says what
              the claim is, and the place that spells it out is one press away.

              So this is a `<p>` again, with the SAME constant as its text,
              E2E-pinned by literal equality, so the element change must not
              move a character of it. */}
          <p
            data-testid="ai.honesty-note"
            data-clamped={honestyClamped ? "true" : undefined}
            style={{
              fontSize: "var(--text-xs)",
              lineHeight: 1.4,
              color: "var(--fg-3)",
              margin: 0,
              flex: 1,
              minWidth: 0,
              ...(honestyClamped
                ? {
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical" as const,
                    WebkitLineClamp: 1,
                    overflow: "hidden",
                  }
                : {}),
            }}
          >
            {aiChatHonestyNote(activeProviderName)}
          </p>
          {chat.turns.length > 0 ? (
            <IconButton
              icon={honestyOpen ? "chevron-up" : "chevron-down"}
              label={t(
                // The catalog's path is authoritative and these two live under
                // `agentTurn.*` (their copy is the clamping pair, "Show the full
                // note" / "Shorten the note", which is what this chevron does).
                // The call used to omit `agentTurn.`, so the control rendered the
                // raw key path as its label and tooltip: `check-i18n.mjs` reads
                // `t("…")` literals, and a key inside a ternary is not one. The
                // guard scans expressions now, which is what found this.
                honestyOpen
                  ? "editor.chrome.rightPanel.aiChat.agentTurn.honestyCollapse"
                  : "editor.chrome.rightPanel.aiChat.agentTurn.honestyExpand",
              )}
              tooltip
              iconSize={12}
              expanded={honestyOpen}
              testId="ai.honesty-toggle"
              onClick={() => setHonestyOpen((open) => !open)}
            />
          ) : null}
        </div>
      )}
      {/* **No CTA here, and the absence is the decision** (owner, 2026-11-08).
          This surface used to draw a pill under the sentence above that opened
          Settings → AI → provider, on the argument that the full text of what
          leaves ("CONSENT_WHAT_LEAVES" and its siblings) lives on that screen and
          one link beat a second, shorter copy.

          Two things were wrong with it. The sentence directly above already names
          the provider and says the model is not Myne's, so the pill repeated what
          the reader had just been told one line earlier; and putting a Settings
          door in the middle of a chat panel is a control whose target is three
          screens away from what the user was doing. The consent text is still
          reachable — it is the AI panel's own screen, where someone who wants to
          read it goes. A chat panel does not need to send them.
          `ai.notice-settings` is gone from the surface and from its tests. */}
      {/* The conversation itself, shared with the agent tab. Gated on
          `ai_enabled` so the composer is reachable in the stub E2E build and in
          a no-model state, where a send surfaces the honest error turn. */}
      {aiEnabled ? (
        <ConversationSurface
          testId="ai.chat-panel-surface"
          {...(onInsert === undefined ? {} : { onInsert })}
          openNoteId={openNoteId}
          openNoteTitle={openNoteTitle}
          {...(folders === undefined ? {} : { folders })}
          {...(onNotesWritten === undefined ? {} : { onNotesWritten })}
          {...(onRunUndone === undefined ? {} : { onRunUndone })}
          onStatusChange={setSurfaceStatus}
          confirmRevertRunId={fallbackRevertRunId}
          onConfirmRevertConsumed={() => setFallbackRevertRunId(null)}
          restingCause={restingId}
          degraded={degraded}
          mentionTargets={mentionTargets}
          onOpenNote={openMention}
        />
      ) : null}

      {historyOpen ? (
        <ChatHistoryModal open onClose={() => setHistoryOpen(false)} />
      ) : null}
    </div>
  );
}
