import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../../../components";

/** Note-actions sheet (the ⋯ menu): Copy / Move / History / Export / Archive /
 *  Trash. Ported off the old right-panel footer so the panel matches the desktop
 *  tabbed convention (context only). */
export function NoteActionsSheet({
  stat,
  copied,
  busy,
  onClose,
  onCopy,
  onMove,
  onHistory,
  onTasks,
  onExport,
  onArchive,
  onTrash,
}: {
  stat: string;
  copied: boolean;
  busy: boolean;
  onClose: () => void;
  onCopy: () => void;
  onMove: () => void;
  onHistory: () => void;
  /** Open this note's tasks (MYND-620 task 4). */
  onTasks: () => void;
  onExport: () => void;
  onArchive: () => void;
  onTrash: () => void;
}) {
  const { t } = useTranslation();
  // Rows split into logical groups (produce / organize / destructive) by a
  // heavier group separator — the mobile twin of the desktop ContextMenu `group`
  // dividers. `groupTop` drops a row's top hairline when a separator precedes it.
  const row = (text: string, onClick: () => void, opts?: { danger?: boolean; groupTop?: boolean; testId?: string }): ReactNode => (
    <button
      onClick={onClick}
      disabled={busy}
      data-testid={opts?.testId}
      style={{ display: "flex", alignItems: "center", width: "100%", border: "none", borderTop: opts?.groupTop ? "none" : "1px solid var(--line-1)", background: "transparent", padding: "15px 18px", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1, fontFamily: "var(--font-sans)", fontSize: 16, color: opts?.danger ? "var(--danger)" : "var(--fg-1)" }}
    >
      {text}
    </button>
  );
  const sep: ReactNode = <div aria-hidden style={{ height: 1, background: "var(--line-2)", margin: "7px 0" }} />;
  return (
    <Sheet onClose={onClose} padded={false}>
      {() => (
        <>
          <div style={{ padding: "0 18px 12px", fontSize: 13, color: "var(--fg-3)" }}>{stat}</div>
          {row(copied ? t("editor.noteMenu.copied") : t("editor.noteMenu.copyToClipboard"), onCopy)}
          {row(t("tasks.title"), onTasks, { testId: "editor.note-menu-tasks" })}
          {row(t("editor.noteMenu.versionHistory"), onHistory)}
          {row(t("export.pdf.title"), onExport)}
          {sep}
          {row(t("editor.noteMenu.moveToFolder"), onMove, { groupTop: true })}
          {row(t("notes.archive.title"), onArchive)}
          {sep}
          {row(t("editor.noteMenu.moveToTrash"), onTrash, { danger: true, groupTop: true })}
        </>
      )}
    </Sheet>
  );
}
