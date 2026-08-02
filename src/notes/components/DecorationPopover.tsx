// `<DecorationPopover>` — anchored color-label picker for a sidebar row
// (MYND-184). Opened from a flat ContextMenu item ("Color…"), so `ContextMenu`
// itself stays lean (no submenu / custom-render row) per its own design note.
//
// Reuses ContextMenu's idiom verbatim: `position: fixed` at the click
// coordinates, a post-paint viewport-edge clamp, and Esc + outside-click
// dismissal. Selecting a swatch applies the color and closes; the "None"
// affordance clears it.
//
// A folder's popover (MYND-185) will grow an icon-grid section below the
// swatches — this component is the single home for that, so the note variant
// (color only) and the folder variant (color + icon) share one surface.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { LABEL_SLOTS, labelSlotName, labelColorVar } from "../decorations";
import { FOLDER_ICON_NAMES } from "../folderIcons";
import { FolderGlyph } from "./FolderGlyph";
import {
  hoverSurface,
  HOVER_TRANSITION,
} from "../../components/primitives/hoverSurface";

const POPOVER_STYLE: CSSProperties = {
  position: "fixed",
  zIndex: 1000,
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: 8,
  padding: 8,
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)",
  fontFamily: "var(--font-sans)",
};

const SECTION_LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: "var(--fg-3)",
  padding: "0 2px 6px",
};

const SWATCH_ROW_STYLE: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
};

const SWATCH_BUTTON_BASE: CSSProperties = {
  width: 24,
  height: 24,
  padding: 0,
  borderRadius: "50%",
  border: "2px solid transparent",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  transition: HOVER_TRANSITION,
};

const ICON_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(6, 28px)",
  gap: 4,
};

const ICON_BUTTON_BASE: CSSProperties = {
  width: 28,
  height: 28,
  padding: 0,
  borderRadius: 6,
  border: "1px solid transparent",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  color: "var(--fg-3)",
  transition: HOVER_TRANSITION,
};

export type DecorationPopoverProps = {
  /** Anchor position in client (viewport) coordinates. */
  x: number;
  y: number;
  /** Currently-assigned color slot, or `null` when the row has no color. */
  color: string | null;
  /** Apply a color slot, or `null` to clear it. The popover closes after. */
  onSelectColor: (slot: string | null) => void;
  /** Folder-icon picker (MYND-185). Present only for a folder; when given, the
   *  popover grows an icon-grid section below the swatches with a "Default"
   *  reset. A note's popover omits this (color only). */
  icon?: {
    /** Currently-assigned glyph name, or `null` for the default folder icon. */
    value: string | null;
    /** Apply a glyph, or `null` to reset to the default. Closes the popover. */
    onSelect: (name: string | null) => void;
  };
  onClose: () => void;
};

export function DecorationPopover({
  x,
  y,
  color,
  onSelectColor,
  icon,
  onClose,
}: DecorationPopoverProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({
    left: x,
    top: y,
  });

  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    let left = x;
    let top = y;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (left + rect.width > vw - 4) left = Math.max(4, vw - rect.width - 4);
    if (top + rect.height > vh - 4) top = Math.max(4, vh - rect.height - 4);
    setPosition({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      const node = ref.current;
      if (node === null) return;
      if (!node.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  const choose = useCallback(
    (slot: string | null) => {
      onSelectColor(slot);
      onClose();
    },
    [onSelectColor, onClose],
  );

  const chooseIcon = useCallback(
    (name: string | null) => {
      icon?.onSelect(name);
      onClose();
    },
    [icon, onClose],
  );

  return (
    <div
      ref={ref}
      style={{ ...POPOVER_STYLE, left: position.left, top: position.top }}
      role="menu"
      aria-label={t("notes.decoration.menuLabel")}
      data-testid="notes.decoration-popover"
    >
      <div style={SECTION_LABEL_STYLE}>{t("notes.decoration.colorSection")}</div>
      <div style={SWATCH_ROW_STYLE}>
        <button
          type="button"
          title={t("notes.decoration.none")}
          aria-label={t("notes.decoration.noColor")}
          aria-pressed={color === null}
          data-color-slot="none"
          {...hoverSurface()}
          style={{
            ...SWATCH_BUTTON_BASE,
            borderColor: color === null ? "var(--accent)" : "var(--line-2)",
          }}
          onClick={() => choose(null)}
        >
          <NoneGlyph />
        </button>
        {LABEL_SLOTS.map((slot) => (
          <button
            key={slot}
            type="button"
            title={labelSlotName(slot)}
            aria-label={labelSlotName(slot)}
            aria-pressed={color === slot}
            data-color-slot={slot}
            {...hoverSurface()}
            style={{
              ...SWATCH_BUTTON_BASE,
              borderColor: color === slot ? "var(--accent)" : "transparent",
            }}
            onClick={() => choose(slot)}
          >
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: labelColorVar(slot),
              }}
            />
          </button>
        ))}
      </div>
      {icon !== undefined && (
        <>
          <div style={{ ...SECTION_LABEL_STYLE, padding: "12px 2px 6px" }}>
            {t("notes.decoration.iconSection")}
          </div>
          <div style={ICON_GRID_STYLE}>
            <button
              type="button"
              title={t("notes.decoration.default")}
              aria-label={t("notes.decoration.defaultFolderIcon")}
              aria-pressed={icon.value === null}
              data-icon-name="default"
              {...hoverSurface()}
              style={{
                ...ICON_BUTTON_BASE,
                borderColor:
                  icon.value === null ? "var(--accent)" : "var(--line-2)",
              }}
              onClick={() => chooseIcon(null)}
            >
              <DefaultFolderGlyph />
            </button>
            {FOLDER_ICON_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                title={name}
                aria-label={name}
                aria-pressed={icon.value === name}
                data-icon-name={name}
                {...hoverSurface()}
                style={{
                  ...ICON_BUTTON_BASE,
                  color: "var(--fg-2)",
                  borderColor:
                    icon.value === name ? "var(--accent)" : "transparent",
                }}
                onClick={() => chooseIcon(name)}
              >
                <FolderGlyph name={name} size={16} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** The default (closed) folder glyph — the "reset to default" affordance. */
function DefaultFolderGlyph() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

/** A hollow circle with a slash — the "no color" affordance. */
function NoneGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--fg-3)"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </svg>
  );
}
