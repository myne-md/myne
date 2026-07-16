// `MobileViewRenderHost` — the mobile counterpart to the desktop
// `viewRenderHost`: one `view_type` dispatch to a concrete renderer. Mobile has
// no `ViewHost` pane; a saved view is rendered inside the notes pane
// (`EditorFlow.renderNotesPane`) in place of the flat note list. All three types
// render (cards / table / list) — full desktop parity — over the SAME shared
// query-engine `ViewResult` and the SAME shared typed-cell formatter, so the two
// clients never drift. READ-ONLY projection: a single tap opens the note.

import type { SavedView } from "../../../../lib/prefs";
import type { ViewResult } from "@myne/editor/host/notes/queryEngine";
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
  }
}
