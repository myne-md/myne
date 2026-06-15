// `<ViewSettings>` — the saved-view *display* settings modal for cards views
// (Saved Views follow-on). A desktop modal carve-out (ModalShell), peer to
// `<FilterBuilder>`: where the filter builder edits a view's `filters` AST, this
// edits the cards-render fields the schema already carries but no UI exposed —
// `image` (the frontmatter property whose value resolves to the card cover),
// `image_aspect_ratio`, and `card_size`. The cards renderer (`cardsView.tsx`)
// already consumes all three; this is the missing input surface.
//
// Cards-only: the parent gates the open on `view_type === "cards"` (table/list
// renderers are stubs, no cover concept). The cover image itself is NOT chosen
// here — it lives in each note's frontmatter (a property value carrying an
// `attachment://` ref); this picks WHICH property is the cover.
//
// Pure / presentational: seeds local draft state from `initial` once (mounted
// fresh per open, like FilterBuilder), and hands the parent a patch on Save.
// Omit-when-empty discipline mirrors the Rust `skip_serializing_if = "None"`:
// an empty image / "Default" aspect / default card size send `undefined` so the
// persisted view stays clean.
//
// Observability (src/CLAUDE.md "Test observability"): every control carries a
// `view-settings.*` testid so the real-IPC E2E can drive and read it.

import { useMemo, useState, type CSSProperties } from "react";
import { ModalShell } from "../../components/primitives/ModalShell";
import { Button } from "../../components/primitives/Button";
import { Input } from "../../components/primitives/Input";
import { SearchableSelect } from "../../components/primitives/SearchableSelect";
import type { SelectOption } from "../../components/primitives/Select";
import {
  DEFAULT_CARD_WIDTH,
  MIN_CARD_WIDTH,
  MAX_CARD_WIDTH,
} from "../views/cardsView";

/** The display fields this modal edits — the subset of `SavedView` that drives
 *  the cards render. All optional: `undefined` means "use the render default". */
export interface ViewDisplayPatch {
  image?: string;
  image_aspect_ratio?: string;
  card_size?: number;
}

export interface ViewSettingsProps {
  /** Header title (the view's name). */
  title: string;
  /** Seed values from the view being edited. */
  initial: ViewDisplayPatch;
  /** Frontmatter property names present in the view's current result, surfaced
   *  as one-click suggestions for the cover-image property field. Free text is
   *  still allowed (a property no current note carries yet, or an empty view). */
  propertySuggestions: readonly string[];
  /** Dismiss without persisting (Cancel / Esc / backdrop / ×). */
  onCancel: () => void;
  /** Persist the composed patch. The parent merges it onto the view and upserts;
   *  fields left at their default arrive as `undefined` (omitted on the wire). */
  onSave: (patch: ViewDisplayPatch) => void;
}

const BODY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-5)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
};

const FIELD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const LABEL_STYLE: CSSProperties = {
  fontSize: 13,
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
};

const HINT_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
  lineHeight: 1.5,
  margin: 0,
};

const SUGGESTION_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-2)",
};

const CHIP_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-2)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-1)",
  padding: "2px 8px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const CARD_SIZE_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
};

const CARD_SIZE_VALUE_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-2)",
  fontVariantNumeric: "tabular-nums",
  minWidth: 56,
};

const FOOTER_STYLE: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "var(--space-3)",
  padding: "var(--space-4) var(--space-5)",
  borderTop: "1px solid var(--line-1)",
};

// Aspect-ratio presets. The stored value is the FLOAT-STRING the render parses
// (`resolveAspectRatio` in cardsView.tsx); the empty value means "unset" → the
// render falls back to its ≈16:9 default, so we omit the field entirely.
const ASPECT_DEFAULT = "";
const ASPECT_OPTIONS: readonly SelectOption<string>[] = [
  { value: ASPECT_DEFAULT, label: "Default (16:9)" },
  { value: "1.78", label: "16:9 (wide)" },
  { value: "1.5", label: "3:2" },
  { value: "1.33", label: "4:3" },
  { value: "1", label: "1:1 (square)" },
];

export function ViewSettings({
  title,
  initial,
  propertySuggestions,
  onCancel,
  onSave,
}: ViewSettingsProps) {
  const [image, setImage] = useState(initial.image ?? "");
  const [aspect, setAspect] = useState(
    initial.image_aspect_ratio ?? ASPECT_DEFAULT,
  );
  const [cardSize, setCardSize] = useState(
    initial.card_size ?? DEFAULT_CARD_WIDTH,
  );

  // Only show suggestions the user hasn't already typed as the current value.
  const suggestions = useMemo(
    () => propertySuggestions.filter((p) => p !== image.trim()),
    [propertySuggestions, image],
  );

  const save = () => {
    const trimmed = image.trim();
    onSave({
      image: trimmed === "" ? undefined : trimmed,
      image_aspect_ratio: aspect === ASPECT_DEFAULT ? undefined : aspect,
      card_size: cardSize === DEFAULT_CARD_WIDTH ? undefined : cardSize,
    });
  };

  return (
    <ModalShell
      open
      title={title}
      labelId="view-settings-title"
      onClose={onCancel}
      width={480}
      closeLabel="Cancel"
    >
      <div data-testid="view-settings.modal" style={BODY_STYLE}>
        {/* Cover image property -------------------------------------------- */}
        <div style={FIELD_STYLE}>
          <label htmlFor="view-settings.image-input" style={LABEL_STYLE}>
            Cover image property
          </label>
          <p style={HINT_STYLE}>
            The frontmatter property whose value is an image — shown as each
            card's cover. Leave empty for no cover.
          </p>
          <Input
            id="view-settings.image-input"
            type="text"
            data-testid="view-settings.image-input"
            value={image}
            placeholder="e.g. cover"
            onChange={(e) => setImage(e.target.value)}
          />
          {suggestions.length > 0 && (
            <div style={SUGGESTION_ROW_STYLE}>
              {suggestions.map((p) => (
                <button
                  key={p}
                  type="button"
                  data-testid="view-settings.image-suggestion"
                  data-value={p}
                  style={CHIP_STYLE}
                  onClick={() => setImage(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Aspect ratio ----------------------------------------------------- */}
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>Image aspect ratio</span>
          <SearchableSelect
            testId="view-settings.aspect-select"
            aria-label="Image aspect ratio"
            options={ASPECT_OPTIONS}
            selected={[aspect]}
            onChange={(next) => setAspect(next[0] ?? ASPECT_DEFAULT)}
          />
        </div>

        {/* Card size -------------------------------------------------------- */}
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>Card size</span>
          <div style={CARD_SIZE_ROW_STYLE}>
            <input
              type="range"
              data-testid="view-settings.card-size"
              aria-label="Card size"
              min={MIN_CARD_WIDTH}
              max={MAX_CARD_WIDTH}
              step={10}
              value={cardSize}
              onChange={(e) => setCardSize(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span data-testid="view-settings.card-size-value" style={CARD_SIZE_VALUE_STYLE}>
              {cardSize} px
            </span>
            <Button
              variant="ghost"
              data-testid="view-settings.card-size-reset"
              disabled={cardSize === DEFAULT_CARD_WIDTH}
              onClick={() => setCardSize(DEFAULT_CARD_WIDTH)}
            >
              Reset
            </Button>
          </div>
        </div>
      </div>

      <div style={FOOTER_STYLE}>
        <Button variant="ghost" data-testid="view-settings.cancel" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" data-testid="view-settings.save" onClick={save}>
          Save
        </Button>
      </div>
    </ModalShell>
  );
}
