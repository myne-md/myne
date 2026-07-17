import { useTranslation } from "react-i18next";
import { Sheet } from "../../../../components";
import { LABEL_SLOTS, labelSlotName, labelColorVar } from "@myne/decorations";
import { FOLDER_ICON_NAMES } from "@myne/decorations/folderIcons";
import { FolderGlyph } from "../decorations/FolderGlyph";

/** Bottom-sheet color-label + folder-icon picker (MYND-516) — the mobile twin
 *  of the desktop anchored `DecorationPopover`. A note's sheet shows the 6-swatch
 *  color row + "None"; a folder's sheet adds the 16-glyph icon grid + "Default".
 *  Selecting applies immediately and closes the sheet (each selector runs the
 *  Sheet's animated `close`). "None"/"Default" clears the assignment. */
export function DecorationSheet({
  color,
  onSelectColor,
  icon,
  onClose,
}: {
  /** Currently-assigned color slot, or `null` when the row has no color. */
  color: string | null;
  /** Apply a color slot, or `null` to clear it. The sheet closes after. */
  onSelectColor: (slot: string | null) => void;
  /** Folder-icon picker — present only for a folder. When given, the sheet grows
   *  an icon-grid section with a "Default" reset. A note's sheet omits it. */
  icon?: {
    /** Currently-assigned glyph name, or `null` for the default folder icon. */
    value: string | null;
    /** Apply a glyph, or `null` to reset to the default. Closes the sheet. */
    onSelect: (name: string | null) => void;
  };
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Sheet onClose={onClose}>
      {(close) => {
        const chooseColor = (slot: string | null) => {
          onSelectColor(slot);
          close();
        };
        const chooseIcon = (name: string | null) => {
          icon?.onSelect(name);
          close();
        };
        return (
          <div data-testid="notes.decoration-sheet" role="menu" aria-label={t("notes.decoration.menuLabel")}>
            <div style={SECTION_LABEL_STYLE}>{t("notes.decoration.colorSection")}</div>
            <div style={SWATCH_ROW_STYLE}>
              <button
                type="button"
                aria-label={t("notes.decoration.noColor")}
                aria-pressed={color === null}
                data-testid="notes.decoration-color"
                data-color-slot="none"
                onClick={() => chooseColor(null)}
                style={{ ...SWATCH_BTN, borderColor: color === null ? "var(--accent)" : "var(--line-2)" }}
              >
                <NoneGlyph />
              </button>
              {LABEL_SLOTS.map((slot) => (
                <button
                  key={slot}
                  type="button"
                  aria-label={labelSlotName(slot)}
                  aria-pressed={color === slot}
                  data-testid="notes.decoration-color"
                  data-color-slot={slot}
                  onClick={() => chooseColor(slot)}
                  style={{ ...SWATCH_BTN, borderColor: color === slot ? "var(--accent)" : "transparent" }}
                >
                  <span style={{ width: 22, height: 22, borderRadius: "50%", background: labelColorVar(slot) }} />
                </button>
              ))}
            </div>
            {icon !== undefined && (
              <>
                <div style={{ ...SECTION_LABEL_STYLE, paddingTop: 18 }}>{t("notes.decoration.iconSection")}</div>
                <div style={ICON_GRID_STYLE}>
                  <button
                    type="button"
                    aria-label={t("notes.decoration.defaultFolderIcon")}
                    aria-pressed={icon.value === null}
                    data-testid="notes.decoration-icon"
                    data-icon-name="default"
                    onClick={() => chooseIcon(null)}
                    style={{ ...ICON_BTN, color: "var(--fg-2)", borderColor: icon.value === null ? "var(--accent)" : "var(--line-2)" }}
                  >
                    <DefaultFolderGlyph />
                  </button>
                  {FOLDER_ICON_NAMES.map((name) => (
                    <button
                      key={name}
                      type="button"
                      aria-label={name}
                      aria-pressed={icon.value === name}
                      data-testid="notes.decoration-icon"
                      data-icon-name={name}
                      onClick={() => chooseIcon(name)}
                      style={{ ...ICON_BTN, color: "var(--fg-2)", borderColor: icon.value === name ? "var(--accent)" : "transparent" }}
                    >
                      <FolderGlyph name={name} size={22} />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      }}
    </Sheet>
  );
}

const SECTION_LABEL_STYLE = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg-2)",
  padding: "6px 2px 10px",
} as const;

const SWATCH_ROW_STYLE = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  alignItems: "center",
} as const;

const SWATCH_BTN = {
  width: 40,
  height: 40,
  padding: 0,
  borderRadius: "50%",
  border: "2px solid transparent",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
} as const;

const ICON_GRID_STYLE = {
  display: "grid",
  gridTemplateColumns: "repeat(6, 1fr)",
  gap: 6,
} as const;

const ICON_BTN = {
  width: "100%",
  aspectRatio: "1 / 1",
  padding: 0,
  borderRadius: 10,
  border: "1px solid transparent",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
} as const;

/** The default (closed) folder glyph — the "reset to default" affordance. */
function DefaultFolderGlyph() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

/** A hollow circle with a slash — the "no color" affordance. */
function NoneGlyph() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="var(--fg-3)" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </svg>
  );
}
