// `<ArchivePanel>` — the vault Archive view (MYND-331 + folder-archive). A modal
// overlay (the same backdrop envelope as `<TrashPanel>`) listing the archive in
// two sections:
//   - FOLDER rows (folder-archive): folders archived as a unit (`archived_folders`
//     prefs set), top-level only (a nested archived folder folds under its
//     archived ancestor). Per row: Restore (→ the whole subtree returns live, no
//     confirm) + Delete → Trash (soft-trashes the subtree, behind an inline
//     confirm since it touches many notes).
//   - NOTE rows: individually note-archived notes (value-strict `archived:`) that
//     are NOT already inside an archived folder (those show under the folder row).
//     Per row: Restore (→ live, back in its folder) + Delete (→ Trash).
//
// There is **no "Empty archive" action** — archive is kept indefinitely, no
// auto-purge. Restore/Delete of notes route through `unarchiveWithRollback` /
// `trashWithRollback`; folder Restore/Delete route through the folder-archive
// handlers threaded from `useFolderManagement`.

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
import { Icon } from "../../components/primitives/Icon";
import { folderKey } from "../../dialect/folderPath";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useOverlayInert } from "../../hooks/useOverlayInert";
import {
  archivedFolderKeys,
  collectSubtreeNoteIdsFromCache,
  isNoteFolderArchived,
  topLevelArchivedFolders,
} from "../archivedFolders";
import { archivedRecords, useSelectedNote, type NoteId } from "../sidebarState";
import { useWorkspace } from "../workspaceContext";
import { BACKDROP_STYLE, DeleteConfirmModal } from "./DeleteConfirmModal";
import { PanelEmptyState } from "./PanelEmptyState";
import {
  AGE_STYLE,
  COUNT_STYLE,
  HEADER_CLOSE_STYLE,
  HEADER_LEFT_STYLE,
  HEADER_RIGHT_STYLE,
  HEADER_STYLE,
  HEADER_TITLE_STYLE,
  LIST_STYLE,
  PANEL_STYLE,
  ROW_ACTIONS_STYLE,
  ROW_ICON_BTN_STYLE,
  ROW_STYLE,
  ROW_TITLE_STYLE,
  STATUS_LINE_STYLE,
} from "./notePanelStyles";
import { formatRelativeTime } from "./relativeTime";

const FOLDER_TITLE_STYLE: CSSProperties = {
  ...ROW_TITLE_STYLE,
  display: "flex",
  alignItems: "center",
  gap: "6px",
};

/** Display form of a canonical trailing-slash folder path (drop the slash). */
function folderLabel(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

export type ArchivePanelProps = {
  open: boolean;
  onClose: () => void;
  /** The `archived_folders` set (folder-archive) — raw canonical paths. */
  archivedFolders: readonly string[];
  /** Restore a folder (remove its subtree from `archived_folders`). */
  onRestoreFolder: (path: string) => void;
  /** Soft-trash an archived folder's subtree + drop it from the set. */
  onDeleteFolderToTrash: (path: string) => void;
};

export function ArchivePanel({
  open,
  onClose,
  archivedFolders,
  onRestoreFolder,
  onDeleteFolderToTrash,
}: ArchivePanelProps) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  const ws = useWorkspace();
  const [status, setStatus] = useState<string | null>(null);
  // Folder path armed for the inline "Move N to Trash?" confirm (null = none).
  const [confirmFolder, setConfirmFolder] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // The rest of the page goes INERT while this is open (myne-md/myne#728).
  // The focus trap above contains Tab; it does not stop a screen reader's
  // virtual cursor reading the page behind, and `aria-modal` is an assertion
  // some assistive technology ignores. Registered on the BACKDROP, which is
  // the whole overlay: registering the card would inert the backdrop it is in.
  const backdropRef = useRef<HTMLDivElement>(null);
  useOverlayInert(backdropRef, open);
  // Trap + restore focus while open (MYND-93).
  useFocusTrap(dialogRef, { enabled: open });


  const archivedKeys = useMemo(
    () => archivedFolderKeys(archivedFolders),
    [archivedFolders],
  );
  // Top-level archived folders (nested ones fold under their ancestor).
  const folderRows = useMemo(
    () => topLevelArchivedFolders(archivedFolders),
    [archivedFolders],
  );
  // Individually-archived notes NOT already under an archived folder (those are
  // represented by their folder row — avoid listing them twice).
  const noteRows = useMemo(
    () =>
      archivedRecords(ctx.cache).filter(
        (r) => !isNoteFolderArchived(r.folder, archivedKeys),
      ),
    [ctx.cache, archivedKeys],
  );

  // Esc closes the panel — but only when no folder-delete confirm is layered on
  // top. While one is, the <DeleteConfirmModal> owns Esc (→ Cancel), the same
  // split TrashPanel uses for its purge confirm.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && confirmFolder === null) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, confirmFolder]);

  // Clear any transient status + armed confirm whenever the panel reopens.
  useEffect(() => {
    if (open) {
      setStatus(null);
      setConfirmFolder(null);
    }
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
        setStatus(t("notes.archive.restoreError"));
      });
    },
    [ctx, t],
  );

  // Delete a note from the Archive → move to Trash (reversible soft-trash;
  // permanent deletion is a separate step from the Trash panel). trashNote
  // clears `archived:` and sets `trashed:`, so the note leaves the Archive.
  const deleteToTrash = useCallback(
    (id: NoteId) => {
      void ctx
        .trashWithRollback(id)
        .then(() => {
          // Trashing removes the note from the live tree: close its tabs, or a
          // pane keeps a resident, editable buffer whose next autosave writes
          // `trashed:` back off and resurrects the note (myne-md/myne#819).
          ws.closeNoteEverywhere(id);
        })
        .catch(() => {
          setStatus(t("notes.archive.deleteError"));
        });
    },
    [ctx, t, ws],
  );

  const confirmDeleteFolder = useCallback(() => {
    if (confirmFolder === null) return;
    const path = confirmFolder;
    setConfirmFolder(null);
    void Promise.resolve(onDeleteFolderToTrash(path)).catch(() => {
      setStatus(t("notes.archive.folderDeleteError"));
    });
  }, [confirmFolder, onDeleteFolderToTrash, t]);

  if (!open) return null;

  const count = folderRows.length + noteRows.length;

  return (
    <div
      ref={backdropRef}
      style={{
        ...BACKDROP_STYLE,
        animation: "settings-backdrop-in var(--duration-fast) var(--ease-standard)",
      }}
      onClick={handleBackdrop}
      role="presentation"
    >
      <div
        ref={dialogRef}
        style={PANEL_STYLE}
        role="dialog"
        aria-modal="true"
        data-testid="archive.panel"
        aria-labelledby="archive-panel-title"
      >
        <div style={HEADER_STYLE}>
          <div style={HEADER_LEFT_STYLE}>
            <h2 id="archive-panel-title" style={HEADER_TITLE_STYLE}>
              {t("notes.archive.title")}
            </h2>
            {count > 0 && (
              <span style={COUNT_STYLE}>{t("notes.archive.count", { count })}</span>
            )}
          </div>
          <div style={HEADER_RIGHT_STYLE}>
            <button
              type="button"
              style={HEADER_CLOSE_STYLE}
              data-panel-action="close"
              data-testid="archive.close"
              title={t("notes.archive.close")}
              aria-label={t("notes.archive.close")}
              onClick={onClose}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>
        {status !== null && <div style={STATUS_LINE_STYLE}>{status}</div>}

        {count === 0 ? (
          <PanelEmptyState
            icon="archive"
            title={t("notes.archive.emptyTitle")}
            body={t("notes.archive.emptyBody")}
            testId="archive.empty-state"
          />
        ) : (
          <div style={LIST_STYLE}>
            {folderRows.map((path) => (
              <div
                key={`folder:${path}`}
                style={ROW_STYLE}
                data-testid="archive.folder-row"
                data-folder-path={path}
              >
                <span style={FOLDER_TITLE_STYLE} title={folderLabel(path)}>
                  <Icon name="folder" size={14} />
                  {folderLabel(path)}
                </span>
                {/* Delete arms the shared <DeleteConfirmModal> (rendered below),
                    not an inline band — #202. */}
                <div style={ROW_ACTIONS_STYLE}>
                  <button
                    type="button"
                    style={ROW_ICON_BTN_STYLE}
                    data-panel-action="restore"
                    data-testid="archive.folder-restore"
                    data-folder-path={path}
                    title={t("notes.archive.restore")}
                    aria-label={t("notes.archive.restore")}
                    onClick={() => onRestoreFolder(path)}
                  >
                    <Icon name="rotate-ccw" size={16} />
                  </button>
                  <button
                    type="button"
                    style={ROW_ICON_BTN_STYLE}
                    data-panel-action="delete"
                    data-testid="archive.folder-delete"
                    data-folder-path={path}
                    title={t("notes.archive.delete")}
                    aria-label={t("notes.archive.delete")}
                    onClick={() => setConfirmFolder(path)}
                  >
                    <Icon name="trash-2" size={16} />
                  </button>
                </div>
              </div>
            ))}
            {noteRows.map((r) => (
              <div key={r.noteUuid} style={ROW_STYLE}>
                <span
                  style={ROW_TITLE_STYLE}
                  title={r.title ?? t("notes.archive.untitled")}
                >
                  {r.title === null || r.title.trim() === ""
                    ? t("notes.archive.untitled")
                    : r.title}
                </span>
                <span style={AGE_STYLE}>
                  {r.archived !== null
                    ? formatRelativeTime(new Date(r.archived))
                    : ""}
                </span>
                <div style={ROW_ACTIONS_STYLE}>
                  <button
                    type="button"
                    style={ROW_ICON_BTN_STYLE}
                    data-panel-action="restore"
                    data-testid="archive.restore"
                    data-note-id={r.noteUuid}
                    title={t("notes.archive.restore")}
                    aria-label={t("notes.archive.restore")}
                    onClick={() => restore(r.noteUuid)}
                  >
                    <Icon name="rotate-ccw" size={16} />
                  </button>
                  <button
                    type="button"
                    style={ROW_ICON_BTN_STYLE}
                    data-panel-action="delete"
                    data-testid="archive.delete"
                    data-note-id={r.noteUuid}
                    title={t("notes.archive.delete")}
                    aria-label={t("notes.archive.delete")}
                    onClick={() => deleteToTrash(r.noteUuid)}
                  >
                    <Icon name="trash-2" size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {confirmFolder !== null && (
        <DeleteConfirmModal
          title={t("notes.archive.folderDeleteTitle")}
          body={t("notes.archive.folderDeleteBody", {
            name: folderLabel(confirmFolder),
            count: collectSubtreeNoteIdsFromCache(
              ctx.cache,
              folderKey(confirmFolder),
            ).length,
          })}
          warning={t("notes.archive.folderDeleteWarning")}
          confirmLabel={t("notes.archive.folderDeleteConfirmCta")}
          confirmTestId="archive.folder-delete-confirm"
          cancelTestId="archive.folder-delete-cancel"
          onCancel={() => setConfirmFolder(null)}
          onConfirm={confirmDeleteFolder}
        />
      )}
    </div>
  );
}
