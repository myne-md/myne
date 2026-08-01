// Settings → Editor: editor-typography presets (text size / line spacing /
// content width / font family). Self-contained like its sibling controls
// (SpellSettings / DailyNotesSettings): local state loaded on mount, disk-first
// persist with no in-flight gating. Each setter bumps the prefs nonce, so the
// open editor (its own `usePrefs`) re-reads and re-renders live.
//
// Selecting a field's canonical default clears the stored value to `null` (via
// `toWire`), keeping an explicitly-default vault byte-identical to an untouched
// one. The presets + their CSS mapping are single-homed in `editor/typography.ts`.

import { Fragment, useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  prefsRead,
  setEditorContentWidth,
  setEditorFontFamily,
  setEditorLineSpacing,
  setEditorTextSize,
} from "../../lib/prefs";
import {
  CONTENT_WIDTH_OPTIONS,
  FONT_FAMILY_OPTIONS,
  LINE_SPACING_OPTIONS,
  TEXT_SIZE_OPTIONS,
  TYPOGRAPHY_DEFAULTS,
  contentWidthKey,
  fontFamilyKey,
  lineSpacingKey,
  textSizeKey,
  toWire,
  typographyStyleFromKeys,
  type TypographyOption,
} from "../../editor/typography";
import { Segmented } from "../primitives/Segmented";
import { ERROR_STYLE } from "./panel-styles";
import { SettingRow } from "./SettingRow";

const PREVIEW_WRAP_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const PREVIEW_CAPTION_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

// Mirrors the editor's own paper + rule so the specimen reads as a slice of the
// note surface rather than a settings widget.
const PREVIEW_FRAME_STYLE: CSSProperties = {
  background: "var(--paper-1, var(--bg-1))",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-4)",
  overflow: "hidden",
};

const PREVIEW_TEXT_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--fg-1)",
  fontSize: "var(--editor-text-size)",
  lineHeight: "var(--editor-line-spacing)",
  fontFamily: "var(--editor-font-family)",
};

type FieldKey = "textSize" | "lineSpacing" | "contentWidth" | "fontFamily";

interface RowSpec {
  field: FieldKey;
  testId: string;
  // i18n KEYS, not resolved labels — resolved with `t(...)` at render time so a
  // language switch re-labels the rows (a module-scope resolved string would
  // freeze the boot language).
  labelKey: string;
  helperKey: string;
  options: readonly TypographyOption[];
  def: string;
  persist: (value: string | null) => Promise<void>;
}

const ROWS: readonly RowSpec[] = [
  {
    field: "textSize",
    testId: "settings.editor-text-size",
    labelKey: "settings.typography.textSizeLabel",
    helperKey: "settings.typography.textSizeHelper",
    options: TEXT_SIZE_OPTIONS,
    def: TYPOGRAPHY_DEFAULTS.textSize,
    persist: setEditorTextSize,
  },
  {
    field: "lineSpacing",
    testId: "settings.editor-line-spacing",
    labelKey: "settings.typography.lineSpacingLabel",
    helperKey: "settings.typography.lineSpacingHelper",
    options: LINE_SPACING_OPTIONS,
    def: TYPOGRAPHY_DEFAULTS.lineSpacing,
    persist: setEditorLineSpacing,
  },
  {
    field: "contentWidth",
    testId: "settings.editor-content-width",
    labelKey: "settings.typography.contentWidthLabel",
    helperKey: "settings.typography.contentWidthHelper",
    options: CONTENT_WIDTH_OPTIONS,
    def: TYPOGRAPHY_DEFAULTS.contentWidth,
    persist: setEditorContentWidth,
  },
  {
    field: "fontFamily",
    testId: "settings.editor-font-family",
    labelKey: "settings.typography.fontLabel",
    helperKey: "settings.typography.fontHelper",
    options: FONT_FAMILY_OPTIONS,
    def: TYPOGRAPHY_DEFAULTS.fontFamily,
    persist: setEditorFontFamily,
  },
];

export function TypographySettings() {
  const { t } = useTranslation();
  const [sel, setSel] = useState<Record<FieldKey, string>>({
    textSize: TYPOGRAPHY_DEFAULTS.textSize,
    lineSpacing: TYPOGRAPHY_DEFAULTS.lineSpacing,
    contentWidth: TYPOGRAPHY_DEFAULTS.contentWidth,
    fontFamily: TYPOGRAPHY_DEFAULTS.fontFamily,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        setSel({
          textSize: textSizeKey(p),
          lineSpacing: lineSpacingKey(p),
          contentWidth: contentWidthKey(p),
          fontFamily: fontFamilyKey(p),
        });
      })
      .catch(() => {
        /* locked / no vault — leave defaults */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(row: RowSpec, value: string) {
    if (sel[row.field] === value) return;
    setError(null);
    try {
      // Disk-first: persist before reflecting so a failure never shows a
      // "saved" illusion (the segment + live editor stay put). The setter bumps
      // the prefs nonce, so the open editor re-renders with the new preset.
      await row.persist(toWire(value, row.def));
      setSel((s) => ({ ...s, [row.field]: value }));
    } catch {
      setError(t("settings.typography.errorSave"));
    }
  }

  return (
    <>
      {ROWS.map((row) => {
        const label = t(row.labelKey);
        // Each option's `label` is an i18n KEY (single-homed in
        // `editor/typography.ts`); resolve it here so a language switch
        // re-labels the segments. `value` (the wire/testid tail) is untouched.
        const options = row.options.map((o) => ({ value: o.value, label: t(o.label) }));
        return (
          <Fragment key={row.field}>
            <SettingRow
              label={label}
              helper={t(row.helperKey)}
              control={
                <Segmented
                  options={options}
                  value={sel[row.field]}
                  onChange={(value) => void choose(row, value)}
                  ariaLabel={label}
                  testId={row.testId}
                />
              }
            />
          </Fragment>
        );
      })}
      {/* MYND-624: a live specimen of the four presets above. Typography is the
          setting whose effect is hardest to hold in your head -- "relaxed" line
          spacing and "wide" content width mean nothing until you see them, and
          the editor is behind a modal while you are choosing. Resolved through
          the SAME `typographyStyleFromKeys` the editor uses, so the preview
          cannot claim something the note will not do. */}
      <div style={PREVIEW_WRAP_STYLE} data-testid="settings.typography-preview">
        <span style={PREVIEW_CAPTION_STYLE}>{t("settings.typography.previewLabel")}</span>
        <div style={PREVIEW_FRAME_STYLE}>
          <p style={{ ...typographyStyleFromKeys(sel), ...PREVIEW_TEXT_STYLE }}>
            {t("settings.typography.previewBody")}
          </p>
        </div>
      </div>
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
