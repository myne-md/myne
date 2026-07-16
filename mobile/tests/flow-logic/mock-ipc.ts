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
  /** Note ids `note_list` returns — seeds existing rows for tablet-layout tests
   *  (each renders a clickable `notes.row`; body is empty via `note_read`). */
  noteIds?: string[];
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
  /** Boot to the fail-closed Unlock surface (one `Corrupted` vault, `Empty`
   *  slot) — for the corrupted-vault fail-closed flow. */
  corruptedVault?: boolean;
  /** Boot to the ≥2-vault picker (two `Exists` vaults, `Empty` slot) — for the
   *  multi-vault picker → select → unlock flow. */
  multiVault?: boolean;
  /** Reject `plugin:vault-unlock|unlock` with this `VaultUnlockError` (the
   *  wrong-password path renders the non-distinguishing banner). */
  unlockError?: { kind: string; detail?: unknown };
  /** Reject `quick_unlock_with_pin` with this `QuickUnlockError` (wrong-PIN
   *  carries `detail.remaining`). */
  pinRedeemError?: { kind: string; detail?: unknown };
  /** Reject `plugin:vault-delete|vault_delete` with this error (the
   *  PartialDelete → Continue terminal exit). */
  deleteError?: { kind: string };
  /** Canned recovery phrase words returned by `plugin:vault-creation|begin`
   *  (24 words). Defaults to 24× "ribbon" so the type-back challenge — which
   *  picks 4 RANDOM positions — is satisfiable by typing "ribbon" everywhere. */
  createPhrase?: string[];
  /** Canned `quick_unlock_status` (defaults to not-configured). A
   *  `quick_unlock_setup_*` / `quick_unlock_disable` call mutates the canned
   *  value so a settings toggle flip is reflected by the next status read. */
  quickUnlock?: { configured: boolean; method: "pin" | "biometric" | null; available: boolean };
  /** Reject `quick_unlock_with_biometric` with this `QuickUnlockError`. */
  biometricRedeemError?: { kind: string; detail?: unknown };
  /** Reject `quick_unlock_setup_biometric` with this `QuickUnlockError`. */
  biometricSetupError?: { kind: string };
  /** Canned pending watch captures returned ONCE by `captures|take_pending`
   *  (§9.18 Apple Watch drain). Each becomes a `note_create` + an `ack`. */
  pendingCaptures?: Array<{ id: string; text: string }>;
  /** Canned imported shares returned ONCE by
   *  `share-import|drain_pending_shares` (§9.19 OS share-sheet drain). The
   *  host-side drain does decrypt→import→ack, so the mock just returns the
   *  SYNC-9 confirmation list; a non-dedup entry drives the SF5 toast. */
  pendingShares?: Array<{ id: string; filename: string; deduplicated?: boolean }>;
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

    // Quick-unlock canned state — mutable so a setup/disable call is reflected
    // by the next `quick_unlock_status` read (the settings toggle round-trip).
    let quickUnlock = config.quickUnlock ?? { configured: false, method: null, available: false };

    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      // ── Boot / editor mount ──
      // freshDevice → boot to Welcome (no vaults, Empty slot); lockedVault →
      // boot to Unlock (one Exists vault, Empty slot); otherwise the Unlocked
      // slot shortcuts `initialStageFromProbe` straight to the editor.
      "plugin:vault-unlock|vault_list": () => {
        if (config.freshDevice) return [];
        if (config.corruptedVault) return [{ id: "flow-vault", status: { kind: "Corrupted" } }];
        if (config.multiVault)
          return [
            { id: "vault-personal", status: { kind: "Exists" }, label: "Personal", last_unlock: 0 },
            { id: "vault-work", status: { kind: "Exists" }, label: "Work", last_unlock: null },
          ];
        return [{ id: "flow-vault", status: { kind: "Exists" } }];
      },
      "plugin:vault-unlock|vault_slot_kind": () =>
        config.freshDevice || config.lockedVault || config.corruptedVault || config.multiVault ? "Empty" : "Unlocked",
      "plugin:vault-unlock|vault_is_unlocked": () => true,
      "plugin:vault-unlock|report_user_activity": () => null,
      "plugin:vault-unlock|unlock": () => {
        if (config.unlockError) throw config.unlockError;
        return null;
      },
      // ── Vault creation (5-step onboarding) ──
      // begin mints the phrase + account + session; commit persists and returns
      // the new vault id; cancel is the unmount best-effort. The phrase is 24×
      // the same word by default so the RANDOM 4-word type-back challenge is
      // satisfiable without reading which positions were picked.
      "plugin:vault-creation|begin": () => ({
        phrase: config.createPhrase ?? new Array(24).fill("ribbon"),
        session_token: "flow-session",
        account_number: "MY-4F2A-9C17-8E2D-1B5F-K",
      }),
      "plugin:vault-creation|commit": () => "flow-vault",
      "plugin:vault-creation|cancel": () => null,
      // ── Vault delete (lost-both-secrets escape) ──
      "plugin:vault-delete|vault_delete": () => {
        const w = window as unknown as { __vaultDeletes?: number };
        w.__vaultDeletes = (w.__vaultDeletes ?? 0) + 1;
        if (config.deleteError) throw config.deleteError;
        return null;
      },
      "plugin:prefs|prefs_read": () => DEFAULT_PREFS,
      "plugin:notes|note_list": () => config.noteIds ?? [],
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
      "plugin:quick-unlock|quick_unlock_with_pin": () => {
        if (config.pinRedeemError) throw config.pinRedeemError;
        return null;
      },
      "plugin:quick-unlock|quick_unlock_disable": () => {
        quickUnlock = { configured: false, method: null, available: false };
        return null;
      },
      // ── Apple Watch pending-capture surface (§9.18 drain) ──
      // note_create records the created body so a drain test can assert the
      // queued captures became notes; captures|take_pending returns the canned
      // pending set ONCE (then empty, mirroring a real take+ack draining the
      // queue); ack + seal_staged record their calls.
      "plugin:notes|note_create": (args) => {
        const w = window as unknown as { __noteCreates?: string[] };
        (w.__noteCreates ??= []).push(String(args.plaintext ?? ""));
        return "00000000-0000-7000-8000-000000000000";
      },
      "plugin:notes|note_update": (args) => {
        const w = window as unknown as { __noteUpdates?: string[] };
        (w.__noteUpdates ??= []).push(String(args.plaintext ?? ""));
        return null;
      },
      "plugin:notes|note_delete": (args) => {
        const w = window as unknown as { __noteDeletes?: string[] };
        (w.__noteDeletes ??= []).push(String(args.id ?? ""));
        return null;
      },
      "plugin:notes|note_read": () => "",
      "plugin:captures|seal_staged": () => {
        const w = window as unknown as { __sealStagedCalls?: number };
        w.__sealStagedCalls = (w.__sealStagedCalls ?? 0) + 1;
        return 0;
      },
      "plugin:captures|take_pending": () => {
        const w = window as unknown as { __pendingTaken?: boolean };
        if (w.__pendingTaken) return [];
        w.__pendingTaken = true;
        return config.pendingCaptures ?? [];
      },
      "plugin:captures|ack": (args) => {
        const w = window as unknown as { __captureAcks?: string[] };
        (w.__captureAcks ??= []).push(String(args.id ?? ""));
        return null;
      },
      // ── Share-import surface (§9.19 OS share-sheet drain) ──
      // drain_pending_shares returns the canned imported set ONCE (then empty,
      // mirroring a real host-side drain that acks each entry after import), and
      // records the number of drain calls.
      "plugin:share-import|drain_pending_shares": () => {
        const w = window as unknown as { __shareDrains?: number; __sharesTaken?: boolean };
        w.__shareDrains = (w.__shareDrains ?? 0) + 1;
        if (w.__sharesTaken) return [];
        w.__sharesTaken = true;
        return (config.pendingShares ?? []).map((s) => ({
          id: s.id,
          filename: s.filename,
          deduplicated: s.deduplicated ?? false,
        }));
      },
      "plugin:share-import|share_ack": (args) => {
        const w = window as unknown as { __shareAcks?: string[] };
        (w.__shareAcks ??= []).push(String(args.id ?? ""));
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
