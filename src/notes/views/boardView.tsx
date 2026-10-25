// `BoardView` — the board renderer for a saved view (myne-md/myne#922).
//
// A board is a VIEW over notes, never an object of its own. There is no board
// file, no per-board database, and nothing a gesture would rewrite: the lanes are
// the distinct values of the view's `group_by` property, in an order the view
// declares, and each card is a note the query engine already produced. So this
// module owns layout and gestures, and every WRITE goes through a host-owned
// command:
//
//   - a drag is one field write (`boardDrag.ts` → `note_set_field`), which is
//     what makes it mergeable and incapable of losing a card it did not touch;
//   - adding a card is a create plus one field write (`addCard.ts`);
//   - a lane rename and a multi-card move are N single-note writes plus one
//     manifest write, ONE action and ONE restore (`boardBulk.ts`).
//
// The board never writes a note itself, never batches writes in the renderer, and
// never optimistically shows a lane the note does not carry once the host has
// answered. A refused write puts the card back where the DATA says it is and
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
// The card itself is `./card` (task 3), the same component the gallery mounts, so
// cover resolution, the context menu and the testids cannot drift between the two
// surfaces. The derivation is `./lanes`, tested on its own.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
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
import { addCardToLane } from "./addCard";
import { moveCardsToLane, renameLane } from "./boardBulk";
import {
  lastActionIsRestorable,
  restoreLastBulkAction,
  type BulkFieldResult,
  type BulkRestoreResult,
} from "../bulkSetField";
import { SelectToggle } from "./selectToggle";
import { buildCardMenuItems } from "./cardMenu";
import { ContextMenu } from "../components/ContextMenu";
import { ModalShell } from "../../components/primitives/ModalShell";
import { Button } from "../../components/primitives/Button";
import { IconButton } from "../../components/primitives/IconButton";
import { Input } from "../../components/primitives/Input";
import { Select, type SelectOption } from "../../components/primitives/Select";
import type { NoteSetFieldError } from "../../types/note-set-field-error";

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

/** The bar above the lanes: the bulk move, the restore and the report. */
const BAR_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  borderBottom: "1px solid var(--line-1)",
};

const REPORT_LINE_STYLE: CSSProperties = {
  margin: 0,
  padding: "var(--space-1) var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const REPORT_REFUSAL_STYLE: CSSProperties = {
  ...REPORT_LINE_STYLE,
  color: "var(--fg-3)",
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

/** The add-card and rename controls sit at the trailing edge of the lane header,
 *  on the count's baseline, so the header keeps one reading line. */
const LANE_ACTIONS_STYLE: CSSProperties = {
  marginInlineStart: "auto",
  display: "inline-flex",
  gap: "var(--space-1)",
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

/** The slot's selection toggle sits above the card's own top-left corner, in the
 *  lane's padding, so it never covers the title the reader is pointing at. The
 *  slot is the positioning context and the card keeps its own geometry. */
const CARD_SELECT_STYLE: CSSProperties = {
  position: "absolute",
  insetInlineStart: 0,
  top: 0,
  zIndex: 1,
};

const CARD_SLOT_WITH_SELECT_STYLE: CSSProperties = {
  ...CARD_SLOT_STYLE,
  position: "relative",
  paddingInlineStart: "var(--target-min)",
};

const CONFIRM_BODY_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  lineHeight: "var(--leading-normal)",
};

const CONFIRM_ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  marginTop: "var(--space-4)",
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
 *
 * `approved` is this device's verdict on `def`, handed in rather than re-read:
 * a lane rename writes the definition, and that write must carry the approval
 * only when the approval was already there. A version-less view is approved by
 * definition (the Rust rule), so its default mirrors that.
 */
/**
 * What the host lets a card DO. Supplied rather than called directly, because
 * every one of these leaves the board: opening a note is the workspace's, and
 * archiving or trashing writes the host's reserved markers, which no manifest can
 * address in either direction. `archive`/`trash` absent → the menu carries
 * navigation only, which is what a read-only host gets.
 */
export interface BoardCardActions {
  readonly open: (noteId: string) => void;
  readonly openInNewTab: (noteId: string) => void;
  readonly revealInFolder: (noteId: string) => void;
  readonly copyLink: (noteId: string) => void;
  readonly archive?: (noteId: string) => Promise<void>;
  readonly trash?: (noteId: string) => Promise<void>;
}

export function BoardView({
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
  approved?: boolean;
  /** The host's card actions. Present → the board draws the shared menu itself,
   *  because it is the surface that offers the lifecycle verb. */
  cardActions?: BoardCardActions;
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
  const thisDeviceApproved = approved ?? def.version === undefined;

  const [drag, dispatch] = useReducer(boardDragReducer, initialBoardDragState);
  const rendered = useMemo(
    () => applyOptimistic(lanes, drag.pending),
    [lanes, drag.pending],
  );

  // ---- add a card (task 6) ------------------------------------------------
  const [addingLane, setAddingLane] = useState<string | null>(null);
  const [addError, setAddError] = useState<{
    /** `null` when no note could be created at all. */
    readonly refusal: NoteSetFieldError | null;
  } | null>(null);

  // ---- the card menu and the two lifecycle actions (task 8) ---------------
  const [cardMenu, setCardMenu] = useState<{
    readonly noteId: string;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const [trashTarget, setTrashTarget] = useState<string | null>(null);
  const [actionError, setActionError] = useState<"archive" | "trash" | null>(null);

  // ---- multi-card move and lane rename (task 7) ---------------------------
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [moveTarget, setMoveTarget] = useState<string>(() => lanes[0]?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [bulkOutcome, setBulkOutcome] = useState<BulkFieldResult | null>(null);
  const [restored, setRestored] = useState<BulkRestoreResult | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [definitionFailed, setDefinitionFailed] = useState(false);

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
      // A control inside the card is a control, not the start of a drag: the
      // cover chip and the selection toggle both live in there.
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

  // One lifecycle action, through the host's own path. A refusal is a LINE
  // rather than a silent no-op: a card that did not move must say so, and a
  // locked vault is the ordinary way this happens.
  const runLifecycle = useCallback(
    (noteId: string, kind: "archive" | "trash") => {
      const run = kind === "archive" ? cardActions?.archive : cardActions?.trash;
      if (run === undefined) return;
      void run(noteId).catch(() => setActionError(kind));
    },
    [cardActions],
  );

  const cardMenuItems = useMemo(() => {
    if (cardMenu === null || cardActions === undefined) return [];
    const id = cardMenu.noteId;
    const lifecycle =
      cardActions.archive !== undefined && cardActions.trash !== undefined
        ? {
            archive: () => runLifecycle(id, "archive"),
            // The trash item asks first: archiving and trashing both take the
            // note off this board, but only one of them is the recoverable
            // action a hurried click should not perform by accident.
            trash: () => setTrashTarget(id),
          }
        : undefined;
    return buildCardMenuItems(
      {
        open: () => cardActions.open(id),
        openInNewTab: () => cardActions.openInNewTab(id),
        revealInFolder: () => cardActions.revealInFolder(id),
        copyLink: () => cardActions.copyLink(id),
      },
      lifecycle,
    );
  }, [cardActions, cardMenu, runLifecycle]);

  // One card into one lane: create, place, then open. The board does not invent
  // the row: the field write re-indexes the note and the next query carries the
  // card with the truth behind it.
  const runAddCard = useCallback(
    (lane: string) => {
      if (addingLane !== null) return;
      setAddingLane(lane);
      setAddError(null);
      void (async () => {
        try {
          const result = await addCardToLane({
            viewId: def.id,
            laneField,
            lane,
            template: def.template,
          });
          if (result.refusal !== null) {
            setAddError({ refusal: result.refusal });
            return;
          }
          // A NEW TAB rather than the focused one: replacing the board with the
          // new note would turn "capture an item" into "leave the board".
          onOpenNote?.(result.noteId, { newTab: true, toSide: false });
        } catch {
          setAddError({ refusal: null });
        } finally {
          setAddingLane(null);
        }
      })();
    },
    [addingLane, def.id, def.template, laneField, onOpenNote],
  );

  // ---- selection, the move, and the one restore (task 7) ------------------
  const laneOptions = useMemo<readonly SelectOption<string>[]>(
    () =>
      rendered.map((lane) => ({
        value: lane.value,
        label:
          lane.value === "" ? t("notes.views.cards.noValue") : lane.value,
      })),
    [rendered, t],
  );
  // The declaration can change under the selection (a rename, a merge), so the
  // control always holds a value the options actually carry.
  const targetLane = laneOptions.some((option) => option.value === moveTarget)
    ? moveTarget
    : (laneOptions[0]?.value ?? "");

  const toggleCard = useCallback((noteId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  }, []);

  const allSelected =
    rendered.length > 0 &&
    rendered.every((lane) => lane.rows.every((row) => selected.has(row.noteId)));

  const toggleAll = useCallback(() => {
    const every = rendered.flatMap((lane) => lane.rows.map((row) => row.noteId));
    setSelected((prev) =>
      every.length > 0 && every.every((id) => prev.has(id)) ? new Set() : new Set(every),
    );
  }, [rendered]);

  const runMove = useCallback(() => {
    if (busy || selected.size === 0) return;
    setBusy(true);
    setRestored(null);
    // Targets are built from the rows the board is showing, so the precondition
    // is the lane value the reader is looking at.
    const cards = rendered.flatMap((lane) =>
      lane.rows
        .filter((row) => selected.has(row.noteId))
        .map((row) => ({ noteId: row.noteId, fromLane: lane.value })),
    );
    void (async () => {
      try {
        setBulkOutcome(
          await moveCardsToLane({
            viewId: def.id,
            field: laneField,
            toLane: targetLane,
            cards,
          }),
        );
        setSelected(new Set());
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, def.id, laneField, rendered, selected, targetLane]);

  const startRename = useCallback((lane: string) => {
    setRenameTarget(lane);
    setRenameDraft(lane);
    setDefinitionFailed(false);
  }, []);

  const commitRename = useCallback(() => {
    const from = renameTarget;
    const to = renameDraft.trim();
    setRenameTarget(null);
    if (from === null || to === "" || to === from) return;
    const cards =
      rendered
        .find((lane) => lane.value === from)
        ?.rows.map((row) => ({ noteId: row.noteId, fromLane: from })) ?? [];
    setBusy(true);
    setRestored(null);
    setBulkOutcome(null);
    void (async () => {
      try {
        const result = await renameLane({
          viewId: def.id,
          field: laneField,
          fromLane: from,
          toLane: to,
          cards,
          view: def,
          approved: thisDeviceApproved,
        });
        setDefinitionFailed(result.definitionFailed);
        // The per-card refusals are the report the reader needs, so they are
        // handed to the same block the move uses.
        setBulkOutcome(result.move);
        setSelected(new Set());
      } finally {
        setBusy(false);
      }
    })();
  }, [def, laneField, renameDraft, renameTarget, rendered, thisDeviceApproved]);

  const runRestore = useCallback(() => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        // `def` is the definition in hand: restoring one moves its version
        // forward and keeps this device's approval, rather than reviving the old
        // number and leaving the view unapproved.
        setRestored(await restoreLastBulkAction(def));
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, def]);

  const restoreAvailable = lastActionIsRestorable();

  // The note titles for the report, from the rows the board was handed.
  const titleOf = useCallback(
    (noteId: string): string => {
      for (const lane of rendered) {
        const row = lane.rows.find((r) => r.noteId === noteId);
        if (row !== undefined) {
          return row.title ?? t("notes.views.cards.untitled");
        }
      }
      return t("notes.views.cards.untitled");
    },
    [rendered, t],
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

  const addErrorLine: ReactNode =
    addError === null ? null : (
      <p data-testid={VIEW_TESTID.boardAddError} role="status" style={REFUSAL_STYLE}>
        {addError.refusal === null
          ? t("notes.views.board.addCardFailed")
          : t("notes.views.board.addCardRefused", {
              reason: refusalSentence(addError.refusal, t),
            })}
      </p>
    );

  const actionErrorLine: ReactNode =
    actionError === null ? null : (
      <p data-testid={VIEW_TESTID.boardActionError} role="status" style={REFUSAL_STYLE}>
        {t(
          actionError === "archive"
            ? "notes.views.board.archiveFailed"
            : "notes.views.board.trashFailed",
        )}
      </p>
    );

  const bulkReport: ReactNode =
    bulkOutcome === null ? null : (
      <div data-testid={VIEW_TESTID.boardBulkReport}>
        <p style={REPORT_LINE_STYLE}>
          {t("notes.views.bulk.written", { count: bulkOutcome.writtenCount })}
        </p>
        {/* Per card, with its own reason: a count alone leaves the reader unable
            to tell what to redo, which is the point of reporting a partial result
            instead of rolling it back. */}
        {bulkOutcome.refused.map((entry) => (
          <p key={entry.noteId} style={REPORT_REFUSAL_STYLE} data-note-id={entry.noteId}>
            {t("notes.views.bulk.refusedLine", {
              title: titleOf(entry.noteId),
              reason: refusalSentence(entry.reason, t),
            })}
          </p>
        ))}
        {definitionFailed && (
          <p style={REPORT_LINE_STYLE} data-testid={VIEW_TESTID.boardLanesNotSaved}>
            {t("notes.views.board.lanesNotSaved")}
          </p>
        )}
        {restored !== null && (
          <p style={REPORT_LINE_STYLE} data-testid={VIEW_TESTID.boardRestored}>
            {t("notes.views.bulk.restored", { count: restored.restoredCount })}
          </p>
        )}
        {restored !== null && restored.failed.map((entry) => (
          <p key={entry.noteId} style={REPORT_REFUSAL_STYLE} data-note-id={entry.noteId}>
            {t(
              entry.reason === "notRestorable"
                ? "notes.views.bulk.notRestorableLine"
                : "notes.views.bulk.restoreFailedLine",
              { title: titleOf(entry.noteId) },
            )}
          </p>
        ))}
        {restored !== null && restored.viewRestored && (
          <p style={REPORT_LINE_STYLE} data-testid={VIEW_TESTID.boardLaneOrderRestored}>
            {t("notes.views.board.laneOrderRestored")}
          </p>
        )}
        {restored !== null && restored.viewRestoreFailed && (
          <p style={REPORT_LINE_STYLE} data-testid={VIEW_TESTID.boardLaneOrderRestoreFailed}>
            {t("notes.views.board.laneOrderRestoreFailed")}
          </p>
        )}
      </div>
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
      {writable && (
        <div data-testid={VIEW_TESTID.boardBulkBar} style={BAR_STYLE}>
          <SelectToggle
            testId={VIEW_TESTID.boardSelectAll}
            label={t("notes.views.board.selectAll")}
            checked={allSelected}
            onToggle={toggleAll}
          />
          <Select
            testId={VIEW_TESTID.boardMoveTarget}
            aria-label={t("notes.views.board.moveTo")}
            value={targetLane}
            options={laneOptions}
            onChange={setMoveTarget}
          />
          <Button
            variant="primary"
            data-testid={VIEW_TESTID.boardMoveApply}
            disabled={busy || selected.size === 0}
            onClick={runMove}
          >
            {t("notes.views.board.moveSelected", { count: selected.size })}
          </Button>
          {/* Only when there is something to restore: a note in the current
              on-disk format is a CRDT note, so most actions capture no snapshot,
              and an action that only changed the lane order still has one thing
              to put back. */}
          {restoreAvailable && (
            <Button
              variant="secondary"
              data-testid={VIEW_TESTID.boardRestore}
              disabled={busy}
              onClick={runRestore}
            >
              {t("notes.views.bulk.restore")}
            </Button>
          )}
        </div>
      )}
      {refusalLine}
      {addErrorLine}
      {actionErrorLine}
      {bulkReport}
      <div data-testid={VIEW_TESTID.boardLanes} style={LANES_STYLE}>
        {rendered.map((lane: BoardLane) => {
          const label =
            lane.value === "" ? t("notes.views.cards.noValue") : lane.value;
          const isDropTarget = drag.hoverLane === lane.value;
          const isRenaming = renameTarget === lane.value;
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
              {isRenaming ? (
                <div style={LANE_HEADER_STYLE}>
                  <Input
                    autoFocus
                    aria-label={t("notes.views.board.newLaneName")}
                    data-testid={VIEW_TESTID.boardRenameInput}
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenameTarget(null);
                    }}
                    style={{ flex: "1 1 auto", minWidth: 0 }}
                  />
                  <Button
                    variant="primary"
                    data-testid={VIEW_TESTID.boardRenameSave}
                    onClick={commitRename}
                  >
                    {t("notes.views.board.saveLaneName")}
                  </Button>
                  <Button
                    variant="ghost"
                    data-testid={VIEW_TESTID.boardRenameCancel}
                    onClick={() => setRenameTarget(null)}
                  >
                    {t("notes.views.board.cancelLaneRename")}
                  </Button>
                </div>
              ) : (
                <div data-testid={VIEW_TESTID.laneHeading} style={LANE_HEADER_STYLE}>
                  <span style={LANE_TITLE_STYLE}>{label}</span>
                  <span style={LANE_COUNT_STYLE}>· {lane.rows.length}</span>
                  {/* Only where the view DECLARES its lane property writable: a
                      board that cannot place or rename a card must not offer to,
                      and a disabled button would be an offer it cannot honour. */}
                  {writable && (
                    <span style={LANE_ACTIONS_STYLE}>
                      <IconButton
                        icon="plus"
                        label={t("notes.views.board.addCardTo", { lane: label })}
                        testId={VIEW_TESTID.boardAddCard}
                        disabled={addingLane !== null}
                        onClick={() => runAddCard(lane.value)}
                      />
                      <IconButton
                        icon="pencil"
                        label={t("notes.views.board.renameLane", { lane: label })}
                        testId={VIEW_TESTID.boardRename}
                        disabled={busy}
                        onClick={() => startRename(lane.value)}
                      />
                    </span>
                  )}
                </div>
              )}
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
                            : writable
                              ? CARD_SLOT_WITH_SELECT_STYLE
                              : CARD_SLOT_STYLE
                        }
                        onPointerDown={onCardPointerDown(row, lane.value)}
                        onKeyDown={onCardKeyDown(row, lane.value)}
                      >
                        {writable && (
                          <span style={CARD_SELECT_STYLE}>
                            <SelectToggle
                              testId={VIEW_TESTID.boardSelectCard}
                              noteId={row.noteId}
                              label={t("notes.views.board.selectCard", {
                                title: row.title ?? t("notes.views.cards.untitled"),
                              })}
                              checked={selected.has(row.noteId)}
                              onToggle={() => toggleCard(row.noteId)}
                            />
                          </span>
                        )}
                        <ViewCard
                          row={row}
                          columns={columns}
                          coverProperty={def.image}
                          coverAspectRatio={resolveAspectRatio(
                            def.image_aspect_ratio,
                          )}
                          onOpenNote={onOpenNote}
                          onCardContextMenu={
                            cardActions === undefined
                              ? onCardContextMenu
                              : (noteId, pos) =>
                                  setCardMenu({ noteId, x: pos.x, y: pos.y })
                          }
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
      {cardMenu !== null && cardMenuItems.length > 0 && (
        <ContextMenu
          x={cardMenu.x}
          y={cardMenu.y}
          items={cardMenuItems}
          onClose={() => setCardMenu(null)}
        />
      )}
      <ModalShell
        open={trashTarget !== null}
        title={t("notes.list.trashConfirmTitle")}
        labelId="board-trash-confirm-title"
        onClose={() => setTrashTarget(null)}
        width={420}
      >
        <p style={CONFIRM_BODY_STYLE}>{t("notes.list.trashConfirmWarning")}</p>
        <div style={CONFIRM_ACTIONS_STYLE}>
          <Button variant="ghost" onClick={() => setTrashTarget(null)}>
            {t("notes.views.board.cancel")}
          </Button>
          <Button
            variant="danger"
            data-testid={VIEW_TESTID.boardTrashConfirm}
            onClick={() => {
              const id = trashTarget;
              setTrashTarget(null);
              if (id !== null) runLifecycle(id, "trash");
            }}
          >
            {t("notes.list.trashConfirmConfirm")}
          </Button>
        </div>
      </ModalShell>
    </div>
  );
}
