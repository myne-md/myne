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
// One row here is a POINTER, not a control (MYND-604): the graph's appearance
// and physics settings live in a floating panel inside the graph pane, because
// they are per-device tuning previewed against the canvas they change — adding
// a seventh Settings panel for them was rejected. That leaves a discoverability
// gap ("where do I change how the graph looks?"), and the row closes it by
// naming where the settings are and opening the graph.
//
// Theme model (MYND-110): the choice persists in the encrypted vault.prefs
// blob (`theme: Option<ThemeChoice>`, None ≡ system). Selecting a segment is
// **disk-first** — `setTheme` persists, then `applyTheme` flips `<html
// data-theme>` — so a write failure never shows a "saved" illusion (the
// segment stays where it was + an error is surfaced). No in-flight gating:
// the write is fast (not Argon2-bound), so the modal's dismiss handlers stay
// live. System maps to `null` (clears the field → the CSS `@media
// prefers-color-scheme` follows the OS live).

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { ControlBlock } from "./ControlBlock";
import { LanguageSelect } from "./LanguageSelect";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { hoverSurface, HOVER_TRANSITION } from "../primitives/hoverSurface";
import { Switch } from "../primitives/Switch";
import { ERROR_STYLE, PANEL_ROOT_STYLE } from "./panel-styles";
import {
  prefsRead,
  setCustomTheme,
  setShowNoteTimestamps,
  setShowTaskMarker,
  setTheme,
  type ThemeChoice,
} from "../../lib/prefs";
import { applyTheme } from "../../lib/theme";
import { applyAccent, readAccent, writeAccent } from "../../lib/accentColor";
import { CustomThemesSection } from "./CustomThemesSection";

// `value: "system"` maps to a `null` theme on the wire (clears the field).
// `labelKey` holds the i18n key (resolved at render, not import) so a language
// switch re-labels the segments without freezing the boot language.
interface ThemeOption {
  value: "light" | "dark" | "amoled" | "system";
  labelKey: string;
}

const THEMES: readonly ThemeOption[] = [
  { value: "light", labelKey: "settings.appearance.theme.light" },
  { value: "dark", labelKey: "settings.appearance.theme.dark" },
  { value: "amoled", labelKey: "settings.appearance.theme.amoled" },
  { value: "system", labelKey: "settings.appearance.theme.system" },
];

/** Map the stored `theme` (light | dark | amoled | null) to the selected segment. */
function segmentFor(theme: ThemeChoice | null): ThemeOption["value"] {
  return theme ?? "system";
}

/** Map a chosen segment to the wire value (`null` ≡ system). */
function wireValue(value: ThemeOption["value"]): ThemeChoice | null {
  return value === "system" ? null : value;
}

// ---------------------------------------------------------------------------
// Theme preview cards (MYND-206) — replace the abstract segmented control with
// a miniature of the app painted in each theme's OWN palette, so Light / Dark /
// Amoled / System can be COMPARED at a glance instead of picked blind and
// switched-into to see. It keeps the exact radiogroup contract the `Segmented`
// control had (role, the `settings.theme` group testid, per-card
// `settings.theme-<value>` + `data-value`/`data-active` + `aria-checked`), so
// the E2E prefs scenarios target it unchanged.
//
// The mockup internals are LITERAL hex, mirroring `styles/tokens.css`: each
// card depicts a theme that is NOT the live one, so `var(--paper)` (which
// resolves to the ACTIVE theme) would paint the same picture four times. Change
// a ramp in tokens.css → update the matching entry here.
interface ThemeSwatch {
  paper: string;
  paper2: string;
  line: string;
  ink: string;
  accent: string;
}

const THEME_SWATCHES: Record<"light" | "dark" | "amoled", ThemeSwatch> = {
  light: { paper: "#fbfbfa", paper2: "#f4f4f2", line: "#e3e2dd", ink: "#1a1a17", accent: "#2c4a7a" },
  dark: { paper: "#121210", paper2: "#1a1a17", line: "#2c2b28", ink: "#e8e7df", accent: "#8aa4d0" },
  amoled: { paper: "#000000", paper2: "#000000", line: "#1f1e1c", ink: "#e8e7df", accent: "#8aa4d0" },
};

const CARDS_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  flexWrap: "wrap",
  gap: 10,
};

const THEME_CARD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
  width: 132,
  padding: 7,
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  background: "var(--bg-2)",
  cursor: "pointer",
  textAlign: "start",
  transition:
    "border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)",
};

const CARD_LABEL_STYLE = (selected: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 6,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: selected ? "var(--fg-1)" : "var(--fg-2)",
});

const MOCKUP_HEIGHT = 78;

/** A tiny inked bar — a stand-in for a line of text or a UI element. */
function bar(color: string, opacity: number, width: number | string, height = 4): CSSProperties {
  return { width, height, borderRadius: 2, background: color, opacity, flexShrink: 0 };
}

/** One theme's miniature: sidebar rail + title + two text lines + accent chip. */
function MiniMockup({ s }: { s: ThemeSwatch }) {
  return (
    <div
      aria-hidden="true"
      style={{
        display: "flex",
        flexDirection: "row",
        height: MOCKUP_HEIGHT,
        borderRadius: "var(--radius-2)",
        overflow: "hidden",
        border: `1px solid ${s.line}`,
        background: s.paper,
      }}
    >
      <div
        style={{
          width: 34,
          background: s.paper2,
          borderInlineEnd: `1px solid ${s.line}`,
          padding: 6,
          display: "flex",
          flexDirection: "column",
          gap: 5,
        }}
      >
        <div style={bar(s.ink, 0.4, 20)} />
        <div style={bar(s.ink, 0.24, 16)} />
        <div style={bar(s.ink, 0.24, 18)} />
        <div style={bar(s.accent, 0.9, 14)} />
      </div>
      <div style={{ flex: 1, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={bar(s.ink, 0.75, "60%", 5)} />
        <div style={bar(s.ink, 0.28, "100%")} />
        <div style={bar(s.ink, 0.28, "88%")} />
        <div style={{ ...bar(s.accent, 1, 30, 8), marginTop: 2 }} />
      </div>
    </div>
  );
}

/** The System card: a light half and a dark half, signalling "follows your OS". */
function SystemMockup() {
  const l = THEME_SWATCHES.light;
  const d = THEME_SWATCHES.dark;
  const half = (s: ThemeSwatch, rightBorder?: string): CSSProperties => ({
    flex: 1,
    background: s.paper,
    padding: 7,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    ...(rightBorder !== undefined ? { borderInlineEnd: `1px solid ${rightBorder}` } : {}),
  });
  return (
    <div
      aria-hidden="true"
      style={{
        display: "flex",
        flexDirection: "row",
        height: MOCKUP_HEIGHT,
        borderRadius: "var(--radius-2)",
        overflow: "hidden",
        border: "1px solid var(--line-2)",
      }}
    >
      <div style={half(l, d.line)}>
        <div style={bar(l.ink, 0.75, "72%", 5)} />
        <div style={bar(l.ink, 0.28, "100%")} />
        <div style={{ ...bar(l.accent, 1, 24, 7), marginTop: 2 }} />
      </div>
      <div style={half(d)}>
        <div style={bar(d.ink, 0.8, "72%", 5)} />
        <div style={bar(d.ink, 0.3, "100%")} />
        <div style={{ ...bar(d.accent, 1, 24, 7), marginTop: 2 }} />
      </div>
    </div>
  );
}

interface ThemePreviewCardsProps {
  selected: ThemeOption["value"];
  onChoose: (value: ThemeOption["value"]) => void;
  ariaLabel: string;
  optionAria: (label: string) => string;
  labelFor: (key: string) => string;
}

/** A handful of ready accent hues offered in the picker popover. */
const ACCENT_PRESETS = [
  "#2c4a7a",
  "#3b82f6",
  "#0ea5e9",
  "#14b8a6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#8b5cf6",
  "#6366f1",
] as const;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Accent-color row (device-local, `lib/accentColor.ts`): a full-color swatch
 *  that opens a picker POPOVER (preset hues + a paste-any-hex field), plus an
 *  icon reset that restores the theme's own accent. */
function AccentColorRow({ onDialogOpenChange }: { onDialogOpenChange?: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [accent, setAccent] = useState<string | null>(() => readAccent());
  const [open, setOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // The swatch shows the EFFECTIVE accent — the custom one, or the theme's own
  // `--accent` (read computed) when none is set.
  const effective =
    accent ??
    (getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim() ||
      "#2c4a7a");

  const set = (color: string | null) => {
    writeAccent(color);
    applyAccent(color);
    setAccent(color);
  };

  // Tell the Settings shell a child surface is up, for as long as it is.
  //
  // Without this ONE Escape closes both. The popover's own handler below is on
  // `document` and `SettingsModal`'s is on `window`; neither stops propagation,
  // so a single keypress reaches both and the user loses the Settings modal
  // they were working in along with the picker they meant to dismiss. The
  // shell's guard is `if (childDialogOpenRef.current) return;`, and the flag is
  // raised only through this prop — `SyncPanel` and `AiPanel` already do it.
  // `handleBackdropClick` consults the same flag, so the click-outside path is
  // fixed by the same line.
  useEffect(() => {
    onDialogOpenChange?.(open);
    return () => onDialogOpenChange?.(false);
  }, [open, onDialogOpenChange]);

  // Outside-click / Esc close the popover.
  useEffect(() => {
    if (!open) return;
    setHexDraft(effective);
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const id = window.setTimeout(
      () => document.addEventListener("mousedown", onDown),
      0,
    );
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Accept a pasted/typed hex (with or without the leading '#').
  const commitHex = (raw: string) => {
    const v = raw.trim();
    const hex = v.startsWith("#") ? v : `#${v}`;
    if (HEX_RE.test(hex)) set(hex.toLowerCase());
  };

  return (
    <SettingRow
      anchorId="appearance.accent"
      label={t("settings.appearance.accentLabel")}
      helper={t("settings.appearance.accentHelper")}
      control={
        <div
          ref={ref}
          style={{ position: "relative", display: "flex", alignItems: "center", gap: "var(--space-2)" }}
        >
          {accent !== null && (
            <button
              type="button"
              onClick={() => set(null)}
              aria-label={t("settings.appearance.accentReset")}
              title={t("settings.appearance.accentReset")}
              data-testid="settings.accent-reset"
              {...hoverSurface()}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 26,
                height: 26,
                padding: 0,
                border: 0,
                borderRadius: "var(--radius-1)",
                background: "transparent",
                color: "var(--fg-3)",
                cursor: "pointer",
                transition: HOVER_TRANSITION,
              }}
            >
              <Icon name="rotate-ccw" size={15} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={t("settings.appearance.accentLabel")}
            aria-haspopup="dialog"
            aria-expanded={open}
            data-testid="settings.accent-color"
            style={{
              width: 26,
              height: 26,
              padding: 0,
              border: "1px solid var(--line-2)",
              borderRadius: "50%",
              background: effective,
              cursor: "pointer",
              flexShrink: 0,
            }}
          />
          {open && (
            <div
              role="dialog"
              data-testid="settings.accent-popover"
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                insetInlineEnd: 0,
                zIndex: 1100,
                width: 208,
                padding: "var(--space-3)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-2)",
                background: "var(--bg-1)",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--radius-2)",
                boxShadow: "var(--shadow-2)",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(5, 1fr)",
                  gap: "var(--space-2)",
                }}
              >
                {ACCENT_PRESETS.map((c) => {
                  const selected = effective.toLowerCase() === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      aria-label={c}
                      onClick={() => set(c)}
                      data-testid="settings.accent-preset"
                      style={{
                        width: 24,
                        height: 24,
                        padding: 0,
                        borderRadius: "50%",
                        background: c,
                        border: `2px solid ${selected ? "var(--fg-1)" : "transparent"}`,
                        cursor: "pointer",
                      }}
                    />
                  );
                })}
              </div>
              <input
                type="text"
                value={hexDraft}
                spellCheck={false}
                autoComplete="off"
                placeholder="#2c4a7a"
                aria-label={t("settings.appearance.accentHexAria")}
                data-testid="settings.accent-hex"
                onChange={(e) => {
                  setHexDraft(e.target.value);
                  commitHex(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitHex(hexDraft);
                }}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "var(--space-2)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-sm)",
                  color: "var(--fg-1)",
                  background: "var(--bg-2)",
                  border: "1px solid var(--line-2)",
                  borderRadius: "var(--radius-1)",
                  outline: "none",
                }}
              />
            </div>
          )}
        </div>
      }
    />
  );
}

/** The theme picker: one preview card per theme, a radiogroup like `Segmented`. */
function ThemePreviewCards({
  selected,
  onChoose,
  ariaLabel,
  optionAria,
  labelFor,
}: ThemePreviewCardsProps) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} data-testid="settings.theme" style={CARDS_ROW_STYLE}>
      {THEMES.map((o) => {
        const isSel = o.value === selected;
        const label = labelFor(o.labelKey);
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={isSel}
            aria-label={optionAria(label)}
            data-testid={`settings.theme-${o.value}`}
            data-value={o.value}
            data-active={isSel ? "true" : "false"}
            onClick={() => {
              if (!isSel) onChoose(o.value);
            }}
            onMouseEnter={
              isSel
                ? undefined
                : (e) => {
                    e.currentTarget.style.borderColor = "var(--line-3)";
                  }
            }
            onMouseLeave={
              isSel
                ? undefined
                : (e) => {
                    e.currentTarget.style.borderColor = "var(--line-2)";
                  }
            }
            style={{
              ...THEME_CARD_STYLE,
              borderColor: isSel ? "var(--accent)" : "var(--line-2)",
              boxShadow: isSel ? "0 0 0 1px var(--accent)" : "none",
            }}
          >
            {o.value === "system" ? <SystemMockup /> : <MiniMockup s={THEME_SWATCHES[o.value]} />}
            <span style={CARD_LABEL_STYLE(isSel)}>
              {label}
              {isSel && (
                <span style={{ color: "var(--accent)", display: "inline-flex" }}>
                  <Icon name="check" size={13} />
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface AppearancePanelProps {
  /**
   * Open the graph tab (MYND-604 task 9). The graph's own appearance and
   * physics controls live in a panel inside the graph pane, not in Settings —
   * deliberately, so the 6-panel taxonomy stays as it is. This row is the
   * pointer that closes the discoverability gap that decision creates.
   * Absent → the control is disabled, the same defensive degrade StoragePanel's
   * rows use (Settings only opens from the unlocked editor, so in practice it
   * is always supplied).
   */
  onOpenGraph?: () => void;
  /**
   * Raised while this panel has a child surface on screen — today the accent
   * picker popover. The Settings shell stands its own Escape and backdrop
   * handlers down while it is true, so one Escape dismisses the child and the
   * next one dismisses Settings. Same contract as `SyncPanel` and `AiPanel`.
   */
  onDialogOpenChange?: (open: boolean) => void;
}

export function AppearancePanel({ onOpenGraph, onDialogOpenChange }: AppearancePanelProps = {}) {
  const { t } = useTranslation();
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
  // MYND-613 — note-task marker visibility. Defaults `true`, matching the
  // pref's own omit-when-default polarity.
  const [showTaskMarkerState, setShowTaskMarkerState] = useState(true);
  const [markerError, setMarkerError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((prefs) => {
        if (!cancelled) {
          setSelected(segmentFor(prefs.theme));
          setShowTimestamps(prefs.show_note_timestamps);
          setShowTaskMarkerState(prefs.show_task_marker);
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
      setError(t("settings.appearance.themeSaveError"));
    }
  }

  async function toggleTaskMarker(next: boolean) {
    setMarkerError(null);
    // Optimistic like the timestamps toggle: flip immediately, persist, and
    // revert on failure so the switch never shows a "saved" illusion. The setter
    // bumps the prefs nonce, so the sidebar and the tab strip (each their own
    // `usePrefs` instance) reflect it live.
    setShowTaskMarkerState(next);
    try {
      await setShowTaskMarker(next);
    } catch {
      setShowTaskMarkerState(!next);
      setMarkerError(t("settings.appearance.taskMarkerSaveError"));
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
      setTsError(t("settings.appearance.timestampsSaveError"));
    }
  }

  return (
    <div style={PANEL_ROOT_STYLE}>
      <LanguageSelect />

      <ControlBlock
        anchorId="appearance.theme"
        label={t("settings.appearance.themeLabel")}
        helper={t("settings.appearance.themeHelper")}
        control={
          <>
            <ThemePreviewCards
              selected={selected}
              onChoose={(value) => void choose(value)}
              ariaLabel={t("settings.appearance.themeLabel")}
              optionAria={(label) =>
                t("settings.appearance.themeOptionAria", { label })
              }
              labelFor={(key) => t(key)}
            />
            {error != null && error !== "" && (
              <p role="alert" style={ERROR_STYLE}>
                {error}
              </p>
            )}
          </>
        }
      />

      <AccentColorRow onDialogOpenChange={onDialogOpenChange} />

      <SettingRow
        label={t("settings.appearance.showEditTimesLabel")}
        helper={t("settings.appearance.showEditTimesHelper")}
        error={tsError}
        control={(helperId) => (
          <Switch
            checked={showTimestamps}
            onChange={(next) => void toggleTimestamps(next)}
            ariaLabel={t("settings.appearance.showEditTimesAria")}
            ariaDescribedBy={helperId}
            testId="settings.note-timestamps-toggle"
          />
        )}
      />

      <SettingRow
        label={t("settings.appearance.taskMarkerLabel")}
        helper={t("settings.appearance.taskMarkerHelper")}
        error={markerError}
        control={(helperId) => (
          <Switch
            checked={showTaskMarkerState}
            onChange={(next) => void toggleTaskMarker(next)}
            ariaLabel={t("settings.appearance.taskMarkerAria")}
            ariaDescribedBy={helperId}
            testId="settings.task-marker-toggle"
          />
        )}
      />

      <SettingRow
        label={t("settings.appearance.graphSettingsLabel")}
        helper={t("settings.appearance.graphSettingsHelper")}
        control={
          <Button
            variant="secondary"
            onClick={onOpenGraph}
            disabled={onOpenGraph === undefined}
            data-testid="settings.open-graph"
          >
            {t("settings.appearance.openGraph")}
          </Button>
        }
      />

      <CustomThemesSection
        activeCustom={activeCustom}
        onActiveCustomChange={setActiveCustom}
      />
    </div>
  );
}
