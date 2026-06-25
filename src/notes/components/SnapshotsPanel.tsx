// `<SnapshotsPanel>` — the file-recovery surface for encrypted per-note
// snapshots (MYND-97). A modal overlay (reusing the `<DeleteConfirmModal>`
// backdrop envelope, like `<TrashPanel>`) scoped to ONE note: a left list of the
// note's snapshots (newest-first, with relative age + size), a right pane that
// previews the selected snapshot with a minimal added/removed line-diff against
// the current note, and a confirmed Restore.
//
// Copy discipline (SYNC-4): the term is "snapshot", never "backup"/"export";
// encryption is shown typographically ("Encrypted · 12s ago"), not with a
// green-badge cliché; nothing overclaims beyond the threat-model §7 guarantee.
// Restore routes through the backend `snapshot_restore`, which captures the
// current note as an undo point first (SYNC-5) — the confirm copy says so.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import i18n from "../../i18n";
import type { NoteId } from "../sidebarState";
import { noteRead } from "../readNote";
import {
  snapshotList,
  snapshotPreview,
  snapshotRestore,
} from "../snapshots";
import type { SnapshotError, SnapshotMeta } from "../../types/snapshot-error";
import { BACKDROP_STYLE } from "./DeleteConfirmModal";
import { changedLineCount, lineDiff, type DiffLine } from "../lineDiff";
import { formatRelativeTime } from "./relativeTime";

const PANEL_STYLE: CSSProperties = {
  width: 720,
  maxWidth: "92vw",
  height: "70vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3)",
  boxShadow: "var(--shadow-3)",
  fontFamily: "var(--font-sans)",
  overflow: "hidden",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  padding: "var(--space-4) var(--space-5)",
  borderBottom: "1px solid var(--line-1)",
};

const HEADER_TITLE_STYLE: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--fg-1)",
  margin: 0,
};

const SUBTITLE_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
  maxWidth: 360,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const BODY_STYLE: CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
};

const LIST_STYLE: CSSProperties = {
  width: 240,
  flexShrink: 0,
  overflowY: "auto",
  borderRight: "1px solid var(--line-1)",
  padding: "var(--space-2) 0",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "var(--space-2) var(--space-5)",
  cursor: "pointer",
  border: "none",
  background: "transparent",
  width: "100%",
  textAlign: "left",
  fontFamily: "var(--font-sans)",
};

const ROW_SELECTED_STYLE: CSSProperties = {
  ...ROW_STYLE,
  background: "var(--accent-soft)",
};

const ROW_AGE_STYLE: CSSProperties = {
  fontSize: 13,
  color: "var(--fg-1)",
};

const ROW_META_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
};

const DETAIL_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
};

const DETAIL_BAR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-3) var(--space-5)",
  borderBottom: "1px solid var(--line-1)",
};

const DIFF_STYLE: CSSProperties = {
  flex: 1,
  overflow: "auto",
  margin: 0,
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const DIFF_LINE_BASE: CSSProperties = { display: "block" };
const DIFF_ADD_STYLE: CSSProperties = { ...DIFF_LINE_BASE, color: "var(--accent)" };
const DIFF_DEL_STYLE: CSSProperties = {
  ...DIFF_LINE_BASE,
  color: "var(--fg-3)",
  textDecoration: "line-through",
};
const DIFF_SAME_STYLE: CSSProperties = { ...DIFF_LINE_BASE, color: "var(--fg-2)" };

const EMPTY_STATE_STYLE: CSSProperties = {
  margin: "auto",
  padding: "var(--space-7) var(--space-5)",
  textAlign: "center",
  fontSize: 13,
  color: "var(--fg-3)",
  maxWidth: 360,
};

const PLACEHOLDER_STYLE: CSSProperties = {
  margin: "auto",
  padding: "var(--space-7)",
  textAlign: "center",
  fontSize: 13,
  color: "var(--fg-3)",
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-3) var(--space-5)",
  borderTop: "1px solid var(--line-1)",
};

const STATUS_STYLE: CSSProperties = { fontSize: 12, color: "var(--warning)" };

const BTN_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: 500,
  padding: "4px 10px",
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Honest, non-overclaiming copy for a rejected snapshot command. */
function formatSnapshotError(err: unknown): string {
  const kind = (err as Partial<SnapshotError>)?.kind;
  switch (kind) {
    case "VaultNotUnlocked":
      return i18n.t("notes.snapshots.errorVaultLocked");
    case "SnapshotNotFound":
      return i18n.t("notes.snapshots.errorNotFound");
    case "CannotDecrypt":
      return i18n.t("notes.snapshots.errorCannotDecrypt");
    case "Io":
      return i18n.t("notes.snapshots.errorIo");
    case "NotesDirNotADirectory":
      return i18n.t("notes.snapshots.errorStorageAccess");
    case "InvalidNoteId":
    case "InvalidSnapshotId":
    case "JoinFailure":
    default:
      return i18n.t("notes.snapshots.errorGeneric");
  }
}

export type SnapshotsPanelProps = {
  open: boolean;
  onClose: () => void;
  /** The note whose snapshots are shown. When null, the panel renders nothing. */
  noteId: NoteId | null;
  /** Current note title, for the header subtitle (display only). */
  noteTitle: string | null;
  /**
   * Called after a successful restore so the host can re-read the open note's
   * editor body from disk (restore overwrites the `.myn` out-of-band of the
   * editor's autosave). Without this the open buffer stays stale until the user
   * reselects the note.
   */
  onRestored?: () => void;
};

export function SnapshotsPanel({
  open,
  onClose,
  noteId,
  noteTitle,
  onRestored,
}: SnapshotsPanelProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Trap + restore focus while open (MYND-93).
  useFocusTrap(dialogRef, { enabled: open });
  const [snaps, setSnaps] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [current, setCurrent] = useState<string>("");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    if (noteId === null) return;
    setLoading(true);
    setListError(null);
    try {
      const list = await snapshotList(noteId);
      setSnaps(list);
    } catch (err) {
      setSnaps([]);
      setListError(formatSnapshotError(err));
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  // Load the snapshot list on open / note change; reset transient state.
  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setPreview(null);
    setDetailError(null);
    setStatus(null);
    void loadList();
  }, [open, loadList]);

  // Esc closes the panel (when no confirm is layered on top).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && confirmRestore === null) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, confirmRestore, onClose]);

  const selectSnapshot = useCallback(
    async (uuid: string) => {
      if (noteId === null) return;
      setSelected(uuid);
      setPreview(null);
      setDetailError(null);
      try {
        const [body, cur] = await Promise.all([
          snapshotPreview(noteId, uuid),
          noteRead(noteId).catch(() => ""),
        ]);
        setPreview(body);
        setCurrent(cur);
      } catch (err) {
        setDetailError(formatSnapshotError(err));
      }
    },
    [noteId],
  );

  const doRestore = useCallback(async () => {
    if (noteId === null || confirmRestore === null) return;
    const uuid = confirmRestore;
    setConfirmRestore(null);
    try {
      await snapshotRestore(noteId, uuid);
      // Re-read the open note's editor body from disk — restore overwrote the
      // `.myn` via the backend, so the editor's buffer is otherwise stale.
      onRestored?.();
      setStatus(t("notes.snapshots.restoredStatus"));
      setSelected(null);
      setPreview(null);
      await loadList();
    } catch (err) {
      setStatus(formatSnapshotError(err));
    }
  }, [noteId, confirmRestore, loadList, onRestored, t]);

  const handleBackdrop = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const diff: DiffLine[] | null = useMemo(() => {
    if (preview === null) return null;
    return lineDiff(preview, current);
  }, [preview, current]);

  if (!open || noteId === null) return null;

  const count = snaps.length;

  return (
    <div style={BACKDROP_STYLE} onClick={handleBackdrop} role="presentation">
      <div
        ref={dialogRef}
        style={PANEL_STYLE}
        role="dialog"
        aria-modal="true"
        data-testid="snapshots.panel"
        aria-labelledby="snapshots-panel-title"
      >
        <div style={HEADER_STYLE}>
          <h2 id="snapshots-panel-title" style={HEADER_TITLE_STYLE}>
            {t("notes.snapshots.title")}
          </h2>
          <span
            style={SUBTITLE_STYLE}
            title={noteTitle ?? t("notes.snapshots.untitled")}
          >
            {noteTitle && noteTitle.trim() !== ""
              ? noteTitle
              : t("notes.snapshots.untitled")}
          </span>
        </div>

        {count === 0 && !loading ? (
          <div style={EMPTY_STATE_STYLE}>
            {listError ?? t("notes.snapshots.emptyState")}
          </div>
        ) : (
          <div style={BODY_STYLE}>
            <div style={LIST_STYLE} aria-label={t("notes.snapshots.listLabel")}>
              {loading && snaps.length === 0 ? (
                <div style={{ ...ROW_META_STYLE, padding: "var(--space-3) var(--space-5)" }}>
                  {t("notes.snapshots.loading")}
                </div>
              ) : (
                snaps.map((s, idx) => {
                  const isSel = s.snapshot_uuid === selected;
                  return (
                    <button
                      key={s.snapshot_uuid}
                      type="button"
                      style={isSel ? ROW_SELECTED_STYLE : ROW_STYLE}
                      aria-pressed={isSel}
                      data-testid="snapshots.row"
                      data-snapshot-id={s.snapshot_uuid}
                      data-index={idx}
                      onClick={() => void selectSnapshot(s.snapshot_uuid)}
                    >
                      <span style={ROW_AGE_STYLE}>
                        {formatRelativeTime(new Date(s.captured_at_ms)) ||
                          t("notes.snapshots.justNow")}
                      </span>
                      <span style={ROW_META_STYLE}>
                        {t("notes.snapshots.encryptedSize", {
                          size: formatBytes(s.size_bytes),
                        })}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            <div style={DETAIL_STYLE}>
              {selected === null ? (
                <div style={PLACEHOLDER_STYLE}>
                  {t("notes.snapshots.selectPlaceholder")}
                </div>
              ) : detailError !== null ? (
                <div style={PLACEHOLDER_STYLE}>{detailError}</div>
              ) : preview === null ? (
                <div style={PLACEHOLDER_STYLE}>
                  {t("notes.snapshots.decrypting")}
                </div>
              ) : (
                <>
                  <div style={DETAIL_BAR_STYLE}>
                    <span style={ROW_META_STYLE}>
                      {diff
                        ? t("notes.snapshots.changeCount", {
                            count: changedLineCount(diff),
                          })
                        : ""}
                    </span>
                    <button
                      type="button"
                      style={RESTORE_BTN_STYLE}
                      data-testid="snapshots.restore"
                      data-snapshot-id={selected}
                      onClick={() => setConfirmRestore(selected)}
                    >
                      {t("notes.snapshots.restoreCta")}
                    </button>
                  </div>
                  <pre style={DIFF_STYLE} data-testid="snapshots.preview">
                    {diff?.map((d, idx) => (
                      <span
                        key={idx}
                        style={
                          d.type === "add"
                            ? DIFF_ADD_STYLE
                            : d.type === "del"
                              ? DIFF_DEL_STYLE
                              : DIFF_SAME_STYLE
                        }
                      >
                        {d.type === "add" ? "+ " : d.type === "del" ? "− " : "  "}
                        {d.text}
                      </span>
                    ))}
                  </pre>
                </>
              )}
            </div>
          </div>
        )}

        <div style={FOOTER_STYLE}>
          {status !== null && <span style={STATUS_STYLE}>{status}</span>}
          <button
            type="button"
            style={{ ...BTN_STYLE, marginLeft: "auto" }}
            onClick={onClose}
          >
            {t("notes.snapshots.close")}
          </button>
        </div>
      </div>

      {confirmRestore !== null && (
        <RestoreConfirm
          onCancel={() => setConfirmRestore(null)}
          onConfirm={() => void doRestore()}
        />
      )}
    </div>
  );
}

// Restore confirmation — a lightweight modal that does NOT reuse
// `<DeleteConfirmModal>` because that hardcodes "This cannot be undone.", which
// is wrong for restore: the backend captures the current note as an undo point
// first (SYNC-5), so restore IS reversible. Cancel is default-focused; Esc
// cancels.
const CONFIRM_CARD_STYLE: CSSProperties = {
  width: 380,
  maxWidth: "90vw",
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3)",
  boxShadow: "var(--shadow-3)",
  padding: "var(--space-5)",
  fontFamily: "var(--font-sans)",
};

const CONFIRM_TITLE_STYLE: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--fg-1)",
  margin: "0 0 var(--space-2)",
};

const CONFIRM_BODY_STYLE: CSSProperties = {
  fontSize: 13,
  color: "var(--fg-2)",
  margin: "0 0 var(--space-5)",
  lineHeight: 1.5,
};

const CONFIRM_ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-3)",
};

function RestoreConfirm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      style={BACKDROP_STYLE}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <div
        style={CONFIRM_CARD_STYLE}
        role="dialog"
        aria-modal="true"
        data-testid="snapshots.restore-confirm"
        aria-labelledby="restore-confirm-title"
      >
        <h2 id="restore-confirm-title" style={CONFIRM_TITLE_STYLE}>
          {t("notes.snapshots.confirmTitle")}
        </h2>
        <p style={CONFIRM_BODY_STYLE}>{t("notes.snapshots.confirmBody")}</p>
        <div style={CONFIRM_ROW_STYLE}>
          <button
            ref={cancelRef}
            type="button"
            style={BTN_STYLE}
            data-testid="snapshots.restore-cancel"
            onClick={onCancel}
          >
            {t("notes.snapshots.cancel")}
          </button>
          <button
            type="button"
            style={RESTORE_BTN_STYLE}
            data-testid="snapshots.restore-confirm-cta"
            onClick={onConfirm}
          >
            {t("notes.snapshots.restore")}
          </button>
        </div>
      </div>
    </div>
  );
}
