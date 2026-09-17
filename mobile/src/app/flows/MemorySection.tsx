// The phone's agent-memory + personality section (myne-md/myne#697, task 9).
//
// The desktop `src/components/settings/MemorySection.tsx` twin, recut for the
// phone: the settings primitives here are file-local to `SettingsSheet`, so
// this section owns its own style consts (the `AiHistorySheet` discipline)
// and the shared `Button` primitive. Same commands, same testids
// (`settings.memory.*`), same `ai_enabled` gate (rendered only when on:
// omitted rather than greyed, the mobile posture for a capability the device
// will not honour).
//
// Touch conventions (`reference/user-flows.md` "Mobile AI"): destructive
// confirms are stacked with the safe answer on the bottom edge (Cancel last),
// and per-row delete is an inline two-tap arm (the
// `archive.folder-delete-confirm` pattern: a second sheet over this panel
// would be a modal layer over a sheet).

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../components/Button";
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

const HEADING: CSSProperties = {
  margin: "var(--space-4) 0 0",
  fontSize: "var(--text-md)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
};

const HELPER: CSSProperties = {
  margin: "var(--space-1) 0 0",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const LIST: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  margin: "var(--space-3) 0 0",
  padding: 0,
  listStyle: "none",
};

const ROW: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-3)",
  borderRadius: "var(--radius-2)",
  border: "1px solid var(--line-1)",
  background: "var(--paper-2)",
};

const ROW_TEXT: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const ROW_META: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const ROW_ACTIONS: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
};

const TEXTAREA: CSSProperties = {
  width: "100%",
  minHeight: 96,  // a control size, not a measure token
  resize: "vertical",
  font: "inherit",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "var(--paper)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-2) var(--space-3)",
  boxSizing: "border-box",
};

const STACK: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  marginTop: "var(--space-3)",
};

function MemoryRow(props: {
  row: MemoryListRow;
  text: string | null;
  unreadable: boolean;
  onSaved: () => void;
  onDeleted: () => void;
  onToast: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      await memoryWrite(draft, props.row.id);
      props.onToast(t("settings.memory.savedToast"));
      setEditing(false);
      props.onSaved();
    } catch {
      props.onToast(t("settings.memory.saveFailed"));
    } finally {
      setBusy(false);
    }
  }, [draft, props, t]);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await memoryDelete(props.row.id);
      props.onToast(t("settings.memory.deletedToast"));
      props.onDeleted();
    } catch {
      props.onToast(t("settings.memory.deleteFailed"));
    } finally {
      setBusy(false);
      setDeleteArmed(false);
    }
  }, [props, t]);

  if (editing) {
    return (
      <li style={ROW} data-testid="settings.memory.row-editing">
        <textarea
          data-testid="settings.memory.edit-input"
          aria-label={t("settings.memory.editLabel")}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          spellCheck={false}
          style={TEXTAREA}
        />
        {/* Stacked, safe answer last: Cancel sits on the bottom edge. */}
        <div style={STACK}>
          <Button
            variant="primary"
            data-testid="settings.memory.save"
            disabled={busy || draft.trim().length === 0}
            onClick={() => void save()}
          >
            {t("settings.memory.save")}
          </Button>
          <Button
            variant="ghost"
            data-testid="settings.memory.cancel-edit"
            disabled={busy}
            onClick={() => setEditing(false)}
          >
            {t("settings.memory.cancel")}
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li style={ROW} data-testid="settings.memory.row">
      {props.row.quarantined ? (
        <p style={ROW_META} data-testid="settings.memory.row-held">
          {t("settings.memory.heldForReview")}
        </p>
      ) : null}
      {props.unreadable ? (
        <p style={ROW_TEXT} data-testid="settings.memory.row-unreadable">
          {t("settings.memory.entryUnreadable")}
        </p>
      ) : (
        <p style={ROW_TEXT}>{props.text ?? ""}</p>
      )}
      <p style={ROW_META}>
        {t("settings.memory.updatedAt", {
          val: new Date(props.row.updated_at).toLocaleString(),
        })}{" "}
        · v{props.row.version}
      </p>
      {deleteArmed ? (
        <div style={STACK}>
          <Button
            variant="danger"
            data-testid="settings.memory.delete-confirm"
            disabled={busy}
            onClick={() => void remove()}
          >
            {t("settings.memory.deleteLabel")}
          </Button>
          <Button
            variant="ghost"
            data-testid="settings.memory.delete-cancel"
            disabled={busy}
            onClick={() => setDeleteArmed(false)}
          >
            {t("settings.memory.cancelLabel")}
          </Button>
        </div>
      ) : (
        <div style={ROW_ACTIONS}>
          <Button
            variant="secondary"
            full={false}
            data-testid="settings.memory.edit"
            disabled={props.unreadable}
            onClick={() => {
              setDraft(props.text ?? "");
              setEditing(true);
            }}
          >
            {t("settings.memory.editLabel")}
          </Button>
          <Button
            variant="secondary"
            full={false}
            data-testid="settings.memory.delete"
            onClick={() => setDeleteArmed(true)}
          >
            {t("settings.memory.deleteLabel")}
          </Button>
        </div>
      )}
    </li>
  );
}

/** The memory + personality section, rendered inside the AI panel when on. */
export function MemorySection(props: { onToast: (message: string) => void }) {
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
      setPersonalityDraft((await personalityRead()).map((d) => d.text).join("\n"));
      setLoadFailed(false);
    } catch {
      // Report, never collapse to empty (§9.25.3 report-don't-empty): the
      // draft is left untouched so a save cannot overwrite what was never read.
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
      props.onToast(t("settings.memory.clearedToast"));
      setConfirmingClear(false);
      void reload();
    } catch {
      props.onToast(t("settings.memory.deleteFailed"));
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
      props.onToast(t("settings.memory.personalitySavedToast"));
      void reload();
    } catch {
      props.onToast(t("settings.memory.personalitySaveFailed"));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personalityDraft, reload, t]);

  return (
    <div data-testid="settings.memory-section">
      <h3 style={HEADING}>{t("settings.memory.heading")}</h3>
      <p style={HELPER}>{t("settings.memory.helper")}</p>

      {loadFailed ? (
        <div style={HELPER}>
          <p data-testid="settings.memory.load-failed">{t("settings.memory.loadFailed")}</p>
          <Button variant="secondary" data-testid="settings.memory.retry" onClick={() => void reload()}>
            {t("settings.memory.retryLabel")}
          </Button>
        </div>
      ) : rows === null ? null : rows.length === 0 ? (
        <p data-testid="settings.memory.empty" style={HELPER}>
          {t("settings.memory.empty")}
        </p>
      ) : (
        <ul style={LIST} data-testid="settings.memory.list">
          {rows.map((row) => (
            <MemoryRow
              key={row.id}
              row={row}
              text={texts[row.id] ?? null}
              unreadable={failedIds.has(row.id)}
              onSaved={() => void reload()}
              onDeleted={() => void reload()}
              onToast={props.onToast}
            />
          ))}
        </ul>
      )}

      {confirmingClear ? (
        <div style={STACK}>
          <Button
            variant="danger"
            data-testid="settings.memory.clear-confirm"
            disabled={busy}
            onClick={() => void clearAll()}
          >
            {t("settings.memory.clearConfirm")}
          </Button>
          <Button
            variant="ghost"
            data-testid="settings.memory.clear-cancel"
            onClick={() => setConfirmingClear(false)}
          >
            {t("settings.memory.cancelLabel")}
          </Button>
        </div>
      ) : (
        <div style={STACK}>
          <Button
            variant="secondary"
            data-testid="settings.memory.clear-all"
            disabled={busy || (rows !== null && rows.length === 0)}
            onClick={() => setConfirmingClear(true)}
          >
            {t("settings.memory.clearAllLabel")}
          </Button>
        </div>
      )}

      <h3 style={HEADING}>{t("settings.memory.personalityLabel")}</h3>
      <textarea
        data-testid="settings.memory.personality-input"
        value={personalityDraft}
        disabled={busy}
        onChange={(e) => setPersonalityDraft(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder={t("settings.memory.personalityPlaceholder")}
        style={{ ...TEXTAREA, marginTop: "var(--space-2)" }}
      />
      <p style={HELPER}>{t("settings.memory.personalityHelper")}</p>
      <div style={STACK}>
        <Button
          variant="secondary"
          data-testid="settings.memory.personality-save"
          disabled={busy}
          onClick={() => void savePersonality()}
        >
          {t("settings.memory.personalitySaveLabel")}
        </Button>
      </div>
    </div>
  );
}
