// `CardsView` — the cards-gallery renderer for a saved view (MYND-275, Saved
// Views #5). PURE component: it consumes the query-engine's grouped-row output
// (`ViewResult`) and the persisted view definition (`SavedView`) and paints a
// calm card gallery, grouped by a heading per group and windowed by shelf.
//
// The CARD itself lives in `./card` (myne-md/myne#922 task 3): cover
// resolution, the click/keyboard/context matrix and the testids are shared with
// the board, so the two renderers cannot drift on what a card is. What stays
// here is gallery-only: the shelf chunking, the per-view sizing, and the
// virtualized heading/shelf stream.
//
// The render is read-only: no contenteditable, no <input>, no drag/drop
// affordance anywhere (views are projections, not editable buffers).

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { SavedView } from "../../lib/prefs";
import type { ViewResult, ViewRow } from "../queryEngine";
import {
  dedupeRowsByNote,
  displayColumns,
  resolveAspectRatio,
  resolveCoverAttachmentId,
} from "./viewLayout";
import { VirtualList } from "../components/VirtualList";
import {
  ViewCard,
  type CardContextMenuHandler,
  type OpenNoteHandler,
  type SetCoverHandler,
} from "./card";

// The card and its handler contract live in `./card` (myne-md/myne#922 task 3),
// re-exported here so the gallery's existing importers — and the card test's
// type imports — keep resolving from the module they always named.
export type {
  CardContextMenuHandler,
  OpenNoteHandler,
  OpenNoteIntent,
  SetCoverHandler,
} from "./card";

/** Exact empty-state copy from the design canon ("Cards view — render" frame),
 *  in the source language. The rendered text goes through i18n
 *  (`notes.views.cards.empty`); this literal is kept as the test/E2E full-text
 *  assertion anchor and matches the English catalog value. */
export const CARDS_EMPTY_COPY = "No notes match this view";

// `resolveCoverAttachmentId` moved to the shared `viewLayout` (the mobile card
// renderer reuses it verbatim for its cover). Re-exported so existing importers
// of `./cardsView` (PaneView + the cards tests) stay unchanged.
export { resolveCoverAttachmentId };

/** Default card column width (px) when the view sets no `card_size`. */
export const DEFAULT_CARD_WIDTH = 220;
/** Sane clamp so a hand-edited `card_size` can't break the gallery layout.
 *  Exported so the view-settings UI drives its slider from the same canon
 *  `resolveCardWidth` clamps against (no drift between control and render). */
export const MIN_CARD_WIDTH = 120;
export const MAX_CARD_WIDTH = 600;
/** Inter-card gap in px — the numeric twin of the `var(--space-3)` token the
 *  shelf grid uses. Load-bearing for the `columnsPerRow` math (a CSS var can't
 *  be read back from a 0-width jsdom container). Keep in sync with the token. */
const CARD_GAP_PX = 12;
/** Cold-start row-height estimate (px) the row-virtualizer assumes for an
 *  unmeasured shelf/heading before its ResizeObserver reports the real height.
 *  A shelf is one card tall (~cover + title + a couple property rows). */
const SHELF_ESTIMATED_HEIGHT = 280;

/**
 * Compute how many cards fit per shelf for a measured gallery width (task 9).
 * Mirrors the CSS grid `repeat(auto-fill, minmax(<cardWidth>px, 1fr))` track
 * count: each track is `cardWidth` wide with a `gap` between tracks, so the
 * number of tracks `n` satisfies `n*cardWidth + (n-1)*gap <= width`, i.e.
 * `n = floor((width + gap) / (cardWidth + gap))`. A 0-width / pre-layout
 * environment (jsdom) yields `n = 1` so the stream is still well-formed.
 */
export function columnsForWidth(
  width: number,
  cardWidth: number,
  gap: number = CARD_GAP_PX,
): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / (cardWidth + gap)));
}

/** A heading item in the linear virtualized stream (one per group). */
type HeadingItem = { kind: "heading"; key: string; label: string; count: number };
/** A shelf item: one row of up to `columnsPerRow` cards from a single group. */
type ShelfItem = { kind: "shelf"; key: string; cards: ViewRow[] };
/** The two kinds the row-virtualizer renders. */
type GalleryItem = HeadingItem | ShelfItem;

/** Chunk a flat array into fixed-size shelves (the last shelf may be short). */
function chunk<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Flatten the deduped groups into the linear item stream the {@link VirtualList}
 * windows: each group contributes a `heading` item followed by its rows chunked
 * into `shelf` items of `columnsPerRow` cards. Cross-group fan-out is preserved
 * (the engine owns grouping); only the within-group dupe was already collapsed
 * by {@link dedupeRowsByNote} in the caller.
 */
export function buildGalleryStream(
  groups: ReadonlyArray<{ key: string; label: string; rows: ViewRow[] }>,
  columnsPerRow: number,
): GalleryItem[] {
  const cols = Math.max(1, columnsPerRow);
  const stream: GalleryItem[] = [];
  for (const group of groups) {
    stream.push({
      kind: "heading",
      key: `h:${group.key}`,
      label: group.label,
      count: group.rows.length,
    });
    const shelves = chunk(group.rows, cols);
    shelves.forEach((cards, shelfIndex) => {
      stream.push({
        kind: "shelf",
        // Stable across width changes within a group; the shelf index keeps it
        // unique. (Group keys are unique per ViewResult.)
        key: `s:${group.key}:${shelfIndex}`,
        cards,
      });
    });
  }
  return stream;
}

/**
 * Resolve the card column width (px) from the view's `card_size` (task 5). The
 * render is a pure CONSUMER — it reads the schema value, clamps it to a sane
 * range, and falls back to {@link DEFAULT_CARD_WIDTH} when the field is missing
 * or not a finite positive number. It never owns or persists the value.
 */
export function resolveCardWidth(cardSize: number | undefined): number {
  if (cardSize === undefined || !Number.isFinite(cardSize) || cardSize <= 0) {
    return DEFAULT_CARD_WIDTH;
  }
  return Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, cardSize));
}

// `resolveAspectRatio` moved to the shared `viewLayout` (the board and the
// mobile cover renderer read the same rule). Re-exported so existing importers
// of `./cardsView` (the view settings slider, the cards tests) stay unchanged.
export { resolveAspectRatio };

// `dedupeRowsByNote` moved to the shared `viewLayout` (the table + list
// renderers reuse it verbatim). Re-exported so existing importers of
// `./cardsView` (the cards tests) stay unchanged.
export { dedupeRowsByNote };

const GROUP_HEADING_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--space-2)",
  margin: "var(--space-5) 0 var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-2)",
};

const GROUP_COUNT_STYLE: CSSProperties = {
  fontWeight: "var(--weight-regular)",
  fontSize: 12,
  color: "var(--fg-3)",
};

const CARD_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: "var(--space-3)",
};

const EMPTY_STYLE: CSSProperties = {
  margin: "12vh auto 0",
  maxWidth: 420,
  textAlign: "center",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  lineHeight: 1.6,
};

/**
 * The cards gallery. Pure — `def` provides the display columns (image / sort /
 * group are the engine's concern, already reflected in `result`); `result`
 * carries the grouped, sorted rows.
 */
export function CardsView({
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
  // Text property rows exclude the cover-image property (`def.image`) — its
  // value is the attachment ref, painted as the cover, never as a text row.
  const columns = useMemo(() => displayColumns(def), [def]);
  // Per-view sizing from the schema (task 5) — pure consumers, sane fallbacks.
  const cardWidth = resolveCardWidth(def.card_size);
  const aspectRatio = resolveAspectRatio(def.image_aspect_ratio);

  // Measure the gallery width with a ResizeObserver so the shelf-chunker knows
  // how many cards fit per row (task 9). Same pattern VirtualList.tsx uses — no
  // new dependency. A 0-width / pre-layout environment (jsdom) → 1 column.
  const galleryRef = useRef<HTMLDivElement | null>(null);
  const [galleryWidth, setGalleryWidth] = useState(0);
  useLayoutEffect(() => {
    const node = galleryRef.current;
    if (node === null) return;
    setGalleryWidth(node.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === node) setGalleryWidth(node.clientWidth);
      }
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  const columnsPerRow = columnsForWidth(galleryWidth, cardWidth);

  // Shelf grid: a fixed-track row over tokens (NOT auto-fill — the virtualizer
  // owns row layout, the shelf owns column layout). `card_size` is reflected
  // here as the per-track min width (task 5: card_size → rendered column width).
  const shelfStyle = useMemo<CSSProperties>(
    () => ({
      ...CARD_GRID_STYLE,
      gridTemplateColumns: `repeat(${columnsPerRow}, minmax(${cardWidth}px, 1fr))`,
    }),
    [columnsPerRow, cardWidth],
  );

  // Paint the engine's groups verbatim (cross-group fan-out preserved); guard
  // only the within-group dupe. Count + shelves use the deduped rows so the
  // "value · count" heading matches the cards actually shown. The render is the
  // sole owner of within-group dedupe; `buildGalleryStream` only chunks.
  const groups = useMemo(
    () =>
      result.groups.map((group) => ({
        key: group.key,
        label: group.key === "" ? t("common.novalue") : group.key,
        rows: dedupeRowsByNote(group.rows),
      })),
    [result.groups, t],
  );
  // Flatten groups → linear heading/shelf stream the row-virtualizer windows:
  // only the visible shelves (+ buffer) mount, so a large result set never
  // mounts thousands of card nodes at once.
  const stream = useMemo(
    () => buildGalleryStream(groups, columnsPerRow),
    [groups, columnsPerRow],
  );
  const totalRows = groups.reduce((sum, group) => sum + group.rows.length, 0);

  if (totalRows === 0) {
    return (
      <div data-testid="view.empty" style={EMPTY_STYLE}>
        {t("common.nonotesmatchthisview")}
      </div>
    );
  }

  // The card resolves its own cover and owns its click/key/context matrix, so
  // the gallery and the board cannot disagree about what a card does.
  const renderCard = (row: ViewRow): ReactNode => (
    <ViewCard
      key={row.noteId}
      row={row}
      columns={columns}
      coverProperty={def.image}
      coverAspectRatio={aspectRatio}
      onOpenNote={onOpenNote}
      onCardContextMenu={onCardContextMenu}
      onSetCover={onSetCover}
    />
  );

  const renderItem = (item: GalleryItem): ReactNode => {
    if (item.kind === "heading") {
      return (
        <div data-testid="view.group-heading" style={GROUP_HEADING_STYLE}>
          <span>{item.label}</span>
          <span style={GROUP_COUNT_STYLE}>· {item.count}</span>
        </div>
      );
    }
    return <div style={shelfStyle}>{item.cards.map(renderCard)}</div>;
  };

  return (
    <div
      ref={galleryRef}
      data-testid="view.cards"
      style={{ maxWidth: 920, margin: "0 auto", height: "100%" }}
    >
      <VirtualList<GalleryItem>
        items={stream}
        keyOf={(item) => item.key}
        renderItem={renderItem}
        estimatedRowHeight={SHELF_ESTIMATED_HEIGHT}
      />
    </div>
  );
}
