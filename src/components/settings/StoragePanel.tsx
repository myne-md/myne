// Settings → Storage panel: read-only vaults-location path display +
// Backup/Restore actions (MYND-56; engines MYND-32/MYND-218).
//
// Path resolution mirrors `src-tauri/src/paths.rs` post-MYND-165:
// vaults live under `appDataDir()/vaults/<id>/`; the panel shows the
// `vaults/` root (the per-id directory name is an opaque UUID — showing
// the root is the useful, stable path). No new IPC, no capability ACL
// change. The promise is module-cached so switching rail items doesn't
// re-fire two Tauri IPCs per visit.
//
// Penpot canon: `🔴 screen------settings--storage` (frame id
// `9fb59646-2811-8082-8007-fd43bc128f9a`).

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { appDataDir, join } from "../../platform/path";
import { openPath } from "../../platform/opener";
import { Button } from "../primitives/Button";
import { AutomaticBackupBlock } from "./AutomaticBackupBlock";
import { ControlBlock } from "./ControlBlock";
import { SettingRow } from "./SettingRow";
import { PANEL_ROOT_STYLE } from "./panel-styles";

// Module-scope memoized resolution. The vault path doesn't change
// during a process lifetime; one IPC pair per app session is enough.
let vaultPathPromise: Promise<string> | null = null;
function resolveVaultPath(): Promise<string> {
  if (!vaultPathPromise) {
    vaultPathPromise = (async () => {
      const base = await appDataDir();
      return join(base, "vaults");
    })();
  }
  return vaultPathPromise;
}

// Internal sentinel values held in `vaultPath` state — NOT user copy. `"…"` is
// the locale-neutral loading glyph; `PATH_UNAVAILABLE_SENTINEL` flags the
// resolution-failed state and is rendered through `t(...)` at display time so
// the user-facing words are translated while the gating comparison stays stable.
const PATH_LOADING_SENTINEL = "…";
const PATH_UNAVAILABLE_SENTINEL = "\u0000path-unavailable";

const PATH_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "stretch",
  gap: "var(--space-2)",
};

const PATH_DISPLAY_STYLE: CSSProperties = {
  flex: 1,
  display: "block",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: 6,
  padding: "8px 12px",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  userSelect: "text",
  WebkitUserSelect: "text",
  wordBreak: "break-all",
};

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
  const [vaultPath, setVaultPath] = useState<string>(PATH_LOADING_SENTINEL);

  useEffect(() => {
    let cancelled = false;
    resolveVaultPath()
      .then((dir) => {
        if (!cancelled) setVaultPath(dir);
      })
      .catch(() => {
        if (!cancelled) setVaultPath(PATH_UNAVAILABLE_SENTINEL);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pathPending =
    vaultPath === PATH_LOADING_SENTINEL ||
    vaultPath === PATH_UNAVAILABLE_SENTINEL;
  const displayPath =
    vaultPath === PATH_UNAVAILABLE_SENTINEL
      ? t("settings.storage.pathUnavailable")
      : vaultPath;

  return (
    <div style={PANEL_ROOT_STYLE}>
      <ControlBlock
        anchorId="storage.location"
        label={t("settings.storage.locationLabel")}
        helper={t("settings.storage.locationHelper")}
        control={
          <div style={PATH_ROW_STYLE}>
            <code style={PATH_DISPLAY_STYLE}>{displayPath}</code>
            <Button
              variant="secondary"
              onClick={() => {
                if (pathPending) return;
                void openPath(vaultPath).catch(() => {
                  /* opener-plugin failure is non-fatal — the path is
                   * already shown for manual copy/paste. */
                });
              }}
              disabled={pathPending}
            >
              {t("settings.storage.openInFiles")}
            </Button>
          </div>
        }
      />

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

      <ControlBlock
        anchorId="storage.export"
        label={t("settings.storage.exportLabel")}
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
    </div>
  );
}
