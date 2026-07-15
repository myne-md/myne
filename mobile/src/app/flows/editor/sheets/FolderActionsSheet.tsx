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
  onNewSubfolder,
  onRename,
  onArchive,
  onTrash,
}: {
  name: string;
  onClose: () => void;
  onNewNote: () => void;
  onNewSubfolder: () => void;
  onRename: () => void;
  onArchive: () => void;
  onTrash: () => void;
}) {
  const { t } = useTranslation();
  // Logical groups (create / edit / destructive) split by a heavier separator —
  // the mobile twin of the desktop ContextMenu `group` dividers. `groupTop`
  // drops a row's top hairline when a separator already precedes it.
  const row = (text: string, onClick: () => void, opts?: { danger?: boolean; groupTop?: boolean }): ReactNode => (
    <button
      onClick={onClick}
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
          {row(t("notes.list.newSubfolder"), onNewSubfolder)}
          {sep}
          {row(t("attachments.library.menuRename"), onRename, { groupTop: true })}
          {row(t("notes.list.archiveFolder"), onArchive)}
          {sep}
          {row(t("notes.list.deleteFolderConfirm"), onTrash, { danger: true, groupTop: true })}
        </>
      )}
    </Sheet>
  );
}
