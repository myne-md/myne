// `ViewRenderHost` — the single viewType-dispatch branch for the saved-view
// renderer (MYND-275, Saved Views #5, task 2). It maps `def.view_type` to a
// concrete renderer:
//
//   "cards"          → <CardsView/>  (this task)
//   "table" / "list" → a calm "arrives in a later update" fallback
//
// The table renderer (MYND-277) and the list renderer (MYND-278) slot in
// beside CardsView here — one dispatch site, never crash on an unhandled type.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { SavedView } from "../../lib/prefs";
import type { ViewResult } from "../queryEngine";
import {
  CardsView,
  type CardContextMenuHandler,
  type OpenNoteHandler,
  type SetCoverHandler,
} from "./cardsView";

const FALLBACK_STYLE: CSSProperties = {
  margin: "12vh auto 0",
  maxWidth: 420,
  textAlign: "center",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-3)",
  lineHeight: 1.6,
};

export function ViewRenderHost({
  def,
  result,
  onOpenNote,
  onCardContextMenu,
  onSetCover,
}: {
  def: SavedView;
  result: ViewResult;
  onOpenNote?: OpenNoteHandler;
  onCardContextMenu?: CardContextMenuHandler;
  onSetCover?: SetCoverHandler;
}) {
  const { t } = useTranslation();
  switch (def.view_type) {
    case "cards":
      return (
        <CardsView
          def={def}
          result={result}
          onOpenNote={onOpenNote}
          onCardContextMenu={onCardContextMenu}
          onSetCover={onSetCover}
        />
      );
    case "table":
    case "list":
      return (
        <div data-testid="view.unsupported" style={FALLBACK_STYLE}>
          {t("notes.views.host.unsupported")}
        </div>
      );
  }
}
