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
  onArchive,
  onTrash,
}: {
  title: string;
  favorited: boolean;
  onClose: () => void;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onMove: () => void;
  onArchive: () => void;
  onTrash: () => void;
}) {
  const { t } = useTranslation();
  // Rows sit flush inside the Sheet (which is already the single rounded,
  // bordered container) — separated only by hairlines. No inner bordered box, or
  // the modal reads as a box-in-a-box.
  const row = (text: string, onClick: () => void, danger = false): ReactNode => (
    <button
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", width: "100%", border: "none", borderTop: "1px solid var(--line-1)", background: "transparent", padding: "15px 18px", cursor: "pointer", fontFamily: "var(--font-sans)", fontSize: 16, color: danger ? "var(--danger)" : "var(--fg-1)" }}
    >
      {text}
    </button>
  );
  return (
    <Sheet onClose={onClose} padded={false}>
      {() => (
        <>
          <div style={{ padding: "0 18px 12px", fontSize: 13, fontWeight: 600, color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
          {row(t("editor.noteMenu.open"), onOpen)}
          {row(favorited ? t("notes.row.removeFromFavorites") : t("notes.row.addToFavorites"), onToggleFavorite)}
          {row(t("editor.noteMenu.moveToFolder"), onMove)}
          {row(t("editor.nav.archive"), onArchive)}
          {row(t("editor.noteMenu.moveToTrash"), onTrash, true)}
        </>
      )}
    </Sheet>
  );
}
