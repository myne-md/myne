// `usePrefs` — the mobile counterpart to the desktop `src/hooks/usePrefs.ts`.
//
// Reads the unlocked vault's `vault.prefs` (a cheap decrypt of a small blob) and
// re-reads whenever a prefs setter bumps the shared nonce (`prefsNonce.ts`), so
// every settings surface reflects disk truth after any write — matching the
// desktop chokepoint discipline. In browser-dev (`pnpm dev`, no Tauri host) it
// resolves to {@link DEFAULT_PREFS} so the Settings UI stays navigable.

import { useCallback, useEffect, useRef, useState } from "react";
import { HAS_TAURI } from "./app-window";
import { prefsRead, type PrefsView } from "./prefs";
import { usePrefsNonce } from "./prefsNonce";

/** Fall-back-to-defaults view used before the first read resolves and in
 *  browser-dev. Mirrors the Rust-side default semantics (spec §9.5.5): every
 *  optional field unset (`null` / empty), timestamps shown, screen-capture off. */
export const DEFAULT_PREFS: PrefsView = {
  screen_capture_protection: false,
  // ENABLED, matching the Rust default (MYND-563/592; opt-out). An absent key
  // reads as on — the transcribe command re-reads it host-side, so this default
  // only affects UI visibility, never the gate.
  transcription_enabled: true,
  // ENABLED, matching the Rust default (MYND-618/619). An absent key must read
  // as on: reading it as off would silently disable reminders on every existing
  // vault, which is the worst available reading of a missing value.
  reminders_enabled: true,
  reminder_horizon_days: null,
  show_note_timestamps: true,
  attachment_compression_enabled: true,
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
  // `null` is the real default for all three (myne#279): it means "no explicit
  // choice", which resolves to the app's own language and this device's zone,
  // and is omitted from the encrypted blob so a vault that never chose stays
  // byte-identical to a pre-feature one.
  date_format: null,
  favorites: [],
  item_order: {},
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
  time_format: null,
  timezone: null,
  folder_icons: {},
  device_names: {},
  hidden_bar_items: [],
  bar_items_order: [],
  right_panel_active_tab: null,
  right_panel_hidden_tabs: [],
  right_panel_tab_order: [],
  editor_toolbar_order: [],
  editor_toolbar_hidden: [],
  item_colors: {},
  label: null,
  icon: null,
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

  // Monotonic request token: only the LATEST read may write state.
  //
  // Without it these reads are last-resolver-wins, and they genuinely overlap.
  // One user action can advance the nonce several times (a folder rename writes
  // deliberate_folders, archived_folders, item_colors and folder_icons, each
  // bumping as it resolves), the bumps land in separate microtasks so
  // `prefsNonce.ts`'s coalescing does not collapse them, and each re-runs this
  // effect. If read N resolves after read N+1, the older view wins and the
  // surface sits on pre-write prefs with no further bump coming, which is the
  // stale-open-editor defect the chokepoint exists to prevent, arriving by a
  // different road.
  //
  // The `cancelled` flag this replaces could not do the job: it was read before
  // `await load()`, where it is always false, and `load` wrote state
  // unconditionally. The desktop twin already gets this right by checking its
  // flag AFTER the await (`src/hooks/usePrefs.ts:265`); a token additionally
  // covers `reload`, which no effect cleanup can cancel.
  const request = useRef(0);
  // The highest-numbered read whose view actually reached state. Separate from
  // `request` because "issued" and "applied" answer different questions.
  const applied = useRef(0);

  const load = useCallback(async () => {
    const mine = ++request.current;
    const superseded = () => mine !== request.current;
    // No token check here, deliberately: nothing between the increment above
    // and this branch awaits or yields, so `superseded()` is provably false and
    // a guard would read as a race that cannot happen. The token exists for the
    // three sites after `await prefsRead()`.
    if (!HAS_TAURI) {
      setPrefs(DEFAULT_PREFS);
      setLoading(false);
      return;
    }
    setError(false);
    try {
      const view = await prefsRead();
      // High-water mark rather than `superseded()`, and the difference is a real
      // case: if read N is overtaken by read N+1 and N+1 then FAILS, dropping
      // N's successful view leaves the hook on data older than what it had in
      // hand, with no further bump coming. Applying the newest view that
      // actually succeeded is the property wanted; a later success still wins,
      // because its own number is higher.
      if (mine <= applied.current) return;
      applied.current = mine;
      setPrefs(view);
    } catch {
      if (superseded()) return;
      // Non-distinguishing: keep the last-known / default view; surface a flag.
      setError(true);
    } finally {
      if (!superseded()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Re-run on nonce advance (a setter resolved) so the UI reflects disk truth.
  }, [load, nonce]);

  return { prefs, loading, error, reload: load };
}
