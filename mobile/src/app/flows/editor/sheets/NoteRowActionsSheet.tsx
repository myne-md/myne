import { useTranslation } from "react-i18next";
import { Sheet } from "../../../../components";
import { ActionRow, ActionRowSeparator } from "./ActionRow";

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
  /** Move-up/move-down within the note's folder container (MYND-596). Absent
   *  outside the plain notes tree (where `item_order` is the active ordering). */
}) {
  const { t } = useTranslation();
  return (
    <Sheet onClose={onClose} padded={false}>
      {() => (
        <>
          <div style={{ padding: "0 18px 12px", fontSize: 13, fontWeight: 600, color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
          <ActionRow icon="file-text" label={t("notes.cardMenu.open")} onClick={onOpen} />
          <ActionRowSeparator />
          <ActionRow
            icon="star"
            label={favorited ? t("notes.row.removeFromFavorites") : t("notes.row.addToFavorites")}
            onClick={onToggleFavorite}
            groupTop
            testId="notes.favorite-action"
          />
          {/* The glyph is the desktop note menu's `folder`, on its own "Move to…"
              row: the picture is shared even though this client's label is its own
              key. */}
          <ActionRow icon="folder" label={t("editor.noteMenu.moveToFolder")} onClick={onMove} />
          <ActionRow
            icon="palette"
            label={t("notes.list.color")}
            onClick={onColor}
            testId="notes.note-color-action"
          />

          <ActionRow icon="archive" label={t("notes.archive.title")} onClick={onArchive} />
          <ActionRowSeparator />
          <ActionRow
            icon="trash"
            label={t("common.movetotrash")}
            onClick={onTrash}
            danger
            groupTop
          />
        </>
      )}
    </Sheet>
  );
}
