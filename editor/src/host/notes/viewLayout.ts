// `viewLayout` — shared, platform-agnostic layout helpers for the saved-view
// TABLE (MYND-277) and LIST (MYND-278) renderers. PURE: no React, no DOM, no
// platform deps — so the desktop renderers (over `VirtualList`) and the mobile
// renderers (over `ScreenScroll`) compute the IDENTICAL group stream, column
// set, column geometry, and data-testids. The cards renderer keeps its own
// shelf-chunking stream (`buildGalleryStream`); only the pieces table + list +
// cards all need in common live here.

import type { StoredProperty, ViewResult, ViewRow } from "./queryEngine";
import {
  extractAttachmentRefs,
  isAttachmentId,
  parseAttachmentTarget,
} from "./attachmentRef";

/** The data-testid strings the renderers expose. Shared so the E2E contract is
 *  ONE cross-platform surface — desktop + mobile assert the same ids. Group
 *  heading + empty are reused from the cards precedent verbatim. */
export const VIEW_TESTID = {
  table: "view.table",
  tableHeader: "view.table-header",
  tableRow: "view.table-row",
  list: "view.list",
  listRow: "view.list-row",
  groupHeading: "view.group-heading",
  empty: "view.empty",
  // The board (myne-md/myne#922). The lane ids are here rather than written
  // inline because the board mounts from a second tree (mobile imports the
  // shared module), and one E2E locator has to work on both.
  board: "view.board",
  boardLanes: "view.board-lanes",
  boardNoGroupBy: "view.board-no-group-by",
  lane: "view.lane",
  laneScroll: "view.lane-scroll",
  laneHeading: "view.lane-heading",
  laneEmpty: "view.lane-empty",
  /** The slot one card occupies inside a lane: the element that carries the
   *  drag and keyboard gesture, so the pointer target and the card's own click
   *  stay separate things. */
  laneCardSlot: "view.card-slot",
  /** The line a refused drag renders, where the gesture happened. */
  boardRefusal: "view.board-refusal",
  /** One lane's add-card control. Repeated per lane, so E2E scopes it by the
   *  lane's own `data-lane-value`. */
  boardAddCard: "view.board-add-card",
  /** The line an add-card gesture renders when it could not place the card. */
  boardAddError: "view.board-add-error",
} as const;

/** Default cover aspect ratio (≈16:9) when a view sets no
 *  `image_aspect_ratio`. */
export const DEFAULT_COVER_ASPECT_RATIO = "1.78";

/**
 * Resolve the cover aspect ratio (a CSS `aspect-ratio` string) from a view's
 * `image_aspect_ratio` — a STRING in the schema (e.g. `"1.65"`) so the `.base`
 * float never enters canonical JSON. Pure consumer: a finite positive parse is
 * used verbatim; anything else falls back to the default.
 *
 * Shared by the cards gallery and the board (myne-md/myne#922), and reached by
 * mobile through the same module: one cover rule, not one per renderer.
 */
export function resolveAspectRatio(ratio: string | undefined): string {
  if (ratio === undefined) return DEFAULT_COVER_ASPECT_RATIO;
  const n = Number.parseFloat(ratio.trim());
  return Number.isFinite(n) && n > 0 ? ratio.trim() : DEFAULT_COVER_ASPECT_RATIO;
}

/**
 * Within-group dedupe by note id (query-engine fan-out constraint, lifted from
 * `cardsView`). The engine OWNS which groups a note lands in — a note
 * legitimately fans out across MULTIPLE group sections (a list-valued groupBy),
 * and each renderer must paint every cross-group appearance untouched. The ONLY
 * thing a renderer guards is the same note appearing twice WITHIN ONE section's
 * row list: those collapse to the first occurrence (also keeping React keys
 * unique inside a group). It never collapses cross-group appearances and never
 * re-derives grouping.
 */
export function dedupeRowsByNote(rows: ReadonlyArray<ViewRow>): ViewRow[] {
  const seen = new Set<string>();
  const out: ViewRow[] = [];
  for (const row of rows) {
    if (seen.has(row.noteId)) continue;
    seen.add(row.noteId);
    out.push(row);
  }
  return out;
}

/** A group-heading item in the linear stream (one per engine group). */
export type ViewStreamHeading = {
  readonly kind: "heading";
  readonly key: string;
  readonly groupKey: string;
  readonly label: string;
  readonly count: number;
};
/** One note row in the linear stream. */
export type ViewStreamRow = {
  readonly kind: "row";
  readonly key: string;
  readonly groupKey: string;
  readonly row: ViewRow;
};
/** The two item kinds table + list flatten a `ViewResult` into (table prepends
 *  its own column-header item; that stays renderer-local). */
export type ViewStreamItem = ViewStreamHeading | ViewStreamRow;

/**
 * Flatten a `ViewResult` into a linear heading+row stream: each group emits one
 * `heading` item followed by its (within-group deduped) `row` items. Cross-group
 * fan-out is preserved (a note under two groupBy values appears under both
 * headings). `noValueLabel` is the i18n string for the implicit empty-key group
 * (`""`). React keys are group-scoped (`r:<groupKey>:<noteId>`) so a fanned-out
 * note stays unique across sections. Returns the stream + the total row count
 * (deduped) so the caller can render the empty state when it is 0.
 */
export function buildViewStream(
  result: ViewResult,
  noValueLabel: string,
): { stream: ViewStreamItem[]; total: number } {
  const stream: ViewStreamItem[] = [];
  let total = 0;
  for (const group of result.groups) {
    const rows = dedupeRowsByNote(group.rows);
    stream.push({
      kind: "heading",
      key: `h:${group.key}`,
      groupKey: group.key,
      label: group.key === "" ? noValueLabel : group.key,
      count: rows.length,
    });
    for (const row of rows) {
      stream.push({
        kind: "row",
        key: `r:${group.key}:${row.noteId}`,
        groupKey: group.key,
        row,
      });
      total++;
    }
  }
  return { stream, total };
}

/**
 * The display columns for a table/list: the view's `columns` minus the
 * cover-image column (`def.image`) — its value is an attachment ref, noise in a
 * text cell — exactly the exclusion the cards renderer applies.
 */
export function displayColumns(def: {
  readonly columns?: readonly string[];
  readonly image?: string;
}): string[] {
  return (def.columns ?? []).filter((c) => c !== def.image);
}

/**
 * Resolve a card cover to an attachment-id from the frontmatter `image:`
 * property value (SYNC-11). Accepts the forms a user can write:
 *   - a form-C embed `![[att:<id>|filename]]`  (first ref wins)
 *   - a bare/bracketed attachment target `att:<id>` or `[[att:<id>]]`
 *   - a bare 64-hex attachment-id
 * Returns the id, or `null` when the property is absent / a list / unparseable
 * — the caller renders an IMAGE-LESS card. Resolved through the EXISTING
 * `attachment://` scheme (`attachmentUrl`); no new decrypt path, no body scan.
 * Shared so the desktop + mobile card renderers resolve covers identically.
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

/** Default sticky Name-column min width (px) — numeric token twin (a CSS var
 *  can't be read back in a 0-width jsdom container; mirrors `CARD_GAP_PX`). */
export const TABLE_NAME_MIN = 200;
/** Default per-property-column min width (px). */
export const TABLE_COL_MIN = 140;

/**
 * The table's `grid-template-columns` + its total minimum width. A wider sticky
 * Name track (`1.5fr`, min `nameMin`) plus one `1fr` track (min `colMin`) per
 * property column. When the container is narrower than `minWidth` the grid keeps
 * the mins and OVERFLOWS — the renderer's `overflow-x:auto` scroller then scrolls
 * horizontally with the Name column pinned. Pure arithmetic (jsdom-safe).
 */
export function tableGridTemplate(
  columnCount: number,
  opts?: { nameMin?: number; colMin?: number },
): { template: string; minWidth: number } {
  const nameMin = opts?.nameMin ?? TABLE_NAME_MIN;
  const colMin = opts?.colMin ?? TABLE_COL_MIN;
  const n = Math.max(0, columnCount);
  const template =
    n === 0
      ? `minmax(${nameMin}px, 1fr)`
      : `minmax(${nameMin}px, 1.5fr) repeat(${n}, minmax(${colMin}px, 1fr))`;
  return { template, minWidth: nameMin + n * colMin };
}
