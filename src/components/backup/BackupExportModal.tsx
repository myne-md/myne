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
// adds is the one-time line this feature is allowed to surface automatically —
// a backup is not a substitute for the recovery phrase, with a button into the
// drill. Dismissal persists in `localStorage` (`backup-drill-line.ts`): shown
// once on this device, then never again.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { save as saveFileDialog } from "../../platform/dialog";
import { Button } from "../primitives/Button";
import { ModalShell } from "../primitives/ModalShell";
import { Spinner } from "../Spinner";
import { exportFailureMessage } from "../../lib/backup-errors";
import {
  hasSeenBackupDrillLine,
  markBackupDrillLineSeen,
} from "../../lib/backup-drill-line";
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

const DRILL_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--space-3)",
  borderTop: "1px solid var(--line-1)",
  paddingTop: "var(--space-3)",
};

const DRILL_TEXT_STYLE: CSSProperties = {
  flex: 1,
  color: "var(--fg-2)",
  lineHeight: 1.5,
};

const DRILL_ONCE_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
  marginBlockStart: "var(--space-1)",
};

interface BackupExportModalProps {
  open: boolean;
  onClose: () => void;
  /** Success → "Check it": close the export surface and land on the recovery
   *  drill in Settings (myne-md/myne#468). Owned by the parent because opening
   *  Settings is the Editor's, not this modal's. */
  onOpenDrill: () => void;
}

export function BackupExportModal({
  open,
  onClose,
  onOpenDrill,
}: BackupExportModalProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<ExportState>({
    step: "running",
    progress: null,
  });
  // Read once per mount: nothing else in the session writes this key. If the
  // user retires the line while this modal is open, the local state below is
  // what hides it, so the stored value need not be re-read.
  const [drillSeen, setDrillSeen] = useState(hasSeenBackupDrillLine);
  // The parent passes an inline closure (unstable identity); routing it through
  // a ref keeps the effect keyed on `open` alone — a parent re-render mid-export
  // must not tear down the progress subscription. `onOpenDrill` is only read
  // from the render, where the prop is always current, so it needs no ref.
  const callbacksRef = useRef({ onClose });
  callbacksRef.current = { onClose };
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
        await exportBackup(destination);
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

  // Retire the line for good. Called from every acknowledgement of the success
  // screen — Done, Esc, the backdrop, and the drill button itself: acting on the
  // line is the strongest acknowledgement there is.
  const retireDrillLine = () => {
    markBackupDrillLineSeen();
    setDrillSeen(true);
  };

  // The one close path for the terminal states. Closing a SUCCESS screen is an
  // acknowledgement, so it retires the line; closing an ERROR screen is not, so
  // it leaves it alone (the line belongs to a completed backup).
  const handleDismiss = () => {
    if (state.step === "success" && !drillSeen) retireDrillLine();
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
            {!drillSeen && (
              <div style={DRILL_ROW_STYLE} data-testid="backup-export.drill-line">
                <div style={DRILL_TEXT_STYLE}>
                  <b>{t("backup.export.drillTitle")}</b>
                  <div>{t("backup.export.drillBody")}</div>
                  <div style={DRILL_ONCE_STYLE}>
                    {t("backup.export.drillOnce")}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    retireDrillLine();
                    onOpenDrill();
                  }}
                  data-testid="backup-export.drill-test"
                >
                  {t("backup.export.drillCta")}
                </Button>
              </div>
            )}
          </div>
          <div style={FOOTER_STYLE}>
            <Button
              variant="secondary"
              onClick={handleDismiss}
              data-testid="backup-export.done"
            >
              {t("backup.export.close")}
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
