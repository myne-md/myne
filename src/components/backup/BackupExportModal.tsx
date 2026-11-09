// Backup-export progress modal (MYND-56 task 1; engine MYND-32).
//
// Post-unlock modal carve-out (decisions.md 2026-05-08) — solicited via the
// Settings button / palette action. Importer anatomy:
// inert while running (no backdrop/Esc dismiss), the error state closes via
// its explicit button only.
//
// Flow: open → engine-owned default filename → native save dialog (its own
// overwrite confirm) → `vault_export_backup` with `backup://progress`
// counts. Cancel → `backup_cancel` (cooperative; partial output discarded).
//
// Success is a SCREEN, not a toast (myne-md/myne#468 task 6). The file's
// existence still means "verified" (SYNC-4), and the screen says so; what it
// adds is one sentence under the filename, because a backup is not a substitute
// for the recovery phrase. It carries no control and no dismissal state: the
// Settings drill and the "Check it" button that used to sit here are withdrawn
// (`decisions/security/0747`, myne-md/myne#935), and what is left is a fact
// worth stating on every successful export rather than a nudge to dismiss once.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { save as saveFileDialog } from "../../platform/dialog";
import { Button } from "../primitives/Button";
import { ModalShell } from "../primitives/ModalShell";
import { Spinner } from "../Spinner";
import { exportFailureMessage } from "../../lib/backup-errors";
import {
  backupCancel,
  backupDefaultFilename,
  exportBackup,
  onBackupProgress,
} from "../../lib/vault-backup";
import type { BackupProgress } from "../../types/backup-export-error";

type ExportState =
  | { step: "running"; progress: BackupProgress | null }
  | { step: "success"; filename: string }
  | { step: "error"; message: string };

/** The file the user chose, without its directory. The save dialog owns the
 *  path; the success screen is about the artefact, and the mockup shows the
 *  name alone. Splits on either separator (Windows paths reach here too). */
function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// Modal anatomy shared with DeleteAttachmentDialog: padded body + a
// right-aligned footer row, all tokens (src/AGENTS.md "Design tokens").
const BODY_STYLE: CSSProperties = {
  padding: "var(--space-4) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
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

const SUCCESS_TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-lg)",
  color: "var(--fg-1)",
};

const SUCCESS_FILE_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  overflowWrap: "anywhere",
};

const PHRASE_NOTE_STYLE: CSSProperties = {
  borderTop: "1px solid var(--line-1)",
  paddingTop: "var(--space-3)",
  color: "var(--fg-2)",
  lineHeight: 1.5,
};

interface BackupExportModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * The vault to export. `null` while the active id is still resolving. The
   * command takes `vault_id` as a REQUIRED string, so a null target renders an
   * error instead of invoking with a missing argument, which the backend
   * answers with an unrecognised IPC error (myne-md/myne#817).
   */
  vaultId: string | null;
}

export function BackupExportModal({
  open,
  onClose,
  vaultId,
}: BackupExportModalProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<ExportState>({
    step: "running",
    progress: null,
  });
  // The parent passes inline closures (unstable identities); routing them
  // through a ref keeps the effect keyed on `open` alone — a parent re-render
  // mid-export must not tear down the progress subscription.
  const callbacksRef = useRef({ onClose, vaultId });
  callbacksRef.current = { onClose, vaultId };
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

    // The command requires the vault id; without one there is nothing to
    // export, and invoking anyway is what produced the "unknown failure"
    // copy. Read through the ref so a resolved id arriving later does not
    // re-run this effect and tear down the progress subscription.
    const targetVaultId = callbacksRef.current.vaultId;
    if (targetVaultId === null) {
      setState({
        step: "error",
        message: t("backup.errors.export.vaultNotFound"),
      });
      return;
    }

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
      // Dismissed and FAILED are two different outcomes and used to collapse
      // into one (myne#662): a `.catch(() => null)` here made an ACL denial or a
      // platform failure in the save dialog indistinguishable from the user
      // pressing Cancel, so the modal closed and reported nothing at all. A
      // dismissal still closes silently, that is the user's own answer, but a
      // throw is a failure and says so.
      let destination: string | null;
      try {
        destination = await saveFileDialog({
          defaultPath: suggested,
          filters: [{ name: "Myne backup", extensions: ["myne-backup"] }],
        });
      } catch (raw) {
        setState({ step: "error", message: exportFailureMessage(raw) });
        return;
      }
      if (typeof destination !== "string") {
        callbacksRef.current.onClose(); // dialog dismissed — nothing started
        return;
      }
      try {
        await exportBackup(destination, targetVaultId);
        setState({ step: "success", filename: fileNameOf(destination) });
      } catch (raw) {
        // `exportFailureMessage`, not `exportErrorMessage(raw as …)`: the cast
        // let a non-enum throw fall through the exhaustive switch and render as
        // `undefined`, which is the empty error modal of myne#662.
        setState({ step: "error", message: exportFailureMessage(raw) });
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open]);

  // The one close path for the terminal states.
  const handleDismiss = () => {
    onClose();
  };

  return (
    <ModalShell
      open={open}
      title={t("backup.export.title")}
      labelId="backup-export-title"
      // Importer-anatomy inertness: while running, Esc/backdrop/× no-op —
      // cancel goes through the explicit Cancel button (cooperative).
      onClose={state.step === "running" ? () => {} : handleDismiss}
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
      {state.step === "success" && (
        <>
          <div style={BODY_STYLE}>
            <div>
              <div
                style={SUCCESS_TITLE_STYLE}
                data-testid="backup-export.success"
              >
                {/* The SAME key the toast used: the file's existence is what
                    "verified" means (SYNC-4), and this screen is where that
                    statement now lives. */}
                {t("backup.export.successToast")}
              </div>
              <div style={SUCCESS_FILE_STYLE}>{state.filename}</div>
            </div>
            <div style={PHRASE_NOTE_STYLE} data-testid="backup-export.phrase-note">
              {t("backup.export.phraseNotSubstitute")}
            </div>
          </div>
          <div style={FOOTER_STYLE}>
            <Button
              variant="secondary"
              onClick={handleDismiss}
              data-testid="backup-export.done"
            >
              {t("common.close")}
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
              {t("common.close")}
            </Button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
