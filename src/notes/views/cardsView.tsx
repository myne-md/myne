// `CardsView` — the cards-gallery renderer for a saved view (MYND-275, Saved
// Views #5, task 2). PURE component: it consumes the query-engine's grouped-row
// output (`ViewResult`) and the persisted view definition (`SavedView`) and
// paints a calm card gallery — NOT a kanban board.
//
// SKELETON SCOPE (this task): card = optional cover region (LATER, task 4) →
// title → a short list of the view's `columns` properties rendered as PLAIN
// text. Typed property formatting (date/pill/checkbox) is task 6; cover images
// are task 4; cardSize / aspectRatio are task 5. None of those are built here —
// the structure is left clean for them to slot in.
//
// The render is read-only: no contenteditable, no <input>, no drag/drop
// affordance anywhere (views are projections, not editable buffers).

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { SavedView } from "../../lib/prefs";
import type { StoredProperty, ViewResult, ViewRow } from "../queryEngine";
import {
  attachmentUrl,
  extractAttachmentRefs,
  isAttachmentId,
  parseAttachmentTarget,
} from "../attachmentRef";
import { PropertyValue, hasDisplayableValue } from "./propertyFormat";
import { VirtualList } from "../components/VirtualList";
import { Icon } from "../../components/primitives/Icon";

/** Exact empty-state copy from the design canon ("Cards view — render" frame).
 *  The single literal so an E2E full-text assertion has one source. */
export const CARDS_EMPTY_COPY = "No notes match this view";

/**
 * Resolve a card cover to an attachment-id from the frontmatter `image:`
 * property value (task 4, SYNC-11). Accepts the forms a user can write:
 *   - a form-C embed `![[att:<id>|filename]]`  (first ref wins)
 *   - a bare/bracketed attachment target `att:<id>` or `[[att:<id>]]`
 *   - a bare 64-hex attachment-id
 * Returns the id, or `null` when the property is absent / a list / unparseable
 * — the caller then renders an IMAGE-LESS card (no placeholder, no broken-image
 * glyph). The cover is resolved through the EXISTING `attachment://` scheme
 * (`attachmentUrl`); no new decrypt path, no new Tauri command, no body scan.
 */
export function resolveCoverAttachmentId(
  prop: StoredProperty | undefined,
): string | null {
  if (prop === undefined || prop.type === "list") return null;
  const raw = (prop.value ?? "").trim();
  if (raw === "") return null;
  const embeds = extractAttachmentRefs(raw);
  if (embeds.length > 0) return embeds[0]!.id;
  // Strip a surrounding `[[ … ]]` then try an `att:<id>` target.
  const target = raw.replace(/^!?\[\[/, "").replace(/\]\]$/, "").split("|")[0]!;
  const fromTarget = parseAttachmentTarget(target);
  if (fromTarget !== null) return fromTarget;
  return isAttachmentId(raw) ? raw : null;
}

/** Calm fallback label for the implicit no-value group (group key ""). */
const NO_VALUE_LABEL = "No value";

/** Default card column width (px) when the view sets no `card_size`. */
export const DEFAULT_CARD_WIDTH = 220;
/** Sane clamp so a hand-edited `card_size` can't break the gallery layout.
 *  Exported so the view-settings UI drives its slider from the same canon
 *  `resolveCardWidth` clamps against (no drift between control and render). */
export const MIN_CARD_WIDTH = 120;
export const MAX_CARD_WIDTH = 600;
/** Default cover aspect ratio (≈16:9) when the view sets no
 *  `image_aspect_ratio`. */
const DEFAULT_ASPECT_RATIO = "1.78";
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

/**
 * Resolve the cover aspect ratio (a CSS `aspect-ratio` string) from the view's
 * `image_aspect_ratio` — a STRING in the schema (e.g. `"1.65"`) so the `.base`
 * float never enters canonical JSON (#3, SYNC-11). Pure consumer: a finite
 * positive parse is used verbatim; anything else → {@link DEFAULT_ASPECT_RATIO}.
 */
export function resolveAspectRatio(ratio: string | undefined): string {
  if (ratio === undefined) return DEFAULT_ASPECT_RATIO;
  const n = Number.parseFloat(ratio.trim());
  return Number.isFinite(n) && n > 0 ? ratio.trim() : DEFAULT_ASPECT_RATIO;
}

/** Untitled-note fallback (matches the sidebar's "Untitled" placeholder). */
const UNTITLED_LABEL = "Untitled";

/**
 * Within-group dedupe by note id (task 3, query-engine fan-out constraint).
 * The engine OWNS which groups a note lands in — a note legitimately fans out
 * across MULTIPLE group sections (a list-valued groupBy), and the render must
 * paint each of those cross-group appearances untouched. The ONLY thing the
 * render guards is the same note appearing twice WITHIN ONE section's row list:
 * those collapse to the first occurrence (also keeping React keys unique inside
 * a group's card grid). It never collapses a note's cross-group appearances and
 * never re-derives grouping — it only paints the engine's grouped output.
 */
export function dedupeRowsByNote(
  rows: ReadonlyArray<ViewRow>,
): ViewRow[] {
  const seen = new Set<string>();
  const out: ViewRow[] = [];
  for (const row of rows) {
    if (seen.has(row.noteId)) continue;
    seen.add(row.noteId);
    out.push(row);
  }
  return out;
}

const GROUP_HEADING_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--space-2)",
  margin: "var(--space-5) 0 var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg-2)",
};

const GROUP_COUNT_STYLE: CSSProperties = {
  fontWeight: 400,
  fontSize: 12,
  color: "var(--fg-3)",
};

const CARD_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: "var(--space-3)",
};

const CARD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-3)",
  borderRadius: "var(--radius-1)",
  border: "1px solid var(--line-1)",
  // `--paper-2` is the canon's "recessed surfaces (sidebars, cards)" token.
  background: "var(--paper-2)",
};

/** Interactive variant — a card that opens its note carries a pointer cursor
 *  (read-only still: open is the only gesture, no edit/drag affordance).
 *  Derived from {@link CARD_STYLE} so the two never drift. */
const CARD_INTERACTIVE_STYLE: CSSProperties = {
  ...CARD_STYLE,
  cursor: "pointer",
};

const CARD_IMAGE_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  // Cover fills the top of the card (calm canon); aspect ratio is task 5.
  aspectRatio: "16 / 9",
  objectFit: "cover",
  borderRadius: "var(--radius-1)",
  marginBottom: "var(--space-1)",
  background: "var(--paper-3)",
};

const CARD_TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  fontWeight: 600,
  color: "var(--fg-1)",
  lineHeight: 1.35,
};

const CARD_PROP_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-3)",
  lineHeight: 1.45,
};

const EMPTY_STYLE: CSSProperties = {
  margin: "12vh auto 0",
  maxWidth: 420,
  textAlign: "center",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-3)",
  lineHeight: 1.6,
};

/**
 * The cards gallery. Pure — `def` provides the display columns (image / sort /
 * group are the engine's concern, already reflected in `result`); `result`
 * carries the grouped, sorted rows.
 */
/** Open-intent flags for a card click — the same matrix `NoteRow` uses
 *  (`toSide` → split, `newTab` → new tab, neither → reuse the focused tab). */
export type OpenNoteIntent = { newTab: boolean; toSide: boolean };

/** Open a note from a card — wired by the host to `workspaceContext`'s
 *  `openInFocused` / `openNewTabInFocused` / `openToSide` (no new mechanism). */
export type OpenNoteHandler = (noteId: string, intent: OpenNoteIntent) => void;

/** Right-click a card → the host opens a non-mutating context menu at `pos`. */
export type CardContextMenuHandler = (
  noteId: string,
  pos: { x: number; y: number },
) => void;

/** Set (or change) a card's cover image — the host opens the cover picker for
 *  `noteId`. Absent → no cover affordance is rendered (read-only host). */
export type SetCoverHandler = (noteId: string) => void;

const COVER_BUTTON_STYLE: CSSProperties = {
  position: "absolute",
  top: "var(--space-2)",
  right: "var(--space-2)",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "3px 8px",
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  color: "var(--fg-1)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-1)",
  boxShadow: "var(--shadow-1, 0 1px 4px rgba(0,0,0,0.15))",
  cursor: "pointer",
  zIndex: 1,
};

/**
 * One card. Extracted as a component (not an inline render fn) so each card owns
 * its hover state for the "Set cover" affordance — shown on hover when the host
 * passes `onSetCover` (the affordance's click stops propagation so it never opens
 * the note). Read-only hosts pass no handler → no affordance, no hover cost.
 */
function CardArticle({
  row,
  coverId,
  interactive,
  imageStyle,
  columns,
  onClick,
  onAuxClick,
  onContextMenu,
  onSetCover,
}: {
  row: ViewRow;
  coverId: string | null;
  interactive: boolean;
  imageStyle: CSSProperties;
  columns: readonly string[];
  onClick?: (e: ReactMouseEvent) => void;
  onAuxClick?: (e: ReactMouseEvent) => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  onSetCover?: SetCoverHandler;
}) {
  const [hovering, setHovering] = useState(false);
  const showCoverButton = onSetCover !== undefined && hovering;
  const baseStyle = interactive ? CARD_INTERACTIVE_STYLE : CARD_STYLE;

  return (
    <article
      data-testid="view.card"
      data-note-id={row.noteId}
      style={onSetCover !== undefined ? { ...baseStyle, position: "relative" } : baseStyle}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? -1 : undefined}
      onClick={onClick}
      onAuxClick={onAuxClick}
      onContextMenu={onContextMenu}
      onMouseEnter={onSetCover !== undefined ? () => setHovering(true) : undefined}
      onMouseLeave={onSetCover !== undefined ? () => setHovering(false) : undefined}
    >
      {showCoverButton && (
        <button
          type="button"
          data-testid="view.card-set-cover"
          style={COVER_BUTTON_STYLE}
          title={coverId !== null ? "Change cover image" : "Set cover image"}
          onClick={(e) => {
            e.stopPropagation();
            onSetCover?.(row.noteId);
          }}
        >
          <Icon name="image" size={12} />
          {coverId !== null ? "Change cover" : "Set cover"}
        </button>
      )}
      {coverId !== null && (
        <img
          data-testid="view.card-image"
          src={attachmentUrl(coverId)}
          alt=""
          style={imageStyle}
        />
      )}
      <div style={CARD_TITLE_STYLE}>{row.title ?? UNTITLED_LABEL}</div>
      {columns.map((col) => {
        const prop = row.values[col];
        if (!hasDisplayableValue(prop)) return null; // skip empty
        return (
          <div key={col} style={CARD_PROP_STYLE}>
            <PropertyValue prop={prop} />
          </div>
        );
      })}
    </article>
  );
}

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
  // Card navigation (task 7) — mirrors the NoteRow click matrix exactly. The
  // render stays read-only (no edit affordance); these only OPEN the note.
  const handleCardClick = (noteId: string) => (e: ReactMouseEvent) => {
    onOpenNote?.(noteId, {
      newTab: e.metaKey || e.ctrlKey,
      toSide: e.altKey,
    });
  };
  const handleCardAux = (noteId: string) => (e: ReactMouseEvent) => {
    if (e.button === 1) {
      e.preventDefault(); // middle-click → new tab
      onOpenNote?.(noteId, { newTab: true, toSide: false });
    }
  };
  const handleCardContextMenu = (noteId: string) => (e: ReactMouseEvent) => {
    if (onCardContextMenu === undefined) return;
    e.preventDefault();
    onCardContextMenu(noteId, { x: e.clientX, y: e.clientY });
  };
  // Text property rows exclude the cover-image property (`def.image`) — its
  // value is the attachment ref, painted as the cover, never as a text row.
  const columns = useMemo(
    () => (def.columns ?? []).filter((c) => c !== def.image),
    [def.columns, def.image],
  );
  // Per-view sizing from the schema (task 5) — pure consumers, sane fallbacks.
  const cardWidth = resolveCardWidth(def.card_size);
  const aspectRatio = resolveAspectRatio(def.image_aspect_ratio);
  const imageStyle = useMemo<CSSProperties>(
    () => ({ ...CARD_IMAGE_STYLE, aspectRatio }),
    [aspectRatio],
  );

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
        label: group.key === "" ? NO_VALUE_LABEL : group.key,
        rows: dedupeRowsByNote(group.rows),
      })),
    [result.groups],
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
        {CARDS_EMPTY_COPY}
      </div>
    );
  }

  const renderCard = (row: ViewRow): ReactNode => {
    // Cover via the existing `attachment://` scheme; absent/unresolved → an
    // image-less card (NO cover node, NO placeholder/broken-image glyph).
    const coverId =
      def.image !== undefined
        ? resolveCoverAttachmentId(row.values[def.image])
        : null;
    return (
      <CardArticle
        key={row.noteId}
        row={row}
        coverId={coverId}
        interactive={onOpenNote !== undefined}
        imageStyle={imageStyle}
        columns={columns}
        onClick={onOpenNote ? handleCardClick(row.noteId) : undefined}
        onAuxClick={onOpenNote ? handleCardAux(row.noteId) : undefined}
        onContextMenu={
          onCardContextMenu ? handleCardContextMenu(row.noteId) : undefined
        }
        onSetCover={onSetCover}
      />
    );
  };

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
