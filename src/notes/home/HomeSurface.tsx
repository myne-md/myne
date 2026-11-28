// The home surface (myne-md/myne#1074).
//
// ── What this surface is ────────────────────────────────────────────────────
// A composable board of widgets that answers "where was I, and what is due". The
// widgets render modules that already own their data; the surface owns only the
// ARRANGEMENT, which is a synced preference (`prefs.home_cards`) plus a
// device-local "open this on start" switch that now lives in Settings.
//
// ── A bento grid, not two column stacks ────────────────────────────────────
// The old layout ran two independent column stacks, which is masonry, and masonry
// leaves holes: a tall card on the left pushed everything beside it down and left
// dead space under the short one. This is a 12-column grid with quarter-step
// widths and DENSE auto-placement, so a card that does not fit the remaining
// columns is filled by the next one instead of leaving a gap.
//
// The stored `span` is still 1..=4 — a quarter, half, three quarters, or the full
// width — because the wire format must not change: a wider span is a row an older
// client DROPS, and a card that vanishes is worse than a coarse width step.
//
// ── Editing happens in place ───────────────────────────────────────────────
// There is no "arrange" screen. A drag handle appears on the card you point at,
// the corner handle resizes it, the header's menu widens or removes it, and a
// trailing tile adds a widget. All of it writes the same array through
// `HomeLayoutContext`, and the keyboard gets the same operations (Space to pick
// up, arrows to move, Shift+arrows to resize, Delete to remove).
//
// ── No page title ──────────────────────────────────────────────────────────
// The surface had an `<h1>Home</h1>` above a row of cards that are themselves
// titled. The tab already says where you are, so the heading was a label on a
// label, and it cost the first 64 pixels of the board.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { setHomeCards, type HomeCard } from "../../lib/prefs";
import { usePrefs } from "../../hooks/usePrefs";
import {
  HOME_CARD_GROUPS,
  HOME_GROUP_LABEL_KEY,
  homeCardSpec,
  minSpanOf,
  resolveHomeCards,
  HOME_CARD_SPECS,
} from "./homeCards";
import { HOME_CARD_DEFS } from "./cardBodies";
import { HomeLayoutContext, type HomeLayoutApi } from "./HomeLayoutContext";
import { addCard, moveCard, removeCard, resizeCard, sameArrangement } from "./homeLayout";

/** The desktop grid's column count. A stored span of 1..4 means 3/6/9/12 of these. */
const COLUMNS = 12;

/** One quarter of the grid: the unit a stored span is expressed in. */
const SPAN_UNIT = COLUMNS / 4;

/**
 * The widths below which the board re-flows to 6 and then to 2 columns.
 *
 * Measured on the surface's OWN box rather than the window: this surface can be a
 * narrow pane beside a note on a wide screen, and the story catalogue pins the
 * story's width while the browser window stays wide.
 *
 * Re-flowing is not re-arranging: the stored span is untouched, and a phone that
 * shows one column still shows the cards in the order the user chose.
 */
const TWO_COLUMN_PX = 560;
const SIX_COLUMN_PX = 900;

function columnsFor(width: number): number {
  if (width < TWO_COLUMN_PX) return 2;
  if (width < SIX_COLUMN_PX) return 6;
  return COLUMNS;
}

/** A stored span, mapped onto the columns available. Never zero. */
function spanFor(stored: number, columns: number): number {
  if (columns === COLUMNS) return Math.min(stored, 4) * SPAN_UNIT;
  if (columns === 6) {
    // 1..4 quarters become 1..6 of six columns: half steps land on odd counts so
    // the row still reads as bento rather than as a binary wide/narrow.
    const mapped = [2, 3, 5, 6];
    return mapped[Math.min(Math.max(stored, 1), 4) - 1] ?? 6;
  }
  // Two columns: everything narrower than half takes one, the rest takes both.
  return stored >= 2 ? 2 : 1;
}

export function HomeSurface() {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const cards = useMemo(
    () => resolveHomeCards(prefs.home_cards, prefs.ai_enabled),
    [prefs.home_cards, prefs.ai_enabled],
  );

  // ── In place of the old arrange screen ───────────────────────────────────
  // **Every edit writes the WHOLE list.** The stored value is one ordered array,
  // so a partial write would be a second shape to keep in step; `setHomeCards`
  // validates the batch and refuses a card the codec would skip on the next load.
  const persist = useCallback((next: readonly HomeCard[]) => {
    if (sameArrangement(cards, next)) return;
    void setHomeCards(next);
  }, [cards]);

  const patch = useCallback(
    (operation: (current: readonly HomeCard[]) => HomeCard[]) => {
      persist(operation(cards));
    },
    [cards, persist],
  );

  const setOptions = useCallback(
    (id: string, options: Readonly<Record<string, string>>) => {
      patch((current) =>
        current.map((card) =>
          card.id === id ? { ...card, options: { ...(card.options ?? {}), ...options } } : card,
        ),
      );
    },
    [patch],
  );

  const layout: HomeLayoutApi = useMemo(
    () => ({ cards, patch, setOptions }),
    [cards, patch, setOptions],
  );

  // Measured, not windowed: see `columnsFor`.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(COLUMNS * 120);
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? el.clientWidth;
      if (measured > 0) setWidth(measured);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const columns = columnsFor(width);

  // ── Drag to reorder ─────────────────────────────────────────────────────
  // Pointer events rather than a drag library: the repo carries none, and the
  // behaviour needed is small and specific (a handle, a threshold, an index).
  const [dragging, setDragging] = useState<{ id: string; from: number; to: number } | null>(null);
  const dragRef = useRef<{ id: string; from: number; pointerId: number; moved: boolean } | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());

  const indexAt = useCallback((x: number, y: number): number => {
    // The hit test reads the DOM, because the answer IS where the cards are.
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [id, el] of cardRefs.current) {
      const rect = el.getBoundingClientRect();
      const inRow = y >= rect.top - rect.height / 2 && y <= rect.bottom + rect.height / 2;
      const distance = Math.abs(x - (rect.left + rect.width / 2)) + (inRow ? 0 : Math.abs(y - (rect.top + rect.height / 2)));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = cards.findIndex((card) => card.id === id);
      }
    }
    return best;
  }, [cards]);

  const onHandleDown = useCallback(
    (card: HomeCard, index: number) => (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { id: card.id, from: index, pointerId: event.pointerId, moved: false };
      setDragging({ id: card.id, from: index, to: index });
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (drag === null) return;
      drag.moved = true;
      const to = indexAt(event.clientX, event.clientY);
      if (to >= 0) setDragging((current) => (current === null ? current : { ...current, to }));
    },
    [indexAt],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setDragging(null);
      if (drag === null) return;
      if (event.currentTarget.hasPointerCapture(drag.pointerId)) {
        event.currentTarget.releasePointerCapture(drag.pointerId);
      }
      if (!drag.moved) return;
      const to = indexAt(event.clientX, event.clientY);
      if (to < 0 || to === drag.from) return;
      patch((current) => moveCard(current, drag.from, to));
    },
    [indexAt, patch],
  );

  // ── Drag to resize ──────────────────────────────────────────────────────
  const resizeRef = useRef<{ id: string; startX: number; startSpan: number; columnWidth: number } | null>(null);
  const [resizing, setResizing] = useState<{ id: string; span: number } | null>(null);

  const onResizeDown = useCallback(
    (card: HomeCard) => (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const el = cardRefs.current.get(card.id);
      if (el === undefined) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeRef.current = {
        id: card.id,
        startX: event.clientX,
        startSpan: card.span,
        // The column width is what turns pixels into a stored span; read it from
        // the grid itself rather than recomputing what the CSS already decided.
        columnWidth: Math.max(el.getBoundingClientRect().width / spanFor(card.span, columns), 1) * SPAN_UNIT,
      };
      setResizing({ id: card.id, span: card.span });
    },
    [columns],
  );

  const onResizeMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const resize = resizeRef.current;
    if (resize === null) return;
    const quarters = Math.round((event.clientX - resize.startX) / resize.columnWidth);
    const span = Math.max(1, Math.min(4, resize.startSpan + quarters));
    setResizing({ id: resize.id, span });
  }, []);

  const onResizeUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const resize = resizeRef.current;
      resizeRef.current = null;
      if (resize === null) {
        setResizing(null);
        return;
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const pending = resizing;
      setResizing(null);
      if (pending === null || pending.span === resize.startSpan) return;
      patch((current) => resizeCard(current, resize.id, pending.span));
    },
    [patch, resizing],
  );

  // ── The keyboard gets the same operations ───────────────────────────────
  const [announcement, setAnnouncement] = useState("");
  const onHandleKey = useCallback(
    (card: HomeCard, index: number) => (event: React.KeyboardEvent<HTMLElement>) => {
      const label = t(homeCardSpec(card.kind)?.labelKey ?? "notes.home.cards.unknown");
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const to = event.key === "ArrowLeft" ? Math.max(0, index - 1) : Math.min(cards.length - 1, index + 1);
        if (to === index) return;
        patch((current) => moveCard(current, index, to));
        setAnnouncement(t("notes.home.a11y.moved", { name: label, position: to + 1 }));
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? +1 : -1;
        const span = Math.max(minSpanOf(card.kind), Math.min(4, card.span + delta));
        if (span === card.span) return;
        patch((current) => resizeCard(current, card.id, span));
        setAnnouncement(t("notes.home.a11y.resized", { name: label, width: span }));
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        patch((current) => removeCard(current, card.id));
        setAnnouncement(t("notes.home.a11y.removed", { name: label }));
      }
    },
    [cards.length, patch, t],
  );

  // ── Add a widget ────────────────────────────────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false);
  const available = useMemo(
    () => HOME_CARD_SPECS.filter((spec) => spec.requiresAi !== true || prefs.ai_enabled),
    [prefs.ai_enabled],
  );

  return (
    <HomeLayoutContext.Provider value={layout}>
      <div
        ref={rootRef}
        data-testid="home.surface"
        // The board scrolls; the add tile is part of the flow so it sits after the
        // last card rather than floating over one.
        style={{ height: "100%", overflowY: "auto", padding: "var(--space-4) var(--space-5) var(--space-6)" }}
      >
        {cards.length === 0 ? (
          <EmptyBoard onAdd={() => setPickerOpen(true)} />
        ) : (
          <div
            data-testid="home.cards"
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              // **Dense flow is the hole fix.** A 2-span card that will not fit the
              // columns left over in a row is filled by the next card instead of
              // leaving a gap, which is what the old independent column stacks did.
              gridAutoFlow: "row dense",
              alignItems: "start",
              gap: "var(--space-3)",
            }}
          >
            {cards.map((card, index) => {
              const isDragging = dragging?.id === card.id;
              const targetIndex = dragging === null ? -1 : dragging.to;
              const span = resizing?.id === card.id ? resizing.span : card.span;
              return (
                <CardFrame
                  key={card.id}
                  card={card}
                  index={index}
                  span={spanFor(span, columns)}
                  dragging={isDragging}
                  // The card being dragged dims and lifts; the rest stay put so the
                  // target position is readable while the pointer moves.
                  dropBefore={!isDragging && targetIndex === index}
                  refCallback={(el) => {
                    if (el === null) cardRefs.current.delete(card.id);
                    else cardRefs.current.set(card.id, el);
                  }}
                  onHandleDown={onHandleDown(card, index)}
                  onHandleKey={onHandleKey(card, index)}
                  onPointerMove={(event) => {
                    onPointerMove(event);
                    onResizeMove(event);
                  }}
                  onPointerUp={(event) => {
                    onPointerUp(event);
                    onResizeUp(event);
                  }}
                  onResizeDown={onResizeDown(card)}
                  onWiden={() =>
                    patch((current) => resizeCard(current, card.id, card.span >= 4 ? minSpanOf(card.kind) : card.span + 1))
                  }
                  onNarrow={() =>
                    patch((current) => resizeCard(current, card.id, card.span - 1))
                  }
                  onRemove={() => patch((current) => removeCard(current, card.id))}
                />
              );
            })}
            <AddTile onOpen={() => setPickerOpen(true)} columns={columns} />
          </div>
        )}

        {pickerOpen && (
          <WidgetPicker
            available={available}
            onClose={() => setPickerOpen(false)}
            onAdd={(kind) => {
              patch((current) => addCard(current, kind));
              setPickerOpen(false);
            }}
          />
        )}

        {/* Reorder and resize are not visible events, so they are announced. */}
        <div aria-live="polite" style={VISUALLY_HIDDEN}>
          {announcement}
        </div>
      </div>
    </HomeLayoutContext.Provider>
  );
}

const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

/** One widget: header, body, and the controls that only appear on the card you point at. */
function CardFrame({
  card,
  index,
  span,
  dragging,
  dropBefore,
  refCallback,
  onHandleDown,
  onHandleKey,
  onPointerMove,
  onPointerUp,
  onResizeDown,
  onWiden,
  onNarrow,
  onRemove,
}: {
  card: HomeCard;
  index: number;
  span: number;
  dragging: boolean;
  dropBefore: boolean;
  refCallback: (el: HTMLDivElement | null) => void;
  onHandleDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onHandleKey: (event: React.KeyboardEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizeDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onWiden: () => void;
  onNarrow: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const def = HOME_CARD_DEFS[card.kind];
  const spec = homeCardSpec(card.kind);
  const [menuOpen, setMenuOpen] = useState(false);
  void index;

  return (
    <section
      ref={refCallback}
      data-testid={`home.card.${card.id}`}
      data-kind={card.kind}
      style={{
        gridColumn: `span ${span}`,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "var(--space-3) var(--space-4)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-2)",
        background: "var(--bg-1)",
        opacity: dragging ? 0.6 : 1,
        // A ring rather than a shift while dragging: moving the card under the
        // pointer is what the commit does, and doing both doubles the motion.
        boxShadow: dropBefore ? "0 0 0 1px var(--accent)" : undefined,
        transition: "opacity var(--duration-fast) var(--ease-standard)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          minHeight: 24,
          fontSize: "var(--text-sm)",
          color: "var(--fg-2)",
        }}
      >
        {/* The drag handle is a real button: the keyboard path and the pointer path
            are the same element, so there is no invisible third affordance. */}
        <button
          type="button"
          onPointerDown={onHandleDown}
          onKeyDown={onHandleKey}
          aria-label={t("notes.home.a11y.moveHandle", {
            name: t(spec?.labelKey ?? "notes.home.cards.unknown"),
          })}
          data-testid={`home.card.handle.${card.id}`}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            marginInlineStart: "calc(var(--space-2) * -1)",
            border: "none",
            borderRadius: "var(--radius-1)",
            background: "transparent",
            color: "var(--fg-3)",
            cursor: "grab",
            touchAction: "none",
          }}
        >
          <Icon name="more-vertical" size={14} />
        </button>
        {spec !== undefined && <Icon name={spec.icon} size={14} />}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t(spec?.labelKey ?? "notes.home.cards.unknown")}
        </span>
        {def?.HeaderAction !== undefined && <def.HeaderAction card={card} />}
        <CardMenu
          open={menuOpen}
          onToggle={() => setMenuOpen((open) => !open)}
          card={card}
          onWiden={onWiden}
          onNarrow={onNarrow}
          onRemove={onRemove}
        />
      </header>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-1)", minWidth: 0 }}>
        {def === undefined ? (
          <div style={{ color: "var(--fg-3)" }}>{t("notes.home.cards.pending")}</div>
        ) : (
          <def.Body card={card} />
        )}
      </div>
      {/* The resize handle sits on the corner, which is where every grid editor
          puts it: the pointer travels the same direction as the edge it moves. */}
      <button
        type="button"
        onPointerDown={onResizeDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        aria-label={t("notes.home.a11y.resizeHandle", {
          name: t(spec?.labelKey ?? "notes.home.cards.unknown"),
        })}
        data-testid={`home.card.resize.${card.id}`}
        style={{
          position: "absolute",
          insetInlineEnd: 0,
          insetBlockEnd: 0,
          width: 18,
          height: 18,
          border: "none",
          background: "transparent",
          cursor: "nwse-resize",
          touchAction: "none",
          color: "var(--fg-3)",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "flex-end",
          padding: 2,
        }}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M7 1 1 7M7 4.5 4.5 7" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
    </section>
  );
}

function CardMenu({
  open,
  onToggle,
  card,
  onWiden,
  onNarrow,
  onRemove,
}: {
  open: boolean;
  onToggle: () => void;
  card: HomeCard;
  onWiden: () => void;
  onNarrow: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const floor = minSpanOf(card.kind);
  // A deliberately small menu: two sizes above and below, and remove. Anything
  // else a widget wants to change belongs to the widget, not to the arrangement.
  const item = (label: string, run: () => void, testId: string, disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        run();
        onToggle();
      }}
      data-testid={testId}
      style={{
        display: "block",
        width: "100%",
        textAlign: "start",
        padding: "var(--space-1) var(--space-2)",
        border: "none",
        background: "transparent",
        color: disabled ? "var(--fg-4, var(--fg-3))" : "var(--fg-1)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <span style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("notes.home.cardMenu.label")}
        data-testid={`home.card.menu.${card.id}`}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 24,
          height: 24,
          border: "none",
          borderRadius: "var(--radius-1)",
          background: "transparent",
          color: "var(--fg-3)",
          cursor: "pointer",
        }}
      >
        <Icon name="more-horizontal" size={14} />
      </button>
      {open && (
        <div
          role="menu"
          data-testid={`home.card.menu-list.${card.id}`}
          style={{
            position: "absolute",
            insetInlineEnd: 0,
            insetBlockStart: 26,
            zIndex: 2,
            minWidth: 160,
            padding: "var(--space-1) 0",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-2)",
            background: "var(--bg-1)",
            boxShadow: "0 8px 24px rgb(0 0 0 / 0.18)",
          }}
        >
          {item(t("notes.home.cardMenu.wider"), onWiden, `home.card.menu.${card.id}.wider`, card.span >= 4)}
          {item(t("notes.home.cardMenu.narrower"), onNarrow, `home.card.menu.${card.id}.narrower`, card.span <= floor)}
          {item(t("notes.home.cardMenu.remove"), onRemove, `home.card.menu.${card.id}.remove`)}
        </div>
      )}
    </span>
  );
}

/** The trailing tile: the way a widget gets onto the board. */
function AddTile({ onOpen, columns }: { onOpen: () => void; columns: number }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="home.add"
      style={{
        gridColumn: `span ${columns >= 6 ? 2 : columns}`,
        minHeight: 96,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--space-2)",
        border: "1px dashed var(--line-2)",
        borderRadius: "var(--radius-2)",
        background: "transparent",
        color: "var(--fg-3)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        cursor: "pointer",
      }}
    >
      <Icon name="plus" size={14} />
      {t("notes.home.addCard")}
    </button>
  );
}

function WidgetPicker({
  available,
  onAdd,
  onClose,
}: {
  available: readonly (typeof HOME_CARD_SPECS)[number][];
  onAdd: (kind: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ marginTop: "var(--space-3)" }}>
      <div
        data-testid="home.picker"
        style={{
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-2)",
          background: "var(--bg-1)",
          padding: "var(--space-3) var(--space-4)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
          <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)" as unknown as number }}>
            {t("notes.home.addCard")}
          </span>
          <Button variant="ghost" onClick={onClose} data-testid="home.picker.close">
            {t("common.close")}
          </Button>
        </div>
        {HOME_CARD_GROUPS.map((group) => {
          const specs = available.filter((spec) => spec.group === group);
          if (specs.length === 0) return null;
          return (
            <div key={group} style={{ marginTop: "var(--space-3)" }}>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--fg-3)",
                  marginBottom: "var(--space-1)",
                }}
              >
                {t(HOME_GROUP_LABEL_KEY[group])}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "var(--space-1)" }}>
                {specs.map((spec) => (
                  <button
                    key={spec.kind}
                    type="button"
                    onClick={() => onAdd(spec.kind)}
                    data-testid={`home.picker.add.${spec.kind}`}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "var(--space-2)",
                      textAlign: "start",
                      padding: "var(--space-2)",
                      border: "none",
                      borderRadius: "var(--radius-1)",
                      background: "transparent",
                      color: "var(--fg-1)",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ display: "flex", color: "var(--fg-2)", marginTop: 1 }}>
                      <Icon name={spec.icon} size={14} />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: "var(--text-sm)" }}>{t(spec.labelKey)}</span>
                      <span style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                        {t(spec.descriptionKey)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** An emptied board: one sentence and the only control that helps. */
function EmptyBoard({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--space-3)",
        minHeight: 240,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "var(--text-md)", color: "var(--fg-1)" }}>{t("notes.home.emptyTitle")}</div>
      <Button variant="primary" onClick={onAdd} data-testid="home.empty.add">
        {t("notes.home.addCard")}
      </Button>
    </div>
  );
}
