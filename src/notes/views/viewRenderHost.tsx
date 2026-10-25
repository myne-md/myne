// `ViewRenderHost` — the single `view_type`-dispatch branch for the saved-view
// renderer (Saved Views #5). It maps `def.view_type` to a concrete renderer:
//
//   "cards" → <CardsView/>   (MYND-275)
//   "board" → <BoardView/>   (myne-md/myne#922)
//   "table" → <TableView/>   (MYND-277)
//   "list"  → <ListView/>    (MYND-278)
//
// One dispatch site; all four view types render. Every renderer consumes the
// same query-engine `ViewResult` + the same navigation handlers (`onOpenNote`,
// `onCardContextMenu`); the two CARD renderers (cards, board) also take
// `onSetCover`, and table/list have no cover to take.

import type { SavedView } from "../../lib/prefs";
import type { ViewResult } from "../queryEngine";
import { CardsView } from "./cardsView";
import { BoardView, type BoardCardActions } from "./boardView";
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
  approved,
  cardActions,
}: {
  def: SavedView;
  result: ViewResult;
  onOpenNote?: OpenNoteHandler;
  onCardContextMenu?: CardContextMenuHandler;
  onSetCover?: SetCoverHandler;
  /** This device's verdict on `def`, for the board's own definition writes (a
   *  lane rename must not grant an approval the manager is still asking for). */
  approved?: boolean;
  /** The host's card actions, for the board's own card menu. The other three
   *  renderers keep the host's menu through `onCardContextMenu`. */
  cardActions?: BoardCardActions;
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
    case "board":
      return (
        <BoardView
          def={def}
          result={result}
          onOpenNote={onOpenNote}
          onCardContextMenu={onCardContextMenu}
          onSetCover={onSetCover}
          approved={approved}
          cardActions={cardActions}
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
