// `usePrefs` — the mobile counterpart to the desktop `src/hooks/usePrefs.ts`.
//
// Reads the unlocked vault's `vault.prefs` (a cheap decrypt of a small blob) and
// re-reads whenever a prefs setter bumps the shared nonce (`prefsNonce.ts`), so
// every settings surface reflects disk truth after any write — matching the
// desktop chokepoint discipline. In browser-dev (`pnpm dev`, no Tauri host) it
// resolves to {@link DEFAULT_PREFS} so the Settings UI stays navigable.

import { useCallback, useEffect, useState } from "react";
import { HAS_TAURI } from "./app-window";
import { prefsRead, type PrefsView } from "./prefs";
import { usePrefsNonce } from "./prefsNonce";

/** Fall-back-to-defaults view used before the first read resolves and in
 *  browser-dev. Mirrors the Rust-side default semantics (spec §9.5.5): every
 *  optional field unset (`null` / empty), timestamps shown, screen-capture off. */
export const DEFAULT_PREFS: PrefsView = {
  screen_capture_protection: false,
  show_note_timestamps: true,
  spell_enabled: null,
  spell_languages: [],
  keymap: {},
  last_backup_at: null,
  new_note_location: null,
  new_note_location_folder: null,
  startup_open: null,
  startup_open_note: null,
  deliberate_folders: [],
  archived_folders: [],
  active_workspace: null,
  auto_lock_seconds: null,
  custom_theme: null,
  daily_date_format: null,
  daily_folder: null,
  daily_template: null,
  favorites: [],
  item_order: [],
  editor_layout: null,
  editor_content_width: null,
  editor_default_view_mode: null,
  editor_focus_dim_inactive: null,
  editor_focus_typewriter: null,
  editor_font_family: null,
  editor_line_spacing: null,
  editor_text_size: null,
  editor_line_numbers: null,
  archive_disabled: null,
  theme: null,
  folder_icons: {},
  device_names: {},
  hidden_bar_items: [],
  bar_items_order: [],
  right_panel_active_tab: null,
  right_panel_hidden_tabs: [],
  right_panel_tab_order: [],
  item_colors: {},
  label: null,
  saved_views: [],
  view_order: [],
};

export interface UsePrefs {
  prefs: PrefsView;
  loading: boolean;
  error: boolean;
  reload: () => void;
}

/** Read `vault.prefs`, re-reading on every prefs-nonce advance. */
export function usePrefs(): UsePrefs {
  const nonce = usePrefsNonce();
  const [prefs, setPrefs] = useState<PrefsView>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(HAS_TAURI);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!HAS_TAURI) {
      setPrefs(DEFAULT_PREFS);
      setLoading(false);
      return;
    }
    setError(false);
    try {
      setPrefs(await prefsRead());
    } catch {
      // Non-distinguishing: keep the last-known / default view; surface a flag.
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await load();
    })();
    return () => {
      cancelled = true;
    };
    // Re-run on nonce advance (a setter resolved) so the UI reflects disk truth.
  }, [load, nonce]);

  return { prefs, loading, error, reload: load };
}
