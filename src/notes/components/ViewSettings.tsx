// `<ViewSettings>` — the saved-view settings modal (Saved Views authoring). A
// desktop modal carve-out (ModalShell), peer to `<FilterBuilder>`: where the
// filter builder edits a view's `filters` AST, this edits the render fields the
// schema already carries but no UI exposed — **view type** (cards / table /
// list), **group by**, **sort** (property + direction), **columns** (the table /
// list / card display columns), plus the cards-only cover settings (`image`,
// `image_aspect_ratio`, `card_size`). The renderers already consume all of these;
// this is the missing input surface that makes table / list views user-creatable.
//
// The property pickers (group / sort / columns) enumerate the vault's frontmatter
// key universe (`propertyKeys`, from the `vault_indices_property_keys` accessor)
// so the user chooses from keys that actually exist. Card settings show only for
// a cards view (table / list have no cover concept); their state is preserved
// while hidden so switching type and back keeps the cover config.
//
// Pure / presentational: seeds local draft state from `initial` once (mounted
// fresh per open, like FilterBuilder), and hands the parent a patch on Save.
// Omit-when-default discipline mirrors the Rust `skip_serializing_if = "None"`.
//
// Observability (src/CLAUDE.md "Test observability"): every control carries a
// `view-settings.*` testid so the real-IPC E2E can drive and read it.

import { useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "../../components/primitives/ModalShell";
import { Button } from "../../components/primitives/Button";
import { Input } from "../../components/primitives/Input";
import { Segmented } from "../../components/primitives/Segmented";
import { SearchableSelect } from "../../components/primitives/SearchableSelect";
import type { SelectOption } from "../../components/primitives/Select";
import type { SavedView, SortDirection, ViewType } from "../../lib/prefs";
import {
  DEFAULT_CARD_WIDTH,
  MIN_CARD_WIDTH,
  MAX_CARD_WIDTH,
} from "../views/cardsView";

/** The render fields this modal edits — the subset of `SavedView` beyond the
 *  filter AST, DERIVED from the schema so it tracks it by construction. All
 *  optional: `undefined` means "use the render default". */
export type ViewDisplayPatch = Partial<
  Pick<
    SavedView,
    | "view_type"
    | "group_by"
    | "sort"
    | "columns"
    | "image"
    | "image_aspect_ratio"
    | "card_size"
  >
>;

export interface ViewSettingsProps {
  /** Header title (the view's name). */
  title: string;
  /** Seed values from the view being edited. */
  initial: ViewDisplayPatch;
  /** Every DISTINCT frontmatter property key in the vault (the
   *  `vault_indices_property_keys` universe) — the option set for the group / sort
   *  / column pickers and the cover-image suggestions. */
  propertyKeys: readonly string[];
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
  fontSize: "var(--text-sm)",
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

/** A horizontal control row (sort key + direction; card-size slider + reset). */
const ROW_STYLE: CSSProperties = {
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
/** The "no group / no sort" sentinel for the single-select pickers. */
const NONE = "";

export function ViewSettings({
  title,
  initial,
  propertyKeys,
  onCancel,
  onSave,
}: ViewSettingsProps) {
  const { t } = useTranslation();

  // Option arrays memoized on `t` (stable across control keystrokes so the
  // Segmented / SearchableSelect children aren't re-rendered by fresh identity —
  // consistent with keyOptions / columnOptions below).
  const VIEW_TYPE_OPTIONS = useMemo<readonly { value: string; label: string }[]>(
    () => [
      { value: "cards", label: t("notes.viewSettings.viewTypeCards") },
      { value: "table", label: t("notes.viewSettings.viewTypeTable") },
      { value: "list", label: t("notes.viewSettings.viewTypeList") },
    ],
    [t],
  );
  const DIRECTION_OPTIONS = useMemo<readonly { value: string; label: string }[]>(
    () => [
      { value: "asc", label: t("notes.viewSettings.sortAsc") },
      { value: "desc", label: t("notes.viewSettings.sortDesc") },
    ],
    [t],
  );
  const ASPECT_OPTIONS = useMemo<readonly SelectOption<string>[]>(
    () => [
      { value: ASPECT_DEFAULT, label: t("notes.viewSettings.aspect.default") },
      { value: "1.78", label: t("notes.viewSettings.aspect.wide") },
      { value: "1.5", label: t("notes.viewSettings.aspect.threeTwo") },
      { value: "1.33", label: t("notes.viewSettings.aspect.fourThree") },
      { value: "1", label: t("notes.viewSettings.aspect.square") },
    ],
    [t],
  );
  // Property-key options with a leading "None" for the single-select pickers.
  const keyOptions: readonly SelectOption<string>[] = useMemo(
    () => [
      { value: NONE, label: t("notes.viewSettings.propertyNone") },
      ...propertyKeys.map((k) => ({ value: k, label: k })),
    ],
    [propertyKeys, t],
  );
  const columnOptions: readonly SelectOption<string>[] = useMemo(
    () => propertyKeys.map((k) => ({ value: k, label: k })),
    [propertyKeys],
  );

  const [viewType, setViewType] = useState<string>(initial.view_type ?? "cards");
  const [groupBy, setGroupBy] = useState(initial.group_by ?? NONE);
  const [sortKey, setSortKey] = useState(initial.sort?.key ?? NONE);
  const [sortDir, setSortDir] = useState<string>(initial.sort?.direction ?? "asc");
  const [columns, setColumns] = useState<string[]>(initial.columns ?? []);
  const [image, setImage] = useState(initial.image ?? "");
  const [aspect, setAspect] = useState(initial.image_aspect_ratio ?? ASPECT_DEFAULT);
  const [cardSize, setCardSize] = useState(initial.card_size ?? DEFAULT_CARD_WIDTH);

  // Only show cover suggestions the user hasn't already typed as the current
  // value. Not memoized — `image` changes every keystroke, so a memo buys nothing.
  const suggestions = propertyKeys.filter((p) => p !== image.trim());

  const save = () => {
    const trimmed = image.trim();
    onSave({
      view_type: viewType as ViewType,
      group_by: groupBy === NONE ? undefined : groupBy,
      sort:
        sortKey === NONE
          ? undefined
          : { key: sortKey, direction: sortDir as SortDirection },
      columns: columns.length === 0 ? undefined : columns,
      // Cover fields are preserved even for non-cards views (state is seeded
      // from `initial` and untouched while hidden) so switching type round-trips.
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
      closeLabel={t("notes.viewSettings.cancel")}
    >
      <div data-testid="view-settings.modal" style={BODY_STYLE}>
        {/* View type -------------------------------------------------------- */}
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>{t("notes.viewSettings.viewType")}</span>
          <Segmented
            testId="view-settings.view-type"
            ariaLabel={t("notes.viewSettings.viewType")}
            options={VIEW_TYPE_OPTIONS}
            value={viewType}
            onChange={setViewType}
          />
        </div>

        {/* Group by --------------------------------------------------------- */}
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>{t("notes.viewSettings.groupBy")}</span>
          <SearchableSelect
            testId="view-settings.group-by"
            aria-label={t("notes.viewSettings.groupBy")}
            options={keyOptions}
            selected={[groupBy]}
            onChange={(next) => setGroupBy(next[0] ?? NONE)}
          />
        </div>

        {/* Sort ------------------------------------------------------------- */}
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>{t("notes.viewSettings.sortBy")}</span>
          <div style={ROW_STYLE}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <SearchableSelect
                testId="view-settings.sort-key"
                aria-label={t("notes.viewSettings.sortBy")}
                options={keyOptions}
                selected={[sortKey]}
                onChange={(next) => setSortKey(next[0] ?? NONE)}
              />
            </div>
            {sortKey !== NONE && (
              <Segmented
                testId="view-settings.sort-dir"
                ariaLabel={t("notes.viewSettings.sortDirection")}
                options={DIRECTION_OPTIONS}
                value={sortDir}
                onChange={setSortDir}
              />
            )}
          </div>
        </div>

        {/* Columns ---------------------------------------------------------- */}
        <div style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>{t("notes.viewSettings.columns")}</span>
          <p style={HINT_STYLE}>{t("notes.viewSettings.columnsHint")}</p>
          <SearchableSelect
            testId="view-settings.columns"
            aria-label={t("notes.viewSettings.columns")}
            multiple
            options={columnOptions}
            selected={columns}
            onChange={setColumns}
            placeholder={t("notes.viewSettings.columnsPlaceholder")}
            emptyText={t("notes.viewSettings.columnsEmpty")}
          />
        </div>

        {/* Cover settings — cards only -------------------------------------- */}
        {viewType === "cards" && (
          <>
            <div style={FIELD_STYLE}>
              <label htmlFor="view-settings.image-input" style={LABEL_STYLE}>
                {t("notes.viewSettings.coverImageProperty")}
              </label>
              <p style={HINT_STYLE}>{t("notes.viewSettings.coverImageHint")}</p>
              <Input
                id="view-settings.image-input"
                type="text"
                data-testid="view-settings.image-input"
                value={image}
                placeholder={t("notes.viewSettings.coverImagePlaceholder")}
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

            <div style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>{t("notes.viewSettings.imageAspectRatio")}</span>
              <SearchableSelect
                testId="view-settings.aspect-select"
                aria-label={t("notes.viewSettings.imageAspectRatio")}
                options={ASPECT_OPTIONS}
                selected={[aspect]}
                onChange={(next) => setAspect(next[0] ?? ASPECT_DEFAULT)}
              />
            </div>

            <div style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>{t("notes.viewSettings.cardSize")}</span>
              <div style={ROW_STYLE}>
                <input
                  type="range"
                  data-testid="view-settings.card-size"
                  aria-label={t("notes.viewSettings.cardSize")}
                  min={MIN_CARD_WIDTH}
                  max={MAX_CARD_WIDTH}
                  step={10}
                  value={cardSize}
                  onChange={(e) => setCardSize(Number(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span data-testid="view-settings.card-size-value" style={CARD_SIZE_VALUE_STYLE}>
                  {t("notes.viewSettings.cardSizeValue", { size: cardSize })}
                </span>
                <Button
                  variant="ghost"
                  data-testid="view-settings.card-size-reset"
                  disabled={cardSize === DEFAULT_CARD_WIDTH}
                  onClick={() => setCardSize(DEFAULT_CARD_WIDTH)}
                >
                  {t("notes.viewSettings.reset")}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <div style={FOOTER_STYLE}>
        <Button variant="ghost" data-testid="view-settings.cancel" onClick={onCancel}>
          {t("notes.viewSettings.cancel")}
        </Button>
        <Button variant="primary" data-testid="view-settings.save" onClick={save}>
          {t("notes.viewSettings.save")}
        </Button>
      </div>
    </ModalShell>
  );
}
