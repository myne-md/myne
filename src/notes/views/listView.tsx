// `ListView` — the LIST renderer for a saved view (MYND-278, Saved Views #8).
// Slots beside `CardsView`/`TableView` behind the `viewRenderHost` dispatch. Its
// named reuse target is the sidebar `NoteList`/`NoteRow` treatment: a dense
// single-line-per-note list (title primary + the view's columns as an inline
// typed-value detail line), grouped into static vertical sections. Reuses the
// shared group stream (`viewLayout`), the typed cell formatter (`PropertyValue`),
// the virtualizer (`VirtualList`), and the shared row chrome + click matrix
// (`viewChrome`). READ-ONLY projection (SYNC-1) — no edit affordance, never kanban.

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
  type ViewStreamItem,
} from "./viewLayout";
import { ViewEmpty, ViewGroupHeading, makeViewRowHandlers } from "./viewChrome";
import type { CardContextMenuHandler, OpenNoteHandler } from "./card";
import {
  HOVER_TRANSITION,
} from "../../components/primitives/hoverSurface";
import { interactiveSurface } from "../../components/primitives/interactiveSurface";

const ROW_ESTIMATED_HEIGHT = 48;

const WRAP_STYLE: CSSProperties = { height: "100%" };

const LIST_INNER_STYLE: CSSProperties = {
  height: "100%",
  maxWidth: 720,
  margin: "0 auto",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "var(--space-2) var(--space-3)",
  borderBottom: "1px solid var(--line-1)",
};

const TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-1)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const META_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-3)",
  lineHeight: 1.4,
};

export function ListView({
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
  const { stream, total } = useMemo(
    () => buildViewStream(result, t("notes.views.list.noValue")),
    [result, t],
  );

  const interactive = onOpenNote !== undefined;
  const rowStyle = useMemo<CSSProperties>(
    () => ({
      ...ROW_STYLE,
      cursor: interactive ? "pointer" : "default",
      transition: HOVER_TRANSITION,
    }),
    [interactive],
  );
  const rows = makeViewRowHandlers(onOpenNote, onContextMenu);

  if (total === 0) {
    return <ViewEmpty message={t("notes.views.list.empty")} />;
  }

  const renderItem = (item: ViewStreamItem): ReactNode => {
    if (item.kind === "heading") {
      return <ViewGroupHeading label={item.label} count={item.count} />;
    }
    const { row } = item;
    const metaCols = columns.filter((col) => hasDisplayableValue(row.values[col]));
    return (
      <div
        data-testid={VIEW_TESTID.listRow}
        data-note-id={row.noteId}
        role={interactive ? "button" : undefined}
        // A Tab stop, not a `-1` placeholder: see `makeViewRowHandlers`, whose
        // `key` entry is the other half (myne-md/myne#728).
        tabIndex={interactive ? 0 : undefined}
        {...interactiveSurface({ disabled: !interactive })}
        style={rowStyle}
        onClick={onOpenNote ? rows.click(row.noteId) : undefined}
        onKeyDown={onOpenNote ? rows.key(row.noteId) : undefined}
        onAuxClick={onOpenNote ? rows.aux(row.noteId) : undefined}
        onContextMenu={onContextMenu ? rows.contextMenu(row.noteId) : undefined}
      >
        <span style={TITLE_STYLE} title={row.title ?? undefined}>
          {row.title ?? t("common.untitled")}
        </span>
        {metaCols.length > 0 && (
          <span style={META_STYLE}>
            {metaCols.map((col) => (
              <span key={col}>
                <PropertyValue prop={row.values[col]} />
              </span>
            ))}
          </span>
        )}
      </div>
    );
  };

  return (
    <div data-testid={VIEW_TESTID.list} style={WRAP_STYLE}>
      <div style={LIST_INNER_STYLE}>
        <VirtualList<ViewStreamItem>
          items={stream}
          keyOf={(item) => item.key}
          renderItem={renderItem}
          estimatedRowHeight={ROW_ESTIMATED_HEIGHT}
        />
      </div>
    </div>
  );
}
