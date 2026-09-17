// MemoryPanel: the agent-memory + personality management surface
// (myne-md/myne#697, `decisions/ai/0590`).
//
// **Q7's full-management half.** The chat header popover (AiChatTab) is the
// discoverable half: it shows the live memory beside the conversation the
// wrong answer came from. This panel is the complete one: list, edit, delete,
// clear-all-with-confirm, and the personality editor. The two surfaces share
// the same lib module and the same commands; neither invents a second store.
//
// Everything here is behind the `ai_enabled` gate: AiPanel mounts this
// section only when AI is on (absent, not disabled), so there is no
// off-state to render. A memory section rendered editable while AI is off
// would be the one control claiming the assistant will remember something
// it cannot run to learn.
//
// Coded against the design canon: `SettingRow` + `panel-styles` tokens + the
// `Switch`/`Input` primitives, the same set every other settings section uses.

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  memoryDelete,
  memoryList,
  memoryRead,
  memoryWrite,
  personalityRead,
  personalityWrite,
  type MemoryListRow,
  type PersonalityDirective,
} from "../../lib/memory";
import { ControlBlock } from "./ControlBlock";
import {
  BLOCK_STYLE,
  HELPER_STYLE,
  LABEL_STYLE,
} from "./panel-styles";

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-2)",
  border: "1px solid var(--line-1)",
  background: "var(--paper-2)",
};

const ROW_TEXT_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const ROW_META_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const LINK_BUTTON_STYLE: CSSProperties = {
  font: "inherit",
  fontSize: "var(--text-xs)",
  padding: "var(--space-1) var(--space-2)",
  borderRadius: "var(--radius-1)",
  border: "1px solid var(--line-1)",
  background: "var(--paper-2)",
  color: "var(--fg-1)",
  cursor: "pointer",
  transition: "background var(--duration-fast) var(--ease-standard)",
};

const TEXTAREA_STYLE: CSSProperties = {
  width: "100%",
  minHeight: 96,
  resize: "vertical",
  font: "inherit",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "var(--paper)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "var(--space-2)",
};

function formatUpdatedAt(updatedAt: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  return t("settings.memory.updatedAt", {
    val: new Date(updatedAt).toLocaleString(),
  });
}

/** One memory row: the text, its meta, and its edit/delete controls. */
function MemoryRow(props: {
  row: MemoryListRow;
  text: string | null;
  unreadable: boolean;
  disabled: boolean;
  onSaved: () => void;
  onDeleted: () => void;
  onShowToast: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const startEdit = useCallback(() => {
    setDraft(props.text ?? "");
    setEditing(true);
  }, [props.text]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      await memoryWrite(draft, props.row.id);
      props.onShowToast(t("settings.memory.savedToast"));
      setEditing(false);
      props.onSaved();
    } catch {
      props.onShowToast(t("settings.memory.saveFailed"));
    } finally {
      setBusy(false);
    }
  }, [draft, props, t]);

  if (editing) {
    return (
      <li style={ROW_STYLE} data-testid="settings.memory.row-editing">
        <textarea
          data-testid="settings.memory.edit-input"
          aria-label={t("settings.memory.editLabel")}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          spellCheck={false}
          style={TEXTAREA_STYLE}
        />
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <button
            type="button"
            data-testid="settings.memory.save"
            disabled={busy || draft.trim().length === 0}
            onClick={() => void save()}
            style={LINK_BUTTON_STYLE}
          >
            {t("settings.memory.save")}
          </button>
          <button
            type="button"
            data-testid="settings.memory.cancel-edit"
            disabled={busy}
            onClick={() => setEditing(false)}
            style={LINK_BUTTON_STYLE}
          >
            {t("settings.memory.cancel")}
          </button>
        </div>
      </li>
    );
  }

  return (
    <li style={ROW_STYLE} data-testid="settings.memory.row">
      {props.unreadable ? (
        <p style={ROW_TEXT_STYLE} data-testid="settings.memory.row-unreadable">
          {t("settings.memory.entryUnreadable")}
        </p>
      ) : (
        <p style={ROW_TEXT_STYLE}>{props.text ?? ""}</p>
      )}
      <p style={ROW_META_STYLE}>
        {formatUpdatedAt(props.row.updated_at, t)} · v{props.row.version}
      </p>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <button
          type="button"
          data-testid="settings.memory.edit"
          disabled={props.disabled || props.unreadable}
          onClick={startEdit}
          style={LINK_BUTTON_STYLE}
        >
          {t("settings.memory.editLabel")}
        </button>
        <button
          type="button"
          data-testid="settings.memory.delete"
          disabled={props.disabled}
          onClick={() => {
            void memoryDelete(props.row.id)
              .then(() => {
                props.onShowToast(t("settings.memory.deletedToast"));
                props.onDeleted();
              })
              .catch(() => {
                props.onShowToast(t("settings.memory.deleteFailed"));
              });
          }}
          style={LINK_BUTTON_STYLE}
        >
          {t("settings.memory.deleteLabel")}
        </button>
      </div>
    </li>
  );
}

/** The memory + personality section, rendered inside AiPanel (the AI rail). */
export function MemorySection(props: { onShowToast: (message: string) => void; aiEnabled: boolean }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MemoryListRow[] | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [personalityDraft, setPersonalityDraft] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [busy, setBusy] = useState(false);

  const [loadFailed, setLoadFailed] = useState(false);
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      const list = await memoryList();
      setRows(list);
      const nextTexts: Record<string, string> = {};
      const failed = new Set<string>();
      for (const row of list) {
        try {
          nextTexts[row.id] = await memoryRead(row.id);
        } catch {
          failed.add(row.id);
        }
      }
      setTexts(nextTexts);
      setFailedIds(failed);
      const nextDirectives = await personalityRead();
      setPersonalityDraft(
        nextDirectives.map((d) => d.text).join("\n"),
      );
      setLoadFailed(false);
    } catch {
      // Report, never collapse to empty: an unreadable store read as empty
      // would let the next save persist that emptiness over real records
      // (§9.25.3 report-don't-empty). The draft is left untouched so a save
      // cannot overwrite what was never read.
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const clearAll = useCallback(async () => {
    if (rows === null) return;
    setBusy(true);
    try {
      for (const row of rows) {
        await memoryDelete(row.id);
      }
      props.onShowToast(t("settings.memory.clearedToast"));
      setConfirmingClear(false);
      void reload();
    } catch {
      props.onShowToast(t("settings.memory.deleteFailed"));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, reload]);



  const savePersonality = useCallback(async () => {
    setBusy(true);
    const nextDirectives: PersonalityDirective[] = personalityDraft
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => ({ text: line, updated_at: Date.now() }));
    try {
      await personalityWrite(nextDirectives);
      props.onShowToast(t("settings.memory.personalitySavedToast"));
      void reload();
    } catch {
      props.onShowToast(t("settings.memory.personalitySaveFailed"));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personalityDraft, reload, t]);

  const disabled = !props.aiEnabled || busy;

  return (
    <div style={BLOCK_STYLE} data-testid="settings.memory-section">
      <h3 style={{ ...LABEL_STYLE, fontSize: "var(--text-md)", margin: "var(--space-3) 0 0" }}>
        {t("settings.memory.heading")}
      </h3>
      <p style={HELPER_STYLE}>{t("settings.memory.helper")}</p>

      {loadFailed ? (
        <div style={HELPER_STYLE}>
          <p data-testid="settings.memory.load-failed">{t("settings.memory.loadFailed")}</p>
          <button type="button" data-testid="settings.memory.retry" style={LINK_BUTTON_STYLE} onClick={() => void reload()}>
            {t("settings.memory.retryLabel")}
          </button>
        </div>
      ) : rows === null ? null : rows.length === 0 ? (
        <p data-testid="settings.memory.empty" style={HELPER_STYLE}>
          {t("settings.memory.empty")}
        </p>
      ) : (
        <ul style={LIST_STYLE} data-testid="settings.memory.list">
          {rows.map((row) => (
            <MemoryRow
              key={row.id}
              row={row}
              text={texts[row.id] ?? null}
              unreadable={failedIds.has(row.id)}
              disabled={disabled}
              onSaved={() => void reload()}
              onDeleted={() => void reload()}
              onShowToast={props.onShowToast}
            />
          ))}
        </ul>
      )}

      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        {confirmingClear ? (
          <>
            <button
              type="button"
              data-testid="settings.memory.clear-confirm"
              disabled={disabled}
              onClick={() => void clearAll()}
              style={LINK_BUTTON_STYLE}
            >
              {t("settings.memory.clearConfirm")}
            </button>
            <button
              type="button"
              data-testid="settings.memory.clear-cancel"
              onClick={() => setConfirmingClear(false)}
              style={LINK_BUTTON_STYLE}
            >
              {t("settings.memory.cancelLabel")}
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="settings.memory.clear-all"
            disabled={disabled || (rows !== null && rows.length === 0)}
            onClick={() => setConfirmingClear(true)}
            style={LINK_BUTTON_STYLE}
          >
            {t("settings.memory.clearAllLabel")}
          </button>
        )}
      </div>

      <ControlBlock
        anchorId="ai.personality"
        label={t("settings.memory.personalityLabel")}
        helper={t("settings.memory.personalityHelper")}
        testId="settings.memory.personality-block"
        control={
          <>
            <textarea
              id="ai-personality"
              data-testid="settings.memory.personality-input"
              value={personalityDraft}
              disabled={disabled}
              onChange={(e) => setPersonalityDraft(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={t("settings.memory.personalityPlaceholder")}
              style={{ ...TEXTAREA_STYLE, background: "var(--paper)" }}
            />
            <button
              type="button"
              data-testid="settings.memory.personality-save"
              disabled={disabled}
              onClick={() => void savePersonality()}
              style={LINK_BUTTON_STYLE}
            >
              {t("settings.memory.personalitySaveLabel")}
            </button>
          </>
        }
      />
    </div>
  );
}
