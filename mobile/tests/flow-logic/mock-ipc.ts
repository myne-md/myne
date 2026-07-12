// Mock Tauri IPC for the flow-logic tier (MYND-462 task 3). Injected via
// `page.addInitScript` BEFORE the app boots, it sets `window.__TAURI_INTERNALS__`
// so `HAS_TAURI` is true and every `invoke(cmd, args)` routes to a canned handler
// instead of a real Rust command. This lets headless Chromium drive the sync UI
// flow logic against the dev server with NO backend.
//
// Boot shortcut: `vault_slot_kind` → "Unlocked" makes `initialStageFromProbe`
// route straight to the editor (no password unlock), so a test reaches
// Settings → Sync in a couple of clicks. Everything unrecognised returns a benign
// empty value so the editor mount never throws on an unmocked command.

import type { Page } from "@playwright/test";

/** The runtime `SyncRuntimeStatus` shape (mirrors `lib/use-sync-status`). */
export type MockSyncStatus =
  | { state: "disabled" }
  | { state: "not_enrolled" }
  | { state: "pending" }
  | { state: "idle" }
  | { state: "syncing" }
  | { state: "error"; detail: string }
  | { state: "conflicts"; count: number };

export interface MockDevice {
  device_id_hex: string;
  approved: boolean;
  retired: boolean;
  is_current?: boolean;
}

/** Per-test canned responses for the sync command surface. */
export interface MockConfig {
  syncStatus?: MockSyncStatus;
  endpoint?: { endpoint_url: string | null; cert_pin_hex: string | null; pin_source: "static" | "tofu" | null };
  setEndpoint?: { fingerprint: string | null; pin_source: "static" | "tofu" | null };
  devices?: MockDevice[];
  /** `sync_enroll` outcome — `{ approved }` on success, or a `{ kind }` error to reject. */
  enrollResult?: { approved: boolean };
  enrollError?: { kind: string };
  headFingerprint?: string | null;
  pendingConflicts?: string[];
  /** Boot to the Welcome screen (empty slot + no vaults) instead of straight to
   *  the editor — for the fresh-device join flow. */
  freshDevice?: boolean;
  /** `sync_join_account` outcome. */
  joinResult?: { vault_id: string; pending: boolean; fingerprint: string | null };
  joinError?: { kind: string };
  /** Boot to the Unlock screen (one `Exists` vault, `Empty` slot) instead of
   *  straight to the editor — for the quick-unlock / password unlock flows. */
  lockedVault?: boolean;
  /** Canned `quick_unlock_status` (defaults to not-configured). A
   *  `quick_unlock_setup_*` / `quick_unlock_disable` call mutates the canned
   *  value so a settings toggle flip is reflected by the next status read. */
  quickUnlock?: { configured: boolean; method: "pin" | "biometric" | null; available: boolean };
  /** Reject `quick_unlock_with_biometric` with this `QuickUnlockError`. */
  biometricRedeemError?: { kind: string; detail?: unknown };
  /** Reject `quick_unlock_setup_biometric` with this `QuickUnlockError`. */
  biometricSetupError?: { kind: string };
}

/** Install the mock IPC as an init script so it runs before the app's first paint. */
export async function installMockIpc(page: Page, cfg: MockConfig = {}): Promise<void> {
  await page.addInitScript((config: MockConfig) => {
    const DEFAULT_PREFS = {
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

    // Quick-unlock canned state — mutable so a setup/disable call is reflected
    // by the next `quick_unlock_status` read (the settings toggle round-trip).
    let quickUnlock = config.quickUnlock ?? { configured: false, method: null, available: false };

    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      // ── Boot / editor mount ──
      // freshDevice → boot to Welcome (no vaults, Empty slot); lockedVault →
      // boot to Unlock (one Exists vault, Empty slot); otherwise the Unlocked
      // slot shortcuts `initialStageFromProbe` straight to the editor.
      "plugin:vault-unlock|vault_list": () => (config.freshDevice ? [] : [{ id: "flow-vault", status: { kind: "Exists" } }]),
      "plugin:vault-unlock|vault_slot_kind": () => (config.freshDevice || config.lockedVault ? "Empty" : "Unlocked"),
      "plugin:vault-unlock|vault_is_unlocked": () => true,
      "plugin:vault-unlock|report_user_activity": () => null,
      "plugin:vault-unlock|unlock": () => null,
      "plugin:prefs|prefs_read": () => DEFAULT_PREFS,
      "plugin:notes|note_list": () => [],
      // ── Attachments surface (voice-note capture flow) ──
      // Record every import so a test can assert the capture pipeline produced a
      // `Voice note ….wav` bytes-import; echo the filename back so the inserted
      // form-C embed carries it. Refs/catalog reads are benign empties.
      "plugin:attachments|attachment_import": (args) => {
        const source = (args.source ?? {}) as { kind?: string; bytes?: number[]; filename?: string | null };
        const w = window as unknown as { __voiceImports?: Array<{ kind?: string; len: number; filename?: string | null }> };
        (w.__voiceImports ??= []).push({ kind: source.kind, len: source.bytes?.length ?? 0, filename: source.filename ?? null });
        return {
          id: "a".repeat(64),
          content_type: "audio/wav",
          filename: source.filename ?? "file",
          size: source.bytes?.length ?? 0,
          created_at: 0,
          deduplicated: false,
        };
      },
      "plugin:attachments|catalog_list": () => [],
      "plugin:attachments|attachment_unused_list": () => [],
      "plugin:attachments|attachment_refs_apply": () => null,
      "plugin:attachments|attachment_refs_remove": () => null,
      // ── Quick-unlock surface (per-test configurable) ──
      "plugin:quick-unlock|quick_unlock_status": () => quickUnlock,
      "plugin:quick-unlock|quick_unlock_setup_biometric": () => {
        if (config.biometricSetupError) throw config.biometricSetupError;
        quickUnlock = { configured: true, method: "biometric", available: true };
        return null;
      },
      "plugin:quick-unlock|quick_unlock_with_biometric": () => {
        if (config.biometricRedeemError) throw config.biometricRedeemError;
        return null;
      },
      "plugin:quick-unlock|quick_unlock_with_pin": () => null,
      "plugin:quick-unlock|quick_unlock_disable": () => {
        quickUnlock = { configured: false, method: null, available: false };
        return null;
      },
      // ── Sync surface (per-test configurable) ──
      "plugin:sync|sync_status": () => config.syncStatus ?? { state: "not_enrolled" },
      "plugin:sync|sync_get_endpoint": () =>
        config.endpoint ?? { endpoint_url: null, cert_pin_hex: null, pin_source: null },
      "plugin:sync|sync_set_endpoint": () =>
        config.setEndpoint ?? { fingerprint: null, pin_source: null },
      "plugin:sync|sync_list_devices": () => config.devices ?? [],
      "plugin:sync|sync_approve_device": () => null,
      "plugin:sync|sync_remove_device": () => null,
      "plugin:sync|sync_reset_local": () => null,
      "plugin:sync|sync_head_fingerprint": () => config.headFingerprint ?? "TYRS-N318",
      "plugin:sync|sync_pending_conflicts": () => config.pendingConflicts ?? [],
      "plugin:sync|sync_enroll": () => {
        if (config.enrollError) throw config.enrollError;
        return config.enrollResult ?? { approved: false };
      },
      "plugin:sync|sync_join_account": () => {
        if (config.joinError) throw config.joinError;
        return config.joinResult ?? { vault_id: "flow-vault", pending: true, fingerprint: null };
      },
    };

    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      // Tauri v2 routes `invoke(cmd, args)` through this. Unknown commands resolve
      // to an empty array `[]` — the editor mount hydrates several list-returning
      // commands (vault-indices, archived-folders, …) whose `for…of`/spread would
      // throw "not iterable" on a `null`; `[]` is a safe iterable/empty default and
      // an object-shaped consumer just reads `undefined` off it.
      invoke: (cmd: string, args: Record<string, unknown>) => {
        const h = handlers[cmd];
        try {
          return Promise.resolve(h ? h(args ?? {}) : []);
        } catch (e) {
          return Promise.reject(e);
        }
      },
      transformCallback: (cb: unknown) => cb,
      // `@tauri-apps/api/event` listen() calls this; return a no-op unlisten id.
      unregisterCallback: () => undefined,
    };
  }, cfg);
}
