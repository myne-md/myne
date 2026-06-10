// `<TrashPanel>` — the vault trash view (MYND-133). A modal overlay (reusing
// the `<DeleteConfirmModal>` / `<SettingsModal>` backdrop envelope) listing
// soft-deleted notes with their relative trashed-age. Per row: Restore
// (reversible, no confirm) + Delete permanently (scary confirm). Footer:
// Empty trash (count-aware scary confirm). Empty state when nothing is trashed.
//
// Trash state is the value-strict `trashed:` marker (`trashedRecords` selector);
// Restore = `restoreWithRollback`, single purge = `deleteWithRollback`, empty =
// `emptyTrashWithSync` (best-effort; partial failure reports a remaining count).

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  trashedRecords,
  useSelectedNote,
  type NoteId,
} from "../sidebarState";
import { BACKDROP_STYLE, DeleteConfirmModal } from "./DeleteConfirmModal";
import { formatRelativeTime } from "./relativeTime";

const PANEL_STYLE: CSSProperties = {
  width: 460,
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

const COUNT_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
};

const LIST_STYLE: CSSProperties = {
  overflowY: "auto",
  padding: "var(--space-2) 0",
  flex: 1,
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-2) var(--space-5)",
};

const ROW_TITLE_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  color: "var(--fg-1)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const AGE_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
  flexShrink: 0,
};

const ROW_BTN_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: 500,
  padding: "4px 8px",
  borderRadius: 5,
  cursor: "pointer",
  border: "1px solid var(--line-2)",
  background: "var(--paper-2)",
  color: "var(--fg-1)",
  flexShrink: 0,
};

const PURGE_BTN_STYLE: CSSProperties = {
  ...ROW_BTN_STYLE,
  color: "var(--warning)",
  borderColor: "var(--line-2)",
};

const EMPTY_STATE_STYLE: CSSProperties = {
  padding: "var(--space-7) var(--space-5)",
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

const STATUS_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--warning)",
};

const EMPTY_TRASH_BTN_STYLE: CSSProperties = {
  ...ROW_BTN_STYLE,
  color: "var(--warning)",
  marginLeft: "auto",
};

const CLOSE_BTN_STYLE: CSSProperties = {
  ...ROW_BTN_STYLE,
};

type Confirm =
  | { kind: "single"; id: NoteId; title: string | null }
  | { kind: "empty"; ids: NoteId[] }
  | null;

export type TrashPanelProps = {
  open: boolean;
  onClose: () => void;
};

export function TrashPanel({ open, onClose }: TrashPanelProps) {
  const ctx = useSelectedNote();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [status, setStatus] = useState<string | null>(null);

  const records = useMemo(() => trashedRecords(ctx.cache), [ctx.cache]);

  // Esc closes the panel (when no confirm is layered on top).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && confirm === null) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, confirm, onClose]);

  // Clear the partial-failure status whenever the panel reopens.
  useEffect(() => {
    if (open) setStatus(null);
  }, [open]);

  const handleBackdrop = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const restore = useCallback(
    (id: NoteId) => {
      void ctx.restoreWithRollback(id).catch(() => {
        setStatus("Couldn't restore that note. Try again.");
      });
    },
    [ctx],
  );

  const confirmPurge = useCallback(async () => {
    if (confirm === null) return;
    if (confirm.kind === "single") {
      const id = confirm.id;
      setConfirm(null);
      await ctx.deleteWithRollback(id).catch(() => {
        setStatus("Couldn't delete that note. Try again.");
      });
      return;
    }
    // empty trash — best-effort bulk purge with a remaining count on failure.
    // Re-derive the kill list from the CURRENT trashed set at confirm time (not
    // the snapshot taken when the modal opened): a note restored while the
    // confirm was up — e.g. via the undo toast, which floats above the modal —
    // must NOT be purged (MYND-133; PR-review F1, "no note loss").
    setConfirm(null);
    const ids = trashedRecords(ctx.cache).map((r) => r.noteUuid);
    const result = await ctx.emptyTrashWithSync(ids);
    if (result.failed.length > 0) {
      setStatus(
        `${result.failed.length} note${result.failed.length === 1 ? "" : "s"} couldn't be deleted and remain in the trash.`,
      );
    }
  }, [confirm, ctx]);

  if (!open) return null;

  const count = records.length;

  return (
    <div style={BACKDROP_STYLE} onClick={handleBackdrop} role="presentation">
      <div
        style={PANEL_STYLE}
        role="dialog"
        aria-modal="true"
        data-testid="trash.panel"
        aria-labelledby="trash-panel-title"
      >
        <div style={HEADER_STYLE}>
          <h2 id="trash-panel-title" style={HEADER_TITLE_STYLE}>
            Trash
          </h2>
          <span style={COUNT_STYLE}>
            {count === 0 ? "Empty" : `${count} note${count === 1 ? "" : "s"}`}
          </span>
        </div>

        {count === 0 ? (
          <div style={EMPTY_STATE_STYLE}>Trash is empty.</div>
        ) : (
          <div style={LIST_STYLE}>
            {records.map((r) => (
              <div key={r.noteUuid} style={ROW_STYLE}>
                <span style={ROW_TITLE_STYLE} title={r.title ?? "Untitled"}>
                  {r.title === null || r.title.trim() === ""
                    ? "Untitled"
                    : r.title}
                </span>
                <span style={AGE_STYLE}>
                  {r.trashed !== null
                    ? formatRelativeTime(new Date(r.trashed))
                    : ""}
                </span>
                <button
                  type="button"
                  style={ROW_BTN_STYLE}
                  data-testid="trash.restore"
                  data-note-id={r.noteUuid}
                  onClick={() => restore(r.noteUuid)}
                >
                  Restore
                </button>
                <button
                  type="button"
                  style={PURGE_BTN_STYLE}
                  data-testid="trash.delete"
                  data-note-id={r.noteUuid}
                  onClick={() =>
                    setConfirm({
                      kind: "single",
                      id: r.noteUuid,
                      title: r.title,
                    })
                  }
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={FOOTER_STYLE}>
          {status !== null && <span style={STATUS_STYLE}>{status}</span>}
          {count > 0 && (
            <button
              type="button"
              style={EMPTY_TRASH_BTN_STYLE}
              data-testid="trash.empty"
              onClick={() =>
                setConfirm({
                  kind: "empty",
                  ids: records.map((r) => r.noteUuid),
                })
              }
            >
              Empty trash
            </button>
          )}
          <button
            type="button"
            style={CLOSE_BTN_STYLE}
            data-testid="trash.close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>

      {confirm !== null && confirm.kind === "single" && (
        <DeleteConfirmModal
          noteTitle={confirm.title}
          title="Delete permanently?"
          confirmLabel="Delete permanently"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmPurge()}
        />
      )}
      {confirm !== null && confirm.kind === "empty" && (
        <DeleteConfirmModal
          title="Empty trash?"
          body={`${confirm.ids.length} note${confirm.ids.length === 1 ? "" : "s"} will be permanently deleted.`}
          confirmLabel="Empty trash"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmPurge()}
        />
      )}
    </div>
  );
}
