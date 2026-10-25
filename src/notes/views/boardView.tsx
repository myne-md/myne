// `BoardView` — the board renderer for a saved view (myne-md/myne#922).
//
// A board is a VIEW over notes, never an object of its own. There is no board
// file, no per-board database, and nothing a drag would rewrite: the lanes are
// the distinct values of the view's `group_by` property, in an order the view
// declares, and each card is a note the query engine already produced. So this
// module owns layout and gestures, and every WRITE goes through a host-owned
// command:
//
//   - a drag is one field write (`boardDrag.ts` → `note_set_field`), which is
//     what makes it mergeable and incapable of losing a card it did not touch;
//   - adding a card is a create plus one field write (`addCard.ts`);
//   - a lane rename and a multi-card move are N single-note writes plus one
//     manifest write, reported per note (`boardBulk.ts`).
//
// The board never writes a note itself, never batches writes in the renderer,
// and never optimistically shows a lane the note does not carry once the host
// has answered. A refused write puts the card back where the DATA says it is and
// states the reason.
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

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
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
import {
  adjacentLane,
  applyOptimistic,
  asRefusal,
  boardDragReducer,
  commitBoardDrop,
  dropDecision,
  initialBoardDragState,
  laneOf,
  type PendingDrop,
} from "./boardDrag";
import { refusalSentence } from "./refusalSentence";

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
const NO_GROUP_STYLE: CSSProperties = {
  margin: 0,
  padding: "var(--space-3) var(--space-4)",
  borderBottom: "1px solid var(--line-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  lineHeight: "var(--leading-normal)",
};

/** One refused gesture, stated where the gesture happened. */
const REFUSAL_STYLE: CSSProperties = {
  ...NO_GROUP_STYLE,
  borderBottom: "none",
  color: "var(--fg-2)",
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

/** The lane a card is currently over. State is carried by a FILL step, not by a
 *  coloured border: the canon bans a coloured border as a state channel, and the
 *  lane's own hairline stays one hairline in every state. */
const LANE_DROP_STYLE: CSSProperties = {
  ...LANE_STYLE,
  background: "var(--bg-2)",
};

const LANE_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  borderBottom: "1px solid var(--line-1)",
};

const LANE_TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-2)",
};

const LANE_COUNT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const LANE_BODY_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
};

const LANE_EMPTY_STYLE: CSSProperties = {
  padding: "var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

/** The slot one card occupies inside a lane: the lane's own padding, so a card
 *  never touches the border or its neighbour, while the SCROLLER stays the
 *  lane's full width (the virtualizer measures a row, not a padded box). */
const CARD_SLOT_STYLE: CSSProperties = {
  paddingInline: "var(--space-2)",
  paddingBottom: "var(--space-2)",
};

/** The card being dragged. Dimmed rather than lifted: there is no shadow on an
 *  editor surface, and a drag is already the most visible thing on screen. */
const CARD_SLOT_DRAGGING_STYLE: CSSProperties = {
  ...CARD_SLOT_STYLE,
  opacity: 0.55,
};

const EMPTY_STYLE: CSSProperties = {
  margin: "12vh auto 0",
  maxWidth: 420,
  textAlign: "center",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  lineHeight: "var(--leading-relaxed)",
};

/**
 * The board. Pure in the sense that matters: `def` supplies the declared lane
 * order, the display columns and the cover property; `result` carries the
 * grouped, sorted rows; every write leaves through a host command.
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
  // A drag writes the lane property, so the gesture exists only where the view
  // DECLARES that property writable. Offering it otherwise would be a gesture
  // whose every attempt the host is required to refuse.
  const laneField = def.group_by ?? "";
  const writable =
    hasGroupBy && (def.write_fields ?? []).includes(laneField);

  const [drag, dispatch] = useReducer(boardDragReducer, initialBoardDragState);
  const rendered = useMemo(
    () => applyOptimistic(lanes, drag.pending),
    [lanes, drag.pending],
  );

  // End the optimism when the DATA has moved off the lane the gesture started
  // in: either the write landed (the note is now in the target lane), the note
  // left the result, or something else changed the value first. Holding it
  // longer would show a lane the note does not carry; releasing it before then
  // would flash the card back to its old lane while the re-query is in flight.
  useEffect(() => {
    if (drag.pending === null) return;
    const current = laneOf(lanes, drag.pending.noteId);
    if (current !== drag.pending.fromLane) dispatch({ type: "landed" });
  }, [lanes, drag.pending]);

  // The async half of one drop. One command, one note, one field.
  const runDrop = useCallback(
    (pending: PendingDrop) => {
      void commitBoardDrop({
        viewId: def.id,
        field: laneField,
        noteId: pending.noteId,
        fromLane: pending.fromLane,
        toLane: pending.toLane,
      }).catch((err: unknown) => {
        dispatch({ type: "refused", reason: asRefusal(err) });
      });
    },
    [def.id, laneField],
  );

  // The pointer is tracked at the WINDOW while a gesture is armed, because the
  // pointer leaves the card immediately and the card is not the element that
  // decides a lane. Pointer events only: the same path runs under a finger.
  useEffect(() => {
    if (drag.armed === null && drag.dragging === null) return;
    const onMove = (e: PointerEvent) => dispatch({ type: "move", x: e.clientX, y: e.clientY });
    const onUp = () => {
      // A release outside any lane cancels: there is no drop target under the
      // pointer, so there is nothing to ask the host for.
      dispatch({ type: "cancel" });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag.armed, drag.dragging]);

  const onCardPointerDown = useCallback(
    (row: ViewRow, fromLane: string) => (e: ReactPointerEvent) => {
      if (!writable) return;
      // Primary button only: a right-click opens the menu and a middle-click is
      // the card's own "new tab".
      if (e.button !== 0) return;
      // The cover chip is a control inside the card; a press on it is a press on
      // the chip, not the start of a drag.
      const target = e.target as HTMLElement | null;
      if (target !== null && target.closest("button") !== null) return;
      dispatch({ type: "arm", noteId: row.noteId, fromLane, x: e.clientX, y: e.clientY });
    },
    [writable],
  );

  const onLanePointerOver = useCallback(
    (lane: string) => () => dispatch({ type: "over", lane }),
    [],
  );

  const onLanePointerUp = useCallback(
    (lane: string) => (e: ReactPointerEvent) => {
      const decision = dropDecision(drag, lane);
      dispatch({ type: "drop", lane });
      if (decision !== null) {
        // The lane handled this release; the window listener must not also
        // cancel it as a release outside every lane.
        e.stopPropagation();
        runDrop(decision);
      }
    },
    [drag, runDrop],
  );

  // The keyboard half of the same gesture. A board a keyboard cannot operate is
  // a board half the product cannot use, and `Alt+Left/Right` is the same
  // "move one place" the pointer performs one lane at a time.
  const onCardKeyDown = useCallback(
    (row: ViewRow, fromLane: string) => (e: ReactKeyboardEvent) => {
      if (!writable || !e.altKey) return;
      const delta = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
      if (delta === 0) return;
      const toLane = adjacentLane(rendered, fromLane, delta as -1 | 1);
      if (toLane === null) return;
      e.preventDefault();
      const decision = { noteId: row.noteId, fromLane, toLane };
      dispatch({ type: "keyboard-drop", ...decision });
      runDrop(decision);
    },
    [rendered, runDrop, writable],
  );

  const refusalLine: ReactNode =
    drag.refusal === null ? null : (
      <p
        data-testid={VIEW_TESTID.boardRefusal}
        role="status"
        style={REFUSAL_STYLE}
      >
        {t("notes.views.board.dropRefused", {
          reason: refusalSentence(drag.refusal.reason, t),
          lane:
            drag.refusal.toLane === ""
              ? t("notes.views.cards.noValue")
              : drag.refusal.toLane,
        })}
      </p>
    );

  if (rendered.length === 0) {
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
      {refusalLine}
      <div data-testid={VIEW_TESTID.boardLanes} style={LANES_STYLE}>
        {rendered.map((lane: BoardLane) => {
          const label =
            lane.value === "" ? t("notes.views.cards.noValue") : lane.value;
          const isDropTarget = drag.hoverLane === lane.value;
          return (
            // Keyed by the lane VALUE, so a data change re-renders a lane
            // rather than remounting it: the lane's scroll position lives in
            // its own scroller, and a remount would silently return the reader
            // to the top of a column they had scrolled.
            <section
              key={lane.value}
              data-testid={VIEW_TESTID.lane}
              data-lane-value={lane.value}
              data-drop-active={isDropTarget ? "true" : undefined}
              aria-label={label}
              style={isDropTarget ? LANE_DROP_STYLE : LANE_STYLE}
              onPointerOver={onLanePointerOver(lane.value)}
              onPointerUp={onLanePointerUp(lane.value)}
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
                      <div
                        data-testid={VIEW_TESTID.laneCardSlot}
                        data-note-id={row.noteId}
                        aria-keyshortcuts={
                          writable ? "Alt+ArrowLeft Alt+ArrowRight" : undefined
                        }
                        style={
                          drag.dragging?.noteId === row.noteId
                            ? CARD_SLOT_DRAGGING_STYLE
                            : CARD_SLOT_STYLE
                        }
                        onPointerDown={onCardPointerDown(row, lane.value)}
                        onKeyDown={onCardKeyDown(row, lane.value)}
                      >
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
