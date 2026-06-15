// Editor-typography presets → live CSS values.
//
// The four `PrefsView.editor_*` fields are closed enum strings stored as free
// `Option<String>` in `vault.prefs` (the codec does no validation). This module
// is the single client-side authority that:
//   - lists the valid presets (consumed by the Settings → Editor controls),
//   - maps each preset to a concrete CSS value, and
//   - validates a stored value: an unknown / `null` preset falls back to that
//     field's canonical default (the "clamp on read" the spec defers to the
//     client for these non-load-bearing cosmetic fields).
//
// `typographyStyle(prefs)` returns the inline style PaneView applies to the
// editor's content wrapper: three CSS custom properties (which `editor/theme.ts`
// reads via `var(--editor-*)`, inheriting into `.cm-editor`) plus the content
// `maxWidth`. Changing a custom property is instant — no editor remount, no
// CodeMirror reconfiguration.

import type { CSSProperties } from "react";
import type { PrefsView } from "../lib/prefs";

/** A selectable preset: the wire value + its human label for the Settings UI. */
export interface TypographyOption {
  value: string;
  label: string;
}

// Each map's FIRST key is the canonical default — `null`/unknown resolves to it.
// The label strings are the Settings-UI segment captions (load-bearing for E2E
// by `data-value`, not by label).

const TEXT_SIZE: Record<string, string> = {
  sm: "13px",
  md: "14px",
  lg: "16px",
  xl: "18px",
};
const TEXT_SIZE_DEFAULT = "md";
export const TEXT_SIZE_OPTIONS: readonly TypographyOption[] = [
  { value: "sm", label: "Small" },
  { value: "md", label: "Default" },
  { value: "lg", label: "Large" },
  { value: "xl", label: "Extra large" },
];

const LINE_SPACING: Record<string, string> = {
  tight: "1.45",
  normal: "1.7",
  relaxed: "1.95",
};
const LINE_SPACING_DEFAULT = "normal";
export const LINE_SPACING_OPTIONS: readonly TypographyOption[] = [
  { value: "tight", label: "Tight" },
  { value: "normal", label: "Normal" },
  { value: "relaxed", label: "Relaxed" },
];

// `full` ≡ no max-width (text spans the pane minus its padding).
const CONTENT_WIDTH: Record<string, string> = {
  narrow: "560px",
  normal: "680px",
  wide: "820px",
  full: "none",
};
const CONTENT_WIDTH_DEFAULT = "normal";
export const CONTENT_WIDTH_OPTIONS: readonly TypographyOption[] = [
  { value: "narrow", label: "Narrow" },
  { value: "normal", label: "Normal" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
];

const FONT_FAMILY: Record<string, string> = {
  mono: "var(--font-mono)",
  sans: "var(--font-sans)",
};
const FONT_FAMILY_DEFAULT = "mono";
export const FONT_FAMILY_OPTIONS: readonly TypographyOption[] = [
  { value: "mono", label: "Mono" },
  { value: "sans", label: "Sans" },
];

/** Canonical default preset per field — selecting it clears the stored value
 *  back to `null` (omitted on disk), keeping an explicitly-default vault
 *  byte-identical to an untouched one. */
export const TYPOGRAPHY_DEFAULTS = {
  textSize: TEXT_SIZE_DEFAULT,
  lineSpacing: LINE_SPACING_DEFAULT,
  contentWidth: CONTENT_WIDTH_DEFAULT,
  fontFamily: FONT_FAMILY_DEFAULT,
} as const;

/** Map a chosen preset to the wire value: the canonical default clears to
 *  `null` (byte-minimal); any other preset is sent verbatim. */
export const toWire = (value: string, def: string): string | null =>
  value === def ? null : value;

/** Resolve a stored preset to its canonical form (unknown / null → default). */
function resolve(stored: string | null, def: string, valid: Record<string, string>): string {
  return stored !== null && stored in valid ? stored : def;
}

/** The current text-size preset key (defaulted) — used by the Settings control. */
export const textSizeKey = (p: PrefsView): string =>
  resolve(p.editor_text_size, TEXT_SIZE_DEFAULT, TEXT_SIZE);
export const lineSpacingKey = (p: PrefsView): string =>
  resolve(p.editor_line_spacing, LINE_SPACING_DEFAULT, LINE_SPACING);
export const contentWidthKey = (p: PrefsView): string =>
  resolve(p.editor_content_width, CONTENT_WIDTH_DEFAULT, CONTENT_WIDTH);
export const fontFamilyKey = (p: PrefsView): string =>
  resolve(p.editor_font_family, FONT_FAMILY_DEFAULT, FONT_FAMILY);

/** CSS custom properties + `maxWidth` carrying the editor-typography presets,
 *  applied inline to the editor content wrapper (PaneView). Inherits into
 *  `.cm-editor`, which reads the vars via `var(--editor-*)` in `theme.ts`. */
export type TypographyStyle = CSSProperties & Record<`--${string}`, string>;

export function typographyStyle(p: PrefsView): TypographyStyle {
  return {
    "--editor-text-size": TEXT_SIZE[textSizeKey(p)],
    "--editor-line-spacing": LINE_SPACING[lineSpacingKey(p)],
    "--editor-font-family": FONT_FAMILY[fontFamilyKey(p)],
    maxWidth: CONTENT_WIDTH[contentWidthKey(p)],
  };
}
