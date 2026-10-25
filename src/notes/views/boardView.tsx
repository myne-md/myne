// `BoardView` — the board renderer for a saved view (myne-md/myne#922 task 4).
//
// A board is a VIEW over notes, never an object of its own. There is no board
// file, no per-board database, and nothing a drag would rewrite: the lanes are
// the distinct values of the view's `group_by` property, in an order the view
// declares, and each card is a note the query engine already produced. So this
// module owns layout and nothing else. It reads, it does not write; the drag,
// add-card and lane rename that write through the host arrive in later tasks.
//
// Three layout decisions, and each has a reason worth keeping:
//
// 1. **A declared lane renders even when it is empty.** The point of a board is
//    to move work into a lane that is not occupied yet, so an empty lane
//    disappearing would remove the drop target exactly when the user needs it.
//    It renders as a quiet "No cards" line instead.
// 2. **The lanes are one horizontal strip of non-wrapping columns, and each
//    lane is its OWN vertical scroll container.** This is deliberately not one
//    scroller that wraps its columns: wrapping would make a lane's position
//    depend on how many lanes precede it and how wide the window is, which is
//    how a board stops being readable left to right. Per-lane scrolling also
//    keeps a lane's scroll position its own, and it lets the existing row
//    virtualizer window a lane's cards without a cross-lane index.
// 3. **A board with no lane property says so.** With `group_by` unset there is
//    one group holding everything; rendering it as a board with no explanation
//    would look like a layout bug rather than a missing setting.
//
// The card itself is `./card` (task 3), the same component the gallery mounts,
// so cover resolution, the context menu and the testids cannot drift between
// the two surfaces. The derivation is `./lanes`, tested on its own.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SavedView } from "../../lib/prefs";
import type { ViewResult, ViewRow } from "../queryEngine";
import {
  VIEW_TESTID,
  displayColumns,
  resolveAspectRatio,
} from "./viewLayout";
import { VirtualList } from "../components/VirtualList";
import { ViewCard, type CardContextMenuHandler, type OpenNoteHandler, type SetCoverHandler } from "./card";
import { deriveLanes, type BoardLane } from "./lanes";

/** Lane column width in px. A layout constant rather than a token, the same
 *  class as the gallery's `maxWidth`: it is the board's geometry, not a value a
 *  theme repaints, and the width is what keeps a lane readable at its own
 *  scroll position. */
const LANE_WIDTH = 288;
/** Cold-start height estimate for one card row (card + its slot padding), used
 *  by the row virtualizer before its ResizeObserver reports the real height. */
const LANE_CARD_ESTIMATED_HEIGHT = 132;

const BOARD_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
};

/** The explanatory line a board renders when the view names no lane property. */
const NO_GROUP_STYLE: React.CSSProperties = {
  margin: 0,
  padding: "var(--space-3) var(--space-4)",
  borderBottom: "1px solid var(--line-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  lineHeight: "var(--leading-normal)",
};

const LANES_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  flexWrap: "nowrap",
  alignItems: "stretch",
  gap: "var(--space-3)",
  flex: "1 1 auto",
  minHeight: 0,
  padding: "var(--space-3)",
  // ONE axis scrolls. The strip moves horizontally; every vertical scroll
  // belongs to a lane, which is what keeps a lane's scroll position its own.
  overflowX: "auto",
  overflowY: "hidden",
};

const LANE_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: `0 0 ${LANE_WIDTH}px`,
  minHeight: 0,
  borderRadius: "var(--radius-2)",
  border: "1px solid var(--line-1)",
  // The page surface, not `--paper-2`: a card is `--paper-2`, and a lane filled
  // the same way would leave the cards with nothing to sit on.
  background: "var(--bg-1)",
};

const LANE_HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  borderBottom: "1px solid var(--line-1)",
};

const LANE_TITLE_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-2)",
};

const LANE_COUNT_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const LANE_BODY_STYLE: React.CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
};

const LANE_EMPTY_STYLE: React.CSSProperties = {
  padding: "var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

/** The slot one card occupies inside a lane: the lane's own padding, so a card
 *  never touches the border or its neighbour, while the SCROLLER stays the
 *  lane's full width (the virtualizer measures a row, not a padded box). */
const CARD_SLOT_STYLE: React.CSSProperties = {
  paddingInline: "var(--space-2)",
  paddingBottom: "var(--space-2)",
};

const EMPTY_STYLE: React.CSSProperties = {
  margin: "12vh auto 0",
  maxWidth: 420,
  textAlign: "center",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  lineHeight: "var(--leading-relaxed)",
};

/**
 * The board. Pure — `def` supplies the declared lane order, the display columns
 * and the cover property; `result` carries the grouped, sorted rows.
 */
export function BoardView({
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
  const columns = useMemo(() => displayColumns(def), [def]);
  const lanes = useMemo(
    () => deriveLanes(result.groups, def.lanes ?? []),
    [result.groups, def.lanes],
  );
  // `group_by` is what makes the lanes mean something: without it the engine
  // hands over one group holding every note.
  const hasGroupBy = def.group_by !== undefined && def.group_by !== "";

  if (lanes.length === 0) {
    return (
      <div data-testid={VIEW_TESTID.empty} style={EMPTY_STYLE}>
        {t("notes.views.cards.empty")}
      </div>
    );
  }

  return (
    <div data-testid={VIEW_TESTID.board} style={BOARD_STYLE}>
      {!hasGroupBy && (
        <p data-testid={VIEW_TESTID.boardNoGroupBy} style={NO_GROUP_STYLE}>
          {t("notes.views.board.noGroupBy")}
        </p>
      )}
      <div data-testid={VIEW_TESTID.boardLanes} style={LANES_STYLE}>
        {lanes.map((lane: BoardLane) => {
          const label =
            lane.value === "" ? t("notes.views.cards.noValue") : lane.value;
          return (
            // Keyed by the lane VALUE, so a data change re-renders a lane
            // rather than remounting it: the lane's scroll position lives in
            // its own scroller, and a remount would silently return the reader
            // to the top of a column they had scrolled.
            <section
              key={lane.value}
              data-testid={VIEW_TESTID.lane}
              data-lane-value={lane.value}
              aria-label={label}
              style={LANE_STYLE}
            >
              <div data-testid={VIEW_TESTID.laneHeading} style={LANE_HEADER_STYLE}>
                <span style={LANE_TITLE_STYLE}>{label}</span>
                <span style={LANE_COUNT_STYLE}>· {lane.rows.length}</span>
              </div>
              {lane.rows.length === 0 ? (
                // A declared lane with no cards is the NORMAL state, not a
                // tidy-up opportunity: it is where the next card goes.
                <div data-testid={VIEW_TESTID.laneEmpty} style={LANE_EMPTY_STYLE}>
                  {t("notes.views.board.emptyLane")}
                </div>
              ) : (
                <div style={LANE_BODY_STYLE}>
                  <VirtualList<ViewRow>
                    items={lane.rows}
                    keyOf={(row) => row.noteId}
                    renderItem={(row) => (
                      <div style={CARD_SLOT_STYLE}>
                        <ViewCard
                          row={row}
                          columns={columns}
                          coverProperty={def.image}
                          coverAspectRatio={resolveAspectRatio(
                            def.image_aspect_ratio,
                          )}
                          onOpenNote={onOpenNote}
                          onCardContextMenu={onCardContextMenu}
                          onSetCover={onSetCover}
                        />
                      </div>
                    )}
                    estimatedRowHeight={LANE_CARD_ESTIMATED_HEIGHT}
                    testId={VIEW_TESTID.laneScroll}
                  />
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
