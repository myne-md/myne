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
  type TypographyOption,
} from "../../editor/typography";
import { Segmented } from "../primitives/Segmented";
import { ControlBlock } from "./ControlBlock";

const ERROR_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

type FieldKey = "textSize" | "lineSpacing" | "contentWidth" | "fontFamily";

interface RowSpec {
  field: FieldKey;
  testId: string;
  label: string;
  helper: string;
  options: readonly TypographyOption[];
  def: string;
  persist: (value: string | null) => Promise<void>;
}

const ROWS: readonly RowSpec[] = [
  {
    field: "textSize",
    testId: "settings.editor-text-size",
    label: "Text size",
    helper: "Base size of the editor text. Headings scale with it.",
    options: TEXT_SIZE_OPTIONS,
    def: TYPOGRAPHY_DEFAULTS.textSize,
    persist: setEditorTextSize,
  },
  {
    field: "lineSpacing",
    testId: "settings.editor-line-spacing",
    label: "Line spacing",
    helper: "Vertical space between lines.",
    options: LINE_SPACING_OPTIONS,
    def: TYPOGRAPHY_DEFAULTS.lineSpacing,
    persist: setEditorLineSpacing,
  },
  {
    field: "contentWidth",
    testId: "settings.editor-content-width",
    label: "Content width",
    helper: "Maximum width of the editing column. Full lets text span the pane.",
    options: CONTENT_WIDTH_OPTIONS,
    def: TYPOGRAPHY_DEFAULTS.contentWidth,
    persist: setEditorContentWidth,
  },
  {
    field: "fontFamily",
    testId: "settings.editor-font-family",
    label: "Font",
    helper: "Monospace or proportional (sans-serif) text.",
    options: FONT_FAMILY_OPTIONS,
    def: TYPOGRAPHY_DEFAULTS.fontFamily,
    persist: setEditorFontFamily,
  },
];

export function TypographySettings() {
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
      setError("Couldn't save preference. Please try again.");
    }
  }

  return (
    <>
      {ROWS.map((row) => (
        <Fragment key={row.field}>
          <ControlBlock
            label={row.label}
            helper={row.helper}
            control={
              <Segmented
                options={row.options}
                value={sel[row.field]}
                onChange={(value) => void choose(row, value)}
                ariaLabel={row.label}
                testId={row.testId}
              />
            }
          />
        </Fragment>
      ))}
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
