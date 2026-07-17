// `TableView` — the property-column TABLE renderer for a saved view (MYND-277,
// Saved Views #7). Slots beside `CardsView` behind the `viewRenderHost` dispatch
// and reuses the shared scaffolding verbatim: the query-engine grouped rows
// (`ViewResult`), the typed-cell formatter (`PropertyValue`), the group stream +
// column geometry (`viewLayout`), the row-virtualizer (`VirtualList`), and the
// shared row chrome + click matrix (`viewChrome`).
//
// It is a READ-ONLY projection (SYNC-1): no contenteditable, no `<input>` cell,
// no drag/drop — a calm table of typed cells, NOT a spreadsheet, NEVER a kanban
// (static vertical group sections; `vision.md`). Columns come from `def.columns`
// (the cover-image column excluded), with `row.title` as the leading Name column.
//
// Narrow-pane behaviour (decision: horizontal scroll): columns keep a fixed
// min-width; when the pane is narrower than the table the `VirtualList`
// container scrolls horizontally and the Name column stays pinned
// (`position:sticky; left:0`).

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SavedView } from "../../lib/prefs";
import type { ViewResult } from "../queryEngine";
import { PropertyValue, hasDisplayableValue } from "./propertyFormat";
import { VirtualList } from "../components/VirtualList";
import {
  VIEW_TESTID,
  buildViewStream,
  displayColumns,
  tableGridTemplate,
  type ViewStreamItem,
} from "./viewLayout";
import { ViewEmpty, ViewGroupHeading, makeViewRowHandlers } from "./viewChrome";
import type { CardContextMenuHandler, OpenNoteHandler } from "./cardsView";

/** The column-header pseudo-item prepended to the group stream. */
type ColHeaderItem = { kind: "colheader"; key: string };
type TableItem = ColHeaderItem | ViewStreamItem;

const ROW_ESTIMATED_HEIGHT = 40;

const WRAP_STYLE: CSSProperties = { height: "100%", background: "var(--paper)" };

const CELL_STYLE: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-2)",
  padding: "var(--space-2) 0",
};

const NAME_CELL_STYLE: CSSProperties = {
  ...CELL_STYLE,
  position: "sticky",
  left: 0,
  zIndex: 1,
  // Opaque so property cells scroll UNDER the pinned Name column (matches the
  // row + wrapper `--paper` fill so the occlusion is seamless).
  background: "var(--paper)",
  paddingRight: "var(--space-3)",
  fontWeight: 600,
  color: "var(--fg-1)",
};

/** One grid row (header or data): the column template + a total min-width so a
 *  narrow container overflows horizontally rather than crushing the columns. */
function gridRowStyle(template: string, minWidth: number): CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: template,
    minWidth,
    alignItems: "center",
    columnGap: "var(--space-3)",
    padding: "0 var(--space-3)",
    borderBottom: "1px solid var(--line-1)",
    background: "var(--paper)",
    minHeight: ROW_ESTIMATED_HEIGHT,
  };
}

const HEADER_CELL_STYLE: CSSProperties = {
  ...CELL_STYLE,
  fontSize: 12,
  fontWeight: 600,
  color: "var(--fg-3)",
};

const HEADER_NAME_CELL_STYLE: CSSProperties = {
  ...NAME_CELL_STYLE,
  zIndex: 2, // above data-row Name cells during vertical scroll overlaps
  fontSize: 12,
  color: "var(--fg-3)",
};

export function TableView({
  def,
  result,
  onOpenNote,
  onContextMenu,
}: {
  def: SavedView;
  result: ViewResult;
  onOpenNote?: OpenNoteHandler;
  onContextMenu?: CardContextMenuHandler;
}) {
  const { t } = useTranslation();
  const columns = useMemo(() => displayColumns(def), [def]);
  const { template, minWidth } = useMemo(
    () => tableGridTemplate(columns.length),
    [columns.length],
  );

  const { stream, total } = useMemo(
    () => buildViewStream(result, t("notes.views.table.noValue")),
    [result, t],
  );

  // The column-header row leads the stream (task: `view.table-header`). It
  // scrolls away vertically (sticky vertical header is a v2 polish — a sticky
  // item unmounts past the virtualizer buffer), but its Name cell pins
  // horizontally like every data row.
  const items = useMemo<TableItem[]>(
    () => (total === 0 ? [] : [{ kind: "colheader", key: "__colheader__" }, ...stream]),
    [stream, total],
  );

  // Row styles depend only on the (stable) template + interactivity, so build
  // them once rather than per rendered row.
  const interactive = onOpenNote !== undefined;
  const dataRowStyle = useMemo<CSSProperties>(
    () => ({ ...gridRowStyle(template, minWidth), cursor: interactive ? "pointer" : "default" }),
    [template, minWidth, interactive],
  );
  const headerRowStyle = useMemo<CSSProperties>(
    () => ({ ...gridRowStyle(template, minWidth), borderBottom: "1px solid var(--line-2)" }),
    [template, minWidth],
  );

  const rows = makeViewRowHandlers(onOpenNote, onContextMenu);

  if (total === 0) {
    return <ViewEmpty message={t("notes.views.table.empty")} />;
  }

  const renderItem = (item: TableItem): ReactNode => {
    if (item.kind === "heading") {
      return <ViewGroupHeading label={item.label} count={item.count} />;
    }
    if (item.kind === "colheader") {
      return (
        <div data-testid={VIEW_TESTID.tableHeader} style={headerRowStyle}>
          <span style={HEADER_NAME_CELL_STYLE}>{t("notes.views.table.name")}</span>
          {columns.map((col) => (
            <span key={col} style={HEADER_CELL_STYLE} title={col}>
              {col}
            </span>
          ))}
        </div>
      );
    }
    // A data row.
    const { row } = item;
    return (
      <div
        data-testid={VIEW_TESTID.tableRow}
        data-note-id={row.noteId}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? -1 : undefined}
        style={dataRowStyle}
        onClick={onOpenNote ? rows.click(row.noteId) : undefined}
        onAuxClick={onOpenNote ? rows.aux(row.noteId) : undefined}
        onContextMenu={onContextMenu ? rows.contextMenu(row.noteId) : undefined}
      >
        <span style={NAME_CELL_STYLE} title={row.title ?? undefined}>
          {row.title ?? t("notes.views.cards.untitled")}
        </span>
        {columns.map((col) => {
          const prop = row.values[col];
          return (
            <span key={col} style={CELL_STYLE}>
              {hasDisplayableValue(prop) ? <PropertyValue prop={prop} /> : null}
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <div data-testid={VIEW_TESTID.table} style={WRAP_STYLE}>
      <VirtualList<TableItem>
        items={items}
        keyOf={(item) => item.key}
        renderItem={renderItem}
        estimatedRowHeight={ROW_ESTIMATED_HEIGHT}
        overflowX="auto"
      />
    </div>
  );
}
