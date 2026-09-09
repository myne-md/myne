// SPDX-License-Identifier: AGPL-3.0
//! Which IPC commands the web client answers, refuses, or does not have yet.
//!
//! # Why this table exists at all
//!
//! `src/` reaches its backend through exactly one call shape —
//! `invoke(cmd, args)` — and the shared tree is compiled **unchanged** for both
//! clients (`prd.md` "Never fork the UI"). So every command name the shared UI
//! can emit arrives at this crate, including the ones whose backend lives in
//! `src-tauri/` and was never part of `myne-core` at all (`backup`, `spell`,
//! `importer`, `clipper-pairing`, `pdf-export`, `local-inference`,
//! `vault-repair`). Those need an answer here too, and "we forgot" is not one.
//! (`workspace` was one of them until task 65 moved it into `myne-core`.)
//!
//! # The three classes, and why the third is not folded into the second
//!
//! | Class | Runtime outcome | Meaning |
//! |---|---|---|
//! | dispatched | `ok` / `error` | the command runs; see [`super::dispatch`] |
//! | [`Class::Unsupported`] | one typed `unsupported` outcome | **decided**: this cannot exist in a browser |
//! | [`Class::Pending`] | a loud `NotPorted` error | the port, or the capability *decision*, is still owed |
//!
//! Collapsing `Pending` into `Unsupported` would be the convenient choice and
//! the wrong one. `unsupported` is consumed by the capability descriptor (task
//! 27) to make an affordance **absent** — a permanent, silent product decision.
//! A command that is merely unported would therefore disappear from the UI and
//! stay disappeared, with nothing anywhere reporting that a port was missed. So
//! `Pending` fails loudly instead, and `scripts/check-web-command-coverage.mjs`
//! keeps the split exhaustive against the real inventory of names in the shared
//! tree: a name in none of the three buckets fails the guard, naming the file it
//! was found in.
//!
//! `Pending` also covers **undecided**, not just unwritten: tasks 47 (spell),
//! 71 (importer), 72 (`vault_delete` / `vault_repair`) and 48
//! (export destinations) were each written as "decide it, do not let it fall
//! through the gap". Until they do, those commands are `Pending` — the loud
//! outcome is correct for an open question, and promoting one to `Unsupported`
//! before its decision lands would be pre-empting it in code. Task 72's two
//! landed on 2026-07-27 and went opposite ways, which is what the split is for:
//! `vault_delete` DISPATCHES (it erases this browser's copy) and `vault_repair`
//! is `Unsupported` (it repairs a damage mode OPFS cannot have).
//!
//! # Sources
//!
//! Nothing here is invented. Each `Unsupported` entry cites either
//! `docs/decisions.md` 2026-07-26 "Web capability set", the `Absent on web` list
//! in task 27, a `cannot-exist-in-browser` verdict from
//! `core-wasm-assessment.md`, or a decision another roster in this repo has
//! already taken and recorded (myne#411's `vault-label` cites
//! `check-web-screens.mjs`'s `excluded` verdict on `VaultPicker.tsx`: a setting
//! whose entire subject is a screen this client cannot reach has no referent
//! here, and that is a decision, not a gap). Anything not covered by one of
//! those is `Pending` by construction, which is why this file cannot quietly
//! grow a product decision.

/// What the web client does with a given IPC command name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// [`super::dispatch`] answers it.
    Dispatched,
    /// Decided absent on web. Resolves to the single typed `unsupported`
    /// outcome the seam surfaces as `PlatformUnsupportedError`.
    Unsupported,
    /// Port or capability decision still owed. Resolves to a loud error.
    Pending,
}

/// Commands this crate answers itself today.
///
/// Kept as data rather than left implicit in the `match`, for two reasons: the
/// coverage guard needs to read it statically, and two tests assert the list and
/// the router agree — a name here with no arm
/// (`dispatch::tests::dispatched_names_match_the_router`) and an arm with no
/// name (`…::every_router_arm_is_named_in_the_dispatched_roster`) are both test
/// failures rather than runtime surprises.
///
/// **The second of those did not exist until task 84**, while this comment
/// already claimed it did. What the gap cost was not a broken command but a
/// lying table: an unlisted arm still answers, while `classify` keeps calling it
/// `Pending` and any UI gate reading that answer hides a feature that works.
///
/// One deliberate asymmetry: a **web-only** command (no shared-tree twin, e.g.
/// `attachment_object_url`) must NOT be listed here — the coverage guard rejects
/// a name the shared tree never mentions. Those are exempted by name in
/// `dispatch::tests::WEB_ONLY_ARMS`, with the reasoning there.
pub const DISPATCHED: &[&str] = &[
    // The one command that is genuinely host-independent: it reads a
    // compile-time constant, touches no vault state, and is deliberately not
    // `Slot::Unlocked`-gated (`prefs/commands.rs` `device_platform_value`).
    // It is the round-trip proof for this task — a real command, from the real
    // shared UI, through the real Worker, into real wasm.
    "plugin:prefs|device_platform",
    "plugin:prefs|prefs_read",
    // The prefs setter surface (task 14). Every one except
    // `set_screen_capture_protection`, which is `Class::Unsupported` above — a
    // page cannot ask the compositor to exclude it from a capture. The settings
    // whose FEATURE is absent (spell, AI, OCR, auto-lock timeout) ARE dispatched:
    // the pref is vault content that syncs to every client, and refusing the
    // write would corrupt a setting the user's desktop depends on.
    "plugin:prefs|set_spell_enabled",
    "plugin:prefs|set_editor_line_numbers",
    "plugin:prefs|set_editor_vim_mode",
    "plugin:prefs|set_active_workspace",
    "plugin:prefs|set_editor_default_view_mode",
    "plugin:prefs|set_editor_focus_dim_inactive",
    "plugin:prefs|set_editor_focus_typewriter",
    "plugin:prefs|set_show_note_timestamps",
    "plugin:prefs|set_spell_languages",
    "plugin:prefs|set_keymap_binding",
    "plugin:prefs|set_deliberate_folders",
    "plugin:prefs|set_archived_folders",
    "plugin:prefs|set_ai_enabled",
    "plugin:prefs|set_attachment_compression_enabled",
    "plugin:prefs|set_attachment_ocr_enabled",
    "plugin:prefs|set_ai_excluded_folders",
    // developer-mode (MYND-593): same reasoning as the AI/OCR toggles above —
    // the pref is vault content that syncs to every client (task 2 classifies
    // it DeviceLocal, but it still lives in vault.prefs and must round-trip),
    // even though the feature it gates (local-model overrides) has no web
    // affordance yet.
    "plugin:prefs|set_developer_mode",
    "plugin:prefs|set_item_order",
    "plugin:prefs|set_hidden_bar_items",
    "plugin:prefs|upsert_saved_view",
    "plugin:prefs|delete_saved_view",
    "plugin:prefs|set_view_order",
    "plugin:prefs|set_bar_items_order",
    "plugin:prefs|set_color_groups",
    "plugin:prefs|set_right_panel_active_tab",
    "plugin:prefs|set_right_panel_hidden_tabs",
    "plugin:prefs|set_right_panel_tab_order",
    "plugin:prefs|set_editor_toolbar_order",
    "plugin:prefs|set_editor_toolbar_hidden",
    "plugin:prefs|set_editor_slash_order",
    "plugin:prefs|set_editor_slash_hidden",
    "plugin:prefs|set_daily_date_format",
    "plugin:prefs|set_daily_folder",
    "plugin:prefs|set_daily_template",
    "plugin:prefs|set_periodic_note_setting",
    "plugin:prefs|set_new_note_location",
    "plugin:prefs|set_editor_text_size",
    "plugin:prefs|set_editor_line_spacing",
    "plugin:prefs|set_date_format",
    "plugin:prefs|set_time_format",
    "plugin:prefs|set_timezone",
    "plugin:prefs|set_editor_content_width",
    "plugin:prefs|set_editor_font_family",
    "plugin:prefs|set_startup_open",
    "plugin:prefs|set_favorites",
    "plugin:prefs|set_auto_lock_timeout",
    "plugin:prefs|set_editor_layout",
    "plugin:prefs|set_custom_theme",
    "plugin:prefs|set_item_colors",
    "plugin:prefs|set_folder_icons",
    "plugin:prefs|set_device_name",
    "plugin:prefs|vault_set_icon",
    "plugin:prefs|set_theme",
    "plugin:prefs|set_archive_disabled",
    // The first command that touches storage (task 17). Read-only, no keys, no
    // derivation, no unlock precondition — and the shared UI calls it at boot,
    // so a browser reporting `Exists` after a reload is a real end-to-end
    // persistence proof.
    "plugin:vault-unlock|vault_status",
    // Mid-session storage health (task 22) — the answer the BOOT probe above
    // cannot express: the browser evicting this origin's storage while a session
    // is live. Read-only and cheap (a slot peek plus a 345-byte read), which is
    // what makes it pollable.
    "plugin:vault-unlock|vault_storage_health",
    // The Editor's mount-time slot probe. Read-only (an infallible lock read),
    // no keys, no derivation — and load-bearing to a degree its shape hides:
    // the guard that calls it fail-closes on an IPC REJECTION, so leaving it
    // unported turned a fully working session into "Unexpected state."
    "plugin:vault-unlock|vault_is_unlocked",
    // The BOOT probe's runtime half (myne-md/myne#535). Read-only, like the two
    // rows around it, and load-bearing for the same hidden reason: its caller
    // swallows an IPC rejection into `"Empty"`, so leaving it unported did not
    // fail. It made boot routing unable to see an unlocked slot at all, which
    // sent a completed sign-in to the unlock form and then to a dead-end
    // `VaultAlreadyUnlocked` banner. See `BOOT_PATH` below: this row is now
    // required rather than optional.
    "plugin:vault-unlock|vault_slot_kind",
    // #250: the authoritative active-vault id, straight off the slot map. The
    // TS side used to derive it from a best-effort disk cache; the delete it
    // targets is irreversible on this client too.
    "plugin:vault-unlock|vault_active_id",
    // Local account-number validation for the web first-run identity step
    // (task 30). Host-independent in the same way `device_platform` is: pure
    // over its argument, no vault, no storage, no network.
    "plugin:vault-unlock|account_number_check",
    // Lock = zeroize (task 43). The web idle timer needs a real lock to call,
    // not a UI transition.
    "plugin:vault-unlock|lock",
    // Custom themes (task 45): vault content, so a web user's themes follow
    // them. Validation runs through the same `theme-validator` crate, compiled
    // to wasm — never a TypeScript reimplementation of the injection guard.
    "plugin:themes|themes_list",
    "plugin:themes|themes_read",
    "plugin:themes|themes_export",
    "plugin:themes|themes_import",
    "plugin:themes|themes_delete",
    // Attachments (task 44): the plugin's command cores moved onto the storage
    // seam and the host clock, so `MYA1` / `MYC1` bytes, the
    // `AttachmentsCatalogKey` subkey role and the content-addressed ids are
    // exactly what a desktop wrote.
    "plugin:attachments|catalog_list",
    "plugin:attachments|attachment_import",
    "plugin:attachments|attachment_delete",
    "plugin:attachments|attachment_rename",
    "plugin:attachments|attachment_unused_list",
    "plugin:attachments|attachment_clean_unused",
    // Graph layout (task 46) — the `MYG1` node-position cache. A rebuildable
    // device-local cache by spec (§9.19.4: any read failure means "recompute"),
    // which is exactly what makes it safe on an evictable store.
    "plugin:graph-layout|graph_layout_read",
    "plugin:graph-layout|graph_layout_write",
    // Workspace / pane layout (task 65) — the `MYW1` pane tree. A tab loses its
    // layout on every reload without this, which is a worse loss on web than the
    // same feature is on desktop, not a smaller one.
    "plugin:workspace|workspace_read",
    "plugin:workspace|workspace_write",
    "plugin:workspace|workspace_stage",
    // Task 12 — the first command holding state past its own return.
    "plugin:vault-unlock|unlock",
    // Erase this browser's copy (task 72, owner decision 2026-07-27). The same
    // command as desktop's, on the same slot matrix and the same partial-fail
    // posture, driven through the storage seam instead of `std::fs`. What it
    // MEANS differs — here the container is a cache of a sync-held vault, so
    // this is a sign-out that takes the local copy with it, and the copy the UI
    // shows says exactly that. Nothing under this name talks to the server.
    "plugin:vault-delete|vault_delete",
    // The vault roster (task 85). ONE summary from the constant vault id.
    // Dispatched rather than declared unsupported because `resolveActiveVaultId()`
    // is how several shared modules learn which vault they operate on: an
    // unsupported answer is `null`, and every one of them would silently no-op
    // forever rather than fail visibly.
    "plugin:vault-unlock|vault_list",
    // Sync, the endpoint config only (task 84). Everything else in the plugin
    // is still Pending: this pair is the data plane's precondition, not the
    // data plane. `sync_set_endpoint` here writes the config with no cert pin
    // and reports `PinSource::PlatformTrustStore` — a browser cannot see a leaf
    // certificate, so "verified by the browser" is the honest answer and an
    // empty pin would render as "connected to a local server".
    "plugin:sync|sync_get_endpoint",
    "plugin:sync|sync_set_endpoint",
    // The status indicator (task 84). Read-only and transport-free: it derives
    // from the config, the device-local token, the persisted identity and the
    // conflict staging dir. The live overlay is `None` here — its producer is
    // the background loop, which the browser does not have yet — so the user
    // sees the honest base state rather than a fabricated "Syncing".
    "plugin:sync|sync_status",
    // Which notes the server has NOT acknowledged (task 23). A sibling of
    // `sync_status`, not a field on it: that one is a property of the DEVICE and
    // this is a property of each NOTE, and they diverge in exactly the case that
    // matters — an `Idle` device holding edits the server has never seen. On
    // this client the local copy is an evictable cache, so an unacknowledged
    // edit is the one thing between the user and real loss.
    "plugin:sync|sync_unsynced_edits",
    // The one credential-management action that stays on web (tasks 41 + 88):
    // the password is already typed into the page at every unlock, so it adds no
    // new exposure. Gated on a server acknowledgement — on a client whose local
    // copy is an evictable cache, a change that only this browser holds is the
    // difference between an inconvenience and a lockout.
    "plugin:vault-change-password|change_password",
    // First-sync materialisation progress (task 39). Counts, never a percentage
    // or an ETA: the measured cost spans 6× across engines at the same note
    // count, so any ETA would be wrong by that factor on whichever browser the
    // user happens to be running — and a bar that lies is worse than a count
    // that is merely coarse.
    "plugin:sync|sync_materialisation_progress",
    // The device roster + account projection (task 84). Token-authed, no
    // `root_key`, so one shared precondition (`authed_transport_from_host`)
    // ported all four. This is task 33's client half too: a browser can see the
    // roster it must appear in, and an approval from a desktop shows up here.
    "plugin:sync|sync_list_devices",
    "plugin:sync|sync_approve_device",
    "plugin:sync|sync_remove_device",
    "plugin:sync|sync_account_status",
    // The data plane (task 84): one cycle, on demand. Everything above it in
    // this group is a precondition; this is the command that moves ciphertext.
    // With no background loop yet it is the browser's only way to sync, which is
    // why the core's honest `NotEnrolled`-not-`Idle` mapping matters here.
    "plugin:sync|sync_now",
    // Enrolment (task 84) — what puts this browser INTO the device roster, and
    // task 33's remaining half. The first dispatched command whose core carries
    // key material: the credential is `Zeroizing`-wrapped and dies with the
    // blocking closure, and what crosses back is an identity plus a revocable
    // token, never a key.
    "plugin:sync|sync_enroll",
    // First-run bootstrap (task 85) — the "log in" leg. The last precondition
    // for a browser that has never seen this account; everything else in this
    // plugin assumes a vault already exists. Its vault id is a constant, which
    // is what makes re-running it idempotent by construction.
    "plugin:sync|sync_join_account",
    // Vault creation (`decisions.md` 2026-08-15). Listed here rather than
    // defaulted by the plugin row, so a fourth creation command added later
    // lands as `Pending` and has to be argued for.
    "plugin:vault-creation|begin",
    "plugin:vault-creation|commit",
    "plugin:vault-creation|cancel",
    // Phrase recovery (`decisions.md` 2026-08-15), including the mandatory
    // chained password reset.
    "plugin:vault-recover|recover_with_phrase",
    "plugin:vault-recover|complete_recovery",
    // The two halves of the pending-approval wait (MYND-635), which the web
    // entry screen has always called and this roster has never carried.
    //
    // `sync_head_fingerprint` is how that screen learns approval LANDED: it
    // polls `sync_now` then this, and a non-`None` answer means a head was
    // adopted. Unported, it threw into the `catch` that exists for a pending
    // device's legitimately-failing cycles — so the screen polled forever and
    // never advanced, even after a desktop approved it.
    //
    // `sync_reset_local` is that screen's "the fingerprints don't match"
    // escape hatch. Unported, its rejection was swallowed and the UI claimed
    // the device had stopped trusting forked data while the enrolment stood.
    //
    // Both were absent from the dispatch router AND from here, which is why no
    // gate caught them: the two files agreed with each other about commands
    // neither knew existed.
    "plugin:sync|sync_head_fingerprint",
    "plugin:sync|sync_reset_local",
    // The eye-compare's push hold (myne#462). Dispatched rather than absent
    // because a browser is on both sides of this ceremony, and because the
    // web joiner re-runs it on EVERY re-bootstrap (`decisions.md` 2026-07-26
    // — OPFS is evictable), so it is exercised more here than on desktop.
    "plugin:sync|sync_verify_hold_begin",
    "plugin:sync|sync_verify_hold_end",
    // The quarantine surface (task 87) — `sync-protocol.md` §11.3's "moved
    // aside, never destroyed" rule needs a door, and these are it. `restore` is
    // NOT here: it mints a new note through `note_create_with_dir`, so it lands
    // with the notes WRITE path rather than ahead of it.
    "plugin:sync|sync_list_quarantine",
    "plugin:sync|sync_read_quarantine",
    "plugin:sync|sync_delete_quarantine",
    // Restore mints a note, so it could only land once the notes WRITE path
    // did (task 13). It has — this closes the quarantine door in both
    // directions.
    "plugin:sync|sync_restore_quarantine",
    // Keep-both conflict staging (task 87's other half). Without these a browser
    // would STAGE conflicts it could not resolve — the same dead end quarantine
    // had before its own pass.
    "plugin:sync|sync_pending_conflicts",
    "plugin:sync|sync_take_conflict",
    "plugin:sync|sync_resolve_conflict",
    "plugin:sync|sync_mark_tombstone",
    // Task 13 — the notes read AND write paths, complete. The batch was the last
    // one held back, and the two reasons it was held both dissolved elsewhere:
    // the clock became `HostCtx::now_unix_millis` (task 12), and task 86
    // replaced the WAL's rename-and-parent-fsync durability with
    // write-then-remove behind a presence marker, which OPFS can honour.
    "plugin:notes|note_list",
    "plugin:notes|note_read",
    "plugin:notes|note_titles_batch",
    "plugin:notes|note_create",
    "plugin:notes|note_update",
    "plugin:notes|note_delete",
    "plugin:notes|note_write_batch_transactional",
    // Tasks 14 + 83 — the `MYS1` index, its lifecycle hooks and the query door.
    "plugin:notes|note_search",
    // Task 14 — the pure in-RAM index queries plus the two storage-touching ones.
    "plugin:vault-indices|vault_indices_all_edges",
    // myne#216 — the vault-wide heading set behind the wikilink heading picker,
    // moved off a full-vault `note_read` sweep and onto the index. (Spelling the
    // picker's trigger literally here would unbalance the brackets this file's
    // coverage guard counts to find the const body.)
    "plugin:vault-indices|vault_indices_headings",
    "plugin:vault-indices|vault_indices_orphans",
    "plugin:vault-indices|vault_indices_tag_tree",
    "plugin:vault-indices|vault_indices_property_keys",
    "plugin:vault-indices|vault_indices_persist",
    "plugin:vault-indices|vault_indices_hydrate",
];

/// Whole plugins with one classification. An entry applies to every command
/// under that plugin unless [`PER_COMMAND`] overrides the specific name.
///
/// Patterns rather than one literal string per command on purpose: the
/// classification is per **capability**, and a capability is a plugin far more
/// often than it is a single command. Listing every name would bury the
/// genuinely per-command decisions in a wall of repetition.
///
/// The count that used to stand in this sentence was stale by roughly a third
/// when it was removed, which is the same failure the note under [`PER_COMMAND`]
/// describes. Deleting it rather than correcting it is deliberate: a fresh
/// number restarts the clock, and `scripts/check-web-command-coverage.mjs`
/// prints the live one on every run.
///
/// A plugin default is a **quiet** answer, which is the property [`BOOT_PATH`]
/// exists to withhold from a handful of names: `Pending` here means "a port is
/// owed" and reads as a decision, so a command nobody ever considered inherits
/// one and looks considered.
const PLUGIN_DEFAULT: &[(&str, Class)] = &[
    // ── decided absent on web ────────────────────────────────────────────────
    //
    // The browser clipper pairs a native-messaging host to a browser extension
    // through a desktop-installed manifest (`src-tauri/src/clipper/`). A page
    // cannot be a native-messaging host; the extension talks to the desktop app
    // or to nothing. Task 27 "Absent on web: clipper".
    ("clipper-pairing", Class::Unsupported),
    // On-device LLM inference. Task 27 "Absent on web: local AI".
    //
    // The IN-PROCESS arm genuinely cannot run here: candle + multi-GiB GGUF
    // weights loaded from a bundled resource path on a CPU thread pool, and a
    // Worker has neither the pool nor the resource directory.
    //
    // **The provider arm is a DECISION, not a browser limitation, and saying
    // otherwise would be this file's own "a decision outliving the thing it
    // decided".** Since `decisions.md` 2026-08-09 a user may name a local model
    // runtime on loopback — and a page *can* reach `127.0.0.1`, so "the browser
    // can't" is simply false here, unlike the Tor case it superficially
    // resembles. It stays absent because a served bundle reaching a local
    // daemon is A15/TB11 territory: it would need its own CSP `connect-src`
    // analysis, and it collides with `check-web-third-party.mjs` (zero
    // third-party origins in the served bundle). Revisiting it is a decision
    // with an owner, not an omission.
    //
    // Note this whole entry is inherited by every command under the plugin, so
    // `check-web-command-coverage.mjs` passes unedited when one is added — which
    // is exactly why a wrong rationale here is invisible to every guard and
    // visible only to a reader.
    ("local-inference", Class::Unsupported),
    // Agentic note editing (myne-md/myne#529). Unsupported for the same reason
    // as `local-inference` directly above and by the same decision: the whole AI
    // surface is absent on web, and this plugin has no meaning without a model
    // to run. It carries nothing web-specific of its own: no storage, no new
    // origin, no seam, so there is nothing here that a web port could enable
    // independently of porting the AI surface itself, which is its own epic
    // rather than a task under this feature.
    //
    // `Class::Unsupported` rather than `Class::Pending` deliberately: the
    // feature's own PRD puts web out of scope, and Pending would advertise an
    // affordance the client is not going to grow.
    ("agent", Class::Unsupported),
    // Backup export/restore. `decisions.md` 2026-07-26 "Web capability set":
    // "Opening a backup file as an alternative entry path is not offered", and
    // the code lives in `src-tauri/`, so it would be net-new rather than
    // inherited. Task 27 "Absent on web: backup export/restore".
    ("backup", Class::Unsupported),
    // Account and vault creation. `decisions.md` 2026-07-26 made this absent:
    // the 24-word recovery phrase was "never generated by, displayed by, or
    // typed into served code", and creation both generates and shows it.
    //
    // **`decisions.md` 2026-08-15 reverses that**, so all three commands are
    // DISPATCHED below. The plugin default stays `Pending` rather than becoming
    // an approval-by-default: a FOURTH creation command added later must argue
    // for itself in the dispatch router instead of inheriting a blanket yes from
    // this row, which is the same posture `vault-change-password` and
    // `vault-delete` already take.
    ("vault-creation", Class::Pending),
    // The whole-vault v0.1 → v0.2 migration (#420) is a DESKTOP flow: it re-keys
    // and re-encrypts the entire vault at rest and requires the 24-word recovery
    // phrase, which is never typed into served code (the same reason
    // `vault-creation` and `vault-recover` are absent on web — `decisions.md`
    // 2026-07-26). A browser client joins an already-current account over sync;
    // it does not migrate one.
    ("vault-migrate", Class::Unsupported),
    // Markdown tree export to an OS path chosen through a native Save-As
    // dialog. `core-wasm-assessment.md`: `cannot-exist-in-browser` — "The
    // command's contract IS the desktop filesystem". Task 48's browser
    // download flow is a differently-shaped command, not this one, which is
    // why this stays `Unsupported` rather than `Pending`.
    ("export", Class::Unsupported),
    // ── port or decision still owed ──────────────────────────────────────────
    ("prefs", Class::Pending), // tasks 30, 33
    ("notes", Class::Pending), // task 13
    // Every CRUD command is DISPATCHED (task 44) — import, catalog_list,
    // delete, rename, unused_list, clean_unused, plus the web-only
    // `attachment_object_url`. The entry stays `Pending` so a command this port
    // did NOT reach (`attachment_export` → task 48, `attachment_read_text` /
    // `attachment_read_structured` → the desktop-only preview parsers, the
    // `voice_record_*` trio → task 47's capture decision) lands loudly rather
    // than silently.
    ("attachments", Class::Pending),   // tasks 48, 67
    ("sync", Class::Pending),          // tasks 84–86
    ("vault-unlock", Class::Pending),  // task 12
    ("vault-indices", Class::Pending), // task 31
    // Every themes command is DISPATCHED (task 45); the entry stays so a
    // future command lands loudly rather than silently.
    ("themes", Class::Pending), // task 33
    // Deferred by task 46, not forgotten by it. The four READ commands port
    // cleanly, but `VaultLifecycleHooks::capture_snapshot` is a SYNCHRONOUS
    // trait method and web installs `NoopHooks`, which returns `false` — so
    // nothing on this client ever writes a snapshot, and shipping the readers
    // would give a history viewer that is permanently empty. Making the hook
    // async is a `mobile/` client change; both belong to task 83.
    ("snapshots", Class::Pending), // task 83 (WebHooks decides capture first)
    // Both commands are DISPATCHED (task 46); the entry stays so a future
    // graph-layout command lands loudly rather than silently.
    ("graph-layout", Class::Pending), // task 46
    ("quick-unlock", Class::Pending), // task 40 (the PIN path only; see PER_COMMAND)
    // Dispatched by the arm in `dispatch.rs` (tasks 41 + 88). Listed in
    // DISPATCHED below rather than defaulted here.
    ("vault-change-password", Class::Pending), // task 41 — the plugin default; the one command is dispatched
    // Its one command is DISPATCHED (task 72); the entry stays so a future
    // vault-delete command lands loudly rather than silently.
    ("vault-delete", Class::Pending),
    ("vault-recover", Class::Pending), // task 32 (account-number resolve only; see PER_COMMAND)
    // myne-md/myne#411: the device-local hide-vault-names flag, its setter
    // (which IS the erase) and the keychain-availability probe the Settings
    // Privacy row renders. ABSENT on web, and decided by two facts this repo
    // had already recorded rather than by a fresh call. The setting's entire
    // subject is what the LOCKED PICKER shows, and there is no locked picker
    // here: `check-web-screens.mjs` records `VaultPicker.tsx` as `excluded`
    // because an origin holds exactly one container (constant vault id, task
    // 85), so the >=2-vault branch that produces the picker stage cannot be
    // reached. And the `MYL1` store the flag governs is sealed under an OS
    // keychain `wrap_key`, which a browser does not have, which is why
    // `dispatch.rs`'s two `platform_keychain()` call sites already resolve to
    // the unavailable one.
    //
    // What is absent is the PICKER and the KEYCHAIN, not the encryption.
    // `MYL1` is untouched by this and so is desktop, where the row ships
    // ungated. Web simply has no screen for the option to govern and nowhere
    // to keep the key whose destruction is the erase, so the option here would
    // be a control with no referent.
    //
    // `Unsupported` rather than `Pending` for the reason `vault-repair` below
    // is: `Pending` promises a port, and no port makes a switch meaningful
    // when the thing it switches does not render. The capability behind it is
    // `lockedVaultNames`, absent in the web descriptor, so `PrivacyPanel`
    // omits the row instead of rendering one whose three probes all reject.
    ("vault-label", Class::Unsupported),
    // myne-md/myne#684: the device-local account record (the account/vault
    // split). Absent on web because the thing it governs is absent: a browser
    // holds exactly one vault per origin and has no OS keychain, so there is no
    // grouping to render and nowhere to keep the wrap key whose seal is the
    // record. `Unsupported` rather than `Pending` for the reason `vault-label`
    // above gives: `Pending` promises a port, and no port makes grouping
    // meaningful when there is one vault and no keychain.
    ("account", Class::Unsupported),
    // myne-md/myne#482 + #483: the device-local screen-capture escape hatch
    // and the WebView-side re-assert. Absent on web because the thing they
    // govern is absent: a page cannot ask a browser to exclude itself from the
    // compositor's capture path, so there is no affinity to suppress and none
    // to re-assert after a re-show. `threat-model.md` A15/TB11 already says the
    // web client has no screen-capture protection to fall back on.
    //
    // `Unsupported` rather than `Pending`, for the reason `vault-label` above
    // gives: `Pending` promises a port, and no port makes an escape hatch
    // meaningful when there is nothing to escape from. The capability behind it
    // is `screenCaptureProtection`, absent in the web descriptor, so
    // `PrivacyPanel` and `ScreenCaptureEscape` both omit rather than render
    // controls whose commands would reject.
    ("screen-capture", Class::Unsupported),
    // Owner decision, 2026-07-27 (task 72): repair is ABSENT on web. It scans a
    // vault DIRECTORY for orphan artefacts, which exists because a desktop
    // directory is writable by other software; an OPFS container has one writer
    // and its one damage mode (eviction) is answered by re-sync (task 22). So
    // the affordance is omitted rather than disabled, and the command answers a
    // typed `unsupported` for the paths gating cannot reach.
    ("vault-repair", Class::Unsupported),
    ("secret-export", Class::Pending), // task 46
    // Task 47: absent on web this release. A bundle-size decision, not a
    // portability one — dictionaries are bundled binary resources and would
    // dominate a bundle whose trust story is that it is small enough to audit.
    // `Unsupported` rather than `Pending` because the UI omits the affordance
    // (`spellCheck` is in the web descriptor's ABSENT set), and `Pending` would
    // mean "a port is owed", which would be a different promise.
    //
    // The `MYD1` personal dictionary is untouched by this: it is vault content
    // (`sync-protocol.md` §9 Class 1), so it keeps syncing and a desktop session
    // keeps using it. What is absent is the CHECKER, not the word list.
    ("spell", Class::Unsupported),
    // All three commands are DISPATCHED (task 65 — ported into `core/` rather
    // than gated); the entry stays so a future workspace command lands loudly
    // rather than silently.
    ("workspace", Class::Pending), // task 65
    // Task 71, owner decision 2026-07-27: markdown import SHIPS on web — but not
    // through these two commands. They are a host-confined READ seam
    // (`canonicalize` + within-root), which exists because the desktop WebView is
    // denied `fs:allow-read-dir`; a browser has no path to canonicalise and no
    // host to confine to, so it gets the tree from the user's own directory pick
    // instead. `Unsupported` names the missing MECHANISM, and the capability
    // backing it is `hostDirectoryRead` rather than anything import-shaped — the
    // feature is not absent, this way of reaching it is.
    ("importer", Class::Unsupported),
    // Task 48: absent on web. The obstacle is the OUTPUT rather than the
    // destination — it drives a hidden Tauri WebView, prints it and collects the
    // result, which has no page-side counterpart short of shipping a PDF engine
    // in the bundle. Note-as-markdown and attachment download DO ship, through
    // the browser download flow (`web/src/platform/download.ts`), because their
    // obstacle was the destination and a download answers that.
    ("pdf-export", Class::Unsupported),
    // MYND-490 (cli-thin-client task 12): the `myne` terminal client's door.
    // The one command here reports the door's session state — how long ago the
    // command socket last served a request, and whether the `myne` binary is on
    // the user's `$PATH`. Both questions presuppose a machine: a local Unix
    // socket the desktop process binds, and a sidecar shipped inside the desktop
    // bundle. `Unsupported` rather than `Pending` because there is nothing to
    // port — the capability backing it (`cliAccess`) is absent by platform fact,
    // and the Settings block is omitted rather than greyed.
    ("cli-bridge", Class::Unsupported),
    // myne#678 (epic #173): the pop-out spawn command. A detached note window is
    // a second host-spawned OS window; a browser page has one tab context and
    // cannot open one (the single-tab OPFS lock is the model). `Unsupported`
    // rather than `Pending` because there is nothing to port: the capability
    // backing it (`detachedWindows`) is absent by platform fact, and the affordance
    // is omitted rather than greyed.
    ("detached-window", Class::Unsupported),
];

/// Per-command overrides of [`PLUGIN_DEFAULT`]. Each one is a place where a
/// plugin's capability genuinely splits per command.
///
/// The count is deliberately not stated here. It said "four" while the list held
/// ten (myne-md/myne#535), which is the failure mode of every hand-maintained
/// tally sitting next to the thing it counts.
const PER_COMMAND: &[(&str, Class)] = &[
    // The two phrase-typing entry points were `Unsupported` under `decisions.md`
    // 2026-07-26 and are **DISPATCHED** under 2026-08-15, which reverses that
    // rule for display and entry alike. They are listed in `DISPATCHED` rather
    // than here; the plugin row stays `Pending` so
    // `resolve_vault_by_account_number` and any future sibling still have to
    // argue for themselves.
    // Task 27 "Absent on web: keychain/biometric quick-unlock". Scoped to the
    // biometric pair on purpose: `core-wasm-assessment.md` finds the **PIN**
    // path "genuinely portable (Argon2id + three files under one vault root, no
    // OS secret involved)", so the PIN commands are a port (task 40), not an
    // impossibility.
    // Task 90, owner-recommended verdict landed 2026-07-28: attachment-CONTENT
    // search is absent on web this release. The extractors live in `src-tauri/`
    // and `MYE1` is device-local and never synced (`protocol.md` §9.15), so a
    // browser can neither run an extraction nor inherit one — and
    // `read_extracted` reports a decode failure as a cache MISS meaning
    // "re-extract", which here would be an unwinnable retry on every import.
    // Scoped to the two READ commands: import, catalog, delete, rename and
    // cleanup all ship, and an attachment still matches by FILENAME.
    // myne#379. The plugin default is `Pending` (a `save_secret_text` port is
    // owed for the theme-export path), but THIS command is not owed a port and
    // never will be: it is the desktop 30 s clipboard auto-clear's read+compare,
    // moved host-side so the main window stops holding an OS-clipboard READ
    // grant. `check-web-surfaces.mjs` already records why the web arm cannot
    // have it — page content cannot be granted clipboard read in Firefox and is
    // gesture-gated elsewhere, so a clear would silently never fire. `Pending`
    // here would promise a port that the platform forbids.
    //
    // **The second half of that reasoning is no longer true and is corrected
    // rather than left standing.** It used to add "and no web path reaches it:
    // both callers of `copySecretToClipboard` are substituted out of the
    // bundle". `decisions.md` 2026-08-15 ships the creation flow here, so a
    // caller DOES exist. What keeps this command unreachable now is explicit
    // instead of incidental: `copySecretToClipboard` returns early where the
    // `clipboardAutoClear` capability is absent, and the phrase step tells the
    // user in words that the clipboard will not be cleared — because
    // `recovery-flow.md` §2.2 forbids presenting a control whose stated
    // protection the client cannot perform.
    (
        "plugin:secret-export|clipboard_clear_if_matches",
        Class::Unsupported,
    ),
    (
        "plugin:attachments|attachment_read_text",
        Class::Unsupported,
    ),
    (
        "plugin:attachments|attachment_read_structured",
        Class::Unsupported,
    ),
    // The read-back of the same device-local, never-synced `MYE1` cache (§9.15)
    // the two commands above serve — `read_extracted` is `#[cfg(not(wasm32))]`,
    // so a browser can neither run an extraction nor read one. Same
    // `attachmentTextSearch` capability, `Unsupported` for the same reason.
    (
        "plugin:attachments|attachment_read_extracted_text",
        Class::Unsupported,
    ),
    (
        "plugin:quick-unlock|quick_unlock_setup_biometric",
        Class::Unsupported,
    ),
    (
        "plugin:quick-unlock|quick_unlock_with_biometric",
        Class::Unsupported,
    ),
    // Task 27 "Absent on web: screen-capture protection". `set_content_protected`
    // is a Tauri window API (`docs/dependency-policy.md` load-bearing API
    // watchlist) with no browser counterpart — a page cannot ask the compositor
    // to exclude it from a capture.
    //
    // Deliberately the ONLY prefs command singled out. `set_auto_lock_timeout`
    // is NOT here even though task 27 lists "OS idle auto-lock" as absent: the
    // *pref* is vault content that syncs to every client, and it is the native
    // OS idle **detection** that has no browser equivalent. Refusing the write
    // would corrupt a setting the user's desktop depends on.
    (
        "plugin:prefs|set_screen_capture_protection",
        Class::Unsupported,
    ),
    // MYND-650 task 6: the device-local Tor-routing toggle. Two commands out of
    // a plugin that otherwise ships — deliberately per-command, because `sync`
    // itself works here and most of it is dispatched.
    //
    // The desktop answer to "route my sync through Tor" is a bundled Tor client
    // spawned as a subprocess plus a SOCKS5 tunnel over a loopback TCP socket.
    // A Worker has no subprocess to spawn, no raw socket to tunnel, and no way
    // to point `fetch` at a proxy — so this is `Unsupported`, not `Pending`:
    // there is no port owed. The browser's answer is Tor Browser, which routes
    // the whole page (docs, task 12).
    //
    // Refusing the READ too, not just the write, is deliberate. A read that
    // answered `{enabled: false}` would be a claim about this device's network
    // posture made by a client that cannot have one, and a UI reading it would
    // render an "off" toggle it can never turn on.
    ("plugin:sync|sync_get_tor_routing", Class::Unsupported),
    ("plugin:sync|sync_set_tor_routing", Class::Unsupported),
    // Task 8's posture read, refused for the same reason and with more force:
    // it reports whether *this device's* sync egress is going through a Tor
    // client, and a browser tab's honest answer to that is "I have no idea what
    // this browser is doing" — Tor Browser routes the page, invisibly to the
    // page. Answering `stopped` would read as "not protected" to a user who is
    // in fact running the whole browser over Tor.
    ("plugin:sync|sync_get_tor_state", Class::Unsupported),
];

/// Classify one IPC command name.
///
/// Precedence is [`DISPATCHED`] → [`PER_COMMAND`] → [`PLUGIN_DEFAULT`] →
/// `Pending`. The terminal fallback is `Pending` rather than `Unsupported`
/// because an unrecognised name means this table is out of date, and the loud
/// class is the right answer to that.
pub fn classify(cmd: &str) -> Class {
    if DISPATCHED.contains(&cmd) {
        return Class::Dispatched;
    }
    if let Some((_, class)) = PER_COMMAND.iter().find(|(name, _)| *name == cmd) {
        return *class;
    }
    if let Some(plugin) = plugin_of(cmd) {
        if let Some((_, class)) = PLUGIN_DEFAULT.iter().find(|(name, _)| *name == plugin) {
            return *class;
        }
    }
    Class::Pending
}

/// The plugin segment of `plugin:<name>|<command>`, or `None` for anything that
/// is not in that form.
fn plugin_of(cmd: &str) -> Option<&str> {
    cmd.strip_prefix("plugin:")?.split('|').next()
}

/// The probes that decide which screen the user lands on, which may not be
/// answered by a **plugin default** (myne-md/myne#535).
///
/// # Why these names get a rule of their own
///
/// A command whose port was missed normally announces itself: the call rejects
/// and something on screen says so. These do not announce it the same way,
/// because each is consumed by a caller that must produce an answer either way
/// (a probe cannot leave the user on a loading shim), so an unported one is
/// absorbed into a routing decision instead of surfacing as an error. Two shapes
/// of absorption, and the first is the dangerous one:
///
/// * **Laundered into a plausible answer.** `probeSlotKind()` catches and
///   returns `"Empty"`; `awaitingApprovalVerdict()` catches and returns `false`;
///   `useStorageHealth`'s catch leaves the health `null`, i.e. "nothing wrong
///   found". Each is a legitimate fallback and each is indistinguishable from a
///   real answer.
/// * **Fail-closed, loudly enough to see but not to diagnose.** `listVaults()`
///   preserves the failure as `{err}` and routes to `unlock(IoError)`;
///   `isVaultUnlocked()` rethrows and the Editor's mount guard renders
///   "Unexpected state. Please restart." Neither is silent, and neither names
///   the missing port either.
///
/// It has now happened twice. `vault_is_unlocked` shipped unported and replaced
/// a fully working session with that error screen (`dispatch.rs` says so at its
/// arm). `vault_slot_kind` shipped unported and made boot structurally unable to
/// see an unlocked slot, so a completed sign-in landed on the unlock form and
/// then on a dead-end `VaultAlreadyUnlocked` banner. Both times
/// `check-web-command-coverage.mjs` was green, because `classify` answered from
/// the plugin default and "classified" is all that guard asks for.
///
/// So the rule is narrow and mechanical: a name here must be argued for
/// **by name**, in [`DISPATCHED`] or in [`PER_COMMAND`]. Inheriting
/// `("vault-unlock", Pending)` is exactly the quiet outcome this list forbids.
/// It does NOT assert what the answer is, since a future probe could legitimately
/// be `Unsupported`. It asserts that somebody wrote one down, and that it is not still
/// `Pending`, which for a probe means the client cannot honestly boot.
///
/// Enforced by [`tests::boot_path_commands_are_classified_by_name`]. Verified by
/// breaking it: removing `vault_slot_kind` from [`DISPATCHED`] makes that test
/// fail and name it.
pub const BOOT_PATH: &[&str] = &[
    // `App.tsx`'s boot `Promise.all`: the disk list and the runtime slot.
    "plugin:vault-unlock|vault_list",
    "plugin:vault-unlock|vault_slot_kind",
    // The Editor's mount-time reality check, and the storage-health probe the
    // same screen polls.
    "plugin:vault-unlock|vault_is_unlocked",
    "plugin:vault-unlock|vault_storage_health",
    // The awaiting-approval verdict's two reads. Not boot any more, since #535
    // moved that verdict to the first screen AFTER unlock, and they are here
    // anyway because the membership rule is about the CALLER, not the moment:
    // both reads are made by a caller that converts a rejection into a plausible
    // answer, which is the whole property this roster exists to withhold from a
    // plugin default.
    //
    // They fail in OPPOSITE directions, and each direction is bad in its own
    // way, so neither may be inherited:
    //
    // * `sync_head_fingerprint` is caught into `null`, which means "this device
    //   has adopted no head" and routes TOWARD the compare. Unported, it would
    //   send every approved browser to the wait screen on every reload, forever.
    //   That is the reported #535 symptom wearing a different mask.
    // * `sync_status` is caught into `false`, which reads as "this device is not
    //   waiting for anything" on the one client where waiting is the normal
    //   first state.
    "plugin:sync|sync_head_fingerprint",
    "plugin:sync|sync_status",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_segment_is_parsed_and_malformed_names_do_not_match_a_plugin() {
        assert_eq!(plugin_of("plugin:prefs|prefs_read"), Some("prefs"));
        assert_eq!(plugin_of("prefs_read"), None);
        // A bare `plugin:` prefix yields an empty segment, which matches no
        // entry — the point is that it does not panic or slice out of bounds.
        assert_eq!(plugin_of("plugin:"), Some(""));
    }

    #[test]
    fn dispatched_beats_its_plugin_default() {
        // The property: a DISPATCHED entry wins over its plugin's default.
        assert_eq!(
            classify("plugin:prefs|device_platform"),
            Class::Dispatched,
            "DISPATCHED must take precedence over PLUGIN_DEFAULT"
        );
        // …and a sibling that is NOT dispatched still falls to the default.
        //
        // The counter-example is DERIVED, not hardcoded. It was
        // `plugin:prefs|prefs_read` until task 14 dispatched that command, at
        // which point this test failed for the right reason about the wrong
        // subject — the second time a hardcoded example has gone stale this way
        // (the router's `an_unported_command_is_loud_and_names_itself` was the
        // first). Picking any still-Pending sibling keeps the test about the
        // precedence RULE rather than about a name that keeps moving.
        //
        // **Third staleness, so the name is gone entirely.** Task 14 dispatched
        // the prefs setter surface and `set_favorites` — the previous
        // counter-example — went the way of `prefs_read` before it. The pattern
        // is now clear: any REAL command name is a moving target, because the
        // whole feature is a march of commands from Pending into Dispatched.
        //
        // So the example is synthetic. A name this build has never heard of,
        // under a plugin that still defaults to Pending, exercises the precedence
        // rule exactly — "an unlisted command takes its plugin's default" — and
        // cannot go stale, because nothing will ever dispatch it.
        let pending_plugin = PLUGIN_DEFAULT
            .iter()
            .find(|(_, class)| *class == Class::Pending)
            .map(|(plugin, _)| *plugin)
            .expect("some plugin should still default to Pending");
        let unlisted = format!("plugin:{pending_plugin}|__a_command_this_build_has_never_heard_of");
        assert_eq!(classify(&unlisted), Class::Pending);
    }

    #[test]
    fn per_command_beats_its_plugin_default_in_both_directions() {
        // Unsupported command inside a Pending plugin.
        assert_eq!(
            classify("plugin:prefs|set_screen_capture_protection"),
            Class::Unsupported
        );
        assert_eq!(
            classify("plugin:quick-unlock|quick_unlock_with_biometric"),
            Class::Unsupported
        );
        // …and its sibling in the same plugin is untouched.
        assert_eq!(
            classify("plugin:quick-unlock|quick_unlock_with_pin"),
            Class::Pending
        );
    }

    #[test]
    fn whole_plugin_defaults_apply_to_every_command_under_them() {
        for cmd in [
            "plugin:backup|vault_export_backup",
            "plugin:backup|backup_schedule_read",
            "plugin:clipper-pairing|pairing_accept",
            "plugin:local-inference|infer",
            // `plugin:vault-creation|begin` used to sit here and no longer can:
            // `decisions.md` 2026-08-15 ships creation on web, so the three
            // creation commands are DISPATCHED and the assertion below is their
            // replacement. Swapped rather than deleted, because the property
            // this test exists for — a whole-plugin default reaching every
            // command under it — is unrelated to which plugin demonstrates it.
            "plugin:vault-repair|repair_scan",
            "plugin:export|vault_export_markdown",
        ] {
            assert_eq!(classify(cmd), Class::Unsupported, "{cmd}");
        }
    }

    #[test]
    fn vault_creation_is_dispatched_not_defaulted() {
        // `decisions.md` 2026-08-15. The three commands are listed individually
        // in `DISPATCHED`, and the plugin row stays `Pending` on purpose: a
        // FOURTH creation command added later must appear in the router and in
        // the roster rather than inheriting a blanket yes.
        for cmd in [
            "plugin:vault-creation|begin",
            "plugin:vault-creation|commit",
            "plugin:vault-creation|cancel",
        ] {
            assert_eq!(classify(cmd), Class::Dispatched, "{cmd}");
        }
        assert_eq!(
            classify("plugin:vault-creation|some_future_command"),
            Class::Pending,
            "a new creation command must land as Pending, never inherit Dispatched"
        );
    }

    #[test]
    fn an_unknown_name_falls_to_pending_never_to_unsupported() {
        // The failure mode this pins: a command added to `src/` and forgotten
        // here must fail LOUDLY, not vanish from the UI as a decided absence.
        assert_eq!(classify("plugin:brand-new|do_a_thing"), Class::Pending);
        assert_eq!(classify("not_even_a_plugin_command"), Class::Pending);
    }

    #[test]
    fn no_command_is_classified_twice() {
        // PER_COMMAND is an override table; two entries for one name would make
        // the winner depend on declaration order.
        for (i, (name, _)) in PER_COMMAND.iter().enumerate() {
            assert!(
                !PER_COMMAND[i + 1..].iter().any(|(other, _)| other == name),
                "duplicate PER_COMMAND entry: {name}"
            );
            assert!(
                !DISPATCHED.contains(name),
                "{name} is both DISPATCHED and PER_COMMAND"
            );
        }
        for (i, (plugin, _)) in PLUGIN_DEFAULT.iter().enumerate() {
            assert!(
                !PLUGIN_DEFAULT[i + 1..]
                    .iter()
                    .any(|(other, _)| other == plugin),
                "duplicate PLUGIN_DEFAULT entry: {plugin}"
            );
        }
    }

    #[test]
    fn boot_path_commands_are_classified_by_name() {
        // myne-md/myne#535. The rule is about WHERE the answer comes from, not
        // what it is: a boot probe whose caller converts a rejection into a
        // plausible answer must be argued for by name, because a plugin default
        // makes "nobody considered this" and "we decided" look identical from
        // every other check in the tree.
        //
        // The floor first, because everything below it is a loop over the
        // roster: emptying `BOOT_PATH` would leave the body unrun and this test
        // green, which is the shape of a guard that has stopped checking. Pinned
        // at the measured count, so a probe cannot silently drop off the list.
        assert!(
            BOOT_PATH.len() >= 6,
            "BOOT_PATH lost entries: {} left, and this test is a loop over it",
            BOOT_PATH.len()
        );
        for cmd in BOOT_PATH {
            let named = DISPATCHED.contains(cmd) || PER_COMMAND.iter().any(|(name, _)| name == cmd);
            assert!(
                named,
                "{cmd} is a boot-path probe, so it must appear in DISPATCHED or PER_COMMAND \
                 by name. It currently inherits {:?} from its plugin default, which is the \
                 silent answer this list exists to forbid.",
                classify(cmd)
            );
            // The second assertion is not implied by the first: `PER_COMMAND`
            // may legitimately carry any `Class`, so a name could be argued for
            // BY NAME and still resolve to `Pending`. For a probe that is the
            // one answer the client cannot boot honestly on, whichever table it
            // came from. It also catches a renamed entry, which drops out of
            // both tables and lands back on the plugin default.
            assert_ne!(
                classify(cmd),
                Class::Pending,
                "{cmd} is a boot-path probe and classifies as Pending: either the name was \
                 changed and this roster is stale, or the port is genuinely owed"
            );
        }
    }
}
