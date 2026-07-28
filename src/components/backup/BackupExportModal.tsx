// Backup-export progress modal (MYND-56 task 1; engine MYND-32).
//
// Post-unlock modal carve-out (decisions.md 2026-05-08) — solicited via the
// Settings button / palette action. Importer anatomy:
// inert while running (no backdrop/Esc dismiss), the error state closes via
// its explicit button only. Success closes itself and hands the parent a
// Toast line — the file's existence already means "verified" (SYNC-4).
//
// Flow: open → engine-owned default filename → native save dialog (its own
// overwrite confirm) → `vault_export_backup` with `backup://progress`
// counts. Cancel → `backup_cancel` (cooperative; partial output discarded).

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { save as saveFileDialog } from "../../platform/dialog";
import { Button } from "../primitives/Button";
import { ModalShell } from "../primitives/ModalShell";
import { Spinner } from "../Spinner";
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

// Modal anatomy shared with DeleteAttachmentDialog: padded body + a
// right-aligned footer row, all tokens (src/CLAUDE.md "Design tokens").
const BODY_STYLE: CSSProperties = {
  padding: "var(--space-4) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  lineHeight: 1.6,
  color: "var(--fg-1)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  padding: "var(--space-3) var(--space-5) var(--space-4)",
};

const PROGRESS_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  color: "var(--fg-2)",
};

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
  const { t } = useTranslation();
  const [state, setState] = useState<ExportState>({
    step: "running",
    progress: null,
  });
  // The parent passes inline closures (unstable identities); routing them
  // through refs keeps the effect keyed on `open` alone — a parent
  // re-render mid-export must not tear down the progress subscription.
  const callbacksRef = useRef({ onClose, onShowToast, t });
  callbacksRef.current = { onClose, onShowToast, t };
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
        callbacksRef.current.onShowToast(
          callbacksRef.current.t("backup.export.successToast"),
        );
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
      title={t("backup.export.title")}
      labelId="backup-export-title"
      // Importer-anatomy inertness: while running, Esc/backdrop/× no-op —
      // cancel goes through the explicit Cancel button (cooperative).
      onClose={state.step === "error" ? onClose : () => {}}
    >
      {state.step === "running" && (
        <>
          <div style={BODY_STYLE}>
            <div style={PROGRESS_ROW_STYLE} data-testid="backup-export.progress">
              <Spinner size={16} />
              <span>
                {state.progress === null
                  ? t("backup.export.preparing")
                  : state.progress.phase === "verify"
                    ? t("backup.export.verifying", {
                        done: state.progress.done,
                        total: state.progress.total,
                      })
                    : t("backup.export.copying", {
                        done: state.progress.done,
                        total: state.progress.total,
                      })}
              </span>
            </div>
          </div>
          <div style={FOOTER_STYLE}>
            <Button
              variant="ghost"
              onClick={() => void backupCancel()}
              data-testid="backup-export.cancel"
            >
              {t("backup.export.cancel")}
            </Button>
          </div>
        </>
      )}
      {state.step === "error" && (
        <>
          <div style={BODY_STYLE}>
            <div
              data-testid="backup-export.error"
              style={{ color: "var(--fg-2)" }}
            >
              {state.message}
            </div>
          </div>
          <div style={FOOTER_STYLE}>
            <Button variant="secondary" onClick={onClose}>
              {t("backup.export.close")}
            </Button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
