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
//! in task 27, or a `cannot-exist-in-browser` verdict from
//! `core-wasm-assessment.md`. Anything not covered by one of those is `Pending`
//! by construction, which is why this file cannot quietly grow a product
//! decision.

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
    "plugin:prefs|set_new_note_location",
    "plugin:prefs|set_editor_text_size",
    "plugin:prefs|set_editor_line_spacing",
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
    "plugin:vault-indices|vault_indices_orphans",
    "plugin:vault-indices|vault_indices_tag_tree",
    "plugin:vault-indices|vault_indices_property_keys",
    "plugin:vault-indices|vault_indices_persist",
    "plugin:vault-indices|vault_indices_hydrate",
];

/// Whole plugins with one classification. An entry applies to every command
/// under that plugin unless [`PER_COMMAND`] overrides the specific name.
///
/// Patterns rather than 185 literal strings on purpose: the classification is
/// per **capability**, and a capability is a plugin far more often than it is a
/// single command. Listing every name would bury the four genuinely
/// per-command decisions in a wall of repetition.
const PLUGIN_DEFAULT: &[(&str, Class)] = &[
    // ── decided absent on web ────────────────────────────────────────────────
    //
    // The browser clipper pairs a native-messaging host to a browser extension
    // through a desktop-installed manifest (`src-tauri/src/clipper/`). A page
    // cannot be a native-messaging host; the extension talks to the desktop app
    // or to nothing. Task 27 "Absent on web: clipper".
    ("clipper-pairing", Class::Unsupported),
    // On-device LLM inference: candle + multi-GiB GGUF weights loaded from a
    // bundled resource path, on a CPU thread pool. Task 27 "Absent on web:
    // local AI". Not a size argument alone — there is no thread pool in a
    // Worker and no bundled resource directory to load from.
    ("local-inference", Class::Unsupported),
    // Backup export/restore. `decisions.md` 2026-07-26 "Web capability set":
    // "Opening a backup file as an alternative entry path is not offered", and
    // the code lives in `src-tauri/`, so it would be net-new rather than
    // inherited. Task 27 "Absent on web: backup export/restore".
    ("backup", Class::Unsupported),
    // Account and vault creation. `decisions.md` 2026-07-26: the 24-word
    // recovery phrase is "never generated by, displayed by, or typed into
    // served code", and creation both generates and shows it. This is the
    // normative half of that decision, not a scope cut.
    ("vault-creation", Class::Unsupported),
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
    // async is a `myne-mobile` companion change; both belong to task 83.
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
];

/// Per-command overrides of [`PLUGIN_DEFAULT`]. Four entries, each one a place
/// where a plugin's capability genuinely splits per command.
const PER_COMMAND: &[(&str, Class)] = &[
    // The two phrase-typing entry points, from the same `decisions.md`
    // 2026-07-26 decision as `vault-creation` above. `vault-recover`'s third
    // command (`resolve_vault_by_account_number`) types no phrase and stays
    // `Pending` for task 32 to place.
    (
        "plugin:vault-recover|recover_with_phrase",
        Class::Unsupported,
    ),
    ("plugin:vault-recover|complete_recovery", Class::Unsupported),
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
    (
        "plugin:attachments|attachment_read_text",
        Class::Unsupported,
    ),
    (
        "plugin:attachments|attachment_read_structured",
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
            "plugin:vault-creation|begin",
            "plugin:export|vault_export_markdown",
        ] {
            assert_eq!(classify(cmd), Class::Unsupported, "{cmd}");
        }
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
}
