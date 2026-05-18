// Settings → Storage panel: read-only vault-location path display +
// disabled Backup/Restore buttons (enable with MYND-118).
//
// Path resolution mirrors `src-tauri/src/paths.rs::vault_dir`'s
// derivation — `appDataDir() + join("vault")` reads the same Tauri
// `app_data_dir` source the backend writes to. No new IPC, no
// capability ACL change. The promise is module-cached so switching
// rail items doesn't re-fire two Tauri IPCs per visit.
//
// Penpot canon: `🔴 screen------settings--storage` (frame id
// `9fb59646-2811-8082-8007-fd43bc128f9a`).

import { useEffect, useState, type CSSProperties } from "react";
import { appDataDir, join } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { Button } from "../primitives/Button";
import { ControlBlock } from "./ControlBlock";
import { PANEL_ROOT_STYLE } from "./panel-styles";

// Module-scope memoized resolution. The vault path doesn't change
// during a process lifetime; one IPC pair per app session is enough.
let vaultPathPromise: Promise<string> | null = null;
function resolveVaultPath(): Promise<string> {
  if (!vaultPathPromise) {
    vaultPathPromise = (async () => {
      const base = await appDataDir();
      return join(base, "vault");
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

export function StoragePanel() {
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
        helper="Copy this path to back up your vault manually. The folder contains an encrypted vault.meta file plus per-note .myn blobs."
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
        label="Backup"
        helper="Encrypted backup files are decryptable only with this vault's recovery phrase. Backup format and restore flow ship in Phase 1.x."
        control={
          <div style={BACKUP_BUTTON_ROW_STYLE}>
            <Button variant="secondary" disabled>
              Backup vault…
            </Button>
            <Button variant="secondary" disabled>
              Restore from backup…
            </Button>
          </div>
        }
      />
    </div>
  );
}
