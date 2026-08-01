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

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { LanguageSelect } from "./LanguageSelect";
import { Button } from "../primitives/Button";
import { Segmented } from "../primitives/Segmented";
import { Switch } from "../primitives/Switch";
import { PANEL_ROOT_STYLE } from "./panel-styles";
import {
  prefsRead,
  setCustomTheme,
  setShowNoteTimestamps,
  setShowTaskMarker,
  setTheme,
  type ThemeChoice,
} from "../../lib/prefs";
import { applyTheme } from "../../lib/theme";
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
}

export function AppearancePanel({ onOpenGraph }: AppearancePanelProps = {}) {
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

      <SettingRow
        label={t("settings.appearance.themeLabel")}
        helper={t("settings.appearance.themeHelper")}
        error={error}
        control={
          <Segmented
            options={THEMES.map((o) => ({
              value: o.value,
              label: t(o.labelKey),
            }))}
            value={selected}
            onChange={(value) => void choose(value as ThemeOption["value"])}
            ariaLabel={t("settings.appearance.themeLabel")}
            optionAriaLabel={(o) =>
              t("settings.appearance.themeOptionAria", { label: o.label })
            }
            testId="settings.theme"
          />
        }
      />

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
