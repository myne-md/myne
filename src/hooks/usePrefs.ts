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

import { useCallback, useEffect, useRef, useState } from "react";
import { observeEgressControls } from "../notes/ai/chatStore";
import i18n from "../i18n";
import {
  PrefsView,
  prefsRead,
  type SetMutation,
  setAiEnabled as persistAiEnabled,
  mutateAiExcludedFolders as persistAiExcludedFolders,
  setAutoLockTimeout,
  setAutoTagEnabled as persistAutoTagEnabled,
  setCliEnabled as persistCliEnabled,
  mutateCliExcludedFolders as persistCliExcludedFolders,
  setCliRateLimitDisabled as persistCliRateLimitDisabled,
  setChatHistoryBudget as persistChatHistoryBudget,
  setDeveloperMode as persistDeveloperMode,
  setDateFormat,
  setTimeFormat,
  setTimezone,
  setEditorContentWidth,
  setEditorFontFamily,
  setEditorLineSpacing,
  setEditorTextSize,
  setBarItemsOrder as persistBarItemsOrder,
  setHiddenBarItems as persistHiddenBarItems,
  setKeymapBinding as persistKeymapBinding,
  // Imported UNALIASED, deliberately. `check-ipc-binding-callers.mjs` strips
  // whole import statements and then bare-word matches the binding's name in
  // what is left, so an alias makes the desktop call site invisible to it: the
  // remainder contains only `persistReminderHorizonDays`. With this branch also
  // removing `ReminderSettings.tsx`'s unaliased call, the sole surviving
  // unaliased production reference was mobile's own same-named setter, and the
  // guard's caller loop is not module-scoped, so MOBILE's call was what kept the
  // DESKTOP binding reported as live. Delete mobile's picker and a fully wired
  // desktop binding reads as dead; delete the desktop wire and the guard stays
  // green. There is no name collision here to justify the alias.
  setReminderHorizonDays,
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
  reminders_enabled: true,
  reminder_horizon_days: null,
  show_task_marker: true,
  transcription_enabled: true,
  deliberate_folders: [],
  ai_enabled: false,
  // ingest-image-compression: matches the Rust default. Compression is on
  // unless the user turns it off, so the optimistic pre-read value must be
  // `true` — starting from `false` would flash the wrong answer for
  // effectively every vault.
  attachment_compression_enabled: true,
  // MYND-441: matches the Rust default. OCR is on unless the user turns it off,
  // so the optimistic pre-read value must be `true` — starting from `false`
  // would flash the wrong answer for effectively every vault.
  attachment_ocr_enabled: true,
  ai_excluded_folders: [],
  developer_mode: false,
  chat_history_budget: null,
  archived_folders: [],
  auto_lock_seconds: null,
  // MYND-651: matches the Rust default. A default-off positive opt-in, so the
  // optimistic pre-read value is `false` — the same polarity as `ai_enabled`,
  // which the tag pass is independently gated on.
  auto_tag_enabled: false,
  ai_provider: null,
  ai_provider_consent: null,
  ai_provider_model: null,
  active_workspace: null,
  custom_theme: null,
  daily_date_format: null,
  daily_folder: null,
  daily_template: null,
  periodic_notes: {},
  favorites: [],
  item_order: {},
  editor_layout: null,
  date_format: null,
  time_format: null,
  timezone: null,
  editor_content_width: null,
  editor_default_view_mode: null,
  editor_focus_dim_inactive: null,
  editor_focus_typewriter: null,
  editor_font_family: null,
  editor_line_spacing: null,
  editor_text_size: null,
  editor_line_numbers: null,
  editor_vim_mode: null,
  archive_disabled: null,
  // myne-cli epic (MYND-490). Matches the Rust defaults: door closed, no
  // exclusions, rate-limit toggle unset (default-ON limit applies). Task 12
  // wires up UI-facing setters for these; this task only extends the type +
  // default so the fields are readable from the UI.
  cli_enabled: false,
  cli_excluded_folders: [],
  cli_rate_limit_disabled: null,
  theme: null,
  folder_icons: {},
  device_names: {},
  hidden_bar_items: [],
  bar_items_order: [],
  color_groups: [],
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
  /** Flip the auto-tag sub-toggle (optimistic; same pattern). Co-gated on
   *  `ai_enabled` at the surface, not here. */
  setAutoTagEnabled: (enabled: boolean) => Promise<void>;
  /**
   * Add to and remove from the AI excluded-folders set (optimistic; same
   * pattern). Takes verbs rather than a whole set: see `SetMutation`, and
   * myne-md/myne#613 for what a whole-set write cost.
   */
  setAiExcludedFolders: (
    mutation: SetMutation,
    next: string[],
  ) => Promise<void>;
  /** Flip the Developer mode toggle (optimistic; same converge-on-error pattern). */
  setDeveloperMode: (enabled: boolean) => Promise<void>;
  /** `null` clears the override. The stored value may be lower than the one
   *  passed: the host clamps it, and this hook re-reads to show what stuck. */
  setChatHistoryBudget: (budget: number | null) => Promise<void>;
  /**
   * Open or close the CLI terminal-access door (myne-cli epic, MYND-490).
   * Optimistic; same converge-on-error pattern. The socket itself follows
   * within one supervisor tick — this only writes the preference.
   */
  setCliEnabled: (enabled: boolean) => Promise<void>;
  /** Add to and remove from the CLI excluded-folders set (optimistic). */
  setCliExcludedFolders: (
    mutation: SetMutation,
    next: string[],
  ) => Promise<void>;
  /**
   * Remove (or restore) the default-on CLI command rate limit. A pace bound on
   * a runaway script, NOT a permission check — see `cli_bridge::rate_limit`.
   */
  setCliRateLimitDisabled: (disabled: boolean) => Promise<void>;
  /**
   * Set the auto-lock-on-idle timeout (seconds). Optimistic: cache updates
   * immediately. On IPC rejection, the cache is re-read from disk
   * (authoritative truth) and `onError` is called (typically a toast).
   * Same pattern as `toggleScreenCapture`.
   */
  setAutoLock: (seconds: number) => Promise<void>;
  /**
   * Set the reminder registration horizon (days). Same optimistic-then-converge
   * discipline as {@link setAutoLock}, which it is the near-twin of: a numeric
   * prefs field with a `null` never-set state and a fixed set of offered values.
   *
   * It lives here rather than as a component-local optimistic write (myne#508)
   * so the settings row holds no state of its own and the panel holds no echo
   * for it, the same reason the ~40 setters around it do.
   */
  setReminderHorizon: (days: number) => Promise<void>;
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
  /** myne#279 — display date format (`system`/`iso`/`dmy`/`mdy`/`dmmmy`). */
  setDateFormat: (value: string | null) => Promise<void>;
  /** myne#279 — display time format (`system`/`24h`/`12h`). */
  setTimeFormat: (value: string | null) => Promise<void>;
  /** myne#279 — DISPLAY timezone override (IANA id); never reaches a note. */
  setTimezone: (value: string | null) => Promise<void>;
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

  // Latest-read-wins, shared by the mount read below and by `reload`, which is
  // the shape the mobile twin has (`mobile/src/lib/use-prefs.ts`). One counter
  // for reads issued, one for the highest-numbered read whose view actually
  // reached state.
  //
  // The mount effect's own `cancelled` flag orders it against UNMOUNT and
  // against nothing else. It cannot order it against a concurrent `reload`, and
  // `reload` is the nonce-driven path: a user action that writes several prefs
  // advances the nonce once per write, so two reads are routinely in flight. If
  // the mount read resolves last it reinstates the pre-write view with no
  // further bump coming, which is the stale-open-editor defect this chokepoint
  // exists to prevent, arriving by a different road. Applying the newest read
  // that SUCCEEDED, rather than dropping anything a newer read superseded, also
  // covers the case where the newer read then fails: dropping the older
  // successful view would leave the hook on data older than what it had.
  const request = useRef(0);
  const applied = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const mine = ++request.current;
    (async () => {
      try {
        const view = await prefsRead();
        // Guard the shape, not just the error: a malformed/absent response must
        // leave DEFAULT_PREFS in place. Storing a non-object here takes down
        // every consumer that reads a field off it.
        if (!cancelled && view && mine > applied.current) {
          applied.current = mine;
          // Every applied view is observed, so a change to the egress controls
          // cuts the chat-history seed whichever way it arrived. See
          // `chatStore.observeEgressControls`: `ai_excluded_folders` is
          // Shared(SetUnion), so it also arrives by sync merge, where no setter
          // on this machine is called.
          observeEgressControls(view.ai_excluded_folders, view.ai_provider);
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

  // Auto-tag toggle (on-device-tag-suggestion MYND-651), co-gated on
  // `ai_enabled` at the surface. Same optimistic-then-converge discipline as
  // `setAiEnabledPref` — the rollback-to-captured-value shape this replaces is
  // the one `toggleScreenCapture` above documents as wrong.
  const setAutoTagEnabledPref = useCallback(
    async (enabled: boolean) => {
      setPrefs((p) => ({ ...p, auto_tag_enabled: enabled }));
      try {
        await persistAutoTagEnabled(enabled);
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

  // The agent's chat-history seed budget (myne-md/myne#617).
  //
  // Unlike every toggle here, this one re-reads on SUCCESS as well as on
  // failure: the host CLAMPS the value, so what it stored can be lower than
  // what was sent, and an optimistic update alone would leave a number on
  // screen that is not the number a run will use.
  const setChatHistoryBudgetPref = useCallback(
    async (budget: number | null) => {
      setPrefs((p) => ({ ...p, chat_history_budget: budget }));
      try {
        await persistChatHistoryBudget(budget);
      } catch {
        onError?.(i18n.t("settings.prefs.saveError"));
      } finally {
        // Converges on BOTH arms, which is why the re-read is in `finally`
        // rather than written out twice. On failure it is the same rollback
        // every other setter here does; on SUCCESS it is load-bearing, because
        // the host clamps and the value it stored can be lower than the one
        // sent. A setter that converged only on failure would leave the panel
        // showing a bound no run will use.
        try {
          setPrefs(await prefsRead());
        } catch {
          // Re-read also failed. Keep the optimistic value; the backend
          // tracing logged the original failure. User can retry.
        }
      }
    },
    [onError],
  );

  // Developer mode toggle (`developer-mode` feature, MYND-593). Same
  // optimistic-then-converge discipline as `setAiEnabledPref`.
  const setDeveloperModePref = useCallback(
    async (enabled: boolean) => {
      setPrefs((p) => ({ ...p, developer_mode: enabled }));
      try {
        await persistDeveloperMode(enabled);
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

  /**
   * The shared core of the two EGRESS-control setters (`ai_excluded_folders`,
   * `cli_excluded_folders`). One copy rather than two, because what it holds is
   * a fail-open guard and two copies is the shape where one of them later stops
   * guarding.
   *
   * `next` is only the optimistic cache value; `mutation` is what is written.
   * They are separate arguments because the caller's optimistic view and its
   * claim about what changed are genuinely different things, and collapsing them
   * is what let a stale view delete a peer's entry (myne-md/myne#613).
   *
   * Three outcomes, and the middle one is the reason this is not
   * `writeOptimisticPref`, which discards what the write returned:
   *
   *   - clean, so the optimistic value stands;
   *   - the reserved byte budget REFUSED some additions
   *     (`SET_FIELD_BUDGET_BYTES`), so the cache is now claiming a folder is
   *     excluded from the AI or the CLI that is not excluded on disk. That is a
   *     fail-open reading of a control `docs/threat-model.md` A17 names, so
   *     converge to disk truth and say what happened rather than leaving the
   *     safer-looking value up;
   *   - the write threw, so re-read disk truth and report the ordinary error.
   *
   * A failed re-read leaves the optimistic value in place on both failure paths:
   * the notice still fires, and the next successful read corrects the cache.
   */
  const writeExcludedFolders = useCallback(
    async (
      patch: Partial<PrefsView>,
      persist: (mutation: SetMutation) => Promise<number>,
      mutation: SetMutation,
    ) => {
      setPrefs((p) => ({ ...p, ...patch }));
      // The seed cut used to be here. It moved down into
      // `prefs.setAiExcludedFolders`, which is the single point every exclusion
      // write passes through, so it now sits beside the identical one in
      // `setAiProvider` instead of a layer above it. `persistAiExcludedFolders`
      // below is that binding, so the ordering the cut depends on (before the
      // write, before any await) is unchanged.
      let messageKey: string | null = null;
      try {
        if ((await persist(mutation)) > 0) {
          messageKey = "settings.prefs.folderListFull";
        }
      } catch {
        messageKey = "settings.prefs.saveError";
      }
      if (messageKey === null) return;
      try {
        setPrefs(await prefsRead());
      } catch {
        // Keep the optimistic value; backend tracing logged the original write.
      }
      onError?.(i18n.t(messageKey));
    },
    [onError],
  );

  const setAiExcludedFoldersPref = useCallback(
    (mutation: SetMutation, next: string[]) =>
      writeExcludedFolders(
        { ai_excluded_folders: next },
        persistAiExcludedFolders,
        mutation,
      ),
    [writeExcludedFolders],
  );

  /**
   * Shared optimistic-then-reread-on-error core: patch the cache immediately
   * (so an open surface re-renders live), persist, and on failure re-read disk
   * truth, the same convergence discipline the setters above spell out by hand.
   * Every setter written from here on composes this instead of copying the block
   * again.
   *
   * **Named `writeOptimisticPref`, not `writePref`** (myne-md/myne#507). That
   * name belongs to `src/lib/prefs.ts`'s module-private chokepoint, the one that
   * bumps the prefs nonce and that `scripts/check-prefs-nonce.mjs` enforces. This
   * one touches no IPC and bumps nothing: it patches a cache and delegates. Two
   * functions with the same name and different semantics, one layer apart, is
   * how myne#251 happened, and myne#496 renamed the mobile twin out of the same
   * collision.
   */
  const writeOptimisticPref = useCallback(
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

  // CLI terminal-access door (myne-cli epic, MYND-490; cli-thin-client task
  // 12). Three fields, the same optimistic-then-converge discipline as the AI
  // pair above — the door's own lifecycle supervisor re-reads `vault.prefs`
  // every tick, so a failed write that converges back to disk truth also
  // converges the socket.
  const setCliEnabledPref = useCallback(
    (enabled: boolean) => writeOptimisticPref({ cli_enabled: enabled }, () => persistCliEnabled(enabled)),
    [writeOptimisticPref],
  );

  // The AI setter's twin, through the same core: see `writeExcludedFolders` for
  // why these two do not go through `writeOptimisticPref`.
  const setCliExcludedFoldersPref = useCallback(
    (mutation: SetMutation, next: string[]) =>
      writeExcludedFolders(
        { cli_excluded_folders: next },
        persistCliExcludedFolders,
        mutation,
      ),
    [writeExcludedFolders],
  );

  const setCliRateLimitDisabledPref = useCallback(
    (disabled: boolean) =>
      writeOptimisticPref({ cli_rate_limit_disabled: disabled }, () =>
        persistCliRateLimitDisabled(disabled),
      ),
    [writeOptimisticPref],
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

  // myne#508. Through the shared `writeOptimisticPref` rather than a hand-rolled
  // twin of `setAutoLock` above: the two differ only in the field and the
  // persist call, which is exactly what that helper exists to absorb.
  const setReminderHorizon = useCallback(
    (days: number) =>
      writeOptimisticPref({ reminder_horizon_days: days }, () =>
        setReminderHorizonDays(days),
      ),
    [writeOptimisticPref],
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

  // The four editor-typography setters, over the shared `writeOptimisticPref` core.
  const setEditorTextSizePref = useCallback(
    (value: string | null) => writeOptimisticPref({ editor_text_size: value }, () => setEditorTextSize(value)),
    [writeOptimisticPref],
  );
  const setEditorLineSpacingPref = useCallback(
    (value: string | null) =>
      writeOptimisticPref({ editor_line_spacing: value }, () => setEditorLineSpacing(value)),
    [writeOptimisticPref],
  );
  const setDateFormatPref = useCallback(
    (value: string | null) => writeOptimisticPref({ date_format: value }, () => setDateFormat(value)),
    [writeOptimisticPref],
  );
  const setTimeFormatPref = useCallback(
    (value: string | null) => writeOptimisticPref({ time_format: value }, () => setTimeFormat(value)),
    [writeOptimisticPref],
  );
  const setTimezonePref = useCallback(
    (value: string | null) => writeOptimisticPref({ timezone: value }, () => setTimezone(value)),
    [writeOptimisticPref],
  );
  const setEditorContentWidthPref = useCallback(
    (value: string | null) =>
      writeOptimisticPref({ editor_content_width: value }, () => setEditorContentWidth(value)),
    [writeOptimisticPref],
  );
  const setEditorFontFamilyPref = useCallback(
    (value: string | null) =>
      writeOptimisticPref({ editor_font_family: value }, () => setEditorFontFamily(value)),
    [writeOptimisticPref],
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

  // Shares the token declared beside the mount effect above, so a mount read
  // and a reload order against each other rather than only against themselves.
  const reload = useCallback(async () => {
    const mine = ++request.current;
    try {
      const view = await prefsRead();
      if (mine <= applied.current) return;
      applied.current = mine;
      // Same observation as the mount read, and this is the path a synced
      // change actually takes: the sync apply bumps the prefs nonce, every
      // `usePrefs` re-reads, and the change is visible here with no setter
      // having run.
      observeEgressControls(view.ai_excluded_folders, view.ai_provider);
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
    setAutoTagEnabled: setAutoTagEnabledPref,
    setCliEnabled: setCliEnabledPref,
    setCliExcludedFolders: setCliExcludedFoldersPref,
    setCliRateLimitDisabled: setCliRateLimitDisabledPref,
    setChatHistoryBudget: setChatHistoryBudgetPref,
    setDeveloperMode: setDeveloperModePref,
    setAutoLock,
    setReminderHorizon,
    setHiddenBarItems,
    setBarItemsOrder,
    setRightPanelActiveTab,
    setRightPanelHiddenTabs,
    setRightPanelTabOrder,
    setEditorTextSize: setEditorTextSizePref,
    setEditorLineSpacing: setEditorLineSpacingPref,
    setDateFormat: setDateFormatPref,
    setTimeFormat: setTimeFormatPref,
    setTimezone: setTimezonePref,
    setEditorContentWidth: setEditorContentWidthPref,
    setEditorFontFamily: setEditorFontFamilyPref,
    setKeymapBinding: setKeymapBindingPref,
    reload,
  };
}
