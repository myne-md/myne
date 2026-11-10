// Settings → Storage panel: Backup/Restore actions plus import and export
// (MYND-56; engines MYND-32/MYND-218).
//
// The vault-location section is gone (myne-md/myne#960). It printed
// `appDataDir()/vaults` and offered "Open in Files". Two reasons it went: the
// path is an implementation detail the user cannot act on (a manual copy of that
// directory is exactly what the adjacent Backup control exists to replace, and it
// is the one copy path that is not verified after writing), and the panel's first
// section was an essay about a path in front of the actions people open this
// panel for. Web's Settings → Storage always showed its own browser-storage row
// and is untouched.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../primitives/Button";
import { AutomaticBackupBlock } from "./AutomaticBackupBlock";
import { ControlBlock } from "./ControlBlock";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import { PANEL_ROOT_STYLE } from "./panel-styles";

// Export block (MYND-211): row body + right-aligned action, per the
// Penpot frame `section------export — settings storage block (MYND-211)`.
const EXPORT_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
};

const EXPORT_BODY_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};

interface StoragePanelProps {
  /** The active vault, threaded from Settings (#250) — the schedule block edits
   *  THIS vault's schedule rather than the one a best-effort cache names. */
  vaultId: string | null;
  /** Open the import flow (MYND-53; source-agnostic since MYND-586 — the flow
   *  opens on a source picker covering Obsidian / Notion / Evernote / HTML / CSV).
   *  Absent → the control is disabled (e.g. if Settings is shown outside the
   *  Editor). */
  onImportObsidian?: () => void;
  /** "Back up vault…" → export progress modal (MYND-32). */
  onBackupVault?: () => void;
  /** "Restore from backup…" → the restore Stage flow (MYND-218). */
  onRestoreBackup?: () => void;
  /** "Export…" → the whole-vault markdown export modal (MYND-211). Absent →
   *  disabled, same defensive degrade as the other rows (Settings only opens
   *  from the unlocked editor, so the vault is unlocked by construction). */
  onExportVault?: () => void;
  /** Toast surface — threaded to the automatic-backup block for a failed
   *  settings write (MYND-351). */
  onShowToast?: (message: string) => void;
}

export function StoragePanel({
  vaultId,
  onImportObsidian,
  onBackupVault,
  onRestoreBackup,
  onExportVault,
  onShowToast,
}: StoragePanelProps) {
  const { t } = useTranslation();

  return (
    <div style={PANEL_ROOT_STYLE}>
      {/* Two sections (myne-md/myne#885, #960). The grouping puts the import row
          down beside the export block: both are "move notes across the
          boundary", while backup is about this vault's own encrypted copies. */}

      <SettingsSection title={t("settings.storage.sections.backup")}>
        <SettingRow
          anchorId="storage.backup"
          label={t("settings.storage.backupLabel")}
          helper={t("settings.storage.backupHelper")}
          control={
            <>
              <Button
                variant="secondary"
                onClick={onBackupVault}
                disabled={onBackupVault === undefined}
                data-testid="settings.backup-vault"
              >
                {t("settings.storage.backUpVault")}
              </Button>
              <Button
                variant="secondary"
                onClick={onRestoreBackup}
                disabled={onRestoreBackup === undefined}
                data-testid="settings.restore-backup"
              >
                {t("settings.storage.restoreBackup")}
              </Button>
            </>
          }
        />

        <AutomaticBackupBlock vaultId={vaultId} onShowToast={onShowToast} />
      </SettingsSection>

      <SettingsSection title={t("settings.storage.sections.transfer")}>
        <SettingRow
          anchorId="storage.import"
          label={t("settings.storage.importLabel")}
          helper={t("settings.storage.importHelper")}
          control={
            <Button
              variant="secondary"
              onClick={onImportObsidian}
              disabled={onImportObsidian === undefined}
              data-testid="storage.import"
            >
              {t("settings.storage.importObsidian")}
            </Button>
          }
        />

        <ControlBlock
          anchorId="storage.export"
          label={t("common.export")}
          helper={t("settings.storage.exportHelper")}
          control={
            <div style={EXPORT_ROW_STYLE}>
              <span style={EXPORT_BODY_STYLE}>
                {t("settings.storage.exportBody")}
              </span>
              <Button
                variant="secondary"
                onClick={onExportVault}
                disabled={onExportVault === undefined}
                data-testid="vault-export.block-button"
              >
                {t("settings.storage.exportAction")}
              </Button>
            </div>
          }
        />
      </SettingsSection>
    </div>
  );
}
