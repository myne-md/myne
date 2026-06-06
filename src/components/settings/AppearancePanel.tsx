// Settings → Appearance panel: the Light/Dark/System theme segmented
// control (MYND-110, now live) + the still-disabled Custom theme file
// picker (enables with MYND-112). Disabled-control discipline per
// `decisions.md` 2026-05-08 — real labels, no "Coming soon" copy.
//
// Theme model (MYND-110): the choice persists in the encrypted vault.prefs
// blob (`theme: Option<ThemeChoice>`, None ≡ system). Selecting a segment is
// **disk-first** — `setTheme` persists, then `applyTheme` flips `<html
// data-theme>` — so a write failure never shows a "saved" illusion (the
// segment stays where it was + an error is surfaced). No in-flight gating:
// the write is fast (not Argon2-bound), so the modal's dismiss handlers stay
// live. System maps to `null` (clears the field → the CSS `@media
// prefers-color-scheme` follows the OS live).

import { Fragment, useEffect, useState, type CSSProperties } from "react";
import { Button } from "../primitives/Button";
import { ControlBlock } from "./ControlBlock";
import { PANEL_ROOT_STYLE } from "./panel-styles";
import { prefsRead, setTheme, type ThemeChoice } from "../../lib/prefs";
import { applyTheme } from "../../lib/theme";

const SEGMENTED_STYLE: CSSProperties = {
  display: "inline-flex",
  flexDirection: "row",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  overflow: "hidden",
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
  cursor: "pointer",
  minWidth: 80,
  transition: "background var(--duration-fast) var(--ease-standard)",
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

const ERROR_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

// `value: "system"` maps to a `null` theme on the wire (clears the field).
interface ThemeOption {
  value: "light" | "dark" | "system";
  label: string;
}

const THEMES: readonly ThemeOption[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/** Map the stored `theme` (light | dark | null) to the selected segment. */
function segmentFor(theme: ThemeChoice | null): ThemeOption["value"] {
  return theme ?? "system";
}

/** Map a chosen segment to the wire value (`null` ≡ system). */
function wireValue(value: ThemeOption["value"]): ThemeChoice | null {
  return value === "system" ? null : value;
}

export function AppearancePanel() {
  // Default is "system" — it matches the `None ≡ system` storage default, so a
  // fresh vault (no theme chosen) shows "System" selected, not a misleading
  // "Light". The stored value loads on mount.
  const [selected, setSelected] = useState<ThemeOption["value"]>("system");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((prefs) => {
        if (!cancelled) setSelected(segmentFor(prefs.theme));
      })
      .catch(() => {
        // Keep the "system" default if the read fails — it is the safest
        // (OS-following) baseline and matches a vault with no theme set.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(value: ThemeOption["value"]) {
    if (value === selected) return;
    setError(null);
    const theme = wireValue(value);
    try {
      // Disk-first: persist before applying so a write failure never shows a
      // "saved" illusion (the live theme + segment stay where they were).
      await setTheme(theme);
      setSelected(value);
      applyTheme(theme);
    } catch {
      setError("Couldn't save theme. Please try again.");
    }
  }

  return (
    <div style={PANEL_ROOT_STYLE}>
      <ControlBlock
        label="Theme"
        helper="Switch between light and dark themes, or follow the system preference."
        control={
          <div>
            <div role="radiogroup" aria-label="Theme" style={SEGMENTED_STYLE}>
              {THEMES.map((t, idx) => (
                <Fragment key={t.value}>
                  {idx > 0 && (
                    <span aria-hidden="true" style={SEGMENT_DIVIDER_STYLE} />
                  )}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={t.value === selected}
                    aria-label={`${t.label} theme`}
                    onClick={() => void choose(t.value)}
                    style={
                      t.value === selected
                        ? SEGMENT_SELECTED_STYLE
                        : SEGMENT_BASE_STYLE
                    }
                  >
                    {t.label}
                  </button>
                </Fragment>
              ))}
            </div>
            {error && (
              <p role="alert" style={ERROR_STYLE}>
                {error}
              </p>
            )}
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
