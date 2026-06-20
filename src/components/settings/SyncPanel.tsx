// Sync settings panel (MYND-424/425/426/427) — the in-app hub for the sync
// engine: runtime status + manual sync, this-account device management (add +
// approve + remove), the cold-start "building index" state, and the keep-both
// Conflicts surface. Mounts inside the Editor's SidebarStateProvider, so it reads
// the live note cache for conflict copies. Penpot skipped per the owner
// directive; built against design tokens, mirroring the other Settings panels'
// block / label / helper rhythm.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { SyncStatusIndicator } from "../sync/SyncStatusIndicator";
import { EndpointConfig } from "../sync/EndpointConfig";
import { EnrollDeviceForm } from "../sync/EnrollDeviceForm";
import { DeviceManagementPanel } from "../sync/DeviceManagementPanel";
import { BuildingIndexState } from "../sync/BuildingIndexState";
import { ConflictsView } from "../../notes/components/ConflictsView";
import {
  useSelectedNote,
  conflictRecordsByOriginal,
} from "../../notes/sidebarState";
import { noteRead } from "../../notes/readNote";
import { noteUpdate } from "../../notes/updateNote";
import { deleteNoteRouted } from "../../notes/deleteNote";
import { clearConflictMarkers } from "../../notes/conflictCopy";
import { noteList } from "../../notes";
import {
  PANEL_ROOT_STYLE,
  BLOCK_STYLE,
  LABEL_STYLE,
  HELPER_STYLE,
} from "./panel-styles";

const SECTION_TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
};

export function SyncPanel() {
  const ctx = useSelectedNote();
  const groups = conflictRecordsByOriginal(ctx.cache);

  // Cold-start "building search index…" state. Producer: the MYND-426 engine
  // re-derives vault.search/vault.indices after a full-reconcile or a fresh
  // device enroll and emits `sync://index-building` around that window. Dormant
  // until the loop lands (R3); no-op outside Tauri (browser dev shim).
  const [buildingIndex, setBuildingIndex] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const handle = await listen<{ building: boolean }>(
          "sync://index-building",
          (e) => {
            if (!cancelled) setBuildingIndex(e.payload?.building ?? true);
          },
        );
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Not inside Tauri → no index-building channel.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const refreshSidebar = useCallback(async () => {
    try {
      const ids = await noteList();
      await ctx.refreshAll(ids);
    } catch {
      // Sidebar stays as-is until the next refresh — non-fatal.
    }
  }, [ctx]);

  // Keep-both: the conflict copy becomes an ordinary note (clear its
  // `conflict:` / `conflict_of:` markers, write the new version), then refresh
  // so it re-enters the live sidebar.
  const handleKeepBoth = useCallback(
    (copyId: string) => {
      void (async () => {
        try {
          const content = await noteRead(copyId);
          await noteUpdate(copyId, clearConflictMarkers(content));
          await refreshSidebar();
        } catch {
          // Surfaced via the unchanged Conflicts list — the user can retry.
        }
      })();
    },
    [refreshSidebar],
  );

  // Discard: delete the conflict copy. Routed so that under sync it tombstones
  // (propagates + no resurrection) instead of a bare unlink.
  const handleDiscard = useCallback(
    (copyId: string) => {
      void (async () => {
        try {
          await deleteNoteRouted(copyId);
          await refreshSidebar();
        } catch {
          // Non-fatal — the copy stays listed until the next refresh.
        }
      })();
    },
    [refreshSidebar],
  );

  return (
    <div style={PANEL_ROOT_STYLE} data-testid="settings.sync-panel">
      <div style={BLOCK_STYLE}>
        <span style={LABEL_STYLE}>Sync server</span>
        <EndpointConfig />
        <p style={HELPER_STYLE}>
          Enter the same server URL on every device. For a self-hosted server use
          its <code>https://</code> address; verify the certificate fingerprint
          matches across your devices.
        </p>
      </div>

      <div style={BLOCK_STYLE}>
        <span style={LABEL_STYLE}>Sync status</span>
        <SyncStatusIndicator />
        <BuildingIndexState building={buildingIndex} />
        <p style={HELPER_STYLE}>
          Myne syncs your encrypted notes across your devices. The server stores
          only ciphertext it cannot read.
        </p>
      </div>

      <div style={BLOCK_STYLE}>
        <span style={SECTION_TITLE_STYLE}>Add a device</span>
        <p style={HELPER_STYLE}>
          Sign in on a new device with your account number and password or
          recovery phrase. A device stays pending until an existing device
          approves it.
        </p>
        <EnrollDeviceForm />
      </div>

      <div style={BLOCK_STYLE}>
        <span style={SECTION_TITLE_STYLE}>Devices</span>
        <DeviceManagementPanel />
      </div>

      <div style={BLOCK_STYLE}>
        <span style={SECTION_TITLE_STYLE}>Conflicts</span>
        <p style={HELPER_STYLE}>
          When the same note is edited on two devices at once, Myne keeps both
          copies so nothing is lost. Resolve them here.
        </p>
        <ConflictsView
          groups={groups}
          onKeepBoth={handleKeepBoth}
          onDiscard={handleDiscard}
        />
      </div>
    </div>
  );
}
