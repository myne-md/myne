// Settings → Appearance panel: disabled Theme segmented control
// (Light/Dark/System; enables with MYND-110) + disabled Custom theme
// file picker (enables with MYND-112). Disabled-control discipline
// per `decisions.md` 2026-05-08 — real labels, no "Coming soon" copy.
//
// Penpot canon: `🔴 screen------settings--appearance` (frame id
// `9fb59646-2811-8082-8007-fd3f275e3e1e`).

import { Fragment, type CSSProperties } from "react";
import { Button } from "../primitives/Button";
import { ControlBlock } from "./ControlBlock";
import { PANEL_ROOT_STYLE } from "./panel-styles";

const SEGMENTED_STYLE: CSSProperties = {
  display: "inline-flex",
  flexDirection: "row",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  overflow: "hidden",
  opacity: 0.5,
  alignSelf: "flex-start",
};

const SEGMENT_BASE_STYLE: CSSProperties = {
  border: 0,
  background: "transparent",
  padding: "6px 16px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
  cursor: "not-allowed",
  minWidth: 80,
};

const SEGMENT_SELECTED_STYLE: CSSProperties = {
  ...SEGMENT_BASE_STYLE,
  background: "var(--paper-3)",
  color: "var(--fg-1)",
};

const SEGMENT_DIVIDER_STYLE: CSSProperties = {
  width: 1,
  background: "var(--line-2)",
  alignSelf: "stretch",
};

interface ThemeOption {
  value: "light" | "dark" | "system";
  label: string;
}

const THEMES: readonly ThemeOption[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

// Default selected matches the v0.1 `prefers-color-scheme: light`
// palette baseline; real selection state lands with MYND-110.
const DEFAULT_SELECTED: ThemeOption["value"] = "light";

export function AppearancePanel() {
  return (
    <div style={PANEL_ROOT_STYLE}>
      <ControlBlock
        label="Theme"
        helper="Switch between light and dark themes, or follow the system preference."
        control={
          <div role="radiogroup" aria-label="Theme" style={SEGMENTED_STYLE}>
            {THEMES.map((t, idx) => (
              <Fragment key={t.value}>
                {idx > 0 && (
                  <span aria-hidden="true" style={SEGMENT_DIVIDER_STYLE} />
                )}
                <button
                  type="button"
                  role="radio"
                  aria-checked={t.value === DEFAULT_SELECTED}
                  aria-label={`${t.label} theme (currently unavailable)`}
                  disabled
                  style={
                    t.value === DEFAULT_SELECTED
                      ? SEGMENT_SELECTED_STYLE
                      : SEGMENT_BASE_STYLE
                  }
                >
                  {t.label}
                </button>
              </Fragment>
            ))}
          </div>
        }
      />

      <ControlBlock
        label="Custom theme"
        helper="Load a custom theme from a .css file. Validation runs locally; never uploaded."
        control={
          <div>
            <Button variant="secondary" disabled>
              Choose theme file…
            </Button>
          </div>
        }
      />
    </div>
  );
}
