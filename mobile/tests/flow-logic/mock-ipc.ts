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
import type { CustomThemeEntry } from "../../src/lib/themes";

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
  /** Canned `GET /account/status` projection (MYND-570). Omit for `null` — the
   *  no-route case. `0` ceilings mean unlimited, never a ceiling of zero. */
  accountStatus?: {
    stored_bytes: number;
    device_count: number;
    frozen: boolean;
    quota_bytes: number;
    max_devices: number;
  } | null;
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
  /** What `plugin:reminders|exact_alarm_status` answers (MYND-619). Defaults to
   *  `"not-applicable"` — the iOS / no-such-permission case, where the
   *  precise-delivery block renders nothing at all. */
  exactAlarm?: "exact" | "approximate" | "not-applicable";
  /** What the status becomes after the user returns from the platform screen —
   *  the granted case, which a mock cannot otherwise reach. */
  exactAlarmAfterRequest?: "exact" | "approximate" | "not-applicable";
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
  /** `qr-scan|scan` outcome (MYND-466 device-join QR). */
  qrScan?: { value: string | null };
  /** `sync_decode_join_qr` outcome. */
  qrDecode?: {
    endpoint_url: string;
    account_number: string;
    cert_pin_hex: string | null;
    pin_source: "self_host_tofu" | "hosted" | "self_host_no_pin";
    fresh: boolean;
  };
  qrDecodeError?: { kind: string };
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
  /** Make `note_create` / `note_update` PERSIST into the store `note_list` and
   *  `note_read` answer from, so a note written through the UI is subsequently
   *  readable — what a real host does.
   *
   *  Off by default, and that default is a known fiction: with writes discarded,
   *  a vault seeded empty STAYS empty, which is the only reason the dev-only
   *  spread (`maybeSeedTestData`, which fires on any vault of ≤1 note under
   *  `vite dev`) is invisible to the empty-vault specs. Flipping the default
   *  would surface that spread and rewrite what a dozen specs assert — its own
   *  change, on its own axis. Opt in where a spec genuinely needs to observe a
   *  write it made. */
  statefulNoteWrites?: boolean;
  /** Reject `note_read` for these ids (the failed-open flow). The list load's
   *  per-note read falls back to `""` on rejection, so a seeded row still
   *  renders — only the open itself fails. */
  noteReadErrorIds?: string[];
  /** Preseed saved views into `prefs_read`. The prefs store is STATEFUL —
   *  `upsert_saved_view` / `set_view_order` / `delete_saved_view` mutate it, so
   *  a view created through the UI appears on the next `usePrefs` re-read. */
  savedViews?: SavedView[];
  /** Seeded whole-vault task list (MYND-620). `vault_indices_tasks` returns it
   *  verbatim: Rust does no filtering, sorting or date comparison, so a test
   *  seeds the records and the surfaces do the rest. */
  tasks?: Record<string, unknown>[];
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
  /** Canned `plugin:themes|themes_list` entries (MYND-598) — each `{ name,
   *  palette }` exactly as the host's one-decrypt list surface hands them out,
   *  in `BTreeMap` (UTF-8 byte) order, so a test can seed unsorted names and
   *  assert the UI collates them. Mobile exposes no other themes command: the
   *  four authoring/egress ones are neither registered nor ACL-granted, so
   *  there is nothing else here to mock. */
  customThemes?: CustomThemeEntry[];
  /** Reject `plugin:prefs|set_custom_theme`. Both selection paths are
   *  disk-first, so this is what proves a failed write leaves the SCREEN
   *  unchanged too — the failure mode being guarded against is a phone showing
   *  one theme while `vault.prefs` names another. */
  customThemeWriteFails?: boolean;
  /** Canned `workspace_read` descriptor — the `vault.workspace` (MYW1) opaque
   *  JSON, or `null` for a vault that has never persisted one. The store is
   *  STATEFUL: a `workspace_write` replaces it (and is logged on
   *  `window.__workspaceWrites`), so a test can assert a restore-after-reopen
   *  round-trip rather than just the write payload (MYND-561). */
  workspaceDescriptor?: string | null;
  /** Canned `plugin:attachments|catalog_list` entries (MYND-563) — each a
   *  `CatalogEntry`-shaped `{ id, filename, content_type, size }`. Defaults to
   *  `[]`. Lets a transcription test seed an audio attachment for the
   *  Transcribe row to appear on. */
  catalog?: Array<{ id: string; filename: string; content_type: string; size: number }>;
  /** How `plugin:local-inference|transcribe` behaves (MYND-563). `text` →
   *  resolves with that transcript; `"not_ready"` / `"failed"` → rejects with
   *  that serialized `EngineError` kind. Defaults to resolving a canned string. */
  transcribe?: { text: string } | { error: "not_ready" | "failed" };
}

/** Install the mock IPC as an init script so it runs before the app's first paint. */
export async function installMockIpc(page: Page, cfg: MockConfig = {}): Promise<void> {
  await page.addInitScript((config: MockConfig) => {
    const DEFAULT_PREFS = {
      screen_capture_protection: false,
      // MYND-619: an absent key reads as ENABLED, matching the Rust default —
      // reading it as off would silently disable reminders on every vault.
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
      folder_icons: {},
      icon: null,
      hidden_bar_items: [],
      bar_items_order: [],
      right_panel_active_tab: null,
      right_panel_hidden_tabs: [],
      right_panel_tab_order: [],
      editor_toolbar_order: [],
      editor_toolbar_hidden: [],
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
    // Copied, not aliased: `note_create` / `note_update` mutate this store so
    // `note_list` and `note_read` answer from it (see those handlers).
    const seededNotes = [...(config.notes ?? [])];
    const noteText = new Map(seededNotes.map((n) => [n.id, n.text]));
    /** Next `note_create` id suffix — 0 reproduces the long-standing constant. */
    let mintedNotes = 0;
    // MYND-619 reminder state — STATEFUL for the same reason savedViews is: the
    // switch is only meaningful if a write survives into the next `prefs_read`.
    let remindersEnabled = (config.prefs?.reminders_enabled as boolean | undefined) ?? true;
    let reminderHorizonDays =
      (config.prefs?.reminder_horizon_days as number | null | undefined) ?? null;
    let exactAlarm: string = config.exactAlarm ?? "not-applicable";
    let savedViews: SavedView[] = config.savedViews ? [...config.savedViews] : [];
    let viewOrder: string[] = savedViews.map((v) => v.id);
    // MYND-548: device_names is STATEFUL for the same reason savedViews is — a
    // rename made through the UI must be visible to the next `prefs_read`, which
    // is what the real setter + nonce-bump round-trip does.
    const deviceNames: Record<string, string> = { ...(config.deviceNames ?? {}) };
    // Declared HERE, not at module scope: this callback is serialized into the
    // browser, so a Node-side const would be a ReferenceError at call time.
    const DEFAULT_DEVICE_ID = "aa11bb22cc33dd44ee55ff6677889900";

    // STATEFUL deliberate-folders store (MYND-560). An empty folder exists ONLY
    // as a `deliberate_folders` entry — no note carries its path — so a
    // create-folder flow test is meaningless unless the write survives into the
    // next `prefs_read`. Seeded from `prefs.deliberate_folders` so a test can
    // also start with a pre-existing empty folder (the "arrives via sync" case).
    let deliberateFolders: string[] = Array.isArray(config.prefs?.deliberate_folders)
      ? [...(config.prefs.deliberate_folders as string[])]
      : [];

    // STATEFUL favorites list (MYND-597). The favorites strip pulls a favorited
    // note out of the list, and un-favoriting from the strip's long-press sheet
    // must return it — which only works if `set_favorites` survives into the next
    // `prefs_read`, exactly like the real setter + nonce-bump round-trip.
    let favorites: string[] = Array.isArray(config.prefs?.favorites)
      ? [...(config.prefs.favorites as string[])]
      : [];

    // STATEFUL vault.workspace descriptor (MYND-561). The opaque JSON string the
    // frontend seals into MYW1; `workspace_read` hands back whatever the last
    // `workspace_write` staged, so a "reopen the app" assertion can re-read the
    // persisted folder-expand set instead of trusting a write payload alone.
    let workspaceDescriptor: string | null = config.workspaceDescriptor ?? null;

    // STATEFUL format-bar layout (MYND-555). Both fields are whole-value setters
    // and the panel writes optimistically, so a customize flow test is only
    // meaningful if the write survives into the next `prefs_read` — otherwise the
    // seeded value would keep winning and the live bar would never change.
    let toolbarOrder: string[] = Array.isArray(config.prefs?.editor_toolbar_order)
      ? [...(config.prefs.editor_toolbar_order as string[])]
      : [];
    let toolbarHidden: string[] = Array.isArray(config.prefs?.editor_toolbar_hidden)
      ? [...(config.prefs.editor_toolbar_hidden as string[])]
      : [];

    // STATEFUL custom-theme selection (MYND-598). The Appearance rows write it
    // and the next `prefs_read` is what marks the applied row, so a non-stateful
    // mock would let a persistence assertion pass against behaviour the device
    // would never produce: the seed would keep winning and the write would look
    // like a no-op on re-read.
    let customTheme: string | null = (config.prefs?.custom_theme as string | null | undefined) ?? null;
    // STATEFUL vault icon (vault-icons). Same argument as custom_theme above,
    // with one extra reason: the catch-all at the bottom of this table resolves
    // an UNMOCKED command to `[]`, so without a real handler + store a picker
    // test would pass against its own optimistic draft and prove nothing.
    let vaultIcon: string | null = (config.prefs?.icon as string | null | undefined) ?? null;
    // STATEFUL item_order MAP (MYND-596). The whole-map setter is written
    // optimistically by the move-up/move-down affordance, so a reopen round-trip
    // is only meaningful if the write survives into the next `prefs_read` —
    // exactly like the favorites/toolbar stores above. Seeded from
    // `config.prefs.item_order` so a test can start with a pre-existing order.
    let itemOrder: Record<string, string[]> =
      config.prefs?.item_order && typeof config.prefs.item_order === "object"
        ? { ...(config.prefs.item_order as Record<string, string[]>) }
        : {};

    // Index-feed ledger (myne-mobile#41). Every read + index write the editor
    // performs is recorded here so a test can assert on the SHAPE of the feed,
    // not just its outcome. That matters because the bug this exists to catch is
    // invisible from the UI: saving one note used to re-read, re-parse and
    // re-index the whole vault, and every screen still looked correct while it
    // did. Counting is the only way a scenario can see it.
    const feed = (): {
      noteReads: string[];
      indicesApplies: string[];
      indicesRemoves: string[];
      searchReplaces: number[];
      searchApplies: string[][];
      searchRemoves: string[];
    } => {
      const w = window as unknown as { __indexFeed?: ReturnType<typeof feed> };
      return (w.__indexFeed ??= {
        noteReads: [],
        indicesApplies: [],
        indicesRemoves: [],
        // One entry per whole-corpus replace, holding the doc count it carried.
        searchReplaces: [],
        searchApplies: [],
        searchRemoves: [],
      });
    };

    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      // ── Boot / editor mount ──
      // freshDevice → boot to Welcome (no vaults, Empty slot); lockedVault →
      // boot to Unlock (one Exists vault, Empty slot); otherwise the Unlocked
      // slot shortcuts `initialStageFromProbe` straight to the editor.
      "plugin:vault-unlock|vault_list": () => {
        if (config.freshDevice) return [];
        if (config.corruptedVault) return [{ id: "flow-vault", status: { kind: "Corrupted" } }];
        // `icon: null` on both rows is STRUCTURAL, not a shortcut: multiVault
        // boots to the pre-unlock picker, and the icon is encrypted-only
        // (SYNC-3), so no vault can have a glyph in the RAM cache there.
        if (config.multiVault)
          return [
            { id: "vault-personal", status: { kind: "Exists" }, label: "Personal", icon: null, last_unlock: 0 },
            { id: "vault-work", status: { kind: "Exists" }, label: "Work", icon: null, last_unlock: null },
          ];
        // The default branch IS the unlocked vault, so it projects the stateful
        // icon store — the honest model of the per-session RAM icon cache.
        return [{ id: "flow-vault", status: { kind: "Exists" }, icon: vaultIcon }];
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
        // Spread AFTER `config.prefs` — once a setter runs the stateful store
        // owns these fields, else the seed would keep winning and a write made
        // through the UI would appear to no-op on the next read.
        deliberate_folders: deliberateFolders,
        favorites,
        reminders_enabled: remindersEnabled,
        reminder_horizon_days: reminderHorizonDays,
        device_names: { ...deviceNames },
        editor_toolbar_order: toolbarOrder,
        editor_toolbar_hidden: toolbarHidden,
        custom_theme: customTheme,
        item_order: itemOrder,
        icon: vaultIcon,
      }),
      // Format-bar layout setters (MYND-555): record the write AND mutate the
      // store. `order` is a verbatim sequence; `hidden` is sorted+deduped by the
      // real Rust codec, so mirror that here or the mock would let a test pass
      // against an ordering the device would never return.
      // ── Task reminders (MYND-619) ──────────────────────────────────────
      "plugin:prefs|set_reminders_enabled": (args) => {
        const enabled = Boolean(args.enabled);
        const w = window as unknown as { __remindersEnabledWrites?: boolean[] };
        (w.__remindersEnabledWrites ??= []).push(enabled);
        remindersEnabled = enabled;
        return null;
      },
      "plugin:prefs|set_reminder_horizon_days": (args) => {
        reminderHorizonDays = (args.days ?? null) as number | null;
        return null;
      },
      // The precise-alarm surface. `config.exactAlarm` seeds what the platform
      // answers; opening the settings screen is RECORDED rather than simulated,
      // because a mock cannot leave the app — `exactAlarmAfterRequest` is how a
      // test drives the granted-and-came-back case.
      "plugin:reminders|exact_alarm_status": () => exactAlarm,
      "plugin:reminders|request_exact_alarm": () => {
        const w = window as unknown as { __exactAlarmRequests?: number };
        w.__exactAlarmRequests = (w.__exactAlarmRequests ?? 0) + 1;
        if (config.exactAlarmAfterRequest) exactAlarm = config.exactAlarmAfterRequest;
        return null;
      },
      "plugin:prefs|set_editor_toolbar_order": (args) => {
        const order = (args.order ?? []) as string[];
        const w = window as unknown as { __toolbarOrderWrites?: string[][] };
        (w.__toolbarOrderWrites ??= []).push([...order]);
        toolbarOrder = [...order];
        return null;
      },
      "plugin:prefs|set_editor_toolbar_hidden": (args) => {
        const items = (args.items ?? []) as string[];
        const w = window as unknown as { __toolbarHiddenWrites?: string[][] };
        (w.__toolbarHiddenWrites ??= []).push([...items]);
        toolbarHidden = [...new Set(items)].sort();
        return null;
      },
      // Whole-set setter (MYND-560): record the write AND mutate the store, so
      // the created empty folder is present on the nonce-bumped re-read.
      "plugin:prefs|set_deliberate_folders": (args) => {
        const folders = (args.folders ?? []) as string[];
        const w = window as unknown as { __deliberateFolderWrites?: string[][] };
        (w.__deliberateFolderWrites ??= []).push([...folders]);
        deliberateFolders = [...folders];
        return null;
      },
      // Whole-list favorites setter (MYND-597): record the write AND mutate the
      // store, so un-favoriting from the strip's long-press sheet returns the
      // note to the list on the nonce-bumped re-read. Payload key is `order`.
      "plugin:prefs|set_favorites": (args) => {
        const order = (args.order ?? []) as string[];
        const w = window as unknown as { __favoriteWrites?: string[][] };
        (w.__favoriteWrites ??= []).push([...order]);
        favorites = [...order];
        return null;
      },
      // ── Custom themes (vault.themes MYT1, read-only on mobile) ──
      // The call is COUNTED: the list entries already carry each palette, so a
      // second list (or a `themes_read`) to fetch one on apply is the mistake
      // the count exists to catch.
      "plugin:themes|themes_list": () => {
        const w = window as unknown as { __themesListCalls?: number };
        w.__themesListCalls = (w.__themesListCalls ?? 0) + 1;
        return config.customThemes ?? [];
      },
      // Mirror the ACL: the four authoring/egress commands are neither
      // registered nor granted on mobile, so on a device they REJECT. Mocking
      // them as rejections rather than leaving them to the unknown-command `[]`
      // fallback is what makes "the UI never calls one" a real assertion.
      ...Object.fromEntries(
        ["themes_read", "themes_import", "themes_export", "themes_delete"].map((cmd) => [
          `plugin:themes|${cmd}`,
          () => {
            throw `not allowed by ACL: ${cmd} is not granted on mobile`;
          },
        ]),
      ),
      // The custom-theme selection setter — records the write AND mutates the
      // store, so the applied row survives into the nonce-bumped re-read exactly
      // as the real setter + `bumpPrefsNonce()` round-trip does.
      "plugin:prefs|set_custom_theme": (args) => {
        const name = (args.customTheme ?? null) as string | null;
        if (config.customThemeWriteFails) throw { kind: "IoError" };
        const w = window as unknown as { __customThemeWrites?: (string | null)[] };
        (w.__customThemeWrites ??= []).push(name);
        customTheme = name;
        return null;
      },
      // The vault-icon setter (vault-icons) — records the write AND mutates the
      // store, so the chosen glyph survives into the nonce-bumped re-read and a
      // sheet-remount assertion sees disk truth rather than the optimistic draft
      // it just dropped. Payload key is the bare `icon` (single-word field, so
      // camelCase is a no-op on every transport).
      "plugin:prefs|vault_set_icon": (args) => {
        const name = (args.icon ?? null) as string | null;
        const w = window as unknown as { __vaultIconWrites?: (string | null)[] };
        (w.__vaultIconWrites ??= []).push(name);
        vaultIcon = name;
        return null;
      },
      // Whole-map item_order setter (MYND-596): record the write AND mutate the
      // store, so a move-up/move-down survives into the nonce-bumped re-read and
      // a "reopen the app" assertion sees the persisted order. Payload key is
      // `order` (a container-keyed map), matching the Rust command's BTreeMap.
      "plugin:prefs|set_item_order": (args) => {
        const order = (args.order ?? {}) as Record<string, string[]>;
        const w = window as unknown as { __itemOrderWrites?: Record<string, string[]>[] };
        (w.__itemOrderWrites ??= []).push({ ...order });
        itemOrder = { ...order };
        return null;
      },
      // ── Workspace-state persistence (vault.workspace MYW1 descriptor) ──
      // MYND-561: mobile's folder-expand set rides this blob. Stateful + write
      // log, mirroring the graph-layout pair above.
      "plugin:workspace|workspace_read": () => workspaceDescriptor,
      "plugin:workspace|workspace_write": (args) => {
        const descriptor = String(args.descriptor ?? "");
        const w = window as unknown as { __workspaceWrites?: string[] };
        (w.__workspaceWrites ??= []).push(descriptor);
        workspaceDescriptor = descriptor;
        return null;
      },
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
      // fall back to the drawing flow's `noteIds`-only seed. Notes minted by
      // `note_create` land in `seededNotes`, so they appear here either way —
      // the union matters for the `noteIds`-only specs, whose seed is not in
      // that store and must not be displaced by the first create.
      "plugin:notes|note_list": () => {
        const stored = seededNotes.map((n) => n.id);
        const base =
          (config.notes ?? []).length > 0 ? stored : [...(config.noteIds ?? []), ...stored];
        return [...new Set(base)];
      },
      // ── Vault-indices graph surface ──
      // Default [] keeps `backendEdges` an empty dump (degree-0 graph); the
      // graph flow sets `backendEdgesUnavailable` so the sweep rejects and
      // EditorFlow falls back to `clientEdges` over the seeded bodies.
      "plugin:vault-indices|vault_indices_all_edges": () => {
        if (config.backendEdgesUnavailable) throw { kind: "unavailable" };
        return [];
      },
      // ── Index feed (myne-mobile#41) ──
      // These five are COUNTED. Both indices take per-note deltas, so the number
      // of calls a single save produces IS the contract: one apply, not one per
      // note in the vault. Mocking them explicitly rather than leaving them to
      // the unknown-command `[]` fallback is what makes the count assertable.
      "plugin:vault-indices|vault_indices_apply": (args) => {
        feed().indicesApplies.push(String(args.noteId ?? ""));
        return null;
      },
      "plugin:vault-indices|vault_indices_remove": (args) => {
        feed().indicesRemoves.push(String(args.noteId ?? ""));
        return null;
      },
      "plugin:search|search_index_replace": (args) => {
        feed().searchReplaces.push(((args.docs ?? []) as unknown[]).length);
        return null;
      },
      "plugin:search|search_index_apply": (args) => {
        const docs = (args.docs ?? []) as Array<{ id?: string }>;
        feed().searchApplies.push(docs.map((d) => String(d.id ?? "")));
        return null;
      },
      "plugin:search|search_index_remove": (args) => {
        feed().searchRemoves.push(...((args.ids ?? []) as unknown[]).map(String));
        return null;
      },
      // ── Graph-layout persistence (vault.graph MYG1 cache) ──
      "plugin:graph-layout|graph_layout_read": () => config.graphLayoutPayload ?? null,
      "plugin:graph-layout|graph_layout_write": (args) => {
        const w = window as unknown as { __graphLayoutWrites?: string[] };
        (w.__graphLayoutWrites ??= []).push(String(args.payload ?? ""));
        return null;
      },
      // ── Vault-indices property surface (saved-view property conditions) ──
      // MYND-620: the whole-vault task dump. Unparameterized on purpose — a
      // parameterized accessor would move the §3.6.4 type authority out of the
      // dialect layer, so every surface filters the one list.
      "plugin:vault-indices|vault_indices_tasks": () => config.tasks ?? [],
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
      "plugin:attachments|catalog_list": () => config.catalog ?? [],
      "plugin:attachments|attachment_unused_list": () => [],
      "plugin:attachments|attachment_refs_apply": () => null,
      "plugin:attachments|attachment_refs_remove": () => null,
      // On-device transcription (MYND-563). Resolves with a canned transcript by
      // default, or rejects with a serialized `EngineError` kind so the
      // not-ready / failed UI branches are exercised. The streaming `onSegment`
      // channel is ignored here — the TranscribeRow renders from the resolved
      // `done` promise, so a canned final transcript is enough for flow logic.
      "plugin:local-inference|transcribe": () => {
        const c = config.transcribe;
        if (c && "error" in c) {
          const kind = c.error === "not_ready" ? "NotReady" : "TranscriptionFailed";
          throw { kind };
        }
        return c && "text" in c ? c.text : "the quick brown fox";
      },
      "plugin:local-inference|read_transcript": () => null,
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
      // Both writers persist only under `statefulNoteWrites` — see that flag for
      // why the default discards. Ids are minted in the UUIDv7 shape the real
      // command returns, the first one keeping the constant the single-create
      // specs already assert on.
      "plugin:notes|note_create": (args) => {
        const w = window as unknown as { __noteCreates?: string[] };
        const text = String(args.plaintext ?? "");
        (w.__noteCreates ??= []).push(text);
        const id = `00000000-0000-7000-8000-${String(mintedNotes++).padStart(12, "0")}`;
        if (config.statefulNoteWrites === true) {
          seededNotes.push({ id, text });
          noteText.set(id, text);
        }
        return id;
      },
      "plugin:notes|note_update": (args) => {
        const w = window as unknown as { __noteUpdates?: string[] };
        const text = String(args.plaintext ?? "");
        (w.__noteUpdates ??= []).push(text);
        const id = String(args.noteId ?? "");
        if (config.statefulNoteWrites === true) {
          const row = seededNotes.find((n) => n.id === id);
          if (row !== undefined) row.text = text;
          if (noteText.has(id)) noteText.set(id, text);
        }
        return null;
      },
      "plugin:notes|note_delete": (args) => {
        const w = window as unknown as { __noteDeletes?: string[] };
        (w.__noteDeletes ??= []).push(String(args.id ?? ""));
        return null;
      },
      "plugin:notes|note_read": (args) => {
        const id = String(args.noteId ?? "");
        feed().noteReads.push(id);
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
      // `null` (the default) = no /account/status route — the usage section is
      // omitted entirely, which is the self-hosted / older-server case.
      "plugin:sync|sync_account_status": () => config.accountStatus ?? null,
      "plugin:sync|sync_approve_device": () => null,
      "plugin:sync|sync_remove_device": () => null,
      "plugin:sync|sync_reset_local": () => null,
      "plugin:sync|sync_head_fingerprint": () => config.headFingerprint ?? "TYRS-N318",
      "plugin:sync|sync_pending_conflicts": () => config.pendingConflicts ?? [],
      "plugin:sync|sync_enroll": (args) => {
        // Record the payload so a flow test can assert what the form forwarded.
        // MYND-548: the device name goes to the CORE (which parks it and applies
        // it in a later prefs phase), so "did the name reach the command" is the
        // only half this mocked tier can honestly verify.
        (window as unknown as { __enrollArgs?: unknown }).__enrollArgs = args;
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
      "plugin:qr-scan|scan": () => config.qrScan ?? { value: null },
      "plugin:sync|sync_decode_join_qr": () => {
        if (config.qrDecodeError) throw config.qrDecodeError;
        return (
          config.qrDecode ?? {
            endpoint_url: "https://sync.example.com",
            account_number: "4K7P9RH2JR3T8XW6VZ0A",
            cert_pin_hex: null,
            pin_source: "self_host_no_pin",
            fresh: true,
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
      // `convertFileSrc(id, "attachment")` (the audio tile's `<audio src>` +
      // image thumbnails) routes through here; without it rendering an
      // attachment row throws. Return a deterministic fake URL — the bytes are
      // never fetched headlessly (MYND-563: needed to render an audio row).
      convertFileSrc: (path: string, protocol = "asset") => `${protocol}://localhost/${path}`,
    };

    // `@tauri-apps/api/event` (used by, e.g., the `attachment://` audio tile and
    // any component that `listen()`s) routes through a SEPARATE global. Without
    // it, an `unlisten()` on unmount throws `Cannot read properties of undefined
    // (reading 'unregisterListener')` and blanks the surface. Stub it as no-ops
    // so any event-using component renders headlessly (MYND-563: needed to render
    // an audio attachment row in the Files library).
    (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => undefined,
    };
  }, cfg);
}
