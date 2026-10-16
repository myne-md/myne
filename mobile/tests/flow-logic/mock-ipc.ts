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
  /** Make `set_timezone` REJECT, so a spec can drive the persist-failure
   *  path: the row has to put the stored value back rather than keep the one
   *  that did not land (myne-md/myne#609). */
  timezoneWriteFails?: boolean;
  endpoint?: { endpoint_url: string | null; cert_pin_hex: null; pin_source: "platform_trust_store" | null };
  setEndpoint?: { fingerprint: null; pin_source: "platform_trust_store" | null };
  devices?: MockDevice[];
  /** `sync_enroll` outcome — `{ approved }` on success, or a `{ kind }` error to reject. */
  enrollResult?: { approved: boolean; device_id_hex?: string };
  /** Seed `prefs.device_names` (MYND-548) — `device_id` hex → display name. */
  deviceNames?: Record<string, string>;
  /** What `prefs|device_platform` reports (MYND-548). Defaults to `"ios"`. */
  devicePlatform?: string;
  enrollError?: { kind: string };
  /** What `sync|sync_head_fingerprint` answers. A single value answers forever;
   *  an ARRAY is a sequence that shifts once per read and then sticks on its
   *  last element — the shape needed to model a head that ADVANCES mid-ceremony
   *  (myne#462), which a scalar cannot express and which is exactly the case
   *  that broke. Same semantics as the desktop harness's `mountWith`. */
  headFingerprint?: string | null | Array<string | null>;
  pendingConflicts?: string[];
  /** Boot to the Welcome screen (empty slot + no vaults) instead of straight to
   *  the editor — for the fresh-device join flow. */
  freshDevice?: boolean;
  /** `sync_join_account` outcome. */
  joinResult?: { vault_id: string; pending: boolean; fingerprint: string | null; device_id_hex?: string };
  joinError?: { kind: string };
  // ── The person plane (myne-md/myne#851 tasks 14 and 15) ──────────────────
  /** `sync_person_status`. The default is an unenrolled device, which is what
   *  drops the identity flow on its gate step. */
  personStatus?: {
    enrolled: boolean;
    identity_unlocked: boolean;
    person_id_hex: string | null;
    identity_code: string | null;
    sealed_keypair_present: boolean;
  };
  /** `sync_person_list_invites`: the pending-invite roster the identity home
   *  renders. One row is what puts an `Open` control on screen at all. */
  personInvites?: Array<{ invite_id_hex: string; vault_account_hash_hex: string; claimed: boolean }>;
  /** `sync_person_setup` outcome — the identity-only setup behind the gate's
   *  create and recover doors. `phrase: null` in the RESULT is what tells the flow
   *  it recovered (the backend returns a phrase only when it generated one), so a
   *  spec driving the recover door sets it to `null` deliberately.
   *
   *  ABSENT IS A REFUSAL, not a benign default, and the refusal is the kind the
   *  real backend gives a device with no endpoint configured. A stub that
   *  "succeeded" here would hand a spec a session nobody configured and make the
   *  gate look like it worked for a reason that is this file's invention; the
   *  neighbour `sync_list_roster` refuses by default for the same reason. */
  personSetupResult?: {
    phrase: string | null;
    fingerprint_hex: string;
    person_id_hex: string;
    identity_code: string;
    approved: boolean;
  };
  /** `sync_person_setup` refusal, e.g. `{ kind: "BadRequest" }` for the
   *  non-distinguishing wrong-phrase arm. */
  personSetupError?: { kind: string };
  /** `sync_person_accept_invite` refusal. Absent = the accept lands, and the mock
   *  then reports the accepted vault from `vault_list`, which is what makes the
   *  re-probe reach the editor. */
  acceptInviteError?: { kind: string };
  /** `sync_member_join_vault` refusal, the SECOND-DEVICE path (myne-md/myne#852
   *  task 7). Absent = the join lands. Kept apart from `acceptInviteError` on
   *  purpose: the two commands answer different questions and a spec that could
   *  not refuse one without the other could not tell which command the phone
   *  reached. */
  memberJoinError?: { kind: string };
  /** `sync_list_roster`: the one answer the name step asks for, and the mobile
   *  Members panel's only source. `null` (the default) makes the read REJECT,
   *  the arm the gate has to survive by asking rather than by skipping. */
  roster?: {
    members: Array<{
      fingerprint_hex: string;
      is_self: boolean;
      display_name: string;
      name_state: "absent" | "unverified" | "verified";
      role: "owner" | "member";
      previous_fingerprint_hex: string | null;
      continuity: string | null;
    }>;
    authority: string;
    group_key_epoch: number;
  } | null;
  /** `member_names_set_mine` refusal, mapped to a message by the SHARED
   *  `@myne/client-core/member-name` switch rather than by a copy of it. */
  memberNameError?: { kind: string };
  /** `qr-scan|scan` outcome (MYND-466 device-join QR). */
  qrScan?: { value: string | null };
  /** `qr-scan|scan` REFUSAL. The plugin's non-iOS arm answers
   *  `Error::Unsupported` (`mobile/src-tauri/tauri-plugin-qr-scan`), so every
   *  Android build and every desktop-hosted mobile shell takes this path — and
   *  it is the only one where "Scan" is a button that appears to do nothing
   *  unless the flow says why. Distinct from `qrDecodeError`, which is a bad
   *  PAYLOAD from a scanner that worked. */
  qrScanError?: { kind: string };
  /** `sync_decode_join_qr` outcome, tagged by `kind` exactly as Rust's
   *  `JoinQrView` is. `account` is the owner's device-join — the account number is
   *  what the confirm step shows and the password is what it asks for.
   *  `member_vault` names a shared vault this person is already a member of, being
   *  added to THIS device: there is no account number to show, and the flow hands
   *  the target to the identity join wizard instead (myne-md/myne). */
  qrDecode?:
    | {
        kind: "account";
        endpoint_url: string;
        account_number: string;
        fresh: boolean;
      }
    | {
        kind: "member_vault";
        endpoint_url: string;
        account_hash_hex: string;
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
  /** Canned drained watch meeting sessions (myne-md/myne#812). `drain_pending_meetings`
   *  returns these ONCE (then empty, mirroring a real drain+ack clearing the
   *  manifest); `ack_meeting_session` records the acked session ids. Each chunk
   *  is transcribed through `transcribe`, so one session → one note whose body is
   *  the three embeds + the transcript. */
  pendingMeetings?: Array<{
    session_id: string;
    started_at: number;
    chunks: Array<{ chunk_index: number; attachment_id: string }>;
    missing_chunk_indices?: number[];
    retryable_chunk_indices?: number[];
    /** A note a previous drain already wrote for this session (myne-md/myne#812
     *  review): a re-drain APPENDS to it instead of creating a second note.
     *  `set_meeting_session_note` records one too, and that takes precedence. */
    note_id?: string | null;
  }>;
  /** Reject the first N `captures|ack_meeting_session` calls (myne-md/myne#812).
   *  Drives the crash-after-note-before-ack path: the note is created, the ack
   *  fails, and the next drain re-returns the session — the rare duplicate. */
  meetingAckFailures?: number;
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
  /** Seeded whole-vault heading rows (myne-md/myne#452). `vault_indices_headings`
   *  returns them verbatim, trash-blind exactly as Rust does, so a spec can seed a
   *  row for a note that is NOT resident and assert the client-side join drops it.
   *  Rows carry no note title or folder by design; the join supplies both. */
  vaultHeadings?: Array<{ noteId: string; text: string; level: number }>;
  /** Seeded whole-vault block-anchor rows (myne-md/myne#452). Trash-blind exactly
   *  as Rust is, like the heading rows above, so a spec can seed a row for a note
   *  that is NOT resident and assert `joinVaultBlockAnchors` drops it. The rows
   *  carry a `noteTitle` and `noteFolder` of their own; the join discards both in
   *  favour of the resident note's, so seeding a row with a STALE title is how a
   *  spec asserts that. */
  vaultBlockAnchors?: Array<{
    noteId: string;
    noteTitle: string | null;
    noteFolder: string | null;
    blockId: string;
    preview: string;
  }>;
  /** Serve the two picker dumps from what `vault_indices_apply` was actually
   *  SENT, rather than from the seeded arrays alone (myne-md/myne#452).
   *
   *  Without this the mock is a static array, so a re-read after an apply returns
   *  exactly what a stale set already holds and "the index moved and the picker
   *  refreshed" is unobservable BY CONSTRUCTION, whatever a spec asserts. With
   *  it, a note's applied records replace its seeded rows, seeded rows for notes
   *  that were never applied survive (which is how a non-resident row stays
   *  seedable), and an in-session edit changes what the next read returns. */
  vaultPickersFromApplies?: boolean;
  /** Delay the FIRST `vault_indices_headings` read by this many ms while later
   *  reads answer at once (myne-md/myne#452). That is the out-of-order case the
   *  monotonic sequence guard exists for: a slow early read resolving AFTER a
   *  newer one, and overwriting it with a staler set. Nothing else can produce
   *  it, because every read here is otherwise instantaneous. */
  vaultPickerFirstReadDelayMs?: number;
  /** Reject the first N `vault_indices_headings` and `vault_indices_block_anchors`
   *  calls before serving the seeded rows (myne-md/myne#452). Both commands are
   *  `Slot::Unlocked`-gated, so a read racing an auto-lock rejects for real; this
   *  is how a spec drives that without a lock. The count is per command. */
  vaultPickerFailures?: number;
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
  /** Seed + capture for `plugin:chats|*` (myne-md/myne#675). `rows` seeds the
   *  roster `chats_list` returns (each `{ id, created_at, title, updated_at,
   *  version }`); `payloads` maps conversation id → turn-list payload JSON
   *  `chats_read` returns. Writes through the UI (create/append/rename/
   *  delete) mutate this store, so a later list answers from it, with the same
   *  stateful discipline as the notes store above. Calls land on
   *  `window.__chatsCalls` for specs that assert what was written. */
  chats?: {
    rows?: Array<{
      id: string;
      created_at: number;
      title: string;
      updated_at: number;
      version: number;
    }>;
    payloads?: Record<string, string>;
  };
  /** Seed + capture for `plugin:memory|*` (myne-md/myne#697). `rows` seeds
   *  the roster `memory_list` returns (each `{ id, created_at, updated_at,
   *  version }`); `texts` maps entry id → entry text `memory_read` returns;
   *  `directives` seeds `personality_read`. Writes through the UI
   *  (add/edit/delete/clear/personality-save) mutate this store, so a later
   *  list answers from it. Calls land on `window.__memoryCalls` for specs
   *  that assert what was written. */
  memory?: {
    rows?: Array<{ id: string; created_at: number; updated_at: number; version: number }>;
    texts?: Record<string, string>;
    directives?: string[];
  };
  /** How `plugin:local-inference|transcribe` behaves (MYND-563). `text` →
   *  resolves with that transcript; `"not_ready"` / `"failed"` → rejects with
   *  that serialized `EngineError` kind. Defaults to resolving a canned string. */
  transcribe?: { text: string } | { error: "not_ready" | "too_long" | "failed" };
  /** What `plugin:local-inference|read_transcript` answers (myne-md/myne#886):
   *  the already-cached transcript the reader opens on, or `null` for none (the
   *  default). A cached value puts the sheet straight into its `done` state,
   *  which is the "read before running" path desktop calls View transcription. */
  readTranscript?: string | null;
  /** Segments the mock pushes through the `onSegment` channel before it
   *  resolves (myne-md/myne#886). The real engine emits one per phrase, so this
   *  is what lets a spec observe the running preview and the phrase-joined final
   *  text rather than only the resolved string. */
  transcribeSegments?: string[];
  /** Hold the transcribe resolution for this long. The mock is otherwise
   *  instantaneous, which makes the running state unobservable. */
  transcribeDelayMs?: number;
  /** Whether the device-local `myne.aiOnboardingSeen` flag is set before boot.
   *  Defaults to `true`, so the first-run `AiOnboardingSheet` stays closed and
   *  its full-viewport scrim cannot swallow the clicks of every editor-mounted
   *  spec (myne#805). Set `false` to assert the onboarding itself. */
  aiOnboardingSeen?: boolean;
}

/** Install the mock IPC as an init script so it runs before the app's first paint. */
export async function installMockIpc(page: Page, cfg: MockConfig = {}): Promise<void> {
  await page.addInitScript((config: MockConfig) => {
    // Device-local first-run surfaces are seeded SEEN by default (myne#805).
    // `AiOnboardingSheet` opens whenever `myne.aiOnboardingSeen` is absent and
    // its full-viewport scrim then intercepts every click, which took out the
    // whole editor-mounted flow tier. A spec that actually exercises onboarding
    // opts out with `aiOnboardingSeen: false`.
    try {
      if (config.aiOnboardingSeen === false) {
        localStorage.removeItem("myne.aiOnboardingSeen");
      } else {
        localStorage.setItem("myne.aiOnboardingSeen", "1");
      }
    } catch {
      /* storage disabled — the app offers onboarding, which is its own case */
    }
    // A per-session ack-failure budget for the watch meeting drain (myne-md/myne#812):
    // seeded from config so the first N `ack_meeting_session` calls reject,
    // driving the crash-after-note-before-ack re-drain.
    (window as unknown as { __meetingAckFailures?: number }).__meetingAckFailures =
      config.meetingAckFailures ?? 0;
    const DEFAULT_PREFS = {
      screen_capture_protection: false,
      // myne#177: the real host always sends this (serde emits a BTreeMap as
      // `{}` rather than omitting it), so a mock without it models a host that
      // does not exist.
      periodic_notes: {},
      // MYND-619: an absent key reads as ENABLED, matching the Rust default —
      // reading it as off would silently disable reminders on every vault.
      reminders_enabled: true,
      reminder_horizon_days: null,
      show_note_timestamps: true,
      attachment_compression_enabled: true,
      // MYND-441 / myne-md/myne#880: device-local, defaults ON so an absent key
      // reads as enabled.
      attachment_ocr_enabled: true,
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
      // Fields `use-prefs.ts` DEFAULT_PREFS carries and the mock used to omit.
      // `prefs_read` returns this object SPRAWLED over the app's defaults
      // (`setPrefs(await prefsRead())` replaces state wholesale), so a missing
      // key is `undefined`, not the default: `color_groups: undefined` made
      // `effectiveColorGroups(authored, …)` throw on `authored.length`,
      // ErrorBoundary replaced the shell, and `editor.graph-pane` never mounted
      // (14 mobile-flow failures, myne-md/myne#739).
      color_groups: [],
      date_format: null,
      timezone: null,
      time_format: null,
      device_names: {},
      // ON matching the Rust default (MYND-563/592) — same reason as
      // `reminders_enabled` below: an absent key must not read as off.
      transcription_enabled: true,
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
      // The AI gate's four preconditions (myne-md/myne#456). All four default
      // to the OFF state, which is the property rather than a convention: unset
      // must mean the remote path is UNREACHABLE, so a spec that forgets to
      // seed them cannot accidentally exercise a configured device.
      //
      // `ai_provider_consent` is DEVICE-LOCAL while the other three sync, which
      // is the whole point of this feature and the thing the scenario below
      // drives: a phone enrolled into a configured vault gets the provider, the
      // model and the key, and does not get the approval.
      ai_enabled: false,
      ai_provider: null,
      ai_provider_model: null,
      ai_excluded_folders: [],
      chat_history_budget: null,
      meeting_ai_prompt: null,
      ai_provider_consent: null,
    };

    // AI state, stateful for the same reason every other store here is: a
    // toggle or an approval made through the UI is only meaningful if it
    // survives into the next `prefs_read`. Seeded from `config.prefs` so a spec
    // can start from "another device already configured this vault".
    let aiEnabled = (config.prefs?.ai_enabled as boolean | undefined) ?? false;
    let aiProvider = (config.prefs?.ai_provider as string | null | undefined) ?? null;
    let aiConsent = (config.prefs?.ai_provider_consent as string | null | undefined) ?? null;
    // Whether a key is stored. Write-only on the real host: there is no getter,
    // and the panel decides between "Save key" and "Replace key" from this
    // boolean alone, so the mock exposes exactly that and no more.
    let aiHasKey = Boolean(config.prefs?.ai_provider_key);

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
    // Display date & time (myne#279, mobile in myne-md/myne#609). `null` is
    // "no explicit choice", which is what the blob omits.
    let dateFormat: string | null = (config.prefs?.date_format as string | null | undefined) ?? null;
    let timeFormat: string | null = (config.prefs?.time_format as string | null | undefined) ?? null;
    let timezone: string | null = (config.prefs?.timezone as string | null | undefined) ?? null;
    // Periodic notes (myne-md/myne#880). Stateful like every other store here:
    // a folder typed through the UI is only meaningful if it survives into the
    // next `prefs_read`, which is what makes a reopen assertion see disk truth
    // rather than the field's own re-seeded draft.
    let dailyFolder: string | null = (config.prefs?.daily_folder as string | null | undefined) ?? null;
    let dailyDateFormat: string | null =
      (config.prefs?.daily_date_format as string | null | undefined) ?? null;
    let dailyTemplate: string | null =
      (config.prefs?.daily_template as string | null | undefined) ?? null;
    let chatHistoryBudget: number | null =
      (config.prefs?.chat_history_budget as number | null | undefined) ?? null;
    let attachmentOcrEnabled: boolean =
      (config.prefs?.attachment_ocr_enabled as boolean | undefined) ?? true;
    let meetingAiPrompt: string | null =
      (config.prefs?.meeting_ai_prompt as string | null | undefined) ?? null;
    let aiExcludedFolders: string[] = [
      ...((config.prefs?.ai_excluded_folders as string[] | undefined) ?? []),
    ];
    let periodicNotes: Record<string, string> = {
      ...((config.prefs?.periodic_notes as Record<string, string> | undefined) ?? {}),
    };
    // STATEFUL vault icon (vault-icons). Same argument as custom_theme above,
    // with one extra reason: the catch-all at the bottom of this table resolves
    // an UNMOCKED command to `[]`, so without a real handler + store a picker
    // test would pass against its own optimistic draft and prove nothing.
    let vaultIcon: string | null = (config.prefs?.icon as string | null | undefined) ?? null;
    // Same shape as `vaultIcon`, for the label the vault-name step writes.
    let vaultLabel: string | null = (config.prefs?.label as string | null | undefined) ?? null;
    // Whether `plugin:vault-unlock|unlock` has succeeded in this session.
    //
    // Tracked ONLY so the prefs WRITE handlers can refuse before it, which the
    // real backend does: every prefs write needs the active vault's `prefs_key`,
    // so `vault_set_label` rejects with `SlotNotUnlocked` when no vault is open.
    // Without this the mock accepted a label written at commit time — before any
    // unlock — and a test asserting the write ORDER passed against a defect the
    // device would reject. Found by injection: moving the call above the unlock
    // left the scenario green. Reads are left ungated, because `freshDevice`
    // scenarios read prefs before ever unlocking and gating them would rewrite
    // half this file's fixtures to prove nothing.
    let unlockedThisSession = false;

    /** The vault an accepted invite produced on THIS device, or `null` while none
     *  has (myne-md/myne#851 task 14). The accept is the only thing that sets it,
     *  and `vault_list` / `vault_slot_kind` are the only readers, which is the
     *  real sequence: `sync_person_accept_invite` materializes and unlocks the
     *  slot host-side, and the shell then re-probes and finds it. */
    let acceptedVaultId: string | null = null;
    // Vaults deleted during this session, by id. The delete escape routes by
    // re-probing rather than by navigating, so the roster is the only thing
    // that can carry the outcome — see the vault-delete handler.
    const deletedVaultIds = new Set<string>();
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

    // myne-md/myne#452: what `vault_indices_apply` was sent, per note, so the two
    // dumps below can answer from it. Keyed on the window so it outlives the
    // handler closure.
    type AppliedRows = { headings: unknown[]; blockAnchors: unknown[] };
    const appliedStore = (): Record<string, AppliedRows> => {
      const w = window as unknown as { __appliedIndexRows?: Record<string, AppliedRows> };
      return (w.__appliedIndexRows ??= {});
    };
    /** Seeded rows for notes nothing has applied, plus every applied note's own
     *  rows, each tagged with its note id the way Rust tags them. */
    const servePickerRows = (
      seeded: Array<Record<string, unknown>>,
      key: "headings" | "blockAnchors",
    ): Array<Record<string, unknown>> => {
      if (config.vaultPickersFromApplies !== true) return seeded;
      const applied = appliedStore();
      const fromApplies = Object.entries(applied).flatMap(([noteId, rows]) =>
        (rows[key] as Array<Record<string, unknown>>).map((r) => ({ noteId, ...r })),
      );
      const seededForUnapplied = seeded.filter(
        (r) => applied[String(r.noteId ?? "")] === undefined,
      );
      return [...seededForUnapplied, ...fromApplies];
    };
    let headingReads = 0;
    /** Hold an already-computed answer back, WITHOUT postponing the moment it was
     *  computed. The first version awaited before serving, so the delayed read
     *  snapshotted the store AFTER the applies had landed and returned exactly
     *  what the newer read returned: the out-of-order case could not exist and
     *  removing the sequence guard left every case green. Snapshot first, deliver
     *  late, which is what a slow IPC round-trip actually does. */
    const holdBack = async <T>(rows: T, readIndex: number): Promise<T> => {
      const ms = config.vaultPickerFirstReadDelayMs ?? 0;
      if (ms > 0 && readIndex === 1) {
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      return rows;
    };
    // myne-md/myne#452: per-command rejection budget for `vaultPickerFailures`.
    // Counted on the window so it survives the handler closure being re-entered.
    const failPicker = (which: string): boolean => {
      const budget = config.vaultPickerFailures ?? 0;
      if (budget <= 0) return false;
      const w = window as unknown as { __pickerFailures?: Record<string, number> };
      const seen = (w.__pickerFailures ??= {});
      seen[which] = (seen[which] ?? 0) + 1;
      return seen[which] <= budget;
    };

    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      // ── Boot / editor mount ──
      // freshDevice → boot to Welcome (no vaults, Empty slot); lockedVault →
      // boot to Unlock (one Exists vault, Empty slot); otherwise the Unlocked
      // slot shortcuts `initialStageFromProbe` straight to the editor.
      "plugin:vault-unlock|vault_list": () => {
        // An accepted invite OUTRANKS `freshDevice` from that point on, which is
        // the whole observable difference the accept makes: the identity flow
        // hands back to the shell's re-probe, and only a vault that now exists
        // carries the user to the editor instead of back to Welcome.
        if (acceptedVaultId !== null) {
          return [{ id: acceptedVaultId, status: { kind: "Exists" }, label: null, icon: vaultIcon }];
        }
        if (config.freshDevice) return [];
        if (config.corruptedVault) return [{ id: "flow-vault", status: { kind: "Corrupted" } }];
        // Anything deleted this session is gone from here on — see the
        // vault-delete handler below for why the roster, not the return value,
        // is what the escape depends on.
        if (deletedVaultIds.size > 0) {
          const rows = config.multiVault
            ? [
                { id: "vault-personal", status: { kind: "Exists" }, label: "Personal", icon: null, last_unlock: 0 },
                { id: "vault-work", status: { kind: "Exists" }, label: "Work", icon: null, last_unlock: null },
              ]
            : [{ id: "flow-vault", status: { kind: "Exists" }, icon: vaultIcon }];
          return rows.filter((row) => !deletedVaultIds.has(row.id));
        }
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
        acceptedVaultId !== null
          ? "Unlocked"
          : config.freshDevice || config.lockedVault || config.corruptedVault || config.multiVault
            ? "Empty"
            : "Unlocked",
      "plugin:vault-unlock|vault_is_unlocked": () => true,
      "plugin:vault-unlock|report_user_activity": () => null,
      "plugin:vault-unlock|unlock": () => {
        if (config.unlockError) throw config.unlockError;
        unlockedThisSession = true;
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
      // A successful delete must make the vault stop existing for every LATER
      // probe, not merely return null. The app routes out of the cul-de-sac by
      // re-probing (`AppShell`'s onDeleteVaultSuccess → reprobe), so a roster
      // that still lists the vault sends it straight back to Unlock — which is
      // what this mock did, and why the escape read as broken in a spec whose
      // subject is precisely that it is not. Same stateful-mock shape as the
      // quick-unlock and prefs setters above.
      //
      // Recorded per id (SYNC-6 targets one `vaults/<id>/`), so a multi-vault
      // delete leaves its siblings listed. A missing id means the active vault,
      // which is `flow-vault` in every fixture that has one.
      "plugin:vault-delete|vault_delete": (args) => {
        const w = window as unknown as { __vaultDeletes?: number };
        w.__vaultDeletes = (w.__vaultDeletes ?? 0) + 1;
        // Recorded BEFORE the error leg on purpose. `PartialDelete` means part
        // of the vault is already gone — the flow's own comment is "the slot is
        // already Empty and the editor cannot resume" — so continuing to serve
        // it as a healthy `Exists` row is the one answer that is certainly
        // wrong. `UnlockFlow` routes both legs through the same
        // `onDeleteVaultSuccess`, so both must leave the cul-de-sac.
        deletedVaultIds.add(String(args?.vaultId ?? "flow-vault"));
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
        date_format: dateFormat,
        time_format: timeFormat,
        timezone,
        item_order: itemOrder,
        icon: vaultIcon,
        label: vaultLabel,
        ai_enabled: aiEnabled,
        ai_provider: aiProvider,
        ai_provider_consent: aiConsent,
        // Periodic notes (myne-md/myne#880), spread AFTER `config.prefs` for the
        // same reason every other stateful field above is.
        daily_folder: dailyFolder,
        daily_date_format: dailyDateFormat,
        daily_template: dailyTemplate,
        periodic_notes: { ...periodicNotes },
        ai_excluded_folders: [...aiExcludedFolders],
        chat_history_budget: chatHistoryBudget,
        attachment_ocr_enabled: attachmentOcrEnabled,
        meeting_ai_prompt: meetingAiPrompt,
      }),
      // Format-bar layout setters (MYND-555): record the write AND mutate the
      // store. `order` is a verbatim sequence; `hidden` is sorted+deduped by the
      // real Rust codec, so mirror that here or the mock would let a test pass
      // against an ordering the device would never return.
      // ── Display date & time (myne#279, mobile in myne-md/myne#609) ─────
      // Record AND mutate, like the format-bar pair above: a handler that only
      // records lets a test pass while the row renders the old value, which is
      // the shape the whole issue was about.
      "plugin:prefs|set_date_format": (args) => {
        const v = (args.value ?? null) as string | null;
        const w = window as unknown as { __dateFormatWrites?: (string | null)[] };
        (w.__dateFormatWrites ??= []).push(v);
        dateFormat = v;
        return null;
      },
      "plugin:prefs|set_time_format": (args) => {
        const v = (args.value ?? null) as string | null;
        const w = window as unknown as { __timeFormatWrites?: (string | null)[] };
        (w.__timeFormatWrites ??= []).push(v);
        timeFormat = v;
        return null;
      },
      "plugin:prefs|set_timezone": (args) => {
        const v = (args.value ?? null) as string | null;
        const w = window as unknown as { __timezoneWrites?: (string | null)[] };
        (w.__timezoneWrites ??= []).push(v);
        if (config.timezoneWriteFails) throw { kind: "Io", detail: { io_error_kind: "Other" } };
        timezone = v;
        return null;
      },
      // ── Attachment OCR (MYND-441, switchable on mobile in myne-md/myne#880) ─
      // Record AND mutate, so a spec can assert the command fired and that the
      // value survives into the next `prefs_read`. DEVICE-LOCAL.
      "plugin:prefs|set_attachment_ocr_enabled": (args) => {
        const v = (args.enabled ?? true) as boolean;
        const w = window as unknown as { __attachmentOcrWrites?: boolean[] };
        (w.__attachmentOcrWrites ??= []).push(v);
        attachmentOcrEnabled = v;
        return null;
      },
      // ── AI limits (myne-md/myne#617 + meeting-ai, mobile in myne-md/myne#880) ─
      // Record AND mutate, so a spec can assert both that the command fired and
      // that the value survives into the next `prefs_read`.
      "plugin:prefs|set_chat_history_budget": (args) => {
        const v = (args.budget ?? null) as number | null;
        const w = window as unknown as { __chatBudgetWrites?: (number | null)[] };
        (w.__chatBudgetWrites ??= []).push(v);
        chatHistoryBudget = v;
        return null;
      },
      "plugin:prefs|set_meeting_ai_prompt": (args) => {
        const v = (args.prompt ?? null) as string | null;
        const w = window as unknown as { __meetingPromptWrites?: (string | null)[] };
        (w.__meetingPromptWrites ??= []).push(v);
        meetingAiPrompt = v;
        return null;
      },
      // ── AI excluded folders (MYND-408, mobile in myne-md/myne#880) ─────
      // A set-union MUTATION, not a whole-set write: `add` / `remove` are
      // applied to the store, so a spec can assert that a concurrent entry the
      // caller never saw survives. The Rust codec folds + dedups; mirroring the
      // apply (rather than the canonicalization) is enough for the assertions
      // this tier makes.
      "plugin:prefs|set_ai_excluded_folders": (args) => {
        const mutation = (args.mutation ?? {}) as { add?: string[]; remove?: string[] };
        const w = window as unknown as { __aiExcludedWrites?: unknown[] };
        (w.__aiExcludedWrites ??= []).push(mutation);
        for (const f of mutation.remove ?? []) {
          aiExcludedFolders = aiExcludedFolders.filter((e) => e !== f);
        }
        for (const f of mutation.add ?? []) {
          if (!aiExcludedFolders.includes(f)) aiExcludedFolders = [...aiExcludedFolders, f];
        }
        return 0;
      },
      // ── Periodic notes (myne#177, mobile in myne-md/myne#880) ───────────
      // Record AND mutate, like the date/time trio above: a handler that only
      // records lets a spec pass while the field renders the old value, and the
      // payload SHAPES differ per command, so recording them separately is what
      // makes a routing assertion (daily field vs periodic map) possible at all.
      "plugin:prefs|set_daily_folder": (args) => {
        const v = (args.folder ?? "") as string;
        const w = window as unknown as { __dailyFolderWrites?: string[] };
        (w.__dailyFolderWrites ??= []).push(v);
        dailyFolder = v;
        return null;
      },
      "plugin:prefs|set_daily_date_format": (args) => {
        const v = (args.format ?? "") as string;
        const w = window as unknown as { __dailyFormatWrites?: string[] };
        (w.__dailyFormatWrites ??= []).push(v);
        dailyDateFormat = v;
        return null;
      },
      "plugin:prefs|set_daily_template": (args) => {
        const v = (args.templateId ?? null) as string | null;
        const w = window as unknown as { __dailyTemplateWrites?: (string | null)[] };
        (w.__dailyTemplateWrites ??= []).push(v);
        dailyTemplate = v;
        return null;
      },
      // One `<period>.<setting>` entry. `null` REMOVES the key, which the real
      // backend represents as a stamped absence rather than as "never had it";
      // mirroring the removal (rather than storing a null) is what lets a spec
      // assert the clear.
      "plugin:prefs|set_periodic_note_setting": (args) => {
        const period = String(args.period ?? "");
        const setting = String(args.setting ?? "");
        const value = (args.value ?? null) as string | null;
        const w = window as unknown as { __periodicNoteWrites?: { period: string; setting: string; value: string | null }[] };
        (w.__periodicNoteWrites ??= []).push({ period, setting, value });
        const key = `${period}.${setting}`;
        if (value === null) delete periodicNotes[key];
        else periodicNotes[key] = value;
        return null;
      },
      // ── Task reminders (MYND-619) ──────────────────────────────────────
      // ── AI (myne-md/myne#456) ────────────────────────────────────────
      "plugin:prefs|set_ai_enabled": (args) => {
        aiEnabled = Boolean(args.enabled);
        return null;
      },
      // **Deliberately SLOW, and that is what makes the ordering assertion real.**
      // The two prefs writes the consent handler makes are separate Tauri
      // commands, and in production their arrival at the prefs write mutex is
      // not ordered by the order they were dispatched in. A synchronous mock
      // resolves them in call order no matter what the caller does, so an
      // ordering test over it passes against an unawaited dispatch: measured,
      // with `await` replaced by `void`, the flow suite stayed green. A delay
      // here lets the second command land first unless the caller awaits the
      // first, which is the only shape that fails when the await is removed.
      "plugin:prefs|set_ai_provider": async (args) => {
        await new Promise((r) => setTimeout(r, 40));
        aiProvider = (args.provider as string | null) ?? null;
        // **The host clears the consent whenever the selection CHANGES**, which
        // on a first-time approval it always has. Modelled here rather than
        // ignored, because the ORDER of the two writes is what the accept
        // handler declares load-bearing, and a mock that keeps a consent through
        // a provider change cannot tell a correct order from a raced one.
        if (aiConsent !== aiProvider) aiConsent = null;
        const w = window as unknown as { __aiPrefWrites?: string[] };
        (w.__aiPrefWrites ??= []).push("provider");
        return null;
      },
      "plugin:prefs|set_ai_provider_consent": (args) => {
        // Recorded per provider, never as a flag: an approval for a different
        // provider names a different recipient than the one about to receive
        // the text, and the host compares by equality.
        // `grantedFor`, which is what `setAiProviderConsent` actually sends.
        // The first version of this handler read `args.provider` and recorded
        // `null` for every approval, so the scenario asserting "the write names
        // the provider" failed against a correct implementation. A mock that
        // guesses an argument name tests the guess.
        aiConsent = (args.grantedFor as string | null) ?? null;
        const w = window as unknown as {
          __aiConsentWrites?: (string | null)[];
          __aiPrefWrites?: string[];
        };
        (w.__aiConsentWrites ??= []).push(aiConsent);
        (w.__aiPrefWrites ??= []).push("consent");
        return null;
      },
      "plugin:prefs|set_ai_provider_key": (args) => {
        aiHasKey = typeof args.key === "string" && args.key.length > 0;
        return null;
      },
      "plugin:prefs|ai_provider_has_key": () => aiHasKey,
      // The agent's own reads. `agent_start` RECORDS rather than answers: every
      // scenario here is about what reaches the host, and a canned proposal
      // would invite assertions about the mock's own fixture.
      "plugin:agent|agent_preview_grant": () => ({
        noteCount: 3,
        excludedCount: 0,
        unknownCount: 0,
        newTotal: 3,
      }),
      "plugin:agent|agent_last_run": () => null,
      // **The capability probe goes through the same gate a run does**, and
      // that is the whole reason this arm exists rather than always answering
      // a passing verdict. The composer probes on Send before it starts a run,
      // so on a device that inherited the provider and the key but has not
      // consented HERE, the probe is the call the host refuses. A mock that
      // answered `passed` regardless would let the surface report "we could not
      // check your model" over a configuration problem whose fix is one tap
      // away, which is precisely the collapse the error taxonomy exists to
      // prevent, and no spec would have seen it.
      //
      // Mirrors `authorize_remote` in the order the host checks: the feature
      // flag, a named provider, then a consent that names THAT provider, then a
      // key. Equality on the provider name rather than a boolean, for the same
      // reason the host uses it: an approval for one provider is not an
      // approval for another.
      "plugin:agent|agent_capability": () => {
        if (!aiEnabled) throw "FeatureOff";
        if (aiProvider === null || aiProvider === "") throw "NotReady";
        if (aiConsent !== aiProvider) throw "ConsentMissing";
        if (!aiHasKey) throw "NoCredential";
        return { passed: true };
      },
      "plugin:agent|agent_start": (args) => {
        const w = window as unknown as { __agentStarts?: unknown[] };
        (w.__agentStarts ??= []).push(args?.task ?? null);
        throw "FeatureOff";
      },
      "plugin:agent|agent_list_provider_models": () => [{ id: "a/model" }],
      "plugin:prefs|set_reminders_enabled": (args) => {
        const enabled = Boolean(args.enabled);
        const w = window as unknown as { __remindersEnabledWrites?: boolean[] };
        (w.__remindersEnabledWrites ??= []).push(enabled);
        remindersEnabled = enabled;
        return null;
      },
      "plugin:prefs|set_reminder_horizon_days": (args) => {
        // Recorded as well as stored (myne#508), the same shape as the switch
        // above. Mutating the store alone lets a spec assert what the UI shows
        // and never that a write happened, which is the exact gap that let this
        // setter ship with no caller at all.
        const days = (args.days ?? null) as number | null;
        const w = window as unknown as { __reminderHorizonWrites?: (number | null)[] };
        (w.__reminderHorizonWrites ??= []).push(days);
        reminderHorizonDays = days;
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
      // Add/remove verbs since myne-md/myne#613 (MYND-560 shipped this as a
      // whole-set setter). APPLY the mutation to the store rather than
      // replacing it, so the created empty folder is present on the
      // nonce-bumped re-read and a peer's entry the client never saw survives.
      //
      // The recorded array holds the MUTATIONS, not the resulting sets: a
      // resulting-set recording cannot tell "added X" from "replaced the set
      // with X", which is the exact distinction this issue turns on.
      "plugin:prefs|set_deliberate_folders": (args) => {
        const mutation = (args.mutation ?? {}) as {
          add?: string[];
          remove?: string[];
          addUnlessRemoved?: string[];
          removePrefix?: string[];
          renamePrefix?: Array<{ from: string; to: string }>;
        };
        // `addUnlessRemoved` is applied here as an ordinary add, and that is a
        // STATED limitation rather than an oversight: this store holds no
        // `field_clocks`, so it cannot express "absent and carrying a removal
        // clock" at all. Dropping the verb instead would be worse in the
        // direction that matters, since the back-fill would silently do nothing
        // and the lane would go green over a client that registered no folders.
        // The tombstone half is owned by
        // `a_repair_does_not_resurrect_an_entry_whose_removal_is_on_record` in
        // `core/src/plugins/prefs/set_mutation.rs`.
        const add = [...(mutation.add ?? []), ...(mutation.addUnlessRemoved ?? [])];
        const remove = mutation.remove ?? [];
        const removePrefix = mutation.removePrefix ?? [];
        const renamePrefix = mutation.renamePrefix ?? [];
        const w = window as unknown as {
          __deliberateFolderWrites?: Array<{
            add: string[];
            addUnlessRemoved: string[];
            remove: string[];
            removePrefix: string[];
            renamePrefix: Array<{ from: string; to: string }>;
          }>;
        };
        (w.__deliberateFolderWrites ??= []).push({
          add: [...(mutation.add ?? [])],
          addUnlessRemoved: [...(mutation.addUnlessRemoved ?? [])],
          remove: [...remove],
          removePrefix: [...removePrefix],
          renamePrefix: renamePrefix.map((r) => ({ ...r })),
        });
        // REMOVALS FIRST, then additions, and the identity is the canonical
        // folder key rather than `toLowerCase()`. Both match
        // `apply_set_mutation`, and both were wrong here in a way the core has a
        // named test for: removing after adding makes `{remove:[X], add:[X]}`
        // end with X absent, where the core ends with it present because that is
        // what "replace this entry" means; and a bare lowercase misses a stored
        // `Projects/` when the caller removes `Projects`, which the core matches.
        // This is mobile's only automated lane, so a mock with its own rules is
        // a lane that passes while the client is wrong.
        // Inlined rather than imported: this handler is serialized into the
        // PAGE, so a module-scope binding is not in scope at call time and
        // `folderKey` was `undefined` here, which is what the two folder flow
        // specs failed on. Mirrors `myne_core::folder_key::canonical_folder`:
        // NFC, lowercase, empty segments dropped, one trailing slash.
        const key = (f: string) => {
          const segs = f.normalize("NFC").toLowerCase().split("/").filter(Boolean);
          return segs.length === 0 ? "" : `${segs.join("/")}/`;
        };
        const gone = new Set(remove.map(key));
        let kept = deliberateFolders.filter((f) => !gone.has(key(f)));
        // The two PREFIX verbs, in the core's order: every removing verb before
        // any addition. An entry that folds to the empty string is ignored
        // rather than treated as the root, because an empty prefix is a prefix
        // of everything and the no-op case would be the destructive one.
        const prefixes = removePrefix.map(key).filter((p) => p !== "");
        if (prefixes.length > 0) {
          kept = kept.filter((f) => !prefixes.some((p) => key(f).startsWith(p)));
        }
        const renames = renamePrefix
          .map((r) => ({ from: key(r.from), to: r.to }))
          .filter((r) => r.from !== "");
        if (renames.length > 0) {
          const rerooted: string[] = [];
          for (const f of kept) {
            const id = key(f);
            const hit = renames.find((r) => id.startsWith(r.from));
            if (!hit) {
              rerooted.push(f);
              continue;
            }
            const tail = id.slice(hit.from.length);
            const to = hit.to.endsWith("/") || hit.to === "" ? hit.to : `${hit.to}/`;
            rerooted.push(`${to}${tail}`);
          }
          kept = rerooted.filter(
            (f, i) => rerooted.findIndex((g) => key(g) === key(f)) === i,
          );
        }
        for (const a of add) {
          if (!kept.some((f) => key(f) === key(a))) kept.push(a);
        }
        deliberateFolders = kept;
        return 0; // additions refused for byte budget: none, in a mock
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
      // The export-destination chokepoint (`plugin:export-dir|export_path`,
      // myne-md/myne#517). Mocked rather than left to fall through, because the
      // save seam builds its write path from this answer: without a handler the
      // flow wrote to `undefined` and a scenario asserting on the path was
      // asserting on the mock's silence. It returns the SHAPE the host returns —
      // an absolute path, the directory's display name, the sanitized basename —
      // and nothing about the backup exclusion, which is a device fact no browser
      // tier can stand in for (`mobile/docs/dev/device-matrix.md` §8).
      "plugin:export-dir|export_path": (args) => {
        const name = String(args.filename ?? args.fallback ?? "export.txt");
        return { path: `/flow/Documents/${name}`, dir: "Documents", name };
      },
      // The narrow save seam (`secret-export`). Records the CONTENTS, because
      // what a once-only screen writes to disk is the whole claim of that screen
      // and a handler returning `null` would let a save that wrote the wrong
      // secret report success — which is exactly the shape of the recovery kit's
      // risk (myne-md/myne#468: the kit holds the phrase AND the account number,
      // and the step it replaced wrote only the phrase).
      "plugin:secret-export|save_secret_text": (args) => {
        const w = window as unknown as { __secretSaves?: { path: string; contents: string }[] };
        (w.__secretSaves ??= []).push({
          path: String(args.path ?? ""),
          contents: String(args.contents ?? ""),
        });
        return null;
      },
      // The vault-LABEL setter (MYND-205; driven by the name step in
      // myne-md/myne#468). Records the write AND mutates the store, like the icon
      // setter below it and for the same reason: the flow writes the label after
      // the auto-unlock, and a recording-only handler would let a test pass while
      // the picker still rendered the neutral fallback.
      "plugin:prefs|vault_set_label": (args) => {
        if (!unlockedThisSession) throw { kind: "slot_not_unlocked" };
        const label = (args.label ?? null) as string | null;
        const w = window as unknown as { __vaultLabelWrites?: (string | null)[] };
        (w.__vaultLabelWrites ??= []).push(label);
        vaultLabel = label;
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
        // myne-md/myne#452: keep what was sent, so the two dumps can answer from
        // it rather than from a static array a re-read cannot change.
        appliedStore()[String(args.noteId ?? "")] = {
          headings: (args.headings ?? []) as unknown[],
          blockAnchors: (args.blockAnchors ?? []) as unknown[],
        };
        return null;
      },
      "plugin:vault-indices|vault_indices_remove": (args) => {
        feed().indicesRemoves.push(String(args.noteId ?? ""));
        delete appliedStore()[String(args.noteId ?? "")];
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
      // myne-md/myne#452: the two whole-vault picker dumps. Mocked EXPLICITLY
      // rather than left to the unknown-command `[]` fallback below, and that is
      // the whole reason this arm exists: the fallback is what made the missing
      // wiring invisible. Mobile registered neither command and passed neither
      // prop, so `[[##` and `[[^^` opened with zero rows, and a spec driving them
      // would have seen zero rows here too, from the fallback, and passed.
      "plugin:vault-indices|vault_indices_headings": async () => {
        const readIndex = (headingReads += 1);
        if (failPicker("headings")) throw { kind: "slot_not_unlocked" };
        return await holdBack(
          servePickerRows(
            (config.vaultHeadings ?? []) as Array<Record<string, unknown>>,
            "headings",
          ),
          readIndex,
        );
      },
      "plugin:vault-indices|vault_indices_block_anchors": () => {
        if (failPicker("blockAnchors")) throw { kind: "slot_not_unlocked" };
        return servePickerRows(
          (config.vaultBlockAnchors ?? []) as Array<Record<string, unknown>>,
          "blockAnchors",
        );
      },
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
      // ── AI conversations (myne-md/myne#675) ──
      // STATEFUL roster + payloads: seeded from `config.chats`, mutated by
      // the UI's writes, so list/open/new/rename/delete flows assert against
      // the store rather than the call that just wrote. Mutating calls also
      // land on `window.__chatsCalls` for specs that assert what was written
      // (the `__voiceImports` precedent).
      ...(() => {
        type Row = {
          id: string;
          created_at: number;
          title: string;
          updated_at: number;
          version: number;
        };
        const rows: Row[] = (config.chats?.rows ?? []).map((r) => ({ ...r }));
        const payloads: Record<string, string> = { ...(config.chats?.payloads ?? {}) };
        const record = (cmd: string, args: Record<string, unknown>) => {
          const w = window as unknown as { __chatsCalls?: Array<unknown> };
          (w.__chatsCalls ??= []).push({ cmd, args });
        };
        const byUpdatedDesc = () => [...rows].sort((a, b) => b.updated_at - a.updated_at);
        return {
          "plugin:chats|chats_list": () => byUpdatedDesc(),
          "plugin:chats|chats_read": (args: Record<string, unknown>) => {
            const id = args["conversationIdHex"] as string;
            const payload = payloads[id];
            if (payload === undefined) {
              throw { kind: "ConversationUnreadable" };
            }
            return payload;
          },
          "plugin:chats|chats_create": (args: Record<string, unknown>) => {
            record("chats_create", args);
            const id = "c9".repeat(16);
            let title = "New conversation";
            try {
              const payload = JSON.parse(args["firstTurnPayload"] as string) as {
                turns?: Array<{ role?: unknown; text?: unknown }>;
              };
              const first = (payload.turns ?? []).find(
                (t) => t.role === "user" && typeof t.text === "string" && t.text.length > 0,
              );
              if (first && typeof first.text === "string") {
                title = first.text.replace(/[\r\n]+/g, " ").slice(0, 48);
              }
            } catch {
              // Title derivation is best-effort here; the id is the contract.
            }
            rows.push({ id, created_at: 1, title, updated_at: 1, version: 1 });
            payloads[id] = args["firstTurnPayload"] as string;
            return id;
          },
          "plugin:chats|chats_append_turn": (args: Record<string, unknown>) => {
            record("chats_append_turn", args);
            payloads[args["conversationIdHex"] as string] = args["turnsPayload"] as string;
            return null;
          },
          "plugin:chats|chats_rename": (args: Record<string, unknown>) => {
            record("chats_rename", args);
            const row = rows.find((r) => r.id === args["conversationIdHex"]);
            if (row) {
              row.title = args["newTitle"] as string;
              row.version += 1;
            }
            return null;
          },
          "plugin:chats|chats_delete": (args: Record<string, unknown>) => {
            record("chats_delete", args);
            const i = rows.findIndex((r) => r.id === args["conversationIdHex"]);
            if (i >= 0) rows.splice(i, 1);
            delete payloads[args["conversationIdHex"] as string];
            return null;
          },
        };
      })(),
      // ── Agent memory + personality (myne-md/myne#697) ──
      // STATEFUL roster + texts + directives: seeded from `config.memory`,
      // mutated by the UI's writes. Mutating calls also land on
      // `window.__memoryCalls` for specs that assert what was written.
      ...(() => {
        type Row = { id: string; created_at: number; updated_at: number; version: number };
        const rows: Row[] = (config.memory?.rows ?? []).map((r) => ({ ...r }));
        const texts: Record<string, string> = { ...(config.memory?.texts ?? {}) };
        let directives: string[] = [...(config.memory?.directives ?? [])];
        const record = (cmd: string, args: Record<string, unknown>) => {
          const w = window as unknown as { __memoryCalls?: Array<unknown> };
          (w.__memoryCalls ??= []).push({ cmd, args });
        };
        const byUpdatedDesc = () => [...rows].sort((a, b) => b.updated_at - a.updated_at);
        return {
          // `{ rows, cap }` since myne-md/myne#867: the cap rides with the
          // roster, so the sheet counts against the number the host enforces.
          "plugin:memory|memory_list": () => ({ rows: byUpdatedDesc(), cap: 100 }),
          "plugin:memory|memory_read": (args: Record<string, unknown>) => {
            const text = texts[args["memoryIdHex"] as string];
            if (text === undefined) {
              throw { kind: "EntryNotFound" };
            }
            return text;
          },
          "plugin:memory|memory_write": (args: Record<string, unknown>) => {
            record("memory_write", args);
            const id = (args["memoryIdHex"] as string | undefined) ?? "e9".repeat(16);
            texts[id] = args["text"] as string;
            const row = rows.find((r) => r.id === id);
            if (row) {
              row.version += 1;
              row.updated_at = Date.now();
            } else {
              rows.push({ id, created_at: Date.now(), updated_at: Date.now(), version: 1 });
            }
            return id;
          },
          "plugin:memory|memory_delete": (args: Record<string, unknown>) => {
            record("memory_delete", args);
            const i = rows.findIndex((r) => r.id === args["memoryIdHex"]);
            if (i >= 0) rows.splice(i, 1);
            delete texts[args["memoryIdHex"] as string];
            return null;
          },
          "plugin:memory|personality_read": () => ({
            directives: directives.map((text) => ({ text, updated_at: 1 })),
          }),
          "plugin:memory|personality_write": (args: Record<string, unknown>) => {
            record("personality_write", args);
            directives = (args["directives"] as Array<{ text: string }>).map((d) => d.text);
            return null;
          },
        };
      })(),
      "plugin:attachments|attachment_unused_list": () => [],
      "plugin:attachments|attachment_refs_apply": () => null,
      "plugin:attachments|attachment_refs_remove": () => null,
      // On-device transcription (MYND-563). Resolves with a canned transcript by
      // default, or rejects with a serialized `EngineError` kind so the
      // not-ready / failed UI branches are exercised. The streaming `onSegment`
      // channel is ignored here — the TranscribeRow renders from the resolved
      // `done` promise, so a canned final transcript is enough for flow logic.
      "plugin:local-inference|transcribe": async (args) => {
        const c = config.transcribe;
        if (c && "error" in c) {
          // The real `EngineError` variant names, not the normalized kinds: the
          // point of driving this through `normalizeTranscribeError` is that the
          // mapping is part of what the flow tier covers (myne#485).
          const kind =
            c.error === "not_ready"
              ? "NotReady"
              : c.error === "too_long"
                ? "AudioTooLong"
                : "TranscriptionFailed";
          throw { kind };
        }
        // Stream first, then hold, then resolve — the order the real run takes,
        // so the running state is observable when `transcribeDelayMs` is set.
        const channel = args?.onSegment as { onmessage?: (s: string) => void } | undefined;
        for (const seg of config.transcribeSegments ?? []) channel?.onmessage?.(seg);
        if (config.transcribeDelayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, config.transcribeDelayMs));
        }
        return c && "text" in c ? c.text : "the quick brown fox";
      },
      "plugin:local-inference|read_transcript": () => config.readTranscript ?? null,
      // Clipboard (myne-md/myne#886): the copy action goes through the native
      // sensitive-pasteboard seam. Recorded rather than merely resolved so a spec
      // can assert WHAT was copied, which is the whole point of the action.
      "plugin:sensitive-clipboard|write_text": (args) => {
        const w = window as unknown as { __clipboardWrites?: string[] };
        (w.__clipboardWrites ??= []).push(String(args.value ?? ""));
        return null;
      },
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
      // The watch meeting-chunk seal (myne-md/myne#812): records each delivery
      // the `myne-meeting-chunk` event carried, so a spec can assert the native
      // dispatch reaches the command with its manifest fields intact.
      "plugin:captures|seal_meeting_chunk": (args) => {
        const w = window as unknown as {
          __meetingChunkSeals?: Array<{
            sessionId: string;
            chunkIndex: number;
            startedAt: number;
            path: string;
          }>;
        };
        (w.__meetingChunkSeals ??= []).push({
          sessionId: String(args.sessionId ?? ""),
          chunkIndex: Number(args.chunkIndex ?? 0),
          startedAt: Number(args.startedAt ?? 0),
          path: String(args.path ?? ""),
        });
        return null;
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
      // ── Watch meeting-capture surface (myne-md/myne#812) ──
      // STATEFUL, like the real at-least-once queue: `drain_pending_meetings`
      // returns every seeded session that has NOT been acked yet, and
      // `ack_meeting_session` removes one. So a drain that creates a note but
      // whose ack fails returns the same session on the next drain — the rare
      // duplicate the at-least-once discipline accepts — which a "returned once"
      // mock could not express at all. `meetingAckFailures` makes the first N
      // acks reject, driving that crash-after-note-before-ack path.
      "plugin:captures|meeting_pending_sessions": () => config.pendingMeetings ?? [],
      "plugin:captures|drain_pending_meetings": () => {
        const w = window as unknown as {
          __meetingAcked?: string[];
          __meetingNoteIds?: Record<string, string>;
        };
        const acked = new Set(w.__meetingAcked ?? []);
        const noteIds = w.__meetingNoteIds ?? {};
        return (config.pendingMeetings ?? [])
          .filter((s) => !acked.has(s.session_id))
          .map((s) => ({ ...s, note_id: noteIds[s.session_id] ?? s.note_id ?? null }));
      },
      // The retry half of the on-arrival seal (myne-md/myne#812 review): records
      // the call so a spec can assert boot / unlock re-scans the inbox.
      "plugin:captures|seal_meeting_inbox": () => {
        const w = window as unknown as { __sealMeetingInboxCalls?: number };
        w.__sealMeetingInboxCalls = (w.__sealMeetingInboxCalls ?? 0) + 1;
        return 0;
      },
      // Record the note a session drained into, mirroring the real manifest
      // write, so a re-drain returns it and APPENDS (myne-md/myne#812 review).
      "plugin:captures|set_meeting_session_note": (args) => {
        const w = window as unknown as { __meetingNoteIds?: Record<string, string> };
        (w.__meetingNoteIds ??= {})[String(args.sessionId ?? "")] = String(args.noteId ?? "");
        return null;
      },
      "plugin:captures|ack_meeting_session": (args) => {
        const w = window as unknown as {
          __meetingAcks?: string[];
          __meetingAcked?: string[];
          __meetingAckFailures?: number;
          __meetingResolved?: Record<string, number[]>;
        };
        const id = String(args.sessionId ?? "");
        const resolved = Array.isArray(args.resolvedChunkIndices)
          ? (args.resolvedChunkIndices as number[])
          : [];
        (w.__meetingAcks ??= []).push(id);
        const failed = w.__meetingAckFailures ?? 0;
        if (failed > 0) {
          w.__meetingAckFailures = failed - 1;
          throw { kind: "Backend" };
        }
        // Record the RESOLVED indices too, so a test can assert the H3 contract:
        // a retryable chunk is not in the list and its session is not fully
        // acked away. `__meetingAcked` means "every chunk resolved" (the record
        // is gone), matching the Rust `ack_meeting_session_in_dirs` behaviour
        // where the manifest row survives while any entry is still on disk.
        (w.__meetingResolved ??= {})[id] = resolved;
        const session = (config.pendingMeetings ?? []).find((s) => s.session_id === id);
        // "Fully resolved" means every chunk that could be accounted for is in
        // the ack: the imported/missing ones AND the retryable ones. A retryable
        // chunk is NOT resolved (its entry stays for the next unlock), so the
        // session is not fully acked while one exists — the H3 contract.
        const retryable = session?.retryable_chunk_indices ?? [];
        const allResolved =
          !session ||
          (session.chunks.every((c) => resolved.includes(c.chunk_index)) &&
            session.missing_chunk_indices.every((i) => resolved.includes(i)) &&
            retryable.every((i) => resolved.includes(i)));
        if (allResolved) {
          (w.__meetingAcked ??= []).push(id);
        }
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
      "plugin:sync|sync_set_endpoint": (args) =>
        config.setEndpoint ?? {
          fingerprint: null,
          pin_source: String(args.endpointUrl ?? "").startsWith("https://")
            ? "platform_trust_store" : null,
        },
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
      "plugin:sync|sync_head_fingerprint": () => {
        const fp = config.headFingerprint;
        if (Array.isArray(fp)) return fp.length > 1 ? fp.shift()! : (fp[0] ?? null);
        return fp ?? "TYRS-N318";
      },
      "plugin:sync|sync_verify_hold_begin": () => null,
      "plugin:sync|sync_verify_hold_end": () => null,
      "plugin:sync|sync_pending_conflicts": () => config.pendingConflicts ?? [],
      // ── The person plane (myne-md/myne#851 tasks 14 and 15) ──────────────
      // The identity flow's whole backend surface. Nothing here is stateful
      // except `acceptedVaultId`, and that is deliberate: the accept's only
      // durable effect on this device is a vault, and modelling the vault rather
      // than modelling "the accept returned" is what makes the spec's assertion
      // ("the editor mounted") a statement about the product.
      "plugin:sync|sync_person_status": () =>
        config.personStatus ?? {
          enrolled: false,
          identity_unlocked: false,
          person_id_hex: null,
          identity_code: null,
          sealed_keypair_present: false,
        },
      "plugin:sync|sync_person_list_invites": () => config.personInvites ?? [],
      "plugin:sync|sync_person_setup": (args) => {
        // The identity-only setup, and the ONE command behind both of the gate's
        // doors. `phrase: null` generates a new identity and returns the phrase
        // once; a phrase recovers an existing one. The argument is recorded under
        // its own global because that is the whole question this tier can answer
        // about the gate: WHICH door the phone came through. A gate with only the
        // create arm passes `null` and looks identical on screen.
        (window as unknown as { __personSetupArgs?: unknown }).__personSetupArgs = args;
        if (config.personSetupError) throw config.personSetupError;
        if (!config.personSetupResult) throw { kind: "NotConfigured" };
        return config.personSetupResult;
      },
      "plugin:sync|sync_person_accept_invite": (args) => {
        // The four arguments, in order, are the accept's contract (task 14): the
        // invite id, the owner's out-of-band identity code, the recovery phrase,
        // the device-local password. A spec reads them back from here.
        (window as unknown as { __acceptInviteArgs?: unknown }).__acceptInviteArgs = args;
        if (config.acceptInviteError) throw config.acceptInviteError;
        acceptedVaultId = String(args?.vaultId ?? "accepted-vault");
        return null;
      },
      "plugin:sync|sync_member_join_vault": (args) => {
        // The second device's four arguments, in order: the invite id (from the
        // recipient-scoped list, which INCLUDES the claimed row), the vault's
        // account hash, this person's OWN recovery phrase, and the device-local
        // password. No owner code: the owner is read from the pin this person's
        // sealed profile already carries (`decisions/protocol/0675`), which is the
        // whole difference from the accept above it.
        //
        // Recorded under its OWN global rather than the accept's, so a spec can
        // prove the phone reached THIS command. One shared recorder would make
        // "the join ran" and "the accept ran" indistinguishable, and routing a
        // claimed row through the accept is the exact regression this path exists
        // to prevent (myne-md/myne#794's shape: a plausible sentence over the
        // wrong command).
        (window as unknown as { __joinVaultArgs?: unknown }).__joinVaultArgs = args;
        if (config.memberJoinError) throw config.memberJoinError;
        // Same stateful shape as the accept: the command materializes and unlocks
        // the slot host-side, so the shell's re-probe is what carries the user to
        // the editor. A distinct id, so a spec asserting the editor mounted cannot
        // be answered by a vault the accept put there.
        acceptedVaultId = "joined-device-vault";
        return null;
      },
      "plugin:sync|sync_list_roster": () => {
        // `roster: null` is a REFUSAL rather than an empty roster, because the two
        // are different answers to the name step's question and the step has to
        // treat only one of them as "no name yet".
        if (config.roster === null || config.roster === undefined) {
          throw { kind: "NotUnlocked" };
        }
        return config.roster;
      },
      "plugin:member-names|member_names_set_mine": (args) => {
        (window as unknown as { __memberNameArgs?: unknown }).__memberNameArgs = args;
        if (config.memberNameError) throw config.memberNameError;
        return {};
      },
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
      "plugin:qr-scan|scan": () => {
        if (config.qrScanError) throw config.qrScanError;
        return config.qrScan ?? { value: null };
      },
      "plugin:sync|sync_decode_join_qr": () => {
        if (config.qrDecodeError) throw config.qrDecodeError;
        return (
          config.qrDecode ?? {
            kind: "account",
            endpoint_url: "https://sync.example.com",
            account_number: "4K7P9RH2JR3T8XW6VZ0A",
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
