// Custom-theme command wrappers (MYND-486) — the TS mirror of the vault-content
// `themes` Tauri plugin (`myne-core::plugins::themes`, surfaced on desktop by
// `src-tauri/src/plugins/themes/`). As of MYND-486 the palettes are VAULT
// CONTENT: they live in the encrypted `vault.themes` (`MYT1`) singleton blob
// (protocol.md § 9.21), not device-local plaintext files. Consumed by the apply
// path (`App.tsx` via `readCustomTheme`) and the picker UI
// (`CustomThemesSection.tsx`).
//
// No mock layer (per `src/CLAUDE.md`): these call the real IPC commands. Keep the
// types in lockstep with the Rust `ThemesError` / `ThemeError` serde shapes.

import { invoke } from "@tauri-apps/api/core";
import { importReadFile } from "../notes/import/ports";
import { splitExportPath } from "../notes/exportFlow";

/** Mirror of Rust `theme_validator::ThemeErrorKind`. */
export type ThemeErrorKind = "ParseError" | "MissingKey" | "InvalidValue" | "InvalidName";

/** Mirror of Rust `theme_validator::ThemeError` — the rich validation failure. */
export interface ThemeError {
  kind: ThemeErrorKind;
  /** The offending CSS-variable token, when the failure is token-scoped. */
  key?: string;
  /** The 1-based source line, when the failure is a locatable parse error. */
  line?: number;
}

/** Mirror of Rust `themes::error::ThemesError` variant tag. */
export type ThemesErrorKind =
  | "SlotNotUnlocked"
  | "Io"
  | "InvalidVaultMeta"
  | "NotFound"
  | "Encode"
  | "Invalid";

/**
 * Mirror of Rust `ThemesError` (serde `tag = "kind", content = "detail"`). The
 * only variant the UI destructures is `Invalid`, whose `detail.error` carries
 * the rich {@link ThemeError} so an import failure can point at the exact token.
 */
export interface ThemesError {
  kind: ThemesErrorKind;
  detail?: { error?: ThemeError; io_error_kind?: string };
}

/** A theme's flat `--token → value` CSS-variable palette map. */
export type ThemePalette = Record<string, string>;

/** The 5-swatch chiplet preview derived client-side from a validated palette. */
export interface ThemePreview {
  background: string;
  surface: string;
  foreground: string;
  accent: string;
  line: string;
}

/**
 * One live custom theme as the list surface hands it out — mirror of Rust
 * `ThemeListEntry`. The palette rides along because `vault.themes` is a single
 * blob: the host decrypts and decodes every palette to answer a list at all, so
 * a name-only list would just force each palette to be bought back with its own
 * full decrypt.
 */
export interface CustomThemeEntry {
  name: string;
  palette: ThemePalette;
}

/**
 * List every live custom theme in the unlocked vault's `vault.themes` store —
 * name + palette each, in name order (the host's `BTreeMap` iteration; no
 * client-side re-sort needed). ONE decrypt covers the whole list.
 */
export async function listCustomThemes(): Promise<CustomThemeEntry[]> {
  return invoke<CustomThemeEntry[]>("plugin:themes|themes_list");
}

/**
 * Read one custom theme's `--token → value` palette by name. Rejects (with a
 * {@link ThemesError}) on `NotFound` or a Slot precondition violation.
 */
export async function readCustomTheme(name: string): Promise<ThemePalette> {
  return invoke<ThemePalette>("plugin:themes|themes_read", { name });
}

/**
 * Read one custom theme's palette for a plaintext `.json` export (byte-identical
 * to {@link readCustomTheme}; the distinct name documents the TB3 egress intent).
 */
export async function exportCustomTheme(name: string): Promise<ThemePalette> {
  return invoke<ThemePalette>("plugin:themes|themes_export", { name });
}

/**
 * Import (upsert) a custom theme under `name`. `paletteJson` is the raw contents
 * of a user-picked `.json` theme file; the host validates it through the shared
 * value-shape allowlist BEFORE sealing it into `vault.themes`. Rejects (with a
 * {@link ThemesError}, `kind === "Invalid"`) on an invalid palette shape.
 */
export async function importCustomTheme(name: string, paletteJson: string): Promise<void> {
  await invoke<void>("plugin:themes|themes_import", { name, paletteJson });
}

/**
 * The first free `"<name> (n)"` for `n >= 2`, given the names already in the
 * vault. Returns `name` untouched when it is free.
 *
 * Lives beside {@link importCustomTheme} rather than in a caller because
 * `themes_import` is an UPSERT: "don't silently clobber a theme the user
 * already has" is a property of importing a theme, not of the surface that
 * happens to be importing it. The deep-link dialog (MYND-567) is the first
 * caller; the Settings file-import path still overwrites by filename and is a
 * candidate for the same treatment.
 */
export function nextAvailableThemeName(name: string, taken: readonly string[]): string {
  const existing = new Set(taken);
  let candidate = name;
  for (let n = 2; existing.has(candidate); n += 1) candidate = `${name} (${n})`;
  return candidate;
}

/** Delete one custom theme by name. Idempotent (absent → success). */
export async function deleteCustomTheme(name: string): Promise<void> {
  await invoke<void>("plugin:themes|themes_delete", { name });
}

/**
 * Read a user-picked `.json` theme file's UTF-8 contents via the importer
 * read-seam (`import_read_file`, root-confined; the WebView holds NO general
 * fs-read scope — least-privilege, TB6). The picked path's parent directory is
 * the confining root — `splitExportPath` is the one separator scanner, and it
 * keeps the separator when the parent IS a filesystem root (`/theme.json` → `/`,
 * `C:\theme.json` → `C:\`) so a root-level pick still confines to its directory.
 */
export async function readPickedThemeFile(absolutePath: string): Promise<string> {
  return importReadFile(splitExportPath(absolutePath).dir, absolutePath);
}

/**
 * Derive the 5-swatch chiplet preview from a validated palette. Every stored
 * theme is valid (import validates before sealing), so the required-core tokens
 * are present; a missing token falls back to empty (renders as a blank swatch).
 */
export function themePreview(palette: ThemePalette): ThemePreview {
  const get = (key: string): string => palette[key] ?? "";
  return {
    background: get("--paper"),
    surface: get("--paper-2"),
    foreground: get("--ink-1"),
    accent: get("--accent"),
    line: get("--line-1"),
  };
}
