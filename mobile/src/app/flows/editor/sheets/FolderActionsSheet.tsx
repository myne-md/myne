import { useTranslation } from "react-i18next";
import { Sheet } from "../../../../components";
import { ActionRow, ActionRowSeparator } from "./ActionRow";

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
  /**
   * Open the folder decoration sheet (MYND-516): the icon grid AND the colour row
   * live on that one sheet, so this is ONE row now. It used to be two ("Icon…" and
   * "Color…"), each calling this same function — two doors into one room, and the
   * desktop has always offered the single row they are (`notes.list.customize`,
   * glyph `palette`).
   */
  onDecorate: () => void;
  onArchive: () => void;
  onTrash: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet onClose={onClose} padded={false}>
      {() => (
        <>
          <div style={{ padding: "0 18px 12px", fontSize: 13, fontWeight: 600, color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
          <ActionRow icon="file-plus" label={t("common.newnote")} onClick={onNewNote} />
          <ActionRow icon="image-plus" label={t("notes.newTab.createDrawing")} onClick={onNewDrawing} />
          <ActionRow
            icon="folder-plus"
            label={t("notes.list.newSubfolder")}
            onClick={onNewSubfolder}
            testId="notes.folder-new-subfolder"
          />
          <ActionRowSeparator />
          <ActionRow icon="edit" label={t("common.rename")} onClick={onRename} groupTop />
          <ActionRow
            icon="palette"
            label={t("notes.list.customize")}
            onClick={onDecorate}
            testId="notes.folder-decorate-action"
          />
          <ActionRow icon="archive" label={t("notes.list.archiveFolder")} onClick={onArchive} />

          <ActionRowSeparator />
          <ActionRow
            icon="trash"
            label={t("notes.list.deleteFolderConfirm")}
            onClick={onTrash}
            danger
            groupTop
            // myne-md/myne#613 gave this control its first testid, because
            // mobile's only automated lane could not reach it, which is how the
            // cache-derived removal shipped unnoticed. Both branches then named
            // it, differently. `-action` wins because it has the live consumer:
            // `mobile/tests/flow-logic/folders/folder-delete-confirm.flow.ts`
            // clicks it, and nothing reads the other spelling.
            testId="notes.folder-delete-action"
          />
        </>
      )}
    </Sheet>
  );
}
