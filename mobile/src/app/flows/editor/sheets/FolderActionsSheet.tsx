import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../../../components";

/** Long-press action sheet for a FOLDER row (MYND-480) — the folder-level twin
 *  of `NoteRowActionsSheet`, same visual language + interaction. Actions align
 *  with the desktop folder menu; rename/new-subfolder route through a shared
 *  folder-name prompt in the parent. */
export function FolderActionsSheet({
  name,
  onClose,
  onNewNote,
  onNewDrawing,
  onNewSubfolder,
  onRename,
  onDecorate,
  onArchive,
  onTrash,
}: {
  name: string;
  onClose: () => void;
  onNewNote: () => void;
  onNewDrawing: () => void;
  onNewSubfolder: () => void;
  onRename: () => void;
  /** Open the folder decoration sheet (MYND-516). Two rows ("Icon…" / "Color")
   *  are deliberately kept as separate entry points, but both open the one
   *  sheet — which shows the icon grid AND the color row — so they share a
   *  single prop rather than two callbacks wired to identical calls. */
  onDecorate: () => void;
  onArchive: () => void;
  onTrash: () => void;
  /** Move-up/move-down within the folder's PARENT container (MYND-596). Absent
   *  outside the plain notes tree (where `item_order` is the active ordering). */
}) {
  const { t } = useTranslation();
  // Logical groups (create / edit / destructive) split by a heavier separator —
  // the mobile twin of the desktop ContextMenu `group` dividers. `groupTop`
  // drops a row's top hairline when a separator already precedes it.
  const row = (text: string, onClick: () => void, opts?: { danger?: boolean; groupTop?: boolean; testId?: string }): ReactNode => (
    <button
      onClick={onClick}
      data-testid={opts?.testId}
      style={{ display: "flex", alignItems: "center", width: "100%", border: "none", borderTop: opts?.groupTop ? "none" : "1px solid var(--line-1)", background: "transparent", padding: "15px 18px", cursor: "pointer", fontFamily: "var(--font-sans)", fontSize: 16, color: opts?.danger ? "var(--danger)" : "var(--fg-1)" }}
    >
      {text}
    </button>
  );
  const sep: ReactNode = <div aria-hidden style={{ height: 1, background: "var(--line-2)", margin: "7px 0" }} />;
  return (
    <Sheet onClose={onClose} padded={false}>
      {() => (
        <>
          <div style={{ padding: "0 18px 12px", fontSize: 13, fontWeight: 600, color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
          {row(t("notes.list.newNote"), onNewNote)}
          {row(t("notes.newTab.createDrawing"), onNewDrawing)}
          {row(t("notes.list.newSubfolder"), onNewSubfolder, { testId: "notes.folder-new-subfolder" })}
          {sep}
          {row(t("attachments.library.menuRename"), onRename, { groupTop: true })}
          {row(t("notes.list.icon"), onDecorate, { testId: "notes.folder-icon-action" })}
          {row(t("notes.list.color"), onDecorate, { testId: "notes.folder-color-action" })}
          {row(t("notes.list.archiveFolder"), onArchive)}

          {sep}
          {row(t("notes.list.deleteFolderConfirm"), onTrash, {
            danger: true,
            groupTop: true,
            // myne-md/myne#613 gave this control its first testid, because
            // mobile's only automated lane could not reach it, which is how the
            // cache-derived removal shipped unnoticed. Both branches then named
            // it, differently. `-action` wins because it has the live consumer:
            // `mobile/tests/flow-logic/folders/folder-delete-confirm.flow.ts`
            // clicks it, and nothing reads the other spelling.
            testId: "notes.folder-delete-action",
          })}
        </>
      )}
    </Sheet>
  );
}
