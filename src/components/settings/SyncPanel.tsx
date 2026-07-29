// Sync settings panel (MYND-424/425/426/427) — the in-app hub for the sync
// engine: runtime status + manual sync, this-account device management (add +
// approve + remove), the cold-start "building index" state, and the keep-both
// Conflicts surface. Mounts inside the Editor's SidebarStateProvider, so it reads
// the live note cache for conflict copies. Penpot skipped per the owner
// directive; built against design tokens, mirroring the other Settings panels'
// block / label / helper rhythm.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Trans, useTranslation } from "react-i18next";
import { listen } from "../../platform/event";
import { SyncStatusIndicator } from "../sync/SyncStatusIndicator";
import { EndpointConfig } from "../sync/EndpointConfig";
import { EnrollDeviceForm } from "../sync/EnrollDeviceForm";
import { DeviceManagementPanel } from "../sync/DeviceManagementPanel";
import { DeviceJoinQr } from "../sync/DeviceJoinQr";
import { BuildingIndexState } from "../sync/BuildingIndexState";
import { SyncUsageBlock } from "../sync/SyncUsageBlock";
import { RecoveredNotes } from "../sync/RecoveredNotes";
import { ConflictsView } from "../../notes/components/ConflictsView";
import {
  useSelectedNote,
  conflictRecordsByOriginal,
  UNKNOWN_CONFLICT_ORIGINAL,
} from "../../notes/sidebarState";
import { noteRead } from "../../notes/readNote";
import { noteUpdate } from "../../notes/updateNote";
import { deleteNoteRouted } from "../../notes/deleteNote";
import {
  clearConflictMarkers,
  applyConflictVersion,
  undoConflictVersion,
} from "../../notes/conflictCopy";
import { Toast } from "../Toast";
import { noteList } from "../../notes";
import { useDevices } from "../../hooks/useDevices";
import { useAccountStatus } from "../../hooks/useAccountStatus";
import { useSyncStatus } from "../../hooks/useSyncStatus";
import { ENROLL_PENDING_NOTICE } from "../../lib/load-bearing-copy";
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
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  const groups = conflictRecordsByOriginal(ctx.cache);

  // Device roster, lifted here so its poll feeds BOTH the device list and the
  // "Add a device" enroll gate (single source of enrollment truth).
  const devicesHook = useDevices();

  // Plan-free usage projection (MYND-570). Absent (`null`) on a server without
  // the route — self-hosted or older — in which case the block is simply not
  // rendered: no error, no hosted-only concept, no upsell.
  const { status: accountStatus } = useAccountStatus();
  // "Add a device" enrolls THIS device into an account; once this device is an
  // approved member it can never be re-added, so the form is dead UI — hide it.
  // It stays visible while not-yet-a-member (never enrolled, pending approval,
  // or removed-elsewhere/reset), so re-adding after a reset still works. Hidden
  // until enrollment is positively known, to avoid flashing the form for an
  // already-enrolled device on the first poll.
  const enrolledHere = (devicesHook.devices ?? []).some(
    (d) => d.is_current && d.approved && !d.retired,
  );
  const enrollmentKnown =
    devicesHook.devices !== null || devicesHook.error !== null;
  // A device AWAITING APPROVAL must not be offered the enrol form (MYND-635).
  //
  // It reads as unenrolled from here and always will: a pending device holds no
  // token, so the roster call fails `NotEnrolled` and `enrolledHere` can never
  // become true. The form was therefore shown to exactly the person it cannot
  // help — and using it does real harm, because enrolling mints a FRESH
  // `device_id` and leaves a second pending record behind. Repeat that a few
  // times and the account accumulates devices nobody can identify, each needing
  // its own approval, while the one the user is sitting at still waits.
  //
  // `sync_status` is the arbiter rather than the roster, and that is the point:
  // the roster is the thing a pending device cannot read, so asking it "am I
  // pending?" is asking the one source guaranteed to be silent. Status derives
  // the answer from disk — identity persisted, token absent — with no server
  // round trip.
  const { status: syncStatus } = useSyncStatus();
  const awaitingApproval = syncStatus?.state === "pending";
  const showEnroll = enrollmentKnown && !enrolledHere && !awaitingApproval;

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

  // Take theirs ("Use this version", MYND-452): promote the remote copy to the
  // surviving note and tombstone the local original. A result toast offers Undo.
  // The toast is local to this panel (rendered below) — it floats above the
  // Settings modal (fixed, z-index 1100), so no Editor↔modal plumbing is needed.
  const [takeTheirsPending, setTakeTheirsPending] = useState<{
    copyId: string;
    originalUuid: string;
  } | null>(null);

  const handleTakeTheirs = useCallback(
    (copyId: string, originalUuid: string) => {
      // Defensive: `conflictRecordsByOriginal` groups an orphan copy (no
      // `conflict_of:`) under the UNKNOWN_CONFLICT_ORIGINAL sentinel; ConflictsView
      // already suppresses the take-theirs button there, so this only guards a
      // direct/programmatic call — there's no real original to trash.
      if (originalUuid === UNKNOWN_CONFLICT_ORIGINAL) return;
      void (async () => {
        try {
          await applyConflictVersion(copyId, originalUuid);
          await refreshSidebar();
          setTakeTheirsPending({ copyId, originalUuid });
        } catch {
          // Non-fatal — the copy stays listed until the next refresh.
        }
      })();
    },
    [refreshSidebar],
  );

  const handleUndoTakeTheirs = useCallback(() => {
    const pending = takeTheirsPending;
    if (pending === null) return;
    setTakeTheirsPending(null);
    void (async () => {
      try {
        await undoConflictVersion(pending.copyId, pending.originalUuid);
        await refreshSidebar();
      } catch {
        // Non-fatal — the user can reconcile manually from the list.
      }
    })();
  }, [takeTheirsPending, refreshSidebar]);

  return (
    <div style={PANEL_ROOT_STYLE} data-testid="settings.sync-panel">
      <div style={BLOCK_STYLE}>
        <span style={LABEL_STYLE}>{t("sync.panel.server.label")}</span>
        <EndpointConfig />
        <p style={HELPER_STYLE}>
          <Trans i18nKey="sync.panel.server.helper">
            Enter the same server URL on every device. For a self-hosted server
            use its <code>https://</code> address; verify the certificate
            fingerprint matches across your devices.
          </Trans>
        </p>
      </div>

      <div style={BLOCK_STYLE}>
        <span style={LABEL_STYLE}>{t("sync.panel.status.label")}</span>
        <SyncStatusIndicator />
        <BuildingIndexState building={buildingIndex} />
        <p style={HELPER_STYLE}>{t("sync.panel.status.helper")}</p>
      </div>

      {accountStatus !== null && (
        <div style={BLOCK_STYLE}>
          <span style={LABEL_STYLE}>{t("sync.panel.usage.label")}</span>
          <SyncUsageBlock status={accountStatus} />
          <p style={HELPER_STYLE}>{t("sync.panel.usage.helper")}</p>
        </div>
      )}

      {showEnroll && (
        <div style={BLOCK_STYLE}>
          <span style={SECTION_TITLE_STYLE}>
            {t("sync.panel.addDevice.label")}
          </span>
          <p style={HELPER_STYLE}>{t("sync.panel.addDevice.helper")}</p>
          <EnrollDeviceForm />
        </div>
      )}

      {/* What that form is replaced BY for a device that is already waiting
          (MYND-635). Stating the situation rather than offering an action,
          because there is no action to take here: approval happens on another
          device, and the only button this screen could honestly show would
          create a second pending record.

          The sentence is `ENROLL_PENDING_NOTICE`, rendered verbatim from
          `@myne/copy` — the same literal `EnrollDeviceForm` and the web entry
          screen already show. Not an i18n key: `scripts/check-i18n.mjs` derives
          the load-bearing list from those exported constants and fails if one
          appears as a catalog value, precisely so this sentence cannot acquire
          24 machine-filled variants. */}
      {enrollmentKnown && !enrolledHere && awaitingApproval && (
        <div style={BLOCK_STYLE} data-testid="sync.panel.awaiting-approval">
          <span style={SECTION_TITLE_STYLE}>
            {t("sync.panel.awaitingApproval.label")}
          </span>
          <p style={HELPER_STYLE}>{ENROLL_PENDING_NOTICE}</p>
        </div>
      )}

      <div style={BLOCK_STYLE}>
        <span style={SECTION_TITLE_STYLE}>{t("sync.panel.devices.label")}</span>
        <DeviceManagementPanel hook={devicesHook} />
      </div>

      {/* An enrolled device can invite another by showing a QR (MYND-466). */}
      {enrolledHere && (
        <div style={BLOCK_STYLE}>
          <DeviceJoinQr />
        </div>
      )}

      <div style={BLOCK_STYLE}>
        <span style={SECTION_TITLE_STYLE}>
          {t("sync.panel.conflicts.label")}
        </span>
        <p style={HELPER_STYLE}>{t("sync.panel.conflicts.helper")}</p>
        <ConflictsView
          groups={groups}
          onKeepBoth={handleKeepBoth}
          onDiscard={handleDiscard}
          onTakeTheirs={handleTakeTheirs}
        />
      </div>

      <div style={BLOCK_STYLE}>
        <span style={SECTION_TITLE_STYLE}>
          {t("sync.panel.recovered.label")}
        </span>
        <p style={HELPER_STYLE}>{t("sync.panel.recovered.helper")}</p>
        <RecoveredNotes onRestored={refreshSidebar} />
      </div>

      <Toast
        message={takeTheirsPending ? t("sync.conflicts.tookTheirsToast") : null}
        onDone={() => setTakeTheirsPending(null)}
        durationMs={8000}
        action={
          takeTheirsPending
            ? {
                label: t("sync.conflicts.tookTheirsUndo"),
                onAction: handleUndoTakeTheirs,
              }
            : undefined
        }
      />
    </div>
  );
}
