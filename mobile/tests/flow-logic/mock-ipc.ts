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
import type { SavedView } from "../../src/lib/prefs";

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
  /** Per-note bodies `note_read` returns, keyed by note id. A body carrying
   *  `folder:` frontmatter builds the folder tree (folder-decoration display
   *  tests). Absent ids fall back to "". */
  noteBodies?: Record<string, string>;
  /** Shallow-merged over the default prefs by `prefs_read` — seed e.g.
   *  `folder_icons` / `item_colors` so a display test asserts the row renders
   *  the assigned glyph / color dot. */
  prefs?: Record<string, unknown>;
  endpoint?: { endpoint_url: string | null; cert_pin_hex: string | null; pin_source: "static" | "tofu" | null };
  setEndpoint?: { fingerprint: string | null; pin_source: "static" | "tofu" | null };
  devices?: MockDevice[];
  /** `sync_enroll` outcome — `{ approved }` on success, or a `{ kind }` error to reject. */
  enrollResult?: { approved: boolean; device_id_hex?: string };
  /** Seed `prefs.device_names` (MYND-548) — `device_id` hex → display name. */
  deviceNames?: Record<string, string>;
  /** What `prefs|device_platform` reports (MYND-548). Defaults to `"ios"`. */
  devicePlatform?: string;
  enrollError?: { kind: string };
  headFingerprint?: string | null;
  pendingConflicts?: string[];
  /** Boot to the Welcome screen (empty slot + no vaults) instead of straight to
   *  the editor — for the fresh-device join flow. */
  freshDevice?: boolean;
  /** `sync_join_account` outcome. */
  joinResult?: { vault_id: string; pending: boolean; fingerprint: string | null; device_id_hex?: string };
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
   *  `share-import|drain_pending_shares` (§9.20 OS share-sheet drain). The
   *  host-side drain does decrypt→import→ack, so the mock just returns the
   *  SYNC-9 confirmation list; a non-dedup entry drives the SF5 toast. */
  pendingShares?: Array<{ id: string; filename: string; deduplicated?: boolean }>;
  /** Seed the note list — `note_list` returns these ids and `note_read` returns
   *  the matching `text` (raw frontmatter + body). For the saved-view render
   *  flow: the view's filter runs over these live notes. */
  notes?: Array<{ id: string; text: string }>;
  /** Reject `note_read` for these ids (the failed-open flow). The list load's
   *  per-note read falls back to `""` on rejection, so a seeded row still
   *  renders — only the open itself fails. */
  noteReadErrorIds?: string[];
  /** Preseed saved views into `prefs_read`. The prefs store is STATEFUL —
   *  `upsert_saved_view` / `set_view_order` / `delete_saved_view` mutate it, so
   *  a view created through the UI appears on the next `usePrefs` re-read. */
  savedViews?: SavedView[];
  /** Canned `vault_indices_property_keys` — the view editor's property /
   *  groupBy / sort / column picker universe. */
  propertyKeys?: string[];
  /** Canned `vault_indices_property_values`, keyed by property key: the
   *  `[noteId, StoredProperty]` pairs the query engine's property resolver
   *  reads (a property-filtered view matches nothing without it). */
  propertyValues?: Record<
    string,
    Array<[string, { key: string; type: string; value?: string; elements?: Array<{ type: string; value: string }> }]>
  >;
  /** Make `vault_indices_all_edges` reject so the graph falls back to
   *  client-extracted wikilink edges over the seeded `notes` bodies (the graph
   *  flow's edge source — real extraction, no canned edge dump to drift). */
  backendEdgesUnavailable?: boolean;
  /** Canned `graph_layout_read` payload — the encrypted `vault.graph` cache's
   *  plaintext (`{"v":1,"pos":[[id,x,y],…]}`), or `null` for a cold vault.
   *  Writes are recorded on `window.__graphLayoutWrites` (payload strings). */
  graphLayoutPayload?: string | null;
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

    // Seeded notes + a STATEFUL saved-views store (so a view created through the
    // UI persists into the next `prefs_read`, mirroring the real prefs setter +
    // nonce-bump round-trip). `note_read` looks the body up by id.
    const seededNotes = config.notes ?? [];
    const noteText = new Map(seededNotes.map((n) => [n.id, n.text]));
    let savedViews: SavedView[] = config.savedViews ? [...config.savedViews] : [];
    let viewOrder: string[] = savedViews.map((v) => v.id);
    // MYND-548: device_names is STATEFUL for the same reason savedViews is — a
    // rename made through the UI must be visible to the next `prefs_read`, which
    // is what the real setter + nonce-bump round-trip does.
    const deviceNames: Record<string, string> = { ...(config.deviceNames ?? {}) };
    // Declared HERE, not at module scope: this callback is serialized into the
    // browser, so a Node-side const would be a ReferenceError at call time.
    const DEFAULT_DEVICE_ID = "aa11bb22cc33dd44ee55ff6677889900";

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
      "plugin:prefs|prefs_read": () => ({
        ...DEFAULT_PREFS,
        ...(config.prefs ?? {}),
        saved_views: savedViews,
        view_order: viewOrder,
        device_names: { ...deviceNames },
      }),
      // Record whole-map decoration writes (MYND-516) so a flow test asserts a
      // pick invoked the setter with the spliced key — the `__voiceImports` /
      // `__noteCreates` capture pattern. The payload keys mirror the Rust
      // command params: set_folder_icons({ icons }) / set_item_colors({ colors }).
      "plugin:prefs|set_folder_icons": (args) => {
        const w = window as unknown as { __folderIconWrites?: Array<Record<string, string>> };
        (w.__folderIconWrites ??= []).push((args.icons ?? {}) as Record<string, string>);
        return null;
      },
      "plugin:prefs|set_item_colors": (args) => {
        const w = window as unknown as { __itemColorWrites?: Array<Record<string, string>> };
        (w.__itemColorWrites ??= []).push((args.colors ?? {}) as Record<string, string>);
        return null;
      },
      "plugin:prefs|upsert_saved_view": (args) => {
        const view = args.view as SavedView;
        const i = savedViews.findIndex((v) => v.id === view.id);
        if (i >= 0) savedViews[i] = view;
        else savedViews.push(view);
        return null;
      },
      "plugin:prefs|set_view_order": (args) => {
        viewOrder = (args.order as string[] | undefined) ?? [];
        return null;
      },
      "plugin:prefs|delete_saved_view": (args) => {
        const id = String(args.id ?? "");
        savedViews = savedViews.filter((v) => v.id !== id);
        viewOrder = viewOrder.filter((x) => x !== id);
        return null;
      },
      // note_list: prefer the richer `notes` seed (id + body for the view render);
      // fall back to the drawing flow's `noteIds`-only seed.
      "plugin:notes|note_list": () =>
        seededNotes.length > 0 ? seededNotes.map((n) => n.id) : config.noteIds ?? [],
      // ── Vault-indices graph surface ──
      // Default [] keeps `backendEdges` an empty dump (degree-0 graph); the
      // graph flow sets `backendEdgesUnavailable` so the sweep rejects and
      // EditorFlow falls back to `clientEdges` over the seeded bodies.
      "plugin:vault-indices|vault_indices_all_edges": () => {
        if (config.backendEdgesUnavailable) throw { kind: "unavailable" };
        return [];
      },
      // ── Graph-layout persistence (vault.graph MYG1 cache) ──
      "plugin:graph-layout|graph_layout_read": () => config.graphLayoutPayload ?? null,
      "plugin:graph-layout|graph_layout_write": (args) => {
        const w = window as unknown as { __graphLayoutWrites?: string[] };
        (w.__graphLayoutWrites ??= []).push(String(args.payload ?? ""));
        return null;
      },
      // ── Vault-indices property surface (saved-view property conditions) ──
      "plugin:vault-indices|vault_indices_property_keys": () => config.propertyKeys ?? [],
      "plugin:vault-indices|vault_indices_property_values": (args) =>
        config.propertyValues?.[String(args.key ?? "")] ?? [],
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
      "plugin:notes|note_read": (args) => {
        const id = String(args.noteId ?? "");
        if (config.noteReadErrorIds?.includes(id)) throw { kind: "Io", detail: { io_error_kind: "NotFound" } };
        return noteText.get(id) ?? config.noteBodies?.[id] ?? "";
      },
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
      // ── Share-import surface (§9.20 OS share-sheet drain) ──
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
      // MYND-548 device naming. The setter mirrors the real one's contract: a
      // blank name is refused (no write), so an empty submit cannot blank a row.
      "plugin:prefs|set_device_name": (args) => {
        const id = args.deviceIdHex as string;
        const name = (args.name as string).trim();
        if (name !== "") deviceNames[id] = name;
        return null;
      },
      "plugin:prefs|device_platform": () => config.devicePlatform ?? "ios",
      "plugin:sync|sync_list_devices": () => config.devices ?? [],
      "plugin:sync|sync_approve_device": () => null,
      "plugin:sync|sync_remove_device": () => null,
      "plugin:sync|sync_reset_local": () => null,
      "plugin:sync|sync_head_fingerprint": () => config.headFingerprint ?? "TYRS-N318",
      "plugin:sync|sync_pending_conflicts": () => config.pendingConflicts ?? [],
      "plugin:sync|sync_enroll": () => {
        if (config.enrollError) throw config.enrollError;
        return { approved: false, device_id_hex: DEFAULT_DEVICE_ID, ...config.enrollResult };
      },
      "plugin:sync|sync_join_account": () => {
        if (config.joinError) throw config.joinError;
        return (
          config.joinResult ?? {
            vault_id: "flow-vault",
            pending: true,
            fingerprint: null,
            device_id_hex: DEFAULT_DEVICE_ID,
          }
        );
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
