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
// Inference is local — no provider call, ever (the trust affordance in the AI
// settings panel states the bounded guarantee).

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { usePrefs } from "../../hooks/usePrefs";
import { useAiModelReady } from "../../hooks/useAiModelReady";
import { useChat, type ChatCitation, type ChatTurn } from "../ai/chatStore";
import { AI_CHAT_HONESTY_NOTE } from "../../lib/load-bearing-copy";
import { SECTION_HEADING_STYLE } from "./sharedStyles";

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
  /** Send a message to the conversational chat (conversational-ai-chat task 5).
   *  When wired, the transcript composer replaces the single-shot ask input.
   *  The real streaming invoke is wired by task 7. */
  onSend?: (message: string) => void;
  /** Stop an in-flight streaming generation (task 9). Shown as a "Stop" control
   *  in the composer while `chat.streaming`. */
  onStop?: () => void;
  /** Navigate to a source note from a citation chip (task 8). */
  onOpenNote?: (noteId: string, byteStart: number, byteEnd: number) => void;
  /** Resolve a note id to its title for the citation chip label (task 8). When
   *  absent, chips fall back to a short id prefix. */
  titleOf?: (noteId: string) => string | null;
  /** Show the "getting ready" chrome (embed-on-unlock still indexing — the
   *  compute-lock contention wait). Default false. */
  gettingReady?: boolean;
}

const ASK_INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "5px 8px",
};

const ASK_SUBMIT_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-2)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "5px 10px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const TURN_TEXT_STYLE: CSSProperties = { fontSize: "var(--text-sm)", lineHeight: 1.5 };

/** One source-note citation chip under a grounded assistant turn. Clicking opens
 *  the source note (`onOpenNote`, task 8; disabled when absent). The label is the
 *  note title when resolvable (`titleOf`), else a short id prefix. */
function CitationChip({
  citation,
  onOpenNote,
  titleOf,
}: {
  citation: ChatCitation;
  onOpenNote?: (noteId: string, byteStart: number, byteEnd: number) => void;
  titleOf?: (noteId: string) => string | null;
}) {
  const title = titleOf?.(citation.noteId) ?? null;
  const label = title !== null && title.length > 0 ? title : citation.noteId.slice(0, 8);
  return (
    <button
      type="button"
      data-testid="ai.citation"
      data-note-id={citation.noteId}
      title={label}
      onClick={() => onOpenNote?.(citation.noteId, citation.byteStart, citation.byteEnd)}
      disabled={onOpenNote === undefined}
      style={{
        fontSize: "var(--text-xs)",
        color: "var(--fg-2)",
        background: "var(--bg-1)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-1)",
        padding: "1px 6px",
        cursor: onOpenNote ? "pointer" : "default",
        maxWidth: 160,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontFamily: title !== null ? "var(--font-sans)" : "var(--font-mono)",
      }}
    >
      {label}
    </button>
  );
}

/** One transcript turn (user or assistant). Assistant turns render the streaming
 *  caret, the error state, and the citation chips. Design uses design-token CSS
 *  variables only (no hex), per `src/CLAUDE.md`. */
function ChatTurnView({
  turn,
  onOpenNote,
  titleOf,
  onInsert,
  t,
}: {
  turn: ChatTurn;
  onOpenNote?: (noteId: string, byteStart: number, byteEnd: number) => void;
  titleOf?: (noteId: string) => string | null;
  onInsert?: (text: string) => void;
  t: (key: string) => string;
}) {
  const isUser = turn.role === "user";
  return (
    <div
      data-testid="ai.turn"
      data-role={turn.role}
      data-streaming={turn.streaming ? "true" : "false"}
      style={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "92%",
        background: isUser ? "var(--bg-2)" : "var(--paper-2)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-1)",
        padding: "6px 9px",
      }}
    >
      <div style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-medium)", color: "var(--fg-3)", marginBottom: 2 }}>
        {isUser
          ? t("editor.chrome.rightPanel.aiChat.you")
          : t("editor.chrome.rightPanel.aiChat.assistant")}
      </div>
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
      {/* Empty finalized answer (the small model produced nothing) → a friendly
          placeholder instead of a blank bubble. */}
      {!isUser && !turn.streaming && !turn.error && turn.text.length === 0 && (
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
          style={{ ...TURN_TEXT_STYLE, color: "var(--fg-3)", margin: "4px 0 0" }}
        >
          {t("editor.chrome.rightPanel.aiChat.errorTurn")}
        </p>
      )}
      {turn.citations.length > 0 && (
        <div
          data-testid="ai.citations"
          style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-1)", marginTop: 6 }}
        >
          <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
            {t("editor.chrome.rightPanel.aiChat.citations")}
          </span>
          {turn.citations.map((c, i) => (
            <CitationChip
              key={`${c.noteId}-${c.byteStart}-${i}`}
              citation={c}
              onOpenNote={onOpenNote}
              titleOf={titleOf}
            />
          ))}
        </div>
      )}
      {/* Per-turn "Insert into note" for a summary answer (task 10, SYNC-17). */}
      {turn.insertable && onInsert && !turn.streaming && turn.text.length > 0 && (
        <button
          type="button"
          data-testid="ai.insert-turn"
          onClick={() => onInsert(turn.text)}
          style={{
            marginTop: "var(--space-2)",
            fontSize: 12,
            fontWeight: "var(--weight-medium)",
            color: "var(--fg-2)",
            background: "var(--bg-2)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-1)",
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          {t("editor.chrome.rightPanel.aiChat.insert")}
        </button>
      )}
    </div>
  );
}

export function AiChatTab({
  onInsert,
  onSend,
  onStop,
  onOpenNote,
  titleOf,
  gettingReady = false,
}: AiChatTabProps = {}) {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const aiEnabled = prefs.ai_enabled;
  // Enabled but no model side-loaded → the engine can't produce output yet.
  const modelReady = useAiModelReady(aiEnabled);
  const noModel = aiEnabled && modelReady === false;
  const ready = aiEnabled && !noModel;
  const chat = useChat();
  const [message, setMessage] = useState("");

  return (
    <div data-testid="ai.chat-tab" style={{ padding: "4px 2px" }}>
      <div style={HEADER_ROW_STYLE}>
        <div style={SECTION_HEADING_STYLE}>
          {t("editor.chrome.rightPanel.tabs.aiChat")}
        </div>
        <span
          data-testid="ai.chrome-status"
          data-ai-enabled={aiEnabled ? "true" : "false"}
          data-ai-model-ready={aiEnabled ? (noModel ? "false" : "true") : ""}
          style={{
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-medium)",
            color: aiEnabled && !noModel ? "var(--fg-2)" : "var(--fg-3)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-1)",
            padding: "1px 6px",
            whiteSpace: "nowrap",
          }}
        >
          {!aiEnabled
            ? t("editor.chrome.rightPanel.aiChat.statusOff")
            : noModel
              ? t("editor.chrome.rightPanel.aiChat.statusNoModel")
              : gettingReady
                ? t("editor.chrome.rightPanel.aiChat.statusGettingReady")
                : t("editor.chrome.rightPanel.aiChat.statusReady")}
        </span>
      </div>
      {/* Honest framing (task 13): rendered VERBATIM (load-bearing copy, never
          i18n'd) — a weak on-device model is fallible, so the user is told to
          verify against the cited notes. Must not over-claim / imply isolation. */}
      {ready && (
        <p
          data-testid="ai.honesty-note"
          style={{ fontSize: "var(--text-xs)", lineHeight: 1.4, color: "var(--fg-3)", margin: "8px 0 0" }}
        >
          {AI_CHAT_HONESTY_NOTE}
        </p>
      )}

      {/* Conversational transcript (task 6): the multi-turn chat surface. A
          polite live region so a screen reader announces the streaming turn. */}
      {chat.turns.length > 0 && (
        <div
          data-testid="ai.transcript"
          aria-live="polite"
          aria-atomic="false"
          style={{ display: "flex", flexDirection: "column", gap: 10, margin: "10px 0 0" }}
        >
          {chat.turns.map((turn) => (
            <ChatTurnView
              key={turn.id}
              turn={turn}
              onOpenNote={onOpenNote}
              titleOf={titleOf}
              onInsert={onInsert}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Composer (task 6): replaces the single-shot ask input when wired. Shown
          whenever AI is on (like the former ask input) — NOT gated on a
          side-loaded model, so it is reachable in the stub E2E build and in a
          no-model state (where a send surfaces the honest error turn). The Stop
          control (task 9) appears while a generation streams. */}
      {aiEnabled && onSend && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (chat.streaming) return;
            const m = message.trim();
            if (m.length === 0) return;
            onSend(m);
            setMessage("");
          }}
          style={{ display: "flex", gap: 6, margin: "10px 0 0" }}
        >
          <input
            data-testid="ai.composer-input"
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("editor.chrome.rightPanel.aiChat.composerPlaceholder")}
            aria-label={t("editor.chrome.rightPanel.aiChat.composerPlaceholder")}
            disabled={chat.streaming}
            style={ASK_INPUT_STYLE}
          />
          {chat.streaming && onStop ? (
            <button
              type="button"
              data-testid="ai.composer-stop"
              onClick={() => onStop()}
              style={ASK_SUBMIT_STYLE}
            >
              {t("editor.chrome.rightPanel.aiChat.stop")}
            </button>
          ) : (
            <button
              type="submit"
              data-testid="ai.composer-send"
              disabled={message.trim().length === 0 || chat.streaming}
              style={{
                ...ASK_SUBMIT_STYLE,
                cursor:
                  message.trim().length === 0 || chat.streaming ? "default" : "pointer",
                opacity: message.trim().length === 0 || chat.streaming ? 0.5 : 1,
              }}
            >
              {t("editor.chrome.rightPanel.aiChat.send")}
            </button>
          )}
        </form>
      )}

      {chat.turns.length === 0 && (
        <p
          data-testid={noModel ? "ai.status-no-model" : undefined}
          style={{
            fontSize: "var(--text-sm)",
            lineHeight: 1.5,
            color: "var(--fg-3)",
            margin: "8px 0 0",
          }}
        >
          {!aiEnabled
            ? t("editor.chrome.rightPanel.aiChat.offHint")
            : noModel
              ? t("editor.chrome.rightPanel.aiChat.noModelHint")
              : gettingReady
                ? t("editor.chrome.rightPanel.aiChat.gettingReadyHint")
                : t("editor.chrome.rightPanel.aiChat.empty")}
        </p>
      )}

    </div>
  );
}
