// `<ArchivePanel>` — the vault Archive view (MYND-331). A modal overlay (the
// same backdrop envelope as `<TrashPanel>`) listing archived notes with their
// relative archived-age, newest-first. Per row: Restore (→ live, back in its
// folder; reversible, no confirm) + Delete (→ Trash; reversible soft-trash, no
// scary confirm — permanent deletion happens from the Trash panel). There is
// **no "Empty archive" action** — archive is kept indefinitely, no auto-purge.
//
// Archive state is the value-strict `archived:` marker (`archivedRecords`
// selector); Restore = `unarchiveWithRollback`, Delete = `trashWithRollback`
// (which clears `archived:` and sets `trashed:`, honoring archive ⊥ trash).

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  archivedRecords,
  useSelectedNote,
  type NoteId,
} from "../sidebarState";
import { BACKDROP_STYLE } from "./DeleteConfirmModal";
import {
  AGE_STYLE,
  COUNT_STYLE,
  EMPTY_STATE_STYLE,
  FOOTER_STYLE,
  HEADER_STYLE,
  HEADER_TITLE_STYLE,
  LIST_STYLE,
  PANEL_STYLE,
  ROW_BTN_STYLE,
  ROW_STYLE,
  ROW_TITLE_STYLE,
  STATUS_STYLE,
} from "./notePanelStyles";
import { formatRelativeTime } from "./relativeTime";

const CLOSE_BTN_STYLE: CSSProperties = {
  ...ROW_BTN_STYLE,
  marginLeft: "auto",
};

export type ArchivePanelProps = {
  open: boolean;
  onClose: () => void;
};

export function ArchivePanel({ open, onClose }: ArchivePanelProps) {
  const ctx = useSelectedNote();
  const [status, setStatus] = useState<string | null>(null);

  const records = useMemo(() => archivedRecords(ctx.cache), [ctx.cache]);

  // Esc closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Clear any transient status whenever the panel reopens.
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
      void ctx.unarchiveWithRollback(id).catch(() => {
        setStatus("Couldn't restore that note. Try again.");
      });
    },
    [ctx],
  );

  // Delete from the Archive → move to Trash (reversible soft-trash; permanent
  // deletion is a separate, deliberate step from the Trash panel). trashNote
  // clears `archived:` and sets `trashed:`, so the note leaves the Archive.
  const deleteToTrash = useCallback(
    (id: NoteId) => {
      void ctx.trashWithRollback(id).catch(() => {
        setStatus("Couldn't delete that note. Try again.");
      });
    },
    [ctx],
  );

  if (!open) return null;

  const count = records.length;

  return (
    <div style={BACKDROP_STYLE} onClick={handleBackdrop} role="presentation">
      <div
        style={PANEL_STYLE}
        role="dialog"
        aria-modal="true"
        data-testid="archive.panel"
        aria-labelledby="archive-panel-title"
      >
        <div style={HEADER_STYLE}>
          <h2 id="archive-panel-title" style={HEADER_TITLE_STYLE}>
            Archive
          </h2>
          <span style={COUNT_STYLE}>
            {count === 0 ? "Empty" : `${count} note${count === 1 ? "" : "s"}`}
          </span>
        </div>

        {count === 0 ? (
          <div style={EMPTY_STATE_STYLE}>Archive is empty.</div>
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
                  {r.archived !== null
                    ? formatRelativeTime(new Date(r.archived))
                    : ""}
                </span>
                <button
                  type="button"
                  style={ROW_BTN_STYLE}
                  data-testid="archive.restore"
                  data-note-id={r.noteUuid}
                  onClick={() => restore(r.noteUuid)}
                >
                  Restore
                </button>
                <button
                  type="button"
                  style={ROW_BTN_STYLE}
                  data-testid="archive.delete"
                  data-note-id={r.noteUuid}
                  onClick={() => deleteToTrash(r.noteUuid)}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={FOOTER_STYLE}>
          {status !== null && <span style={STATUS_STYLE}>{status}</span>}
          <button
            type="button"
            style={CLOSE_BTN_STYLE}
            data-testid="archive.close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
