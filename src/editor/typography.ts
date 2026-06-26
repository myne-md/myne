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

/** A selectable preset: the wire value + the i18n KEY of its Settings-UI label.
 *  `label` is a translation key (not display text) — the consumer resolves it
 *  via `t(label)` at render so a language switch re-labels the segments. */
export interface TypographyOption {
  value: string;
  label: string;
}

// Each map's FIRST key is the canonical default — `null`/unknown resolves to it.
// The `label` strings are i18n KEYS for the Settings-UI segment captions
// (resolved with `t(...)` by the consumer; load-bearing for E2E by `data-value`,
// not by the resolved caption).

const TEXT_SIZE: Record<string, string> = {
  sm: "13px",
  md: "14px",
  lg: "16px",
  xl: "18px",
};
const TEXT_SIZE_DEFAULT = "md";
export const TEXT_SIZE_OPTIONS: readonly TypographyOption[] = [
  { value: "sm", label: "editor.typography.textSize.sm" },
  { value: "md", label: "editor.typography.textSize.md" },
  { value: "lg", label: "editor.typography.textSize.lg" },
  { value: "xl", label: "editor.typography.textSize.xl" },
];

const LINE_SPACING: Record<string, string> = {
  tight: "1.45",
  normal: "1.7",
  relaxed: "1.95",
};
const LINE_SPACING_DEFAULT = "normal";
export const LINE_SPACING_OPTIONS: readonly TypographyOption[] = [
  { value: "tight", label: "editor.typography.lineSpacing.tight" },
  { value: "normal", label: "editor.typography.lineSpacing.normal" },
  { value: "relaxed", label: "editor.typography.lineSpacing.relaxed" },
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
  { value: "narrow", label: "editor.typography.contentWidth.narrow" },
  { value: "normal", label: "editor.typography.contentWidth.normal" },
  { value: "wide", label: "editor.typography.contentWidth.wide" },
  { value: "full", label: "editor.typography.contentWidth.full" },
];

const FONT_FAMILY: Record<string, string> = {
  mono: "var(--font-mono)",
  sans: "var(--font-sans)",
};
const FONT_FAMILY_DEFAULT = "mono";
export const FONT_FAMILY_OPTIONS: readonly TypographyOption[] = [
  { value: "mono", label: "editor.typography.font.mono" },
  { value: "sans", label: "editor.typography.font.sans" },
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
