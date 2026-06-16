// Settings → Appearance panel: the Light/Dark/System theme segmented
// control (MYND-110, now live) + the still-disabled Custom theme file
// picker (enables with MYND-112). Disabled-control discipline per
// `decisions.md` 2026-05-08 — real labels, no "Coming soon" copy.
//
// Scope: purely VISUAL controls. The non-visual editor-behaviour controls
// (spell-check, daily-notes) that previously lived here moved to the new
// Editor panel (`EditorPanel.tsx`) — see the taxonomy entry in
// `design-notes.md` superseding the 2026-05-08 5-panel lock.
//
// Theme model (MYND-110): the choice persists in the encrypted vault.prefs
// blob (`theme: Option<ThemeChoice>`, None ≡ system). Selecting a segment is
// **disk-first** — `setTheme` persists, then `applyTheme` flips `<html
// data-theme>` — so a write failure never shows a "saved" illusion (the
// segment stays where it was + an error is surfaced). No in-flight gating:
// the write is fast (not Argon2-bound), so the modal's dismiss handlers stay
// live. System maps to `null` (clears the field → the CSS `@media
// prefers-color-scheme` follows the OS live).

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ControlBlock } from "./ControlBlock";
import { Switch } from "../primitives/Switch";
import { BLOCK_STYLE, HELPER_STYLE, LABEL_STYLE, PANEL_ROOT_STYLE } from "./panel-styles";
import {
  prefsRead,
  setCustomTheme,
  setShowNoteTimestamps,
  setTheme,
  type ThemeChoice,
} from "../../lib/prefs";
import { applyTheme } from "../../lib/theme";
import { CustomThemesSection } from "./CustomThemesSection";

// Label + switch on one row, helper below — mirrors PrivacyPanel's toggle shape.
const TOGGLE_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

const SEGMENTED_STYLE: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  flexDirection: "row",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  overflow: "hidden",
  alignSelf: "flex-start",
};

// The selection fill is a single sliding pill behind the segments — it
// translates/resizes to the active segment instead of each segment toggling its
// own background, so the selection appears to glide between options. Dividers
// and labels sit above it (higher z-index) so they stay crisp as it passes.
const SEGMENT_THUMB_STYLE: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  left: 0,
  background: "var(--paper-3)",
  zIndex: 0,
  pointerEvents: "none",
  transition:
    "transform var(--duration-base) var(--ease-standard), width var(--duration-base) var(--ease-standard)",
};

const SEGMENT_BASE_STYLE: CSSProperties = {
  position: "relative",
  zIndex: 1,
  border: 0,
  background: "transparent",
  padding: "6px 16px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
  cursor: "pointer",
  minWidth: 80,
  transition: "color var(--duration-fast) var(--ease-standard)",
};

const SEGMENT_SELECTED_STYLE: CSSProperties = {
  ...SEGMENT_BASE_STYLE,
  color: "var(--fg-1)",
};

const SEGMENT_DIVIDER_STYLE: CSSProperties = {
  position: "relative",
  zIndex: 1,
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
  value: "light" | "dark" | "amoled" | "system";
  label: string;
}

const THEMES: readonly ThemeOption[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "amoled", label: "AMOLED" },
  { value: "system", label: "System" },
];

/** Map the stored `theme` (light | dark | amoled | null) to the selected segment. */
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
  // The active custom-theme name (null ≡ none). Lifted here so picking a
  // built-in theme below clears it, and the Custom themes subsection can mark
  // the matching row "Applied". custom_theme takes precedence over `theme`.
  const [activeCustom, setActiveCustom] = useState<string | null>(null);
  // Sidebar per-note timestamp visibility (sidebar-note-timestamps). Default
  // `true` (visible) until the stored value loads — matches PrefsView::default.
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [tsError, setTsError] = useState<string | null>(null);

  // Sliding-pill geometry: measured from the active segment's box so the fill
  // can glide to it (segments have unequal widths — "System" is wider than
  // "Light"). Measured in useLayoutEffect (pre-paint) so the initial position
  // lands with no first-render flash; re-measured whenever the selection moves.
  const segmentRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [thumb, setThumb] = useState<{ left: number; width: number }>({
    left: 0,
    width: 0,
  });

  useLayoutEffect(() => {
    const el = segmentRefs.current[THEMES.findIndex((t) => t.value === selected)];
    if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
  }, [selected]);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((prefs) => {
        if (!cancelled) {
          setSelected(segmentFor(prefs.theme));
          setShowTimestamps(prefs.show_note_timestamps);
          setActiveCustom(prefs.custom_theme);
        }
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
      // Picking a built-in theme turns OFF any active custom theme — clear the
      // selection so it doesn't keep overriding (custom_theme has precedence).
      await setCustomTheme(null);
      setSelected(value);
      setActiveCustom(null);
      applyTheme(theme); // also clears any applied custom CSS vars
    } catch {
      setError("Couldn't save theme. Please try again.");
    }
  }

  async function toggleTimestamps(next: boolean) {
    setTsError(null);
    // Optimistic: flip the switch immediately, then persist. The setter bumps
    // the prefs nonce so the sidebar (its own usePrefs instance) reflects this
    // live. On failure, revert so the switch doesn't show a "saved" illusion.
    setShowTimestamps(next);
    try {
      await setShowNoteTimestamps(next);
    } catch {
      setShowTimestamps(!next);
      setTsError("Couldn't save preference. Please try again.");
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
              <span
                aria-hidden="true"
                style={{
                  ...SEGMENT_THUMB_STYLE,
                  width: thumb.width,
                  transform: `translateX(${thumb.left}px)`,
                }}
              />
              {THEMES.map((t, idx) => (
                <Fragment key={t.value}>
                  {idx > 0 && (
                    <span aria-hidden="true" style={SEGMENT_DIVIDER_STYLE} />
                  )}
                  <button
                    ref={(el) => {
                      segmentRefs.current[idx] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={t.value === selected}
                    aria-label={`${t.label} theme`}
                    data-testid={`settings.theme-${t.value}`}
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

      <div style={BLOCK_STYLE}>
        <div style={TOGGLE_ROW_STYLE}>
          <span style={LABEL_STYLE}>Show edit times</span>
          <Switch
            checked={showTimestamps}
            onChange={(next) => void toggleTimestamps(next)}
            ariaLabel="Show edit times in sidebar"
            ariaDescribedBy="note-timestamps-helper"
            testId="settings.note-timestamps-toggle"
          />
        </div>
        <p id="note-timestamps-helper" style={HELPER_STYLE}>
          Display each note's last-edited time beneath its title in the sidebar.
        </p>
        {tsError && (
          <p role="alert" style={ERROR_STYLE}>
            {tsError}
          </p>
        )}
      </div>

      <CustomThemesSection
        activeCustom={activeCustom}
        onActiveCustomChange={setActiveCustom}
      />
    </div>
  );
}
