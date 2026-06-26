// Settings → Appearance → Custom themes subsection (custom-themes epic,
// MYND-112). Lists user-authored themes from `app_config_dir/themes/`, each with
// a palette-chiplet preview, Apply / Delete (inline two-step confirm), plus
// Import and Open-themes-folder actions. Invalid files still list (greyed, with
// their validation error) rather than vanishing.
//
// Design reference: Penpot "MYNE Design" page "4b - Settings & Vault",
// frame `section------settings--appearance--custom-themes (MYND-112)`. All
// fills/text/borders bind to design tokens (no hardcoded hex except the swatch
// colors, which ARE the theme's own validated values).
//
// Copy discipline (HARD): custom themes are validated locally, NOT sandboxed —
// the helper says "validated on this device", never "safe".

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "../primitives/Button";
import { LABEL_STYLE, HELPER_STYLE, BLOCK_STYLE } from "./panel-styles";
import {
  listCustomThemes,
  readCustomTheme,
  deleteCustomTheme,
  importCustomTheme,
  ensureThemesDir,
  type ThemeInfo,
  type ThemeError,
} from "../../lib/themes";
import { prefsRead, setCustomTheme } from "../../lib/prefs";
import { applyCustomTheme, applyTheme } from "../../lib/theme";
import i18n from "../../i18n";

const ERROR_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  marginTop: "var(--space-3)",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
};

const ROW_ACTIVE_STYLE: CSSProperties = {
  ...ROW_STYLE,
  background: "var(--accent-soft)",
  borderColor: "var(--accent)",
};

const ROW_INVALID_STYLE: CSSProperties = {
  ...ROW_STYLE,
  borderStyle: "dashed",
};

const NAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
  flex: 1,
};

const NAME_INVALID_STYLE: CSSProperties = { ...NAME_STYLE, color: "var(--line-3)" };

const APPLIED_BADGE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  color: "var(--accent)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
};

const ROW_ERROR_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--danger)",
  flex: 1,
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--space-2)",
};

const BUTTON_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "var(--space-2)",
};

const CHIPLET_STYLE: CSSProperties = {
  display: "inline-flex",
  flexDirection: "row",
  width: 40,
  height: 28,
  borderRadius: "var(--radius-1)",
  border: "1px solid var(--line-2)",
  overflow: "hidden",
  flexShrink: 0,
};

const CHIPLET_PLACEHOLDER_STYLE: CSSProperties = {
  ...CHIPLET_STYLE,
  border: "1px dashed var(--line-3)",
};

const EMPTY_STYLE: CSSProperties = {
  ...HELPER_STYLE,
  marginTop: "var(--space-3)",
  fontStyle: "italic",
};

/** Render a 5-swatch palette chiplet from a theme's preview colors. */
function Chiplet({ preview }: { preview: NonNullable<ThemeInfo["preview"]> }) {
  const swatches = [
    preview.background,
    preview.surface,
    preview.foreground,
    preview.accent,
    preview.line,
  ];
  return (
    <span style={CHIPLET_STYLE} aria-hidden="true">
      {swatches.map((color, i) => (
        <span key={i} style={{ flex: 1, background: color }} />
      ))}
    </span>
  );
}

/** Human-readable one-liner for a rich validation error. */
function describeError(error: ThemeError | null): string {
  if (!error) return i18n.t("settings.customThemes.error.invalidFile");
  switch (error.kind) {
    case "MissingKey":
      return i18n
        .t("settings.customThemes.error.missingKey", { key: error.key ?? "" })
        .trim();
    case "InvalidValue": {
      const key = error.key ?? i18n.t("settings.customThemes.error.aColorFallback");
      return error.line != null
        ? i18n.t("settings.customThemes.error.invalidValueWithLine", {
            key,
            line: error.line,
          })
        : i18n.t("settings.customThemes.error.invalidValue", { key });
    }
    case "ParseError":
      return error.line != null
        ? i18n.t("settings.customThemes.error.parseErrorWithLine", {
            line: error.line,
          })
        : i18n.t("settings.customThemes.error.parseError");
    case "InvalidName":
      return i18n.t("settings.customThemes.error.invalidName");
    default:
      return i18n.t("settings.customThemes.error.invalidFile");
  }
}

interface CustomThemesSectionProps {
  /** The active custom-theme name (lifted to AppearancePanel so picking a
   *  built-in theme can clear it). `null` ≡ no custom theme active. */
  activeCustom: string | null;
  onActiveCustomChange: (name: string | null) => void;
}

export function CustomThemesSection({
  activeCustom,
  onActiveCustomChange,
}: CustomThemesSectionProps) {
  // Aliased to `translate` because the theme-list `.map((t) => …)` below binds a
  // loop variable named `t` (a `ThemeInfo`), which would otherwise shadow the
  // translation function inside the row JSX.
  const { t: translate } = useTranslation();
  const [themes, setThemes] = useState<ThemeInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  async function refresh() {
    try {
      setThemes(await listCustomThemes());
    } catch {
      setError(translate("settings.customThemes.readError"));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function apply(name: string) {
    setError(null);
    try {
      const palette = await readCustomTheme(name);
      // Disk-first: persist the selection before flipping the live palette.
      await setCustomTheme(name);
      applyCustomTheme(palette);
      onActiveCustomChange(name);
    } catch {
      setError(translate("settings.customThemes.applyError"));
    }
  }

  async function confirmDelete(name: string) {
    setError(null);
    try {
      await deleteCustomTheme(name);
      if (activeCustom === name) {
        // The active theme was removed — clear the selection and fall back to
        // the built-in theme so the UI isn't left on a now-absent palette.
        await setCustomTheme(null);
        onActiveCustomChange(null);
        try {
          const prefs = await prefsRead();
          applyTheme(prefs.theme);
        } catch {
          applyTheme(null);
        }
      }
      setConfirmingDelete(null);
      await refresh();
    } catch {
      setError(translate("settings.customThemes.deleteError"));
    }
  }

  async function importTheme() {
    setError(null);
    const picked = await openFileDialog({
      multiple: false,
      filters: [
        { name: translate("settings.customThemes.fileFilterName"), extensions: ["json"] },
      ],
    }).catch(() => null);
    if (typeof picked !== "string") return;
    try {
      await importCustomTheme(picked);
      await refresh();
    } catch {
      setError(translate("settings.customThemes.importError"));
    }
  }

  async function openFolder() {
    try {
      const dir = await ensureThemesDir();
      await revealItemInDir(dir);
    } catch {
      setError(translate("settings.customThemes.openFolderError"));
    }
  }

  return (
    <div style={BLOCK_STYLE}>
      <span style={LABEL_STYLE}>{translate("settings.customThemes.label")}</span>
      <p style={HELPER_STYLE}>{translate("settings.customThemes.helper")}</p>

      <div style={{ ...BUTTON_ROW_STYLE, marginTop: "var(--space-3)" }}>
        <Button variant="secondary" onClick={() => void importTheme()} data-testid="settings.custom-theme-import">
          {translate("settings.customThemes.importButton")}
        </Button>
        <Button variant="ghost" onClick={() => void openFolder()} data-testid="settings.custom-theme-open-folder">
          {translate("settings.customThemes.openFolderButton")}
        </Button>
      </div>

      {themes.length === 0 ? (
        <p style={EMPTY_STYLE} data-testid="settings.custom-theme-empty">
          {translate("settings.customThemes.empty")}
        </p>
      ) : (
        <div style={LIST_STYLE}>
          {themes.map((t) => {
            const isActive = t.valid && activeCustom === t.name;
            const rowStyle = !t.valid
              ? ROW_INVALID_STYLE
              : isActive
                ? ROW_ACTIVE_STYLE
                : ROW_STYLE;
            return (
              <div
                key={t.name}
                style={rowStyle}
                data-testid="settings.custom-theme-row"
                data-theme-name={t.name}
                data-active={isActive ? "true" : "false"}
                data-valid={t.valid ? "true" : "false"}
              >
                {t.valid && t.preview ? (
                  <Chiplet preview={t.preview} />
                ) : (
                  <span style={CHIPLET_PLACEHOLDER_STYLE} aria-hidden="true" />
                )}

                {t.valid ? (
                  <span style={NAME_STYLE}>{t.display_name}</span>
                ) : (
                  <span style={NAME_INVALID_STYLE}>{t.display_name}</span>
                )}

                {t.valid && isActive && (
                  <span style={APPLIED_BADGE_STYLE}>
                    {translate("settings.customThemes.appliedBadge")}
                  </span>
                )}

                {!t.valid && (
                  <span style={ROW_ERROR_STYLE} role="alert">
                    {describeError(t.error)}
                  </span>
                )}

                <div style={ACTIONS_STYLE}>
                  {t.valid && !isActive && (
                    <Button
                      variant="secondary"
                      onClick={() => void apply(t.name)}
                      data-testid="settings.custom-theme-apply"
                    >
                      {translate("settings.customThemes.apply")}
                    </Button>
                  )}
                  {confirmingDelete === t.name ? (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => void confirmDelete(t.name)}
                        data-testid="settings.custom-theme-delete-confirm"
                      >
                        {translate("settings.customThemes.confirm")}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setConfirmingDelete(null)}
                        data-testid="settings.custom-theme-delete-cancel"
                      >
                        {translate("settings.customThemes.cancel")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={() => setConfirmingDelete(t.name)}
                      data-testid="settings.custom-theme-delete"
                    >
                      {translate("settings.customThemes.delete")}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <p role="alert" style={ERROR_STYLE}>
          {error}
        </p>
      )}
    </div>
  );
}
