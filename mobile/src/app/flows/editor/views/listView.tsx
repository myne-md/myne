// Mobile LIST renderer for a saved view (desktop-parity, MYND-278). A dense
// single-line-per-note list grouped into static vertical sections, over the
// SHARED query-engine result + SHARED typed-cell formatter. Plain `.map()` in a
// `ScreenScroll` (mobile does not virtualize). READ-ONLY — tap opens the note.

import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ScreenScroll } from "../../../../components";
import type { SavedView } from "../../../../lib/prefs";
import type { ViewResult } from "@myne/editor/host/notes/queryEngine";
import {
  PropertyValue,
  hasDisplayableValue,
} from "@myne/editor/host/notes/propertyFormat";
import {
  VIEW_TESTID,
  buildViewStream,
  displayColumns,
} from "@myne/editor/host/notes/viewLayout";
import { MobileGroupHeading, MobileViewEmpty } from "./viewChrome";
import type { MobileOpenHandler } from "./MobileViewRenderHost";
import { tappable } from "../../../a11y/tappable";

const HEADING_STYLE: CSSProperties = {
  padding: "16px 20px 6px",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg-3)",
  letterSpacing: "-0.01em",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  padding: "12px 20px",
  borderTop: "1px solid var(--line-1)",
  cursor: "pointer",
};

const TITLE_STYLE: CSSProperties = {
  fontSize: 16,
  color: "var(--fg-1)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const META_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  color: "var(--fg-3)",
};

export function MobileListView({
  def,
  result,
  onOpen,
}: {
  def: SavedView;
  result: ViewResult;
  onOpen: MobileOpenHandler;
}) {
  const { t } = useTranslation();
  const columns = useMemo(() => displayColumns(def), [def]);
  const { stream, total } = useMemo(
    () => buildViewStream(result, t("notes.views.list.noValue")),
    [result, t],
  );

  if (total === 0) {
    return <MobileViewEmpty message={t("notes.views.list.empty")} />;
  }

  return (
    <ScreenScroll>
      <div data-testid={VIEW_TESTID.list}>
        {stream.map((item) => {
          if (item.kind === "heading") {
            return (
              <MobileGroupHeading
                key={item.key}
                label={item.label}
                count={item.count}
                style={HEADING_STYLE}
              />
            );
          }
          const { row } = item;
          const metaCols = columns.filter((c) => hasDisplayableValue(row.values[c]));
          return (
            <div
              key={item.key}
              data-testid={VIEW_TESTID.listRow}
              data-note-id={row.noteId}
              {...tappable({ onActivate: () => onOpen(row.noteId) })}
              style={ROW_STYLE}
            >
              <div style={TITLE_STYLE}>
                {row.title || t("common.untitled")}
              </div>
              {metaCols.length > 0 && (
                <div style={META_STYLE}>
                  {metaCols.map((col) => (
                    <span key={col}>
                      <PropertyValue prop={row.values[col]} />
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ScreenScroll>
  );
}
