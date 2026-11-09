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
import type { CSSProperties, ReactNode } from "react";
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
import { EmptyState } from "../primitives/EmptyState";
import { SettingRow } from "./SettingRow";
import { SeedMemoryRow } from "./SeedMemoryWizard";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import {
  BLOCK_STYLE,
  HELPER_STYLE,
  LABEL_STYLE,
} from "./panel-styles";

/**
 * **The roster is a bounded, scrolling region** (myne-md/myne#867). Up to
 * `MAX_MEMORY_ENTRIES` rows (100) each carrying up to 2000 characters, in a
 * settings panel that is itself a scroll container: unbounded, the list pushed
 * the personality editor and the clear-all control off the end of the panel, so
 * the controls a full list makes you need were the ones it hid.
 */
const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
  maxHeight: 360,
  overflowY: "auto",
};

/** The `N / cap` readout and, at the cap, the sentence that says what to do
 *  about it. Two elements because they are two facts, and the second only
 *  exists in one state. */
const COUNT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  margin: "var(--space-1) 0 0",
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
  /** The row's testid; the seed group uses its own so a scenario can count the
   *  seed entries without also matching the Settings row that opens the wizard. */
  testId?: string;
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
          aria-label={t("common.edit")}
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
    <li style={ROW_STYLE} data-testid={props.testId ?? "settings.memory.row"}>
      {props.row.quarantined ? (
        <p style={ROW_META_STYLE} data-testid="settings.memory.row-held">
          {t("settings.memory.heldForReview")}
        </p>
      ) : null}
      {props.unreadable ? (
        <p style={ROW_TEXT_STYLE} data-testid="settings.memory.row-unreadable">
          {t("settings.memory.entryUnreadable")}
        </p>
      ) : (
        <p style={ROW_TEXT_STYLE}>{props.text ?? ""}</p>
      )}
      {/* **When it last changed, and nothing else** (issue #970, item 12). The
          row used to end "· v1": `version` is the row's causal counter, the
          value conflict resolution compares, and a reader has no action it
          implies: there is no v2 to open and no history behind it. A number
          nobody can act on reads as an unexplained status. */}
      <p style={ROW_META_STYLE}>{formatUpdatedAt(props.row.updated_at, t)}</p>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <button
          type="button"
          data-testid="settings.memory.edit"
          disabled={props.disabled || props.unreadable}
          onClick={startEdit}
          style={LINK_BUTTON_STYLE}
        >
          {t("common.edit")}
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

/** The memory + personality section, rendered inside AiPanel (the AI rail).
 *
 *  `layout` places the two halves (myne-md/myne#867, on the user's read: the
 *  Advanced topic is two sections, "Preferences" holding the meeting prompt and
 *  the voice preferences, and "Memory" holding what the assistant remembers).
 *  The halves share one load and one busy flag, so they stay one component and
 *  the caller only decides WHERE each renders. Without it they render stacked,
 *  as before. */
export function MemorySection(props: {
  onShowToast: (message: string) => void;
  aiEnabled: boolean;
  layout?: (parts: { memory: ReactNode; personality: ReactNode }) => ReactNode;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MemoryListRow[] | null>(null);
  // The host's cap, not a constant here: see `MemoryListView`.
  const [cap, setCap] = useState<number | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [personalityDraft, setPersonalityDraft] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingSeedClear, setConfirmingSeedClear] = useState(false);
  const [busy, setBusy] = useState(false);

  const [loadFailed, setLoadFailed] = useState(false);
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      const view = await memoryList();
      const list = view.rows;
      setRows(list);
      setCap(view.cap);
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



  const removeSeedRows = useCallback(async () => {
    if (rows === null) return;
    setBusy(true);
    try {
      for (const row of rows.filter((r) => r.origin === "seed")) {
        await memoryDelete(row.id);
      }
      props.onShowToast(t("settings.memory.seed.removedToast"));
      setConfirmingSeedClear(false);
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

  const memory = (
    <div style={BLOCK_STYLE} data-testid="settings.memory-section">
      {/* `data-setting-anchor` here because the settings-search registry carries
          an `ai.memory` entry whose `id` IS the anchor a hit scrolls to, and it
          had none: search found "memory", navigated to the panel and scrolled
          to nothing (myne-md/myne#867). The personality block below already
          rendered its anchor through `ControlBlock`. */}
      <h3
        data-setting-anchor="ai.memory"
        style={{ ...LABEL_STYLE, fontSize: "var(--text-md)", margin: "var(--space-3) 0 0" }}
      >
        {t("settings.memory.heading")}
      </h3>
      <p style={HELPER_STYLE}>{t("settings.memory.helper")}</p>
      <SeedMemoryRow onShowToast={props.onShowToast} onApplied={() => void reload()} />

      {loadFailed ? (
        <div style={HELPER_STYLE}>
          <p data-testid="settings.memory.load-failed">{t("settings.memory.loadFailed")}</p>
          <button type="button" data-testid="settings.memory.retry" style={LINK_BUTTON_STYLE} onClick={() => void reload()}>
            {t("settings.memory.retryLabel")}
          </button>
        </div>
      ) : rows === null ? null : rows.length === 0 ? (
        <EmptyState
          variant="firstRun"
          icon="book-open"
          size="sm"
          title={t("settings.memory.emptyTitle")}
          body={t("settings.memory.empty")}
          testId="settings.memory.empty"
        />
      ) : (
        <>
          {/* **What a limit owes the person it limits** (myne-md/myne#867): the
              count, and at the cap the one action that unblocks it. The write
              refusal itself belongs to the path that writes (the agent's
              `remember`, which is not this surface), so saying it HERE is what
              turns a limit into a job the user can do in advance rather than a
              dead end discovered mid-run. */}
          <div style={COUNT_STYLE}>
            <span data-testid="settings.memory.count" style={HELPER_STYLE}>
              {t("settings.memory.count", { used: rows.length, cap: cap ?? rows.length })}
            </span>
            {cap !== null && rows.length >= cap ? (
              <span
                data-testid="settings.memory.at-cap"
                style={{ ...HELPER_STYLE, color: "var(--fg-1)" }}
              >
                {t("settings.memory.atCap")}
              </span>
            ) : null}
          </div>
          <ul style={LIST_STYLE} data-testid="settings.memory.list">
          {rows
            .filter((row) => row.origin !== "seed")
            .map((row) => (
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
          {rows.some((row) => row.origin === "seed") ? (
            <div data-testid="settings.memory.seed-group" style={{ ...BLOCK_STYLE, marginTop: "var(--space-3)" }}>
              <h4 style={{ ...LABEL_STYLE, margin: 0 }}>
                {t("settings.memory.seed.groupTitle")}
              </h4>
              <p style={HELPER_STYLE} data-testid="settings.memory.seed-group-meta">
                {t("settings.memory.seed.groupMeta", {
                  date: new Date(
                    Math.max(
                      ...rows
                        .filter((row) => row.origin === "seed")
                        .map((row) => row.created_at),
                    ),
                  ).toLocaleDateString(),
                  count: rows.filter((row) => row.origin === "seed").length,
                })}
              </p>
              <ul style={LIST_STYLE} data-testid="settings.memory.seed-list">
                {rows
                  .filter((row) => row.origin === "seed")
                  .map((row) => (
                    <MemoryRow
                      key={row.id}
                      row={row}
                      text={texts[row.id] ?? null}
                      unreadable={failedIds.has(row.id)}
                      disabled={disabled}
                      onSaved={() => void reload()}
                      onDeleted={() => void reload()}
                      onShowToast={props.onShowToast}
                      testId="settings.memory.seed-entry"
                    />
                  ))}
              </ul>
              {confirmingSeedClear ? (
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
                  <Button
                    variant="ghost"
                    data-testid="settings.memory.seed.remove-confirm"
                    disabled={disabled}
                    onClick={() => void removeSeedRows()}
                  >
                    {t("settings.memory.seed.removeConfirm")}
                  </Button>
                  <Button
                    variant="ghost"
                    data-testid="settings.memory.seed.remove-cancel"
                    onClick={() => setConfirmingSeedClear(false)}
                  >
                    {t("settings.memory.cancelLabel")}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  data-testid="settings.memory.seed.remove-all"
                  disabled={disabled}
                  onClick={() => setConfirmingSeedClear(true)}
                >
                  {t("settings.memory.seed.removeAll")}
                </Button>
              )}
            </div>
          ) : null}
        </>
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
    </div>
  );
  const personality = (
    // A setting row whose control is the save (myne-md/myne#867): the same
    // square bordered icon the meeting prompt's reset uses beside it, so the
    // two standing instructions in Preferences read as one kind of row.
    <SettingRow
      anchorId="ai.personality"
      testId="settings.memory.personality-block"
      label={t("settings.memory.personalityLabel")}
      helper={t("settings.memory.personalityHelper")}
      control={
        <IconButton
          icon="circle-check"
          label={t("settings.memory.personalitySaveLabel")}
          tooltip
          bordered
          disabled={disabled}
          testId="settings.memory.personality-save"
          onClick={() => void savePersonality()}
        />
      }
    >
      <textarea
        id="ai-personality"
        data-testid="settings.memory.personality-input"
        aria-label={t("settings.memory.personalityLabel")}
        value={personalityDraft}
        disabled={disabled}
        onChange={(e) => setPersonalityDraft(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder={t("settings.memory.personalityPlaceholder")}
        style={{ ...TEXTAREA_STYLE, background: "var(--paper)" }}
      />
    </SettingRow>
  );

  if (props.layout !== undefined) return <>{props.layout({ memory, personality })}</>;
  return (
    <>
      {memory}
      {personality}
    </>
  );
}
