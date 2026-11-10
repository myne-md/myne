// Settings → Storage → "Automatic backups" (MYND-351). The StoragePanel
// section that configures the device-local recurring encrypted backup: an
// enable toggle, a cadence picker, a target-folder picker, a retention count,
// and a last-run status line. Additive to the manual "Back up vault" control,
// which is unchanged.
//
// Config is device-local (per VaultId) and read/written via the `backup`
// plugin's schedule commands. The scheduler engine itself runs in the Editor
// (`useBackupScheduler`); this panel only edits its settings + shows status.
//
// Design canon: the "Automatic backups" board on Penpot page "4 — Desktop UI
// Kit" (MYND-351). All controls reuse existing primitives (Switch,
// SearchableSelect, Button, Input) and design tokens — no new visual language.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "../../platform/dialog";
import i18n from "../../i18n";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { SearchableSelect } from "../primitives/SearchableSelect";
import { Switch } from "../primitives/Switch";
import type { SelectOption } from "../primitives/Select";
import {
  scheduleRead,
  scheduleWrite,
  type BackupInterval,
  type ScheduleConfig,
  type ScheduleSettings,
} from "../../lib/backup-schedule";
import { SettingRow } from "./SettingRow";

// Interval option values paired with their i18n label keys. Labels are
// resolved at render time (`t(...)`) — storing resolved strings at module
// scope would freeze the boot language.
const INTERVAL_OPTION_KEYS: readonly {
  value: BackupInterval;
  labelKey: string;
}[] = [
  { value: "every-unlock", labelKey: "settings.autoBackup.intervalEveryUnlock" },
  { value: "daily", labelKey: "settings.autoBackup.intervalDaily" },
  { value: "weekly", labelKey: "settings.autoBackup.intervalWeekly" },
];

const FOLDER_STYLE_BASE: CSSProperties = {
  flex: 1,
  display: "block",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "8px 12px",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
};

const FOLDER_DISPLAY_STYLE: CSSProperties = {
  ...FOLDER_STYLE_BASE,
  color: "var(--fg-1)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const FOLDER_PLACEHOLDER_STYLE: CSSProperties = {
  ...FOLDER_STYLE_BASE,
  color: "var(--fg-3)",
  fontFamily: "var(--font-sans)",
};

const RETENTION_INPUT_STYLE: CSSProperties = { width: 72 };

const STATUS_BASE_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  marginTop: "var(--space-1)",
};

/** Format an epoch-ms timestamp with the user's locale; `null` → em dash. */
function formatStamp(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString();
}

/** The status line under the controls — the always-visible, non-silent
 *  last-run state (story 7). */
function statusText(config: ScheduleConfig): { text: string; tone: string } {
  switch (config.lastBackupStatus) {
    case "success":
      return {
        text: i18n.t("settings.autoBackup.statusLastBackup", {
          stamp: formatStamp(config.lastScheduledSuccessAt),
        }),
        tone: "var(--fg-2)",
      };
    case "failed":
      return {
        text: i18n.t("settings.autoBackup.statusFailed", {
          stamp: formatStamp(config.lastBackupAttemptAt),
        }),
        tone: "var(--warning, var(--danger))",
      };
    case "never":
    default:
      return {
        text: i18n.t("settings.autoBackup.statusNever"),
        tone: "var(--fg-3)",
      };
  }
}

interface AutomaticBackupBlockProps {
  /**
   * The active vault whose schedule this block reads and writes (#250).
   *
   * Threaded in rather than resolved here: this block used to call
   * `resolveActiveVaultId()`, which ordered the non-authoritative
   * `registry.json` last-unlock cache. After a quick-unlock or a recovery that
   * cache named a different vault, so the panel edited a schedule belonging to
   * a vault the user was not looking at — and `prune_entry_files` then unlinked
   * THAT vault's archived `.myne-backup` files. `null` while the id is still
   * resolving; the block stays in its loading state.
   */
  vaultId: string | null;
  /** Toast surface for a failed settings write (rolled back to disk state). */
  onShowToast?: (message: string) => void;
}

export function AutomaticBackupBlock({
  vaultId,
  onShowToast,
}: AutomaticBackupBlockProps) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<ScheduleConfig | null>(null);

  // Resolve interval labels at render time so a language switch re-labels them.
  const intervalOptions: SelectOption<BackupInterval>[] =
    INTERVAL_OPTION_KEYS.map((o) => ({ value: o.value, label: t(o.labelKey) }));

  // Load the schedule config for the vault we were given.
  useEffect(() => {
    if (vaultId == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await scheduleRead(vaultId);
        if (cancelled) return;
        setConfig(cfg);
      } catch {
        // Best-effort: leave the block in its loading state. The scheduler
        // still runs from the Editor regardless of this panel rendering.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  // Optimistic write: apply locally, persist, and on failure reload the disk
  // truth + toast. Engine state (ledger/clock/status) is preserved server-side.
  const commit = (next: ScheduleConfig) => {
    if (vaultId == null) return;
    const prev = config;
    setConfig(next);
    const settings: ScheduleSettings = {
      enabled: next.enabled,
      interval: next.interval,
      targetFolder: next.targetFolder,
      retentionN: next.retentionN,
    };
    void scheduleWrite(vaultId, settings).catch(async () => {
      onShowToast?.(t("settings.autoBackup.saveFailedToast"));
      // Reload the on-disk truth so the UI never lies about what persisted.
      try {
        setConfig(await scheduleRead(vaultId));
      } catch {
        if (prev) setConfig(prev);
      }
    });
  };

  const chooseFolder = async () => {
    if (config == null) return;
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: t("settings.autoBackup.chooseFolderDialogTitle"),
    }).catch(() => null);
    if (typeof picked !== "string") return; // cancelled
    commit({ ...config, targetFolder: picked });
  };

  // Loading / no-vault: render nothing rather than a half-state.
  if (config == null) return null;

  const status = statusText(config);

  return (
    <SettingRow
      testId="settings.auto-backup"
      label={t("settings.autoBackup.title")}
      helper={t("settings.autoBackup.helper")}
      control={(helperId) => (
        <Switch
          checked={config.enabled}
          onChange={(enabled) => commit({ ...config, enabled })}
          ariaLabel={t("settings.autoBackup.title")}
          ariaDescribedBy={helperId}
          testId="settings.auto-backup-toggle"
        />
      )}
    >
      {/* The three knobs the toggle governs. Nested rows rather than siblings
          of the block, so the whole schedule reads as one setting. */}
      <SettingRow
        label={t("settings.autoBackup.frequency")}
        control={
          <SearchableSelect
            options={intervalOptions}
            selected={[config.interval]}
            onChange={(next) => {
              const interval = next[0] as BackupInterval;
              commit({ ...config, interval });
            }}
            aria-label={t("settings.autoBackup.frequencyAriaLabel")}
            testId="settings.auto-backup-interval"
            searchPlaceholder={t("settings.autoBackup.searchPlaceholder")}
            emptyText={t("settings.autoBackup.searchEmpty")}
          />
        }
      />

      <SettingRow
        label={t("settings.autoBackup.backupFolder")}
        control={
          <Button
            variant="secondary"
            onClick={() => void chooseFolder()}
            data-testid="settings.auto-backup-folder"
          >
            {t("common.choosefolder")}
          </Button>
        }
      >
        {config.targetFolder ? (
          <code
            style={FOLDER_DISPLAY_STYLE}
            title={config.targetFolder}
            data-testid="settings.auto-backup-folder-path"
          >
            {config.targetFolder}
          </code>
        ) : (
          <span style={FOLDER_PLACEHOLDER_STYLE}>
            {t("settings.autoBackup.noFolderChosen")}
          </span>
        )}
      </SettingRow>

      <SettingRow
        label={t("settings.autoBackup.keepLast")}
        control={
          <Input
            type="number"
            min={1}
            max={365}
            value={config.retentionN}
            style={RETENTION_INPUT_STYLE}
            data-testid="settings.auto-backup-retention"
            // `SettingRow` renders its label as a `<span>` with no association,
            // so a form control inside a row has NO accessible name. A screen
            // reader announced this field as a bare number input
            // (myne-md/myne#845). Naming it here is the local fix; associating
            // every row control is the row's own change.
            aria-label={t("settings.autoBackup.keepLast")}
            onChange={(e) => {
              const n = Number(e.currentTarget.value);
              if (!Number.isInteger(n) || n < 1) return; // ignore empty/invalid mid-type
              commit({ ...config, retentionN: n });
            }}
          />
        }
      />

      <p
        style={{ ...STATUS_BASE_STYLE, color: status.tone }}
        data-testid="settings.auto-backup-status"
      >
        {status.text}
      </p>
    </SettingRow>
  );
}
