// "Recovered notes" section for the Settings → Sync panel — the visibility
// surface over the device-local `quarantine/` dir (the reconcile drop-leg
// parks a previously-synced note there when its server record was deleted +
// reclaimed remotely; never destroyed, never re-uploaded). Lists the
// quarantined blobs with Preview (in-memory decrypt modal, the SnapshotsPanel
// pattern), Restore (backend re-creates it as a NEW note, then drops the
// quarantine source), and Delete (DeleteConfirmModal-gated — this is the only
// path that destroys quarantine evidence). Hidden list when empty; the
// section helper carries the explanation.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Toast } from "../Toast";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import {
  quarantineDelete,
  quarantineList,
  quarantineRead,
  quarantineRestore,
  type QuarantineEntry,
} from "../../notes/quarantine";
import {
  BACKDROP_STYLE,
  DeleteConfirmModal,
} from "../../notes/components/DeleteConfirmModal";
import { formatRelativeTime } from "../../notes/components/relativeTime";

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  overflow: "hidden",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-2) var(--space-3)",
  borderBottom: "1px solid var(--line-1)",
  fontFamily: "var(--font-sans)",
};

const ROW_ID_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--fg-1)",
  flexShrink: 0,
};

const ROW_META_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
  flex: 1,
  minWidth: 0,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const BTN_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: 500,
  padding: "3px 9px",
  borderRadius: 5,
  cursor: "pointer",
  border: "1px solid var(--line-2)",
  background: "var(--paper-2)",
  color: "var(--fg-1)",
  flexShrink: 0,
};

const RESTORE_BTN_STYLE: CSSProperties = {
  ...BTN_STYLE,
  borderColor: "var(--accent)",
  color: "var(--accent)",
};

const DELETE_BTN_STYLE: CSSProperties = {
  ...BTN_STYLE,
  color: "var(--warning)",
};

const ERROR_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--warning)",
  margin: 0,
};

const PREVIEW_CARD_STYLE: CSSProperties = {
  width: 560,
  maxWidth: "90vw",
  maxHeight: "70vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3)",
  boxShadow: "var(--shadow-3)",
  fontFamily: "var(--font-sans)",
  overflow: "hidden",
};

const PREVIEW_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-3) var(--space-5)",
  borderBottom: "1px solid var(--line-1)",
};

const PREVIEW_TITLE_STYLE: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--fg-1)",
  margin: 0,
};

const PREVIEW_ID_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-3)",
};

const PREVIEW_BODY_STYLE: CSSProperties = {
  flex: 1,
  overflow: "auto",
  margin: 0,
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  color: "var(--fg-2)",
};

const PREVIEW_PLACEHOLDER_STYLE: CSSProperties = {
  margin: "auto",
  padding: "var(--space-7)",
  textAlign: "center",
  fontSize: 13,
  color: "var(--fg-3)",
};

const PREVIEW_FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  padding: "var(--space-3) var(--space-5)",
  borderTop: "1px solid var(--line-1)",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export type RecoveredNotesProps = {
  /**
   * Called after a successful restore so the host refreshes the sidebar's
   * note list (the restored note is a brand-new note the live cache hasn't
   * seen). The SyncPanel wires its existing `noteList` + `refreshAll`
   * mechanism here.
   */
  onRestored?: () => Promise<void> | void;
};

export function RecoveredNotes({ onRestored }: RecoveredNotesProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<QuarantineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** File currently mid-restore/delete — its row buttons are disabled. */
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    fileName: string;
    body: string | null;
    failed: boolean;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setEntries(await quarantineList());
      setError(null);
    } catch {
      // Non-fatal: the section keeps its last-known list; the error line
      // carries the honest generic copy (no backend detail to overclaim).
      setError(t("sync.panel.recovered.errorGeneric"));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openPreview = useCallback(
    (fileName: string) => {
      setPreview({ fileName, body: null, failed: false });
      void (async () => {
        try {
          const body = await quarantineRead(fileName);
          setPreview((p) =>
            p?.fileName === fileName ? { fileName, body, failed: false } : p,
          );
        } catch {
          setPreview((p) =>
            p?.fileName === fileName ? { fileName, body: null, failed: true } : p,
          );
        }
      })();
    },
    [],
  );

  const doRestore = useCallback(
    (fileName: string) => {
      setBusy(fileName);
      setError(null);
      void (async () => {
        try {
          await quarantineRestore(fileName);
          setToast(t("sync.recovered.restoredToast"));
          await onRestored?.();
        } catch {
          setError(t("sync.panel.recovered.errorGeneric"));
        } finally {
          setBusy(null);
          await reload();
        }
      })();
    },
    [onRestored, reload, t],
  );

  const doDelete = useCallback(() => {
    const fileName = confirmDelete;
    if (fileName === null) return;
    setConfirmDelete(null);
    setBusy(fileName);
    setError(null);
    void (async () => {
      try {
        await quarantineDelete(fileName);
      } catch {
        setError(t("sync.panel.recovered.errorGeneric"));
      } finally {
        setBusy(null);
        await reload();
      }
    })();
  }, [confirmDelete, reload, t]);

  return (
    <>
      {entries.length > 0 && (
        <div style={LIST_STYLE}>
          {entries.map((e, idx) => {
            const isLast = idx === entries.length - 1;
            const rowBusy = busy === e.file_name;
            const age =
              e.modified_epoch_ms !== null
                ? formatRelativeTime(new Date(e.modified_epoch_ms))
                : "";
            return (
              <div
                key={e.file_name}
                style={isLast ? { ...ROW_STYLE, borderBottom: "none" } : ROW_STYLE}
                data-testid="sync.recovered-row"
                data-file-name={e.file_name}
              >
                <span style={ROW_ID_STYLE}>{e.note_id_hex.slice(0, 8)}…</span>
                <span style={ROW_META_STYLE}>
                  {[formatBytes(e.size), age].filter(Boolean).join(" · ")}
                </span>
                <button
                  type="button"
                  style={BTN_STYLE}
                  disabled={rowBusy}
                  data-testid="sync.recovered-preview"
                  data-file-name={e.file_name}
                  onClick={() => openPreview(e.file_name)}
                >
                  {t("sync.panel.recovered.previewCta")}
                </button>
                <button
                  type="button"
                  style={RESTORE_BTN_STYLE}
                  disabled={rowBusy}
                  data-testid="sync.recovered-restore"
                  data-file-name={e.file_name}
                  onClick={() => doRestore(e.file_name)}
                >
                  {t("sync.panel.recovered.restoreCta")}
                </button>
                <button
                  type="button"
                  style={DELETE_BTN_STYLE}
                  disabled={rowBusy}
                  data-testid="sync.recovered-delete"
                  data-file-name={e.file_name}
                  onClick={() => setConfirmDelete(e.file_name)}
                >
                  {t("sync.panel.recovered.deleteCta")}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {error !== null && <p style={ERROR_STYLE}>{error}</p>}

      {preview !== null && (
        <RecoveredPreviewModal
          fileName={preview.fileName}
          body={preview.body}
          failed={preview.failed}
          onClose={() => setPreview(null)}
        />
      )}

      {confirmDelete !== null && (
        <DeleteConfirmModal
          title={t("sync.panel.recovered.deleteConfirmTitle")}
          body={`${confirmDelete.slice(0, 8)}…`}
          warning={t("sync.panel.recovered.deleteConfirmWarning")}
          confirmTestId="sync.recovered-delete-confirm"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={doDelete}
        />
      )}

      <Toast message={toast} onDone={() => setToast(null)} />
    </>
  );
}

// In-memory decrypt preview — the SnapshotsPanel modal pattern (BACKDROP_STYLE
// reuse, Esc/backdrop close). Plaintext stays in this modal's state only;
// nothing is written to disk.
function RecoveredPreviewModal({
  fileName,
  body,
  failed,
  onClose,
}: {
  fileName: string;
  body: string | null;
  failed: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { enabled: true });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={BACKDROP_STYLE}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        style={PREVIEW_CARD_STYLE}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovered-preview-title"
      >
        <div style={PREVIEW_HEADER_STYLE}>
          <h2 id="recovered-preview-title" style={PREVIEW_TITLE_STYLE}>
            {t("sync.panel.recovered.previewTitle")}
          </h2>
          <span style={PREVIEW_ID_STYLE}>{fileName}</span>
        </div>
        {failed ? (
          <div style={PREVIEW_PLACEHOLDER_STYLE}>
            {t("sync.panel.recovered.errorGeneric")}
          </div>
        ) : body === null ? (
          <div style={PREVIEW_PLACEHOLDER_STYLE}>
            {t("sync.panel.recovered.decrypting")}
          </div>
        ) : (
          <pre style={PREVIEW_BODY_STYLE} data-testid="sync.recovered-preview-body">
            {body}
          </pre>
        )}
        <div style={PREVIEW_FOOTER_STYLE}>
          <button
            type="button"
            style={BTN_STYLE}
            data-testid="sync.recovered-preview-close"
            onClick={onClose}
          >
            {t("sync.panel.recovered.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
