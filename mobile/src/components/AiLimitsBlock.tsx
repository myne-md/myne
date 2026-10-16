// The AI limits on mobile: the chat-history budget and the meeting prompt
// (myne-md/myne#617 and meeting-ai, reached this client in myne-md/myne#880).
//
// # Why these two rows exist
//
// `set_chat_history_budget` is enforced in the SHARED core
// (`core/src/plugins/agent/history.rs` reads `view.chat_history_budget`), so a
// phone already applied an inherited default it could not change, and it is the
// device where chat history is most likely to live. `set_meeting_ai_prompt` is
// the sharper one: the phone is where meeting capture actually HAPPENS, so the
// device that records the meeting could not author the instruction that
// processes it.
//
// # Two different classes, stated rather than left to be guessed
//
// The budget is DEVICE-LOCAL: it bounds how much of this machine's plaintext one
// run sends to a provider, so a laptop on a metered connection and a desktop on
// a fast one legitimately disagree. The prompt is SHARED / scalar LWW: it is
// vault content, so it reaches the account's other devices. The two behave
// differently after a write, and the block says which is which.
//
// # The budget's bound is the SHARED one
//
// The host CLAMPS the value (`MAX_HISTORY_BUDGET` in the Rust history module),
// and this row renders `max` from {@link CHAT_HISTORY_BUDGET_MAX}, the copy the
// settings input needs. The two are held together by
// `tests/lib/chatHistoryBudget.test.ts`, which reads the Rust file: a UI bound
// that agreed with the host by accident is the shape this repository keeps
// finding, and the drift is quiet in both directions. This wrapper deliberately
// does NOT clamp before sending, because a second clamp would read as the
// control and hide the day the real one stopped working.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CHAT_HISTORY_BUDGET_MAX } from "@myne/agent-protocol";
import { TextField } from "./inputs";
import { setChatHistoryBudget, setMeetingAiPrompt } from "../lib/prefs";

const HINT_STYLE = {
  marginTop: "var(--space-3)",
  fontSize: "var(--text-xs)",
  lineHeight: 1.5,
  color: "var(--fg-3)",
} as const;

const LABEL_STYLE = {
  marginTop: "var(--space-4)",
  marginBottom: "var(--space-2)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--fg-3)",
} as const;

const ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  marginTop: "var(--space-2)",
} as const;

const BUTTON_STYLE = {
  background: "none",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  color: "var(--fg-1)",
  cursor: "pointer",
  padding: "var(--space-2) var(--space-3)",
} as const;

/**
 * The budget a draft string means: `null` for empty (the host's default), a
 * number otherwise, and `undefined` for input that is not a number at all (which
 * the row refuses to send rather than coercing to 0).
 *
 * Exported because it is the one place a string becomes a number, and `0` is a
 * real value while `""` is not: `Number("")` is `0`, so the naive read turns
 * "clear the field" into "send zero characters of history".
 */
export function budgetFromDraft(draft: string): number | null | undefined {
  const trimmed = draft.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return undefined;
  return n;
}

export function AiLimitsBlock({
  budget,
  meetingPrompt,
  onToast,
}: {
  budget: number | null;
  meetingPrompt: string | null;
  /** The sheet's toast. A failed write is REPORTED and the draft rolled back:
   *  the re-seed effect above is keyed on the STORED value, which a failed write
   *  leaves unchanged, so without this the field keeps what the user typed while
   *  `vault.prefs` keeps the old one and nothing says so. The desktop twin
   *  reports the same failure through `usePrefs`'s `onShowToast`, which re-reads
   *  disk truth. */
  onToast?: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [budgetDraft, setBudgetDraft] = useState(budget === null ? "" : String(budget));
  const [promptDraft, setPromptDraft] = useState(meetingPrompt ?? "");

  // Re-seed when the stored values move underneath (a sync arriving while the
  // panel is open), so a field never shows a value the vault does not hold.
  useEffect(() => {
    setBudgetDraft(budget === null ? "" : String(budget));
  }, [budget]);
  useEffect(() => {
    setPromptDraft(meetingPrompt ?? "");
  }, [meetingPrompt]);

  const commitBudget = () => {
    const next = budgetFromDraft(budgetDraft);
    if (next === undefined) return;
    if (next === budget) return;
    void setChatHistoryBudget(next).catch(() => {
      setBudgetDraft(budget === null ? "" : String(budget));
      onToast?.(t("settings.saveSettingError"));
    });
  };

  const commitPrompt = () => {
    const next = meetingPrompt === null && promptDraft === "" ? null : promptDraft;
    if (next === meetingPrompt) return;
    void setMeetingAiPrompt(next).catch(() => {
      setPromptDraft(meetingPrompt ?? "");
      onToast?.(t("settings.saveSettingError"));
    });
  };

  return (
    <div data-testid="settings.aiLimits">
      <div style={LABEL_STYLE}>{t("settings.ai.historyBudgetLabel")}</div>
      <div style={ROW_STYLE}>
        <TextField
          testId="settings.aiLimits.budget"
          label={t("settings.ai.historyBudgetLabel")}
          value={budgetDraft}
          onChange={setBudgetDraft}
          onEnter={commitBudget}
          style={{ background: "var(--bg-2)", flex: 1 }}
        />
        <button
          type="button"
          data-testid="settings.aiLimits.budget-commit"
          aria-label={`${t("settings.dailyNotes.mobileSaveLabel")}: ${t("settings.ai.historyBudgetLabel")}`}
          onClick={commitBudget}
          style={BUTTON_STYLE}
        >
          {t("settings.dailyNotes.mobileSaveGlyph")}
        </button>
      </div>
      {/* The `max` the input offers is the SHARED bound, which the drift test
          holds to the Rust clamp. Rendered as text rather than as a `max`
          attribute because the mobile TextField primitive carries no numeric
          input props; the value is stated so a user knows the ceiling. */}
      <div style={HINT_STYLE} data-testid="settings.aiLimits.budget-helper">
        {t("settings.ai.historyBudgetHelper")}
      </div>
      <div style={HINT_STYLE} data-testid="settings.aiLimits.budget-max">
        {t("settings.ai.historyBudgetMaxNotice", { max: CHAT_HISTORY_BUDGET_MAX })}
      </div>
      {/* DEVICE-LOCAL, unlike the prompt below it. */}
      <div style={HINT_STYLE} data-testid="settings.aiLimits.budget-scope">
        {t("settings.ai.historyBudgetDeviceLocal")}
      </div>

      <div style={LABEL_STYLE}>{t("settings.ai.meetingPromptLabel")}</div>
      <TextField
        testId="settings.aiLimits.meetingPrompt"
        label={t("settings.ai.meetingPromptLabel")}
        value={promptDraft}
        onChange={setPromptDraft}
        onEnter={commitPrompt}
        style={{ background: "var(--bg-2)" }}
      />
      <div style={ROW_STYLE}>
        <button
          type="button"
          data-testid="settings.aiLimits.prompt-commit"
          onClick={commitPrompt}
          style={BUTTON_STYLE}
        >
          {t("settings.dailyNotes.mobileSaveGlyph")}
        </button>
        <button
          type="button"
          data-testid="settings.aiLimits.prompt-reset"
          onClick={() => {
            setPromptDraft("");
            void setMeetingAiPrompt(null).catch(() => {
              setPromptDraft(meetingPrompt ?? "");
              onToast?.(t("settings.saveSettingError"));
            });
          }}
          style={BUTTON_STYLE}
        >
          {t("settings.ai.meetingPromptReset")}
        </button>
      </div>
      <div style={HINT_STYLE}>{t("settings.ai.meetingPromptHelper")}</div>
      {/* SHARED, unlike the budget above it. */}
      <div style={HINT_STYLE} data-testid="settings.aiLimits.prompt-scope">
        {t("settings.ai.meetingPromptShared")}
      </div>
    </div>
  );
}
