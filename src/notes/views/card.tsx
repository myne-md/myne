// The one card (myne-md/myne#922 task 3, extracted from `CardsView`).
//
// WHY IT IS ITS OWN MODULE. Two renderers draw the same card: the cards gallery
// and the board. A second implementation would drift on the things a card is
// actually judged by — the cover resolution (an `attachment://` ref, never a
// remote URL), the context menu, the click/keyboard matrix, and the testids an
// E2E scenario locates. So the card lives here, the gallery imports it, and the
// board does too.
//
// The dependency runs ONE WAY: this module imports nothing from a renderer.
// `CardsView` re-exports the shared `viewLayout` helpers its existing importers
// already reach for, and the card contract lives here.
//
// Read-only by construction: no `contenteditable`, no `<input>`, no drag state.
// A view is a projection, and a card's only gesture is opening its note.

import {
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { ViewRow } from "../queryEngine";
import { attachmentUrl } from "../attachmentRef";
import { PropertyValue, hasDisplayableValue } from "./propertyFormat";
import { resolveCoverAttachmentId } from "./viewLayout";
import { Icon } from "../../components/primitives/Icon";

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

/** The testid namespace a card renders under. `view` is the default because a
 *  card is a card whichever renderer mounts it: E2E locates `view.card` on both
 *  surfaces, which is what keeps the gallery and the board from growing two
 *  vocabularies for one element. */
export const DEFAULT_CARD_TESTID_PREFIX = "view";

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

/** The card's inner CONTROL. It carries the column layout the card itself used
 *  to carry, so wrapping the content changed no pixel: the article keeps the
 *  padding, border and background, the wrapper keeps the flow. */
const CARD_CONTENT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

const CARD_IMAGE_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  objectFit: "cover",
  borderRadius: "var(--radius-1)",
  marginBottom: "var(--space-1)",
  background: "var(--paper-3)",
};

const CARD_TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
  lineHeight: 1.35,
};

const CARD_PROP_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-3)",
  lineHeight: 1.45,
};

const COVER_BUTTON_STYLE: CSSProperties = {
  position: "absolute",
  top: "var(--space-2)",
  insetInlineEnd: "var(--space-2)",
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "3px 8px",
  fontFamily: "var(--font-sans)",
  // `--text-xs` is exactly 11px; the padding above has no token at that size.
  fontSize: "var(--text-xs)",
  color: "var(--fg-1)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-1)",
  boxShadow: "var(--shadow-1, 0 1px 4px rgba(0,0,0,0.15))",
  cursor: "pointer",
  zIndex: 1,
};

/** Everything one card needs, and nothing about the renderer that mounted it. */
export interface ViewCardProps {
  /** The row the renderer was handed: the note id, its title and its values. */
  row: ViewRow;
  /** The property keys shown as text, in order (`displayColumns` output). */
  columns: readonly string[];
  /** The frontmatter property carrying the cover, or `undefined` for a view
   *  that declares no cover. Resolution happens HERE so both renderers agree on
   *  what counts as a cover and neither can invent a remote URL. */
  coverProperty?: string;
  /** CSS `aspect-ratio` for the cover, resolved from the view's
   *  `image_aspect_ratio`. */
  coverAspectRatio: string;
  /** Absent → the card is not openable, and therefore not a control. */
  onOpenNote?: OpenNoteHandler;
  /** Absent → no context menu is offered (read-only host). */
  onCardContextMenu?: CardContextMenuHandler;
  /** Absent → no cover affordance is rendered. */
  onSetCover?: SetCoverHandler;
  /** Testid namespace; see {@link DEFAULT_CARD_TESTID_PREFIX}. */
  testIdPrefix?: string;
}

/**
 * One card. A component (not an inline render fn) so each card owns its own
 * reveal state for the "Set cover" affordance, which is shown when the host
 * passes `onSetCover`. Its click stops propagation so it never opens the note.
 * Read-only hosts pass no handler → no affordance, no reveal cost.
 */
export function ViewCard({
  row,
  columns,
  coverProperty,
  coverAspectRatio,
  onOpenNote,
  onCardContextMenu,
  onSetCover,
  testIdPrefix = DEFAULT_CARD_TESTID_PREFIX,
}: ViewCardProps) {
  const { t } = useTranslation();
  // "Revealed" rather than "hovering" (myne-md/myne#728): the Set cover button
  // is the ONLY entry point the affordance has, so gating it on hover alone
  // made setting a cover a mouse-only capability. Focus reveals it too. React's
  // onFocus/onBlur are the delegated focusin/focusout pair, so they fire for
  // the descendant that actually takes focus.
  const [revealed, setRevealed] = useState(false);
  const showCoverButton = onSetCover !== undefined && revealed;
  const interactive = onOpenNote !== undefined;
  const baseStyle = interactive ? CARD_INTERACTIVE_STYLE : CARD_STYLE;
  // Cover via the existing `attachment://` scheme; absent/unresolved → an
  // image-less card (NO cover node, NO placeholder/broken-image glyph).
  const coverId =
    coverProperty !== undefined
      ? resolveCoverAttachmentId(row.values[coverProperty])
      : null;
  const imageStyle: CSSProperties = {
    ...CARD_IMAGE_STYLE,
    aspectRatio: coverAspectRatio,
  };

  // Card navigation — mirrors the NoteRow click matrix exactly. The render
  // stays read-only (no edit affordance); these only OPEN the note.
  const handleClick = (e: ReactMouseEvent) => {
    onOpenNote?.(row.noteId, {
      newTab: e.metaKey || e.ctrlKey,
      toSide: e.altKey,
    });
  };
  const handleAuxClick = (e: ReactMouseEvent) => {
    if (e.button === 1) {
      e.preventDefault(); // middle-click → new tab
      onOpenNote?.(row.noteId, { newTab: true, toSide: false });
    }
  };
  // The keyboard half of that matrix (myne-md/myne#728): a card with
  // `role="button"` and no key handler is a control a keyboard cannot use.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // Space on a focused card would otherwise page the scroller behind it.
    e.preventDefault();
    onOpenNote?.(row.noteId, {
      newTab: e.metaKey || e.ctrlKey,
      toSide: e.altKey,
    });
  };
  const handleContextMenu = (e: ReactMouseEvent) => {
    if (onCardContextMenu === undefined) return;
    e.preventDefault();
    onCardContextMenu(row.noteId, { x: e.clientX, y: e.clientY });
  };

  return (
    // NOT the control, and that is the second answer rather than the first.
    // The card CONTAINS one (the Set cover button), so `role="button"` here
    // makes the pair `nested-interactive` and swallows that button's label
    // into the card's own name. The content block below is the control
    // instead, the same shape the mobile note row uses. The card keeps its
    // click as a mouse convenience, which costs nothing because the real
    // control covers the whole of its content.
    <article
      data-testid={`${testIdPrefix}.card`}
      data-note-id={row.noteId}
      style={
        onSetCover !== undefined ? { ...baseStyle, position: "relative" } : baseStyle
      }
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={onSetCover !== undefined ? () => setRevealed(true) : undefined}
      onMouseLeave={onSetCover !== undefined ? () => setRevealed(false) : undefined}
      onFocus={onSetCover !== undefined ? () => setRevealed(true) : undefined}
      // Hide only when focus leaves the CARD, not when it moves inside it. The
      // Set-cover button is a descendant, so the focusout from the content block
      // into that button bubbles here: an unconditional hide unmounted the
      // button during the very Tab that was reaching it, which made the
      // focus-revealed path (the whole reason it renders after the block) not
      // work by keyboard.
      onBlur={(e) => {
        if (
          onSetCover !== undefined &&
          !e.currentTarget.contains(e.relatedTarget as Node | null)
        ) {
          setRevealed(false);
        }
      }}
    >
      <div
        data-testid={`${testIdPrefix}.card-open`}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={handleKeyDown}
        style={CARD_CONTENT_STYLE}
      >
        {coverId !== null && (
          <img
            data-testid={`${testIdPrefix}.card-image`}
            src={attachmentUrl(coverId)}
            alt=""
            style={imageStyle}
          />
        )}
        <div style={CARD_TITLE_STYLE}>
          {row.title ?? t("common.untitled")}
        </div>
        {columns.map((col) => {
          const prop = row.values[col];
          if (!hasDisplayableValue(prop)) return null; // skip empty
          return (
            <div key={col} style={CARD_PROP_STYLE}>
              <PropertyValue prop={prop} />
            </div>
          );
        })}
      </div>
      {/* AFTER the content block in DOM order, though it paints at the
          card's top-right (myne-md/myne#728, review). It is revealed BY focus
          on that block, so rendering it first put it before the only element
          that can reveal it: forward Tab went straight past to the next card,
          and the control was reachable only by Shift+Tab back into a button
          that had not existed a moment earlier. Visual position is the
          absolute positioning's job; this is the reading order. */}
      {showCoverButton && (
        // A raw <button> on purpose: this is the card's cover chip, painted
        // over the cover region at a fixed 11px, not a standalone control in a
        // row. The `Button` primitive's height and padding would change the
        // card's pixels, and this extraction is a no-pixel refactor (the chip
        // moved here unchanged from the gallery renderer). `scripts/primitive-adoption
        // .mjs` records it, `scripts/check-primitive-adoption.mjs` reads that
        // record.
        <button
          type="button"
          data-testid={`${testIdPrefix}.card-set-cover`}
          style={COVER_BUTTON_STYLE}
          title={
            coverId !== null
              ? t("notes.views.cards.changeCoverImage")
              : t("notes.views.cards.setCoverImage")
          }
          onClick={(e) => {
            e.stopPropagation();
            onSetCover?.(row.noteId);
          }}
        >
          <Icon name="image" size={12} />
          {coverId !== null
            ? t("notes.views.cards.changeCover")
            : t("notes.views.cards.setCover")}
        </button>
      )}
    </article>
  );
}
