// `ViewRenderHost` — the single `view_type`-dispatch branch for the saved-view
// renderer (Saved Views #5). It maps `def.view_type` to a concrete renderer:
//
//   "cards" → <CardsView/>   (MYND-275)
//   "table" → <TableView/>   (MYND-277)
//   "list"  → <ListView/>    (MYND-278)
//
// One dispatch site; all three view types render. Every renderer consumes the
// same query-engine `ViewResult` + the same navigation handlers (`onOpenNote`,
// `onCardContextMenu`); only cards uses `onSetCover` (table/list have no cover).

import type { SavedView } from "../../lib/prefs";
import type { ViewResult } from "../queryEngine";
import { CardsView } from "./cardsView";
import type {
  CardContextMenuHandler,
  OpenNoteHandler,
  SetCoverHandler,
} from "./card";
import { TableView } from "./tableView";
import { ListView } from "./listView";

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
      return (
        <TableView
          def={def}
          result={result}
          onOpenNote={onOpenNote}
          onContextMenu={onCardContextMenu}
        />
      );
    case "list":
      return (
        <ListView
          def={def}
          result={result}
          onOpenNote={onOpenNote}
          onContextMenu={onCardContextMenu}
        />
      );
  }
}
