// Custom-theme failure messages — the ONE `ThemeError → user-facing string` map.
//
// Extracted from `CustomThemesSection` (MYND-567) once the deep-link install
// dialog needed the same mapping. A theme rejected by a deep link and one
// rejected by a hand-picked file fail for exactly the same reasons and must say
// exactly the same thing, so a second copy would only be a way for the two to
// drift — and would let a new `ThemeErrorKind` be handled in one surface while
// the other silently degraded to "invalid file".
//
// Lives here rather than in `src/lib/themes.ts` because that module is the IPC
// wrapper layer and carries no i18n import.

import i18n from "../i18n";
import type { ThemeError, ThemesError } from "./themes";

/**
 * A one-liner for a rich validation failure, pointing at the offending token
 * where the host told us which one it was.
 */
export function describeThemeError(error: ThemeError): string {
  switch (error.kind) {
    case "MissingKey":
      return i18n.t("settings.customThemes.error.missingKey", { key: error.key ?? "" }).trim();
    case "InvalidValue": {
      const key = error.key ?? i18n.t("settings.customThemes.error.aColorFallback");
      return error.line != null
        ? i18n.t("settings.customThemes.error.invalidValueWithLine", { key, line: error.line })
        : i18n.t("settings.customThemes.error.invalidValue", { key });
    }
    case "ParseError":
      return error.line != null
        ? i18n.t("settings.customThemes.error.parseErrorWithLine", { line: error.line })
        : i18n.t("settings.customThemes.error.parseError");
    case "InvalidName":
      return i18n.t("settings.customThemes.error.invalidName");
    case "LowContrast":
      // Name the pair AND both numbers. "Your theme is unreadable" is not
      // something an author can act on; "--ink-1 on --paper is 1.03, needs 4.5"
      // is (myne#394).
      return i18n.t("settings.customThemes.error.lowContrast", {
        key: error.key ?? "",
        against: error.against ?? "",
        ratio: error.ratio ?? "",
        min: error.min ?? "",
      });
    case "ReservedKey":
      // The `--_` namespace is Myne's own — a theme that could write
      // `--_o-ceiling` could raise the bound its own tint wash is clamped by.
      return i18n.t("settings.customThemes.error.reservedKey", { key: error.key ?? "" });
    default:
      return i18n.t("settings.customThemes.error.invalidFile");
  }
}

/**
 * Map a caught `themes_import` rejection to a message: a validation failure
 * (`Invalid`) points at the offending token via {@link describeThemeError};
 * anything else falls back to `fallbackKey`, which each surface supplies in its
 * own voice ("that file isn't a valid theme" vs "couldn't install that theme").
 */
export function describeImportError(caught: unknown, fallbackKey: string): string {
  const err = caught as ThemesError | null;
  if (err && err.kind === "Invalid" && err.detail?.error) {
    return describeThemeError(err.detail.error);
  }
  return i18n.t(fallbackKey);
}
