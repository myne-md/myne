// Mobile CARDS renderer for a saved view (desktop-parity, MYND-275). A calm
// grouped card stack over the SHARED query-engine result + SHARED typed-cell
// formatter. Single-column stack (phone-first). READ-ONLY — tap opens the note.
//
// Cover: when `def.image` resolves to an attachment, the card paints it via the
// shared `attachment://` scheme (registered on mobile); otherwise an image-less
// card of title + typed property rows.

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
  buildViewStream,
  displayColumns,
  resolveCoverAttachmentId,
} from "@myne/editor/host/notes/viewLayout";
import { attachmentUrl } from "@myne/editor/host/notes/attachmentRef";
import { MobileGroupHeading, MobileViewEmpty } from "./viewChrome";
import type { MobileOpenHandler } from "./MobileViewRenderHost";
import { tappable } from "../../../a11y/tappable";

const HEADING_STYLE: CSSProperties = {
  padding: "16px 20px 8px",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg-3)",
};

const CARD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  margin: "0 16px 10px",
  padding: "14px 16px",
  borderRadius: 14,
  border: "1px solid var(--line-1)",
  background: "var(--bg-1)",
  cursor: "pointer",
};

const CARD_IMAGE_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  aspectRatio: "16 / 9",
  objectFit: "cover",
  borderRadius: 10,
  marginBottom: 4,
  background: "var(--line-1)",
};

const TITLE_STYLE: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "var(--fg-1)",
  lineHeight: 1.3,
};

const PROP_STYLE: CSSProperties = {
  fontSize: 13,
  color: "var(--fg-3)",
  lineHeight: 1.4,
};

export function MobileCardsView({
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
    () => buildViewStream(result, t("notes.views.cards.noValue")),
    [result, t],
  );

  if (total === 0) {
    return <MobileViewEmpty message={t("notes.views.cards.empty")} />;
  }

  return (
    <ScreenScroll>
      <div data-testid="view.cards">
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
          // Cover via the existing `attachment://` scheme (registered on mobile);
          // absent/unresolved → an image-less card (no placeholder glyph).
          const coverId =
            def.image !== undefined
              ? resolveCoverAttachmentId(row.values[def.image])
              : null;
          return (
            <div
              key={item.key}
              data-testid="view.card"
              data-note-id={row.noteId}
              {...tappable({ onActivate: () => onOpen(row.noteId) })}
              style={CARD_STYLE}
            >
              {coverId !== null && (
                <img
                  data-testid="view.card-image"
                  src={attachmentUrl(coverId)}
                  alt=""
                  style={CARD_IMAGE_STYLE}
                />
              )}
              <div style={TITLE_STYLE}>
                {row.title ?? t("notes.views.cards.untitled")}
              </div>
              {columns.map((col) =>
                hasDisplayableValue(row.values[col]) ? (
                  <div key={col} style={PROP_STYLE}>
                    <PropertyValue prop={row.values[col]} />
                  </div>
                ) : null,
              )}
            </div>
          );
        })}
      </div>
    </ScreenScroll>
  );
}
