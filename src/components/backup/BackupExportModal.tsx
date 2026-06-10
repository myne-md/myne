// Backup-export progress modal (MYND-56 task 1; engine MYND-32).
//
// Post-unlock modal carve-out (decisions.md 2026-05-08) — solicited via the
// Settings button / palette action / reminder banner. Importer anatomy:
// inert while running (no backdrop/Esc dismiss), the error state closes via
// its explicit button only. Success closes itself and hands the parent a
// Toast line — the file's existence already means "verified" (SYNC-4).
//
// Flow: open → engine-owned default filename → native save dialog (its own
// overwrite confirm) → `vault_export_backup` with `backup://progress`
// counts. Cancel → `backup_cancel` (cooperative; partial output discarded).

import { useEffect, useRef, useState } from "react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "../primitives/Button";
import { ModalShell } from "../primitives/ModalShell";
import { exportErrorMessage } from "../../lib/backup-errors";
import {
  backupCancel,
  backupDefaultFilename,
  exportBackup,
  onBackupProgress,
} from "../../lib/vault-backup";
import type {
  BackupExportError,
  BackupProgress,
} from "../../types/backup-export-error";

type ExportState =
  | { step: "running"; progress: BackupProgress | null }
  | { step: "error"; message: string };

interface BackupExportModalProps {
  open: boolean;
  onClose: () => void;
  /** Toast line on verified success ("success = verified", SYNC-4). */
  onShowToast: (message: string) => void;
}

export function BackupExportModal({
  open,
  onClose,
  onShowToast,
}: BackupExportModalProps) {
  const [state, setState] = useState<ExportState>({
    step: "running",
    progress: null,
  });
  // The parent passes inline closures (unstable identities); routing them
  // through refs keeps the effect keyed on `open` alone — a parent
  // re-render mid-export must not tear down the progress subscription.
  const callbacksRef = useRef({ onClose, onShowToast });
  callbacksRef.current = { onClose, onShowToast };
  // Once-per-open guard for the native save dialog: under StrictMode the
  // effect double-invokes on mount (cleanup between), and the ref —
  // surviving that remount — keeps a second dialog from opening.
  const startedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    setState({ step: "running", progress: null });

    let unlisten: (() => void) | null = null;
    let disposed = false;
    void onBackupProgress((progress) => {
      setState((prev) =>
        prev.step === "running" ? { step: "running", progress } : prev,
      );
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    void (async () => {
      const suggested = await backupDefaultFilename().catch(
        () => "Myne backup.myne-backup",
      );
      const destination = await saveFileDialog({
        defaultPath: suggested,
        filters: [{ name: "Myne backup", extensions: ["myne-backup"] }],
      }).catch(() => null);
      if (typeof destination !== "string") {
        callbacksRef.current.onClose(); // dialog dismissed — nothing started
        return;
      }
      try {
        await exportBackup(destination);
        callbacksRef.current.onShowToast("Backup verified and saved.");
        callbacksRef.current.onClose();
      } catch (raw) {
        setState({
          step: "error",
          message: exportErrorMessage(raw as BackupExportError),
        });
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open]);

  return (
    <ModalShell
      open={open}
      title="Back up vault"
      labelId="backup-export-title"
      // Importer-anatomy inertness: while running, Esc/backdrop/× no-op —
      // cancel goes through the explicit Cancel button (cooperative).
      onClose={state.step === "error" ? onClose : () => {}}
    >
      {state.step === "running" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            data-testid="backup-export.progress"
            style={{ fontSize: 14, color: "var(--fg-2)" }}
          >
            {state.progress === null
              ? "Preparing…"
              : state.progress.phase === "verify"
                ? `Verifying ${state.progress.done} of ${state.progress.total}…`
                : `Copying ${state.progress.done} of ${state.progress.total}…`}
          </div>
          <div>
            <Button
              variant="secondary"
              onClick={() => void backupCancel()}
              data-testid="backup-export.cancel"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {state.step === "error" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            data-testid="backup-export.error"
            style={{ fontSize: 14, lineHeight: 1.6, color: "var(--fg-2)" }}
          >
            {state.message}
          </div>
          <div>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
