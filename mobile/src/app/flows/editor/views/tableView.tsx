// Mobile TABLE renderer for a saved view (desktop-parity, MYND-277). A
// property-column grid over the SHARED query-engine result + SHARED typed cell
// formatter + SHARED column geometry (`tableGridTemplate`), so it matches the
// desktop table exactly. Narrow-screen behaviour is the user's decision:
// HORIZONTAL SCROLL with a pinned Name column — the vertical scroller is
// `ScreenScroll`, nested inside it a single `overflow-x:auto` box, and the Name
// cell is `position:sticky; left:0`. No virtualization (plain `.map()`).
// READ-ONLY — tap opens the note.

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ScreenScroll } from "../../../../components";
import { useSizeClass } from "../../../../formfactor/SizeClassContext";
import type { SavedView } from "../../../../lib/prefs";
import type { ViewResult, ViewRow } from "@myne/editor/host/notes/queryEngine";
import {
  PropertyValue,
  hasDisplayableValue,
} from "@myne/editor/host/notes/propertyFormat";
import {
  VIEW_TESTID,
  buildViewStream,
  displayColumns,
  tableGridTemplate,
} from "@myne/editor/host/notes/viewLayout";
import { MobileGroupHeading, MobileViewEmpty } from "./viewChrome";
import type { MobileOpenHandler } from "./MobileViewRenderHost";
import { tappable } from "../../../a11y/tappable";

const HEADING_STYLE: CSSProperties = {
  padding: "16px 16px 6px",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg-3)",
};

const CELL_STYLE: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 14,
  color: "var(--fg-1)",
  padding: "10px 0",
};

const NAME_CELL_STYLE: CSSProperties = {
  ...CELL_STYLE,
  position: "sticky",
  insetInlineStart: 0,
  zIndex: 1,
  // Opaque so property cells scroll UNDER the pinned Name column.
  background: "var(--bg-1)",
  paddingInlineEnd: 12,
  fontWeight: 600,
};

const HEADER_CELL_STYLE: CSSProperties = {
  ...CELL_STYLE,
  fontSize: 12,
  fontWeight: 600,
  color: "var(--fg-3)",
};

const HEADER_NAME_CELL_STYLE: CSSProperties = {
  ...NAME_CELL_STYLE,
  zIndex: 2,
  fontSize: 12,
  color: "var(--fg-3)",
};

function gridRowStyle(template: string, minWidth: number): CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: template,
    minWidth,
    alignItems: "center",
    columnGap: 12,
    padding: "0 16px",
    borderTop: "1px solid var(--line-1)",
    background: "var(--bg-1)",
  };
}

export function MobileTableView({
  def,
  result,
  onOpen,
}: {
  def: SavedView;
  result: ViewResult;
  onOpen: MobileOpenHandler;
}) {
  const { t } = useTranslation();
  const { sizeClass } = useSizeClass();
  const columns = useMemo(() => displayColumns(def), [def]);
  // Compact phones get tighter tracks so more of the table is visible before the
  // horizontal scroll kicks in; roomier on tablets. Geometry is otherwise shared
  // with desktop (same `tableGridTemplate`).
  const compact = sizeClass === "compact";
  const { template, minWidth } = useMemo(
    () =>
      tableGridTemplate(
        columns.length,
        compact ? { nameMin: 140, colMin: 108 } : undefined,
      ),
    [columns.length, compact],
  );

  const { stream, total } = useMemo(
    () => buildViewStream(result, t("notes.views.table.noValue")),
    [result, t],
  );

  // Row + header grid styles depend only on the (stable) template — build once.
  const dataRowStyle = useMemo<CSSProperties>(
    () => ({ ...gridRowStyle(template, minWidth), cursor: "pointer" }),
    [template, minWidth],
  );
  const headerRowStyle = useMemo<CSSProperties>(
    () => ({ ...gridRowStyle(template, minWidth), borderTop: "none" }),
    [template, minWidth],
  );

  if (total === 0) {
    return <MobileViewEmpty message={t("notes.views.table.empty")} />;
  }

  const renderRow = (row: ViewRow, key: string): ReactNode => (
    <div
      key={key}
      data-testid={VIEW_TESTID.tableRow}
      data-note-id={row.noteId}
      {...tappable({ onActivate: () => onOpen(row.noteId) })}
      style={dataRowStyle}
    >
      <span style={NAME_CELL_STYLE}>{row.title ?? t("notes.views.cards.untitled")}</span>
      {columns.map((col) => (
        <span key={col} style={CELL_STYLE}>
          {hasDisplayableValue(row.values[col]) ? (
            <PropertyValue prop={row.values[col]} />
          ) : null}
        </span>
      ))}
    </div>
  );

  return (
    <ScreenScroll>
      <div data-testid={VIEW_TESTID.table} style={{ overflowX: "auto" }}>
        <div data-testid={VIEW_TESTID.tableHeader} style={headerRowStyle}>
          <span style={HEADER_NAME_CELL_STYLE}>{t("notes.views.table.name")}</span>
          {columns.map((col) => (
            <span key={col} style={HEADER_CELL_STYLE}>
              {col}
            </span>
          ))}
        </div>
        {stream.map((item) =>
          item.kind === "heading" ? (
            <MobileGroupHeading
              key={item.key}
              label={item.label}
              count={item.count}
              style={HEADING_STYLE}
            />
          ) : (
            renderRow(item.row, item.key)
          ),
        )}
      </div>
    </ScreenScroll>
  );
}
