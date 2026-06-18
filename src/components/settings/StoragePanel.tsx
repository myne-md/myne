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
import { appDataDir, join } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { Button } from "../primitives/Button";
import { AutomaticBackupBlock } from "./AutomaticBackupBlock";
import { ControlBlock } from "./ControlBlock";
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

const BACKUP_BUTTON_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "var(--space-2)",
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
  /** Open the Obsidian vault import flow (MYND-53). Absent → the control is
   *  disabled (e.g. if Settings is ever shown outside the Editor). */
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
  onImportObsidian,
  onBackupVault,
  onRestoreBackup,
  onExportVault,
  onShowToast,
}: StoragePanelProps = {}) {
  const [vaultPath, setVaultPath] = useState<string>("…");

  useEffect(() => {
    let cancelled = false;
    resolveVaultPath()
      .then((dir) => {
        if (!cancelled) setVaultPath(dir);
      })
      .catch(() => {
        if (!cancelled) setVaultPath("Path unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={PANEL_ROOT_STYLE}>
      <ControlBlock
        label="Vault location"
        helper="Each vault is a folder of encrypted files under this path. Prefer the Backup button below over manual copies — it verifies the written file."
        control={
          <div style={PATH_ROW_STYLE}>
            <code style={PATH_DISPLAY_STYLE}>{vaultPath}</code>
            <Button
              variant="secondary"
              onClick={() => {
                if (vaultPath === "…" || vaultPath === "Path unavailable") return;
                void openPath(vaultPath).catch(() => {
                  /* opener-plugin failure is non-fatal — the path is
                   * already shown for manual copy/paste. */
                });
              }}
              disabled={vaultPath === "…" || vaultPath === "Path unavailable"}
            >
              Open in Files
            </Button>
          </div>
        }
      />

      <ControlBlock
        label="Import"
        helper="Bring an existing Obsidian vault into Myne. Every Markdown note is imported and encrypted on the spot; your original files are left untouched."
        control={
          <div style={BACKUP_BUTTON_ROW_STYLE}>
            <Button
              variant="secondary"
              onClick={onImportObsidian}
              disabled={onImportObsidian === undefined}
            >
              Import Obsidian vault…
            </Button>
          </div>
        }
      />

      <ControlBlock
        label="Backup"
        helper="Backups stay exactly as encrypted as your vault, in a single verified .myne-backup file. Restoring works with that vault's password or recovery phrase — exactly like unlock."
        control={
          <div style={BACKUP_BUTTON_ROW_STYLE}>
            <Button
              variant="secondary"
              onClick={onBackupVault}
              disabled={onBackupVault === undefined}
              data-testid="settings.backup-vault"
            >
              Back up vault…
            </Button>
            <Button
              variant="secondary"
              onClick={onRestoreBackup}
              disabled={onRestoreBackup === undefined}
              data-testid="settings.restore-backup"
            >
              Restore from backup…
            </Button>
          </div>
        }
      />

      <AutomaticBackupBlock onShowToast={onShowToast} />

      <ControlBlock
        label="Export"
        helper="Plain markdown tree — not encrypted."
        control={
          <div style={EXPORT_ROW_STYLE}>
            <span style={EXPORT_BODY_STYLE}>Export vault as Markdown</span>
            <Button
              variant="secondary"
              onClick={onExportVault}
              disabled={onExportVault === undefined}
              data-testid="vault-export.block-button"
            >
              Export…
            </Button>
          </div>
        }
      />
    </div>
  );
}
