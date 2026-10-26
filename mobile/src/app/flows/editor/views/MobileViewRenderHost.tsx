// `MobileViewRenderHost` — the mobile counterpart to the desktop
// `viewRenderHost`: one `view_type` dispatch to a concrete renderer. Mobile has
// no `ViewHost` pane; a saved view is rendered inside the notes pane
// (`EditorFlow.renderNotesPane`) in place of the flat note list. All four types
// render (cards / table / list / board) — full desktop parity — over the SAME
// shared query-engine `ViewResult` and the SAME shared typed-cell formatter, so
// the two clients never drift. A single tap opens the note.
//
// The BOARD is the one renderer that is the desktop module itself rather than a
// mobile counterpart, and that is deliberate: a board is a projection over notes
// (lanes are the distinct values of the view's `group_by`), so a second copy
// would be a second answer to "which lane is this card in". The module is pure
// React over the shared query-engine types and writes only through the shared
// view-scoped field command, which mobile already registers and grants
// (`notes:allow-note-set-field`). Its gesture is pointer-based, which is what
// lets a finger drive the same path a mouse does.

import type { SavedView } from "../../../../lib/prefs";
import type { ViewResult } from "@myne/editor/host/notes/queryEngine";
import { BoardView } from "@myne/board-view";
import { MobileCardsView } from "./cardsView";
import { MobileTableView } from "./tableView";
import { MobileListView } from "./listView";

/** Mobile has a single open gesture (tap) — the desktop new-tab/split intent
 *  flags collapse to a plain open. */
export type MobileOpenHandler = (noteId: string) => void;

export function MobileViewRenderHost({
  def,
  result,
  onOpen,
}: {
  def: SavedView;
  result: ViewResult;
  onOpen: MobileOpenHandler;
}) {
  switch (def.view_type) {
    case "cards":
      return <MobileCardsView def={def} result={result} onOpen={onOpen} />;
    case "table":
      return <MobileTableView def={def} result={result} onOpen={onOpen} />;
    case "list":
      return <MobileListView def={def} result={result} onOpen={onOpen} />;
    case "board":
      return <BoardView def={def} result={result} onOpenNote={onOpen} />;
  }
}
