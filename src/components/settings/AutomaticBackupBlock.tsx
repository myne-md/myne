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
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
import { resolveActiveVaultId } from "../../lib/vault-list";
import { BLOCK_STYLE, HELPER_STYLE, LABEL_STYLE } from "./panel-styles";

const INTERVAL_OPTIONS: readonly SelectOption<BackupInterval>[] = [
  { value: "every-unlock", label: "Every unlock" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
};

const FOLDER_STYLE_BASE: CSSProperties = {
  flex: 1,
  display: "block",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: 6,
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
        text: `Last backup: ${formatStamp(config.lastScheduledSuccessAt)}`,
        tone: "var(--fg-2)",
      };
    case "failed":
      return {
        text: `Automatic backup failed — ${formatStamp(config.lastBackupAttemptAt)}`,
        tone: "var(--warning, var(--danger))",
      };
    case "never":
    default:
      return { text: "No automatic backup yet.", tone: "var(--fg-3)" };
  }
}

interface AutomaticBackupBlockProps {
  /** Toast surface for a failed settings write (rolled back to disk state). */
  onShowToast?: (message: string) => void;
}

export function AutomaticBackupBlock({ onShowToast }: AutomaticBackupBlockProps = {}) {
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [config, setConfig] = useState<ScheduleConfig | null>(null);

  // Resolve the active vault + load its schedule config once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const id = await resolveActiveVaultId();
        if (cancelled || id == null) return;
        const cfg = await scheduleRead(id);
        if (cancelled) return;
        setVaultId(id);
        setConfig(cfg);
      } catch {
        // Best-effort: leave the block in its loading state. The scheduler
        // still runs from the Editor regardless of this panel rendering.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      onShowToast?.("Could not save backup settings.");
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
      title: "Choose a folder for automatic backups",
    }).catch(() => null);
    if (typeof picked !== "string") return; // cancelled
    commit({ ...config, targetFolder: picked });
  };

  // Loading / no-vault: render nothing rather than a half-state.
  if (config == null) return null;

  const status = statusText(config);

  return (
    <div style={BLOCK_STYLE} data-testid="settings.auto-backup">
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE} id="auto-backup-label">
          Automatic backups
        </span>
        <Switch
          checked={config.enabled}
          onChange={(enabled) => commit({ ...config, enabled })}
          ariaLabel="Automatic backups"
          ariaDescribedBy="auto-backup-helper"
          testId="settings.auto-backup-toggle"
        />
      </div>

      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>Frequency</span>
        <SearchableSelect
          options={INTERVAL_OPTIONS}
          selected={[config.interval]}
          onChange={(next) => {
            const interval = next[0] as BackupInterval;
            commit({ ...config, interval });
          }}
          aria-label="Backup frequency"
          testId="settings.auto-backup-interval"
          searchPlaceholder="Search…"
          emptyText="No match."
        />
      </div>

      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>Backup folder</span>
        <Button
          variant="secondary"
          onClick={() => void chooseFolder()}
          data-testid="settings.auto-backup-folder"
        >
          Choose folder…
        </Button>
      </div>
      {config.targetFolder ? (
        <code style={FOLDER_DISPLAY_STYLE} title={config.targetFolder} data-testid="settings.auto-backup-folder-path">
          {config.targetFolder}
        </code>
      ) : (
        <span style={FOLDER_PLACEHOLDER_STYLE}>No folder chosen yet.</span>
      )}

      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>Keep last</span>
        <Input
          type="number"
          min={1}
          max={365}
          value={config.retentionN}
          style={RETENTION_INPUT_STYLE}
          data-testid="settings.auto-backup-retention"
          onChange={(e) => {
            const n = Number(e.currentTarget.value);
            if (!Number.isInteger(n) || n < 1) return; // ignore empty/invalid mid-type
            commit({ ...config, retentionN: n });
          }}
        />
      </div>

      <p id="auto-backup-status" style={{ ...STATUS_BASE_STYLE, color: status.tone }} data-testid="settings.auto-backup-status">
        {status.text}
      </p>

      <p id="auto-backup-helper" style={HELPER_STYLE}>
        Write an encrypted .myne-backup to a folder on a schedule, while the app
        is open and the vault is unlocked. Backups stay as encrypted as your
        vault; Myne keeps the most recent few and never sends anything off your
        device.
      </p>
    </div>
  );
}
