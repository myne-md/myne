// Custom-theme command wrappers (custom-themes epic, MYND-297) — the TS mirror
// of the `themes` Tauri plugin (`src-tauri/src/plugins/themes/`). Consumed by
// the apply path (`App.tsx` via `readCustomTheme`) and the picker UI (MYND-112,
// via `listCustomThemes` / `deleteCustomTheme`).
//
// No mock layer (per `src/CLAUDE.md`): these call the real IPC commands. Keep
// the types in lockstep with the Rust `ThemeInfo` / `ThemeError` /
// `ThemeCommandError` serde shapes.

import { invoke } from "@tauri-apps/api/core";

/** Mirror of Rust `themes::error::ThemeErrorKind`. */
export type ThemeErrorKind = "ParseError" | "MissingKey" | "InvalidValue" | "InvalidName";

/** Mirror of Rust `themes::error::ThemeError` — the rich validation failure. */
export interface ThemeError {
  kind: ThemeErrorKind;
  /** The offending CSS-variable token, when the failure is token-scoped. */
  key?: string;
  /** The 1-based source line, when the failure is a locatable parse error. */
  line?: number;
}

/** Mirror of Rust `themes::info::ThemePreview` — the chiplet swatch tuple. */
export interface ThemePreview {
  background: string;
  surface: string;
  foreground: string;
  accent: string;
  line: string;
}

/** Mirror of Rust `themes::info::ThemeInfo` — one custom-theme list row. */
export interface ThemeInfo {
  name: string;
  display_name: string;
  /** `null` for an invalid file (the picker greys the row and shows `error`). */
  preview: ThemePreview | null;
  valid: boolean;
  error: ThemeError | null;
}

/** List every custom theme (validated) in `app_config_dir/themes/`. */
export async function listCustomThemes(): Promise<ThemeInfo[]> {
  return invoke<ThemeInfo[]>("plugin:themes|list_custom_themes");
}

/**
 * Read + validate one custom theme by name, returning its `--token → value`
 * palette map. Rejects (with a `ThemeCommandError`) on an unsafe name, an
 * absent file (`NotFound`), or a validation failure (`Invalid`).
 */
export async function readCustomTheme(name: string): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("plugin:themes|read_custom_theme", { name });
}

/** Delete one custom theme file by name. Idempotent (absent → success). */
export async function deleteCustomTheme(name: string): Promise<void> {
  await invoke<void>("plugin:themes|delete_custom_theme", { name });
}

/**
 * Import a user-picked `.json` theme file (its path from the file dialog). The
 * backend reads + validates it, derives a safe name from the file-stem, and
 * places it in the themes folder; returns the new {@link ThemeInfo}. Rejects
 * (`ThemeCommandError`) on an unsafe name or invalid content.
 */
export async function importCustomTheme(sourcePath: string): Promise<ThemeInfo> {
  return invoke<ThemeInfo>("plugin:themes|import_custom_theme", { sourcePath });
}

/** Ensure the themes folder exists and return its path (for revealing it). */
export async function ensureThemesDir(): Promise<string> {
  return invoke<string>("plugin:themes|ensure_themes_dir");
}
