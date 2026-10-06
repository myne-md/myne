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
// heading, the history / memory / new-chat buttons, the status chip, the honesty
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

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { usePrefs } from "../../hooks/usePrefs";
import {
  useAiBackendClass,
  useAiRetrievalState,
  useAiSurfaceState,
} from "../../hooks/useAiModelReady";
import { useChat } from "../ai/chatStore";
import { aiChatHonestyNote } from "../../lib/load-bearing-copy";
import { IconButton } from "../../components/primitives/IconButton";
import { Tooltip } from "../../components/primitives/Tooltip";
import { startNewConversation } from "../ai/startNewConversation";
import { providerLabelOf } from "../../lib/ai-capability";
import { SECTION_HEADING_STYLE } from "./sharedStyles";
import { ChatHistoryModal } from "./ChatHistoryModal";
import { MemoryPopover } from "./MemoryPopover";
import {
  ConversationSurface,
  type ConversationSurfaceStatus,
} from "../ai/ConversationSurface";

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
  /** Toast sink for the memory popover's one-shot outcomes (delete saved /
   *  failed). Absent in isolation: the popover still deletes, it just
   *  reports nothing. */
  onShowToast?: (message: string) => void;
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
  onShowToast,
  onFocusAgent,
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
  // conditions, so a provider named and never finished reads as "answered by
  // OpenRouter" while every request goes in-process. That is myne-md/myne#466's
  // defect. The NAME still comes from the preferences, because only they carry
  // it; it is shown only for the class the host says is active.
  const backendClass = useAiBackendClass(aiEnabled);
  const activeProviderName =
    backendClass === "remote" ? (providerLabelOf(prefs.ai_provider) ?? null) : null;
  // **Asking needs a second capability, and the header used to read only the
  // first** (myne-md/myne#545). `backend` above is the GENERATION row; asking is
  // retrieval-grounded, retrieval is refused a remote provider outright
  // (SYNC-16), and the embedding model is not bundled. So a user with a working
  // provider and no local search model saw the provider's name — which reads as
  // ready — on a surface that refused every turn.
  const retrieval = useAiRetrievalState(aiEnabled);
  const noSearchModel =
    retrieval.embedding.kind === "unavailable" ||
    retrieval.embedding.kind === "absent";
  const gettingReady =
    !noSearchModel &&
    retrieval.embedding.kind === "available" &&
    !retrieval.indexReady;
  const resting: RestingCause = !aiEnabled
    ? "off"
    : backend.kind === "absent"
      ? "unavailable"
      : backend.kind === "unavailable"
        ? NOT_ANSWERING.has(backend.cause ?? "")
          ? "unreachable"
          : "no-provider"
        : "ready";
  const noModel = resting === "no-provider" || resting === "unreachable" || resting === "unavailable";
  const ready = aiEnabled && !noModel;

  const chat = useChat();
  // Conversation history modal (myne-md/myne#675): tab-local boolean, mounted
  // only while open so every opening re-fetches the roster.
  const [historyOpen, setHistoryOpen] = useState(false);
  // Memory popover (myne-md/myne#697): tab-local boolean like the history modal.
  const [memoryOpen, setMemoryOpen] = useState(false);
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
  const STATUS_HINT = noSearchModel
    ? t("editor.chrome.rightPanel.aiChat.noSearchModelHint")
    : resting === "no-provider"
      ? t("editor.chrome.rightPanel.aiChat.noModelHint")
      : resting === "unreachable"
        ? t("editor.chrome.rightPanel.aiChat.unreachableHint")
        : "";
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
          <div style={{ position: "relative", display: "inline-flex" }}>
            <IconButton
              icon="bookmark"
              label={t("editor.chrome.rightPanel.aiChat.memory")}
              tooltip
              // A disclosure, so it says whether it is open. It is a toggle in
              // behaviour and was silent about it: a screen-reader user pressed
              // it twice and heard the same thing both times.
              expanded={memoryOpen}
              testId="ai.memory-button"
              onClick={() => setMemoryOpen((open) => !open)}
            />
            {/* The popover and its button share ONE `position: relative`
                container, so the popover's `bottom: 100%; right: 0` anchors to
                the BUTTON rather than to wherever it sits in the flow. Before
                this it rendered down by the composer (its old `{memoryOpen ? …}`
                slot), so opening it from the header icon painted the card below
                the header, half outside the panel and over the composer
                (myne-md/myne#574). */}
            {memoryOpen ? (
              <MemoryPopover
                onClose={() => setMemoryOpen(false)}
                onOpenSettings={() => {
                  setMemoryOpen(false);
                  // The settings shell opens from the Editor, which passes the
                  // opener down. Absent in isolation: the link then just closes.
                  onOpenSettings?.();
                }}
                onShowToast={onShowToast ?? (() => {})}
              />
            ) : null}
          </div>
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
              out of it. Worse, the sentence that WAS written to give that
              route — `noSearchModelHint`, "Asking searches your notes on this
              device, and that needs a search model here… Choose one in
              Settings → Developer → AI" — was rendered nowhere at all, in any
              client. Somebody wrote it, 31 locales translated it, and it has
              never been on a screen. `check-i18n.mjs` cannot see that: it
              verifies a USED key exists, not that an existing key is used.

              So the degraded chip is a button carrying that sentence as its
              tooltip and opening Settings on the models block. The healthy
              chip stays a `<span>`: naming the provider that is answering is a
              statement, and a statement with a click target invites a press
              that would do nothing useful. */}
          {actionableStatus ? (
            <Tooltip label={STATUS_HINT}>
              <button
                type="button"
                data-testid="ai.chrome-status"
                data-ai-enabled={aiEnabled ? "true" : "false"}
                data-ai-model-ready={aiEnabled ? (noModel ? "false" : "true") : ""}
                data-ai-cause={resting}
                data-actionable="true"
                onClick={() => onOpenSettings?.("ai", "ai.models")}
                className="myne-pill"
                data-interactive="true"
                data-tone={aiEnabled && !noModel ? "ready" : undefined}
              >
                {resting !== "ready"
                  ? chipKey(resting, t)
                  : noSearchModel
                    ? t("editor.chrome.rightPanel.aiChat.statusNoSearchModel")
                    : gettingReady
                      ? t("editor.chrome.rightPanel.aiChat.statusGettingReady")
                      : (activeProviderName ??
                        t("editor.chrome.rightPanel.aiChat.statusReady"))}
              </button>
            </Tooltip>
          ) : (
            <span
              data-testid="ai.chrome-status"
              data-ai-enabled={aiEnabled ? "true" : "false"}
              data-ai-model-ready={aiEnabled ? (noModel ? "false" : "true") : ""}
              data-ai-cause={resting}
              className="myne-pill"
              data-tone={aiEnabled && !noModel ? "ready" : undefined}
            >
              {resting !== "ready"
                ? chipKey(resting, t)
                : noSearchModel
                  ? t("editor.chrome.rightPanel.aiChat.statusNoSearchModel")
                  : gettingReady
                    ? t("editor.chrome.rightPanel.aiChat.statusGettingReady")
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
                honestyOpen
                  ? "editor.chrome.rightPanel.aiChat.honestyCollapse"
                  : "editor.chrome.rightPanel.aiChat.honestyExpand",
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

      {/* The conversation itself, shared with the agent tab. Gated on
          `ai_enabled` so the composer is reachable in the stub E2E build and in
          a no-model state, where a send surfaces the honest error turn. */}
      {aiEnabled ? (
        <ConversationSurface
          testId="ai.chat-panel-surface"
          {...(onInsert === undefined ? {} : { onInsert })}
          openNoteId={openNoteId}
          {...(folders === undefined ? {} : { folders })}
          {...(onNotesWritten === undefined ? {} : { onNotesWritten })}
          {...(onRunUndone === undefined ? {} : { onRunUndone })}
          onStatusChange={setSurfaceStatus}
          confirmRevertRunId={fallbackRevertRunId}
          onConfirmRevertConsumed={() => setFallbackRevertRunId(null)}
          restingCause={resting}
          degraded={noModel}
        />
      ) : null}

      {historyOpen ? (
        <ChatHistoryModal open onClose={() => setHistoryOpen(false)} />
      ) : null}
    </div>
  );
}
