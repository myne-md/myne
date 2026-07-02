// AI Chat right-panel tab body (local-ai epic, ai-ux-surface MYND-408, tasks
// 3 + 5).
//
// The canonical render target the AI capability siblings (note-summarization,
// semantic-search-qa, auto-tag-link) mount their output into. Task 3 shipped
// the strip wiring + empty-state; task 5 adds the shared **"AI off / ready"
// chrome** — the header status reflects the `ai_enabled` pref so a user who
// switches to this tab with AI off sees why it's empty and where to turn it on.
// The "AI thinking…" busy state is wired when a sibling drives a blocking
// inference call (SYNC-7); until then the two states are off / ready.
//
// Inference is local — no provider call, ever (the trust affordance in the AI
// settings panel states the bounded guarantee).

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { usePrefs } from "../../hooks/usePrefs";
import { useAiOutput } from "../ai/aiOutputStore";
import { useTagSuggest } from "../ai/tagSuggestStore";
import type { TagSuggestion } from "../ai/tagRanker";
import { TagSuggestionChips } from "./TagSuggestionChips";
import { SECTION_HEADING_STYLE } from "./sharedStyles";

const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

/** Optional handlers the Editor wires; absent in isolation (e.g. tests). */
export interface AiChatTabProps {
  /** Explicit "Insert into note" action for a ready summary (task 5, SYNC-17).
   *  When absent, the insert affordance is not shown. */
  onInsert?: (text: string) => void;
  /** Explicit click-to-insert for a tag suggestion chip (auto-tag task 4/5).
   *  When absent, chips render but are inert. */
  onAcceptTag?: (suggestion: TagSuggestion) => void;
  /** Ask a grounded question over the resident vault (semantic-search-qa tasks
   *  6/7). When absent (isolation / AI off), the question input is not shown. */
  onAsk?: (question: string) => void;
}

const ASK_INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  color: "var(--fg-1)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "5px 8px",
};

const ASK_SUBMIT_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: "var(--fg-2)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "5px 10px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export function AiChatTab({ onInsert, onAcceptTag, onAsk }: AiChatTabProps = {}) {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const aiEnabled = prefs.ai_enabled;
  const output = useAiOutput();
  const tagSuggest = useTagSuggest();
  const [question, setQuestion] = useState("");

  return (
    <div data-testid="ai.chat-tab" style={{ padding: "4px 2px" }}>
      <div style={HEADER_ROW_STYLE}>
        <div style={SECTION_HEADING_STYLE}>
          {t("editor.chrome.rightPanel.tabs.aiChat")}
        </div>
        <span
          data-testid="ai.chrome-status"
          data-ai-enabled={aiEnabled ? "true" : "false"}
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: aiEnabled ? "var(--fg-2)" : "var(--fg-3)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-1)",
            padding: "1px 6px",
            whiteSpace: "nowrap",
          }}
        >
          {aiEnabled
            ? t("editor.chrome.rightPanel.aiChat.statusReady")
            : t("editor.chrome.rightPanel.aiChat.statusOff")}
        </span>
      </div>
      {aiEnabled && onAsk && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const q = question.trim();
            if (q.length === 0) return;
            onAsk(q);
            setQuestion("");
          }}
          style={{ display: "flex", gap: 6, margin: "10px 0 0" }}
        >
          <input
            data-testid="ai.ask-input"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t("editor.chrome.rightPanel.aiChat.askPlaceholder")}
            aria-label={t("editor.chrome.rightPanel.aiChat.askPlaceholder")}
            style={ASK_INPUT_STYLE}
          />
          <button
            type="submit"
            data-testid="ai.ask-submit"
            disabled={question.trim().length === 0}
            style={{
              ...ASK_SUBMIT_STYLE,
              cursor: question.trim().length === 0 ? "default" : "pointer",
              opacity: question.trim().length === 0 ? 0.5 : 1,
            }}
          >
            {t("editor.chrome.rightPanel.aiChat.askSubmit")}
          </button>
        </form>
      )}
      <p
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--fg-3)",
          margin: "8px 0 0",
        }}
      >
        {aiEnabled
          ? t("editor.chrome.rightPanel.aiChat.empty")
          : t("editor.chrome.rightPanel.aiChat.offHint")}
      </p>

      {/* Persistent polite live region: because the summary / Q&A output below
          arrives asynchronously (a blocking on-device infer), the region must
          pre-exist in the DOM so a screen reader announces the thinking → result
          / error transition when content appears inside it. */}
      <div aria-live="polite" aria-atomic="false">
      {output.status === "thinking" && (
        <p
          data-testid="ai.thinking"
          style={{ fontSize: 13, color: "var(--fg-2)", margin: "12px 0 0" }}
        >
          {t("editor.chrome.rightPanel.aiChat.thinking")}
        </p>
      )}

      {output.status === "error" && (
        <p
          role="alert"
          data-testid="ai.output-error"
          style={{ fontSize: 13, color: "var(--fg-3)", margin: "12px 0 0" }}
        >
          {t("editor.chrome.rightPanel.aiChat.error")}
        </p>
      )}

      {output.status === "ready" && output.text !== null && (
        <div style={{ margin: "12px 0 0" }}>
          {output.truncated && (
            <p
              data-testid="ai.truncation-notice"
              style={{ fontSize: 12, color: "var(--fg-3)", margin: "0 0 6px" }}
            >
              {t("editor.chrome.rightPanel.aiChat.truncated", {
                count: output.summarizedChars,
              })}
            </p>
          )}
          <div
            data-testid="ai.output"
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--fg-1)",
              whiteSpace: "pre-wrap",
            }}
          >
            {output.text}
          </div>
          {onInsert && (
            <button
              type="button"
              data-testid="ai.insert-summary"
              onClick={() => onInsert(output.text as string)}
              style={{
                marginTop: 10,
                fontSize: 12,
                fontWeight: 500,
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
      )}
      </div>

      {/* Persistent polite live region for the async tag-suggestion pass. */}
      <div aria-live="polite" aria-atomic="false">
      {tagSuggest.status === "thinking" && (
        <p
          data-testid="ai.tags-thinking"
          style={{ fontSize: 13, color: "var(--fg-2)", margin: "12px 0 0" }}
        >
          {t("editor.chrome.rightPanel.aiChat.tagsThinking")}
        </p>
      )}
      {tagSuggest.status === "ready" && tagSuggest.suggestions.length > 0 && (
        <TagSuggestionChips
          suggestions={tagSuggest.suggestions}
          onAccept={(s) => onAcceptTag?.(s)}
        />
      )}
      </div>
    </div>
  );
}
