// `usePrefs` — lazy-loading hook for the v0.1 prefs blob (MYND-160).
//
// Lifecycle:
// - Mount: idle state, fires `prefsRead()` once. Cancelled-flag
//   cleanup pattern handles React 19 StrictMode double-mount
//   correctly (the second mount issues a fresh request; only the
//   non-cancelled response updates state).
// - Optimistic write: cache is updated synchronously, then the IPC
//   fires. On rejection, the cache is **re-read from disk** (the
//   authoritative source) so rapid-toggle races between two failing
//   writes converge UI back to disk truth instead of inverting on
//   captured-previous snapshots.
// - Modal close: parent component unmounts the consumer, the hook's
//   state drops, next mount re-reads. No persistent cache across
//   SettingsModal lifecycles — disk is canonical (MYND-160 grill Q5.1).
//
// React Query / SWR is intentionally NOT introduced — the cache shape
// is trivial (1 bool today) and the lifetime is modal-scoped. Per
// `CLAUDE.md` minimal-dep posture (TB9 audit anchor). When prefs grow
// past ~5 fields, revisit (separate PRD).

import { useCallback, useEffect, useState } from "react";
import i18n from "../i18n";
import {
  PrefsView,
  prefsRead,
  setAiEnabled as persistAiEnabled,
  setAiExcludedFolders as persistAiExcludedFolders,
  setAutoLockTimeout,
  setEditorContentWidth,
  setEditorFontFamily,
  setEditorLineSpacing,
  setEditorTextSize,
  setBarItemsOrder as persistBarItemsOrder,
  setHiddenBarItems as persistHiddenBarItems,
  setKeymapBinding as persistKeymapBinding,
  setRightPanelActiveTab as persistRightPanelActiveTab,
  setRightPanelHiddenTabs as persistRightPanelHiddenTabs,
  setRightPanelTabOrder as persistRightPanelTabOrder,
  setScreenCaptureProtection,
} from "../lib/prefs";
import { subscribePrefsNonce } from "../notes/prefsNonce";

/**
 * Default prefs returned before the first read completes AND on any
 * load error. Mirrors `PrefsView::default()` on the Rust side
 * (spec § 9.5.5 safer-state semantic).
 */
const DEFAULT_PREFS: PrefsView = {
  screen_capture_protection: true,
  show_note_timestamps: true,
  deliberate_folders: [],
  ai_enabled: false,
  ai_excluded_folders: [],
  archived_folders: [],
  auto_lock_seconds: null,
  active_workspace: null,
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
  editor_toolbar_order: [],
  editor_toolbar_hidden: [],
  editor_slash_order: [],
  editor_slash_hidden: [],
  item_colors: {},
  keymap: {},
  label: null,
  icon: null,
  last_backup_at: null,
  new_note_location: null,
  new_note_location_folder: null,
  startup_open: null,
  startup_open_note: null,
  spell_enabled: null,
  spell_languages: [],
  saved_views: [],
  view_order: [],
};

interface UsePrefsResult {
  /** Current prefs view — DEFAULT_PREFS until loaded. */
  prefs: PrefsView;
  /**
   * Toggle screen_capture_protection. Optimistic: cache flips
   * immediately. On IPC rejection, the cache is re-read from disk
   * (authoritative truth) and `onError` is called (typically wired
   * to a toast).
   */
  toggleScreenCapture: (enabled: boolean) => Promise<void>;
  /** Flip the AI opt-in toggle (optimistic; same converge-on-error pattern). */
  setAiEnabled: (enabled: boolean) => Promise<void>;
  /** Replace the AI excluded-folders set (optimistic; same pattern). */
  setAiExcludedFolders: (folders: string[]) => Promise<void>;
  /**
   * Set the auto-lock-on-idle timeout (seconds). Optimistic: cache updates
   * immediately. On IPC rejection, the cache is re-read from disk
   * (authoritative truth) and `onError` is called (typically a toast).
   * Same pattern as `toggleScreenCapture`.
   */
  setAutoLock: (seconds: number) => Promise<void>;
  /**
   * Persist the full hidden-bottom-bar-items set (bottom-bar customization).
   * Optimistic: the cache updates immediately so the BottomBar reflects the
   * toggle without a round-trip. On IPC rejection, the cache is re-read from
   * disk (authoritative truth) and `onError` is called. Same pattern as
   * {@link setAutoLock}.
   */
  setHiddenBarItems: (items: string[]) => Promise<void>;
  /**
   * Persist the bottom-bar item display order (drag-to-reorder / right-click
   * move). Optimistically patches the cache so the open bar re-renders without a
   * round-trip. On IPC rejection, the cache is re-read from disk and `onError`
   * is called. Same pattern as {@link setHiddenBarItems}.
   */
  setBarItemsOrder: (order: string[]) => Promise<void>;
  /**
   * Persist the active right-panel tab id (right-panel tabs). Optimistic: the
   * cache updates immediately so the panel re-renders without a round-trip. On
   * IPC rejection, the cache is re-read from disk and `onError` is called. Same
   * pattern as {@link setBarItemsOrder}. `null` clears to the host default.
   */
  setRightPanelActiveTab: (value: string | null) => Promise<void>;
  /**
   * Persist the full hidden-right-panel-tabs set (right-panel tabs). The backend
   * canonicalizes it (sorted + deduped). Optimistic with the same disk-re-read-
   * on-error convergence as {@link setHiddenBarItems}.
   */
  setRightPanelHiddenTabs: (items: string[]) => Promise<void>;
  /**
   * Persist the right-panel tab display order (drag-to-reorder / right-click
   * move). The backend preserves element order verbatim. Optimistic with the same
   * convergence as {@link setBarItemsOrder}.
   */
  setRightPanelTabOrder: (order: string[]) => Promise<void>;
  /**
   * Editor-typography preset setters (editor-typography). Each takes the chosen
   * preset string, or `null` to clear back to that field's canonical default.
   * Optimistic (cache updates immediately so the open editor re-renders live)
   * with the same disk-re-read-on-error convergence as {@link setAutoLock}.
   */
  setEditorTextSize: (value: string | null) => Promise<void>;
  setEditorLineSpacing: (value: string | null) => Promise<void>;
  setEditorContentWidth: (value: string | null) => Promise<void>;
  setEditorFontFamily: (value: string | null) => Promise<void>;
  /**
   * Set / unbind / remove one command's keymap override (hotkeys epic, MYND-304).
   * `chords` is a non-empty array (override), an empty array (`[]`, explicit
   * unbind), or `null` (remove → revert to the in-code default). Optimistic: the
   * cache's `keymap` updates immediately; on IPC rejection the cache re-reads disk
   * truth and `onError` fires. The setter also bumps the prefs nonce on success so
   * the live keybinding engine (its own `usePrefs`) reflects the change.
   */
  setKeymapBinding: (commandId: string, chords: string[] | null) => Promise<void>;
  /**
   * Re-read `vault.prefs` from disk into the cache (MYND-274). Used after a
   * mutation made through a SIBLING surface (e.g. a saved-view create/delete
   * via the prefs plugin) so a consumer of this hook reflects the change. A
   * read failure keeps the current cache (safer-state, like the initial load).
   */
  reload: () => Promise<void>;
}

/**
 * `onError` is the toast hook — invoked when an optimistic write
 * rolled back. The parent threads this from
 * `SettingsModal.onShowToast`.
 */
export function usePrefs(onError?: (message: string) => void): UsePrefsResult {
  const [prefs, setPrefs] = useState<PrefsView>(DEFAULT_PREFS);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const view = await prefsRead();
        if (!cancelled) {
          setPrefs(view);
        }
      } catch {
        // SlotNotUnlocked / Io / InvalidVaultMeta → keep DEFAULT_PREFS
        // (safer state per spec § 9.5.5). The error is observable in
        // the backend tracing; the frontend treats it as "couldn't
        // load, use defaults" and stays usable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleScreenCapture = useCallback(
    async (enabled: boolean) => {
      // Optimistic flip via functional update so concurrent toggles
      // each see the latest visual state when computing their next
      // value (no captured-previous staleness).
      setPrefs((p) => ({ ...p, screen_capture_protection: enabled }));
      try {
        await setScreenCaptureProtection(enabled);
      } catch {
        // Re-read disk truth instead of rolling back to a captured
        // pre-flip value. Pattern fixes the rapid-double-toggle UI/
        // disk inversion case (T1 optimistic-then-fail captures stale
        // baseline from T0's optimistic state; T2 rollback would
        // invert UI vs disk). Re-reading converges UI with disk on
        // every error path, regardless of how many concurrent writes
        // raced.
        try {
          const view = await prefsRead();
          setPrefs(view);
        } catch {
          // Re-read also failed — keep the optimistic value; the
          // backend tracing has logged the original failure. User can
          // retry by toggling again.
        }
        onError?.(i18n.t("settings.prefs.saveError"));
      }
    },
    [onError],
  );

  // AI opt-in toggle + excluded-folders set (local-ai epic, ai-ux-surface
  // MYND-408). Optimistic-then-converge, identical discipline to
  // `toggleScreenCapture`: flip the cache, persist, and on failure re-read disk
  // truth (never roll back to a captured pre-flip value).
  const setAiEnabledPref = useCallback(
    async (enabled: boolean) => {
      setPrefs((p) => ({ ...p, ai_enabled: enabled }));
      try {
        await persistAiEnabled(enabled);
      } catch {
        try {
          const view = await prefsRead();
          setPrefs(view);
        } catch {
          // Re-read also failed — keep the optimistic value; the backend
          // tracing logged the original failure. User can retry.
        }
        onError?.(i18n.t("settings.prefs.saveError"));
      }
    },
    [onError],
  );

  const setAiExcludedFoldersPref = useCallback(
    async (folders: string[]) => {
      setPrefs((p) => ({ ...p, ai_excluded_folders: folders }));
      try {
        await persistAiExcludedFolders(folders);
      } catch {
        try {
          const view = await prefsRead();
          setPrefs(view);
        } catch {
          // Keep the optimistic value; the backend tracing logged the failure.
        }
        onError?.(i18n.t("settings.prefs.saveError"));
      }
    },
    [onError],
  );

  const setAutoLock = useCallback(
    async (seconds: number) => {
      // Optimistic via functional update (no captured-previous staleness).
      setPrefs((p) => ({ ...p, auto_lock_seconds: seconds }));
      try {
        await setAutoLockTimeout(seconds);
      } catch {
        // Re-read disk truth instead of rolling back to a captured value —
        // same convergence discipline as `toggleScreenCapture`.
        try {
          const view = await prefsRead();
          setPrefs(view);
        } catch {
          // Re-read also failed — keep the optimistic value; the backend
          // tracing logged the original failure. User can retry.
        }
        onError?.(i18n.t("settings.prefs.saveError"));
      }
    },
    [onError],
  );

  const setHiddenBarItems = useCallback(
    async (items: string[]) => {
      // Optimistic via functional update (no captured-previous staleness) —
      // same convergence discipline as `setAutoLock` / `toggleScreenCapture`.
      setPrefs((p) => ({ ...p, hidden_bar_items: items }));
      try {
        await persistHiddenBarItems(items);
      } catch {
        // Re-read disk truth instead of rolling back to a captured value.
        try {
          const view = await prefsRead();
          setPrefs(view);
        } catch {
          // Re-read also failed — keep the optimistic value; the backend
          // tracing logged the original failure. User can retry.
        }
        onError?.(i18n.t("settings.prefs.saveError"));
      }
    },
    [onError],
  );

  const setBarItemsOrder = useCallback(
    async (order: string[]) => {
      // Optimistic via functional update — same convergence discipline as
      // `setHiddenBarItems`. The backend preserves element order verbatim.
      setPrefs((p) => ({ ...p, bar_items_order: order }));
      try {
        await persistBarItemsOrder(order);
      } catch {
        // Re-read disk truth instead of rolling back to a captured value.
        try {
          const view = await prefsRead();
          setPrefs(view);
        } catch {
          // Re-read also failed — keep the optimistic value; the backend
          // tracing logged the original failure. User can retry.
        }
        onError?.(i18n.t("settings.prefs.saveError"));
      }
    },
    [onError],
  );

  const setRightPanelActiveTab = useCallback(
    async (value: string | null) => {
      // Optimistic via functional update — same convergence discipline as
      // `setBarItemsOrder`. `null` clears to the host default.
      setPrefs((p) => ({ ...p, right_panel_active_tab: value }));
      try {
        await persistRightPanelActiveTab(value);
      } catch {
        try {
          setPrefs(await prefsRead());
        } catch {
          // Re-read also failed — keep the optimistic value; the backend tracing
          // logged the original failure. User can retry.
        }
        onError?.(i18n.t("settings.prefs.saveError"));
      }
    },
    [onError],
  );

  const setRightPanelHiddenTabs = useCallback(
    async (items: string[]) => {
      // Optimistic via functional update — same convergence discipline as
      // `setHiddenBarItems`. The backend canonicalizes (sorted + deduped).
      setPrefs((p) => ({ ...p, right_panel_hidden_tabs: items }));
      try {
        await persistRightPanelHiddenTabs(items);
      } catch {
        try {
          setPrefs(await prefsRead());
        } catch {
          // Re-read also failed — keep the optimistic value; the backend tracing
          // logged the original failure. User can retry.
        }
        onError?.(i18n.t("settings.prefs.saveError"));
      }
    },
    [onError],
  );

  const setRightPanelTabOrder = useCallback(
    async (order: string[]) => {
      // Optimistic via functional update — same convergence discipline as
      // `setBarItemsOrder`. The backend preserves element order verbatim.
      setPrefs((p) => ({ ...p, right_panel_tab_order: order }));
      try {
        await persistRightPanelTabOrder(order);
      } catch {
        try {
          setPrefs(await prefsRead());
        } catch {
          // Re-read also failed — keep the optimistic value; the backend tracing
          // logged the original failure. User can retry.
        }
        onError?.(i18n.t("settings.prefs.saveError"));
      }
    },
    [onError],
  );

  // Shared optimistic-then-reread-on-error core for the editor-typography
  // setters: patch the cache immediately (so the open editor re-renders live),
  // persist, and on failure re-read disk truth — same convergence discipline as
  // the spelled-out setters above, factored out for the four near-identical
  // typography fields.
  const writeTypographyPref = useCallback(
    async (patch: Partial<PrefsView>, persist: () => Promise<void>) => {
      setPrefs((p) => ({ ...p, ...patch }));
      try {
        await persist();
      } catch {
        try {
          setPrefs(await prefsRead());
        } catch {
          // Re-read also failed — keep the optimistic value; backend tracing
          // logged the original failure. User can retry.
        }
        onError?.(i18n.t("settings.prefs.saveError"));
      }
    },
    [onError],
  );

  const setEditorTextSizePref = useCallback(
    (value: string | null) =>
      writeTypographyPref({ editor_text_size: value }, () => setEditorTextSize(value)),
    [writeTypographyPref],
  );
  const setEditorLineSpacingPref = useCallback(
    (value: string | null) =>
      writeTypographyPref({ editor_line_spacing: value }, () => setEditorLineSpacing(value)),
    [writeTypographyPref],
  );
  const setEditorContentWidthPref = useCallback(
    (value: string | null) =>
      writeTypographyPref({ editor_content_width: value }, () => setEditorContentWidth(value)),
    [writeTypographyPref],
  );
  const setEditorFontFamilyPref = useCallback(
    (value: string | null) =>
      writeTypographyPref({ editor_font_family: value }, () => setEditorFontFamily(value)),
    [writeTypographyPref],
  );

  const setKeymapBindingPref = useCallback(
    async (commandId: string, chords: string[] | null) => {
      // Optimistic via functional update: patch only the one command's entry on
      // the cached keymap (3-state — null removes, else assign). Same
      // convergence discipline as `setHiddenBarItems`. The backend canonicalizes
      // (NFC + sort + dedupe); the nonce bump on success re-reads disk truth so
      // the cache converges to the canonical form.
      setPrefs((p) => {
        const next = { ...p.keymap };
        if (chords === null) {
          delete next[commandId];
        } else {
          next[commandId] = chords;
        }
        return { ...p, keymap: next };
      });
      try {
        await persistKeymapBinding(commandId, chords);
      } catch {
        try {
          setPrefs(await prefsRead());
        } catch {
          // Re-read also failed — keep the optimistic value; the backend tracing
          // logged the original failure. User can retry.
        }
        onError?.(i18n.t("settings.prefs.saveError"));
      }
    },
    [onError],
  );

  const reload = useCallback(async () => {
    try {
      const view = await prefsRead();
      setPrefs(view);
    } catch {
      // Keep the current cache (safer-state per spec § 9.5.5).
    }
  }, []);

  // Cross-surface refresh (Saved Views #4 follow-up): a saved-view mutation made
  // through a SIBLING surface (e.g. the Tag browser's "Save as view") bumps the
  // prefs nonce at the IPC chokepoint. Each `usePrefs` instance subscribes and
  // re-reads disk truth so the sidebar Views section reflects the change without
  // a remount. Coalesced onto a microtask by the store (no render thrash).
  useEffect(() => subscribePrefsNonce(() => void reload()), [reload]);

  return {
    prefs,
    toggleScreenCapture,
    setAiEnabled: setAiEnabledPref,
    setAiExcludedFolders: setAiExcludedFoldersPref,
    setAutoLock,
    setHiddenBarItems,
    setBarItemsOrder,
    setRightPanelActiveTab,
    setRightPanelHiddenTabs,
    setRightPanelTabOrder,
    setEditorTextSize: setEditorTextSizePref,
    setEditorLineSpacing: setEditorLineSpacingPref,
    setEditorContentWidth: setEditorContentWidthPref,
    setEditorFontFamily: setEditorFontFamilyPref,
    setKeymapBinding: setKeymapBindingPref,
    reload,
  };
}
