// Settings → Appearance → Custom themes subsection (custom-themes epic,
// MYND-112; promoted to vault content by MYND-486). Lists the user's custom
// themes from the encrypted `vault.themes` (`MYT1`) store, each with a
// palette-chiplet preview, Apply / Export / Delete (inline two-step confirm),
// plus an Import action. Every stored theme is valid (import validates through
// the shared value-shape allowlist before sealing), so there are no greyed
// invalid rows.
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
import { openUrl } from "../../platform/opener";
import { pickFiles, readPickedSmallText } from "../../platform/filePicker";
import type { PickedFile } from "@myne/editor";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { ThemeChiplet } from "../primitives/ThemeChiplet";
import { BLOCK_STYLE, ERROR_STYLE, HELPER_STYLE, LABEL_STYLE } from "./panel-styles";
import {
  listCustomThemes,
  readCustomTheme,
  exportCustomTheme,
  importCustomTheme,
  deleteCustomTheme,
  themePreview,
  type ThemePreview,
} from "../../lib/themes";
import { prefsRead, setCustomTheme } from "../../lib/prefs";
import { applyCustomTheme, applyTheme } from "../../lib/theme";
import { describeImportError } from "../../lib/theme-errors";
import { saveJsonAsFile } from "../../lib/secret-export";
import { exportedBasename } from "../../notes/exportFlow";

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
  // MYND-595 / MYND-623: the delete-confirm state swaps one ghost button for
  // two, and with a long theme name the row ran out of width and pushed Cancel
  // outside its own border -- an unreachable escape from a destructive prompt.
  // Wrapping keeps both choices inside the row at any name length.
  flexWrap: "wrap",
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

const NAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
  flex: 1,
};

const APPLIED_BADGE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  color: "var(--accent)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--space-2)",
};

const EMPTY_STYLE: CSSProperties = {
  ...HELPER_STYLE,
  marginTop: "var(--space-3)",
  fontStyle: "italic",
};

/** One custom-theme list row: name + the 5-swatch preview derived from its
 *  palette. Every stored theme is valid, so there is no invalid-row state. */
interface ThemeRow {
  name: string;
  preview: ThemePreview;
}

/** The imported theme's name: the picked file's base name minus a trailing
 *  `.json`. `exportedBasename` is the shared separator scanner (POSIX `/` and
 *  Windows `\`), so this file does not re-roll one.
 *
 *  Takes the seam's `PickedFile` rather than a path (#262): a browser handle
 *  carries a `name` and no path at all, so a path-only signature is what forced
 *  this surface to reach for the native dialog in the first place. */
function themeNameFromPickedFile(file: PickedFile): string {
  // `name` is the one field BOTH platforms carry: a browser handle has no path
  // at all, and a desktop handle's name is already the base name.
  return exportedBasename(file.name).replace(/\.json$/i, "");
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
  const { t: translate } = useTranslation();
  const [rows, setRows] = useState<ThemeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  async function refresh() {
    try {
      // ONE decrypt of `vault.themes` yields every live theme's palette, so the
      // chiplet previews derive from what the list already returned — no
      // per-name read-back.
      const entries = await listCustomThemes();
      const loaded = entries.map(
        ({ name, palette }): ThemeRow => ({ name, preview: themePreview(palette) }),
      );
      // The host hands these back in `BTreeMap` order — UTF-8 byte order, which
      // sorts "Şafak" after "Zed". Theme names are user-authored, so the list
      // collates in the reader's locale, not the store's byte order.
      loaded.sort((a, b) => a.name.localeCompare(b.name));
      setRows(loaded);
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

  async function exportTheme(name: string) {
    setError(null);
    try {
      const palette = await exportCustomTheme(name);
      const json = `${JSON.stringify(palette, null, 2)}\n`;
      await saveJsonAsFile(
        `${name}.json`,
        json,
        translate("settings.customThemes.fileFilterName"),
      );
    } catch {
      setError(translate("settings.customThemes.exportError"));
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
    // #262: through the picker SEAM, like the export twin below. This used to
    // call `dialog.open` directly — a typed refusal in the browser — so a user
    // on web who picked a perfectly valid theme file was told it was not a
    // valid theme. The seam's desktop arm is the same native dialog it always
    // was; its web arm is an `<input type=file>`.
    const picked = await pickFiles({
      extensions: ["json"],
      filterLabel: translate("settings.customThemes.fileFilterName"),
    }).catch(() => null);
    const file = picked?.[0];
    if (file === undefined) return;
    const name = themeNameFromPickedFile(file);
    try {
      const paletteJson = await readPickedSmallText(file);
      await importCustomTheme(name, paletteJson);
      await refresh();
    } catch (e) {
      setError(describeImportError(e, "settings.customThemes.importError"));
    }
  }

  return (
    <div
      style={BLOCK_STYLE}
      data-setting-anchor="appearance.custom-themes"
      data-setting-row="true"
    >
      {/* Title left, Import aligned to the right (like a setting-row control). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-3)",
        }}
      >
        <span style={LABEL_STYLE}>{translate("settings.customThemes.label")}</span>
        <Button
          variant="secondary"
          onClick={() => void importTheme()}
          data-testid="settings.custom-theme-import"
        >
          {translate("settings.customThemes.importButton")}
        </Button>
      </div>
      <p style={HELPER_STYLE}>{translate("settings.customThemes.helper")}</p>

      {rows.length === 0 ? (
        <div
          data-testid="settings.custom-theme-empty"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-6) var(--space-3)",
            textAlign: "center",
          }}
        >
          <span aria-hidden="true" style={{ display: "flex", color: "var(--fg-3)" }}>
            <Icon name="palette" size={30} />
          </span>
          <p style={{ ...EMPTY_STYLE, margin: 0 }}>
            {translate("settings.customThemes.empty")}
          </p>
          <Button
            variant="ghost"
            icon="globe"
            style={{ color: "var(--accent)" }}
            onClick={() => void openUrl("https://myne.md/themes/")}
            data-testid="settings.custom-theme-browse"
          >
            {translate("settings.customThemes.browseButton")}
          </Button>
        </div>
      ) : (
        <div style={LIST_STYLE}>
          {rows.map((row) => {
            const isActive = activeCustom === row.name;
            return (
              <div
                key={row.name}
                style={isActive ? ROW_ACTIVE_STYLE : ROW_STYLE}
                data-testid="settings.custom-theme-row"
                data-theme-name={row.name}
                data-active={isActive ? "true" : "false"}
              >
                <ThemeChiplet preview={row.preview} />
                <span style={NAME_STYLE}>{row.name}</span>

                {isActive && (
                  <span style={APPLIED_BADGE_STYLE}>
                    {translate("settings.customThemes.appliedBadge")}
                  </span>
                )}

                <div style={ACTIONS_STYLE}>
                  {!isActive && (
                    <Button
                      variant="secondary"
                      onClick={() => void apply(row.name)}
                      data-testid="settings.custom-theme-apply"
                    >
                      {translate("settings.customThemes.apply")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => void exportTheme(row.name)}
                    data-testid="settings.custom-theme-export"
                  >
                    {translate("settings.customThemes.export")}
                  </Button>
                  {confirmingDelete === row.name ? (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => void confirmDelete(row.name)}
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
                      onClick={() => setConfirmingDelete(row.name)}
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
