import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../../../components";

/** Long-press action sheet for a note-list ROW (distinct from NoteActionsSheet,
 *  which acts on the open note). Star/unstar lives here — for non-favorited rows
 *  it is the only place to favorite, since the inline star shows on starred rows
 *  only. Move / Archive / Trash mirror the in-editor actions. */
export function NoteRowActionsSheet({
  title,
  favorited,
  onClose,
  onOpen,
  onToggleFavorite,
  onMove,
  onColor,
  onArchive,
  onTrash,
}: {
  title: string;
  favorited: boolean;
  onClose: () => void;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onMove: () => void;
  /** Open the note color-label picker (MYND-516). */
  onColor: () => void;
  onArchive: () => void;
  onTrash: () => void;
}) {
  const { t } = useTranslation();
  // Rows sit flush inside the Sheet — separated by hairlines WITHIN a logical
  // group, and by a heavier group separator BETWEEN groups (open / organize /
  // destructive, Obsidian-style), the mobile twin of the desktop ContextMenu's
  // `group` dividers. `groupTop` drops a row's top hairline when a separator
  // already precedes it (no double line).
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
          <div style={{ padding: "0 18px 12px", fontSize: 13, fontWeight: 600, color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
          {row(t("notes.cardMenu.open"), onOpen)}
          {sep}
          {row(favorited ? t("notes.row.removeFromFavorites") : t("notes.row.addToFavorites"), onToggleFavorite, { groupTop: true, testId: "notes.favorite-action" })}
          {row(t("editor.noteMenu.moveToFolder"), onMove)}
          {row(t("notes.list.color"), onColor, { testId: "notes.note-color-action" })}
          {row(t("notes.archive.title"), onArchive)}
          {sep}
          {row(t("editor.noteMenu.moveToTrash"), onTrash, { danger: true, groupTop: true })}
        </>
      )}
    </Sheet>
  );
}
