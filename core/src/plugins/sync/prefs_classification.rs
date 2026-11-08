// SPDX-License-Identifier: AGPL-3.0
//! Normative shared/device-local classification of `vault.prefs` fields
//! (MYND-478; `sync-protocol.md` §10.2).
//!
//! This module is the **single in-code copy** of the §10.2 classification
//! table. The merge phase (`prefs_merge`) consumes it; nothing else may
//! re-derive which fields sync. The conformance test below exhaustively
//! destructures [`protocol::PrefsView`] — a newly added prefs field fails
//! compile here until it receives a classification row, which per §10.2 must
//! land together with a spec-table row in the same change.

/// Merge discipline of a **shared** pref (`sync-protocol.md` §10.2).
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum SharedDiscipline {
    /// Newer field clock wins the whole scalar value.
    ScalarLww,
    /// Sorted, de-duplicated union of both sides, with a **per-entry removal
    /// clock** (myne#613): an entry present on one side only is kept unless the
    /// absent side's `<field>/<entry>` clock is strictly greater, in which case
    /// that side deleted it. The union alone was clockless, which made a removal
    /// unexpressible: the peer's copy came straight back within two rounds.
    /// Exactly the myne#296 rule the per-key maps carry, one shape over.
    ///
    /// `folded` selects the entry identity, and the two are not interchangeable.
    /// `true` for the four folder sets, whose entries fold through `folderKey`
    /// (NFC + case-fold, `markdown-dialect.md` §3.6.2) so `personal/` and
    /// `PERSONAL/` are one entry. `false` for `spell_languages`, whose entries
    /// are case-sensitive language codes: folding them would merge `de-DE` into
    /// `de-de`. The flag lives here rather than beside the merge call so the
    /// classification table stays the single place that knows, which is what
    /// lets the stamper and the merge agree on a clock key by construction.
    /// `removals_propagate` decides whether a removal may be INHERITED from a
    /// peer, and it is a security property for two of the five fields rather
    /// than a preference about merge shape.
    ///
    /// `true` for the organisational sets (`deliberate_folders`,
    /// `archived_folders`, `spell_languages`): the user deleted a folder or a
    /// language and expects it gone everywhere, which is what myne#613 is for.
    ///
    /// `false` for `ai_excluded_folders` and `cli_excluded_folders`, which are
    /// EGRESS CONTROLS and not preferences. `threat-model.md` A17 rests its
    /// remote-provider mitigation on the first ("`ai_excluded_folders` remains
    /// the content-scoped control"), and the shipped UI promises both
    /// absolutely ("Notes in these folders are never read or indexed by AI";
    /// "Folders the terminal never sees"). Their union was monotone by design:
    /// an exclusion present on ANY device survived every merge, so the merge
    /// could only ever fail closed.
    ///
    /// A removal clock breaks exactly that. Removal then races on a wall clock,
    /// and a device whose clock is skewed forward can unexclude a folder in a
    /// way no correctly-clocked device can undo, because the re-add stamps the
    /// SMALLER clock. §10.2's "a skewed winner is repaired by the next genuine
    /// edit" is true for a preference and false for a control whose whole job is
    /// to stay on.
    ///
    /// **What monotone costs, stated because the first version of this comment
    /// got it wrong.** It said "unexcluding still works; it is a local act that
    /// does not travel". It is not local: the single-sided arm restores the
    /// peer's copy unconditionally, so on a synced vault an exclusion cannot be
    /// removed on ANY device once a second device holds it. Removing one means
    /// removing it everywhere, or adding an explicit un-exclude path that says
    /// so. That is the pre-myne#613 behaviour rather than a regression, and it
    /// is the fail-closed side of the trade, but it is a product limitation and
    /// belongs in the issue rather than in a comment claiming the feature
    /// works.
    SetUnion {
        folded: bool,
        removals_propagate: bool,
    },
    /// The whole ordered list is replaced by the newer side; one clock per list.
    SequenceLww,
    /// The whole array/map value is replaced by the newer side; one clock.
    WholeValueLww,
    /// Union of keys; a key edited on both sides resolves LWW on its own
    /// `<field>/<key>` clock (e.g. `device_names/<key>`,
    /// `item_colors/<folderKey>`, `folder_icons/<folderKey>` — MYND-562).
    /// The per-key value is LWW-on-whole, so this discipline also carries
    /// `item_order` (MYND-596): its per-container value is a whole child
    /// sequence rather than a scalar, and each container path races on
    /// `item_order/<container>`.
    PerKeyMapMerge,
}

/// Classification of one `vault.prefs` field (`sync-protocol.md` §10.2).
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum PrefClass {
    /// Describes the vault — syncs, merging per the discipline.
    Shared(SharedDiscipline),
    /// Describes how this device presents/secures the vault — the local
    /// value always survives the merge.
    DeviceLocal,
    /// Merge metadata, not a preference: the `field_clocks` map itself.
    /// The merged blob carries the winning clock per field.
    MergeMetadata,
}

/// The normative table — one row per [`PrefsView`] field, mirroring the
/// `sync-protocol.md` §10.2 classification table exactly. Kept alphabetical
/// by field name (the §9.5.2 canonical key order) so a spec-diff reads
/// side-by-side.
pub const CLASSIFICATION: &[(&str, PrefClass)] = &[
    ("active_workspace", PrefClass::DeviceLocal),
    ("ai_enabled", PrefClass::DeviceLocal),
    (
        "ai_excluded_folders",
        // An EGRESS CONTROL, so its union stays monotone: a removal is a
        // local act and is never inherited from a peer. See the variant's
        // doc for why a removal clock would be fail-OPEN here.
        PrefClass::Shared(SharedDiscipline::SetUnion {
            folded: true,
            removals_propagate: false,
        }),
    ),
    // Shared, and a deliberate divergence from its nearest neighbour above:
    // `ai_enabled` is DeviceLocal because "should THIS machine spend its CPU
    // on inference" is a property of the machine. Naming a REMOTE provider is
    // not — it is a statement about where this vault's notes may be sent, and
    // a vault whose owner said "OpenRouter" has said it about the vault.
    //
    // **Three of the four rows below travel together; the consent does not,
    // since myne-md/myne#456.** This comment used to say all three did, and
    // record the cost as a residual: a newly enrolled device inherited the
    // selection, the consent AND the key, and began sending without anyone at
    // that device seeing the consent screen (ledger SYNC-22; `threat-model.md`
    // §5 stated the same normatively). That residual is closed rather than
    // still being carried, see the `ai_provider_consent` row. What a newly
    // enrolled device inherits now is a selection, a model and a credential,
    // and none of those is permission to use them.
    (
        "ai_provider",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    // DeviceLocal since myne-md/myne#456, and it was `Shared(ScalarLww)` until
    // then. This is the one field in the AI cluster that does NOT travel, and
    // the split is the whole point rather than an inconsistency.
    //
    // **What the old reasoning was, and why it expired.** It read: splitting
    // consent from the selection it approves "would produce the worst state of
    // the four: a device that inherited a provider and a key but not the
    // consent would be configured and silently refused, with no screen anywhere
    // to fix it." That was true and it is no longer, because the missing screen
    // is what myne-md/myne#456 builds. Mobile ships a consent surface in the
    // same change; desktop already had one. A device in that state is now one
    // tap from resolving it, so the argument for carrying the approval across
    // devices lost the thing it rested on.
    //
    // **What this closes.** SYNC-22, stated normatively in `threat-model.md`
    // §5: a newly enrolled device inherited the selection, the consent AND the
    // key, and began sending without anyone at that device seeing the consent
    // screen. It was harmless only while no mobile code read those fields, and
    // writing that code is what made it real. Approving on a laptop is now an
    // approval by that laptop, not by every device the account will ever hold.
    //
    // **The key deliberately still syncs** (see the entry below), so a phone
    // holds a credential it may not use. That is the intended shape: the
    // credential is an account fact and rotating it must reach every device,
    // while the approval is a decision a person makes at a device. The gate is
    // an equality against the active provider, so a phone with the key and no
    // local consent refuses with `ConsentMissing`: "you have not agreed to send
    // this": rather than with a missing-credential error it cannot act on.
    //
    // It is also the ONLY device-local control left on the remote path besides
    // `ai_enabled`, because myne-md/myne#456 removed `developer_mode` from the
    // gate. Those two changes are a pair and neither is defensible alone: one
    // switch by itself would be thinner than what was there before.
    ("ai_provider_consent", PrefClass::DeviceLocal),
    // Shared (SYNC-15). Last-writer-wins is right for a credential in a way it
    // is not for a set: rotating the key on one device MUST replace it
    // everywhere, and a union or a merge of two key values is not a thing that
    // could mean anything. Note the consequence for revocation — deleting the
    // key propagates as an LWW write of `None`, which is what makes "revoke"
    // reach the other devices at all.
    (
        "ai_provider_key",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    // Shared, with the selection it qualifies — the pair is meaningless split.
    // Contrast the nearest DEVICE-classified neighbour, the AI endpoint: that
    // one names a daemon on one machine, so it cannot travel. A model name is
    // a choice about the account's provider, not about this laptop, and a
    // device that inherited "OpenRouter" but not "which model" would be
    // configured and unable to ask (SYNC-24 ships no fallback to paper over
    // it). LWW rather than a set: two chosen models is not a state.
    (
        "ai_provider_model",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    (
        "archive_disabled",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    (
        "archived_folders",
        PrefClass::Shared(SharedDiscipline::SetUnion {
            folded: true,
            removals_propagate: true,
        }),
    ),
    // Shared (ingest-image-compression, MYND-478 §10.2 row): a deliberate
    // divergence from the neighboring compute-budget cluster just below
    // (`attachment_ocr_enabled` / `ai_enabled` / `spell_enabled`) — those are
    // per-device resource switches whose effect is local and reversible,
    // while this one gates an irreversible, vault-wide content-fidelity
    // change to every future imported attachment. The switch must have the
    // same reach as the effect it controls, so it syncs.
    (
        "attachment_compression_enabled",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    ("attachment_ocr_enabled", PrefClass::DeviceLocal),
    ("auto_lock_seconds", PrefClass::DeviceLocal),
    // MYND-651. **Shared**, for the same reason as `transcription_enabled` just
    // below and deliberately unlike its co-gate `ai_enabled` (DeviceLocal):
    // that flag is device-local because it gates a device-local model-path
    // override, and this one gates a bundled task-model every client that ships
    // the AI path carries. Whether the user wants automatic tag suggestions at
    // all is taste, not capability — a device-local value would mean
    // re-choosing it on every new device. A device without the engine still
    // never runs the pass, because `ai_enabled` gates it independently.
    (
        "auto_tag_enabled",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    ("bar_items_order", PrefClass::DeviceLocal),
    // A bound on how much this machine sends to a provider, so it belongs to
    // this machine: the same reasoning `ai_enabled` gets one line down. A laptop
    // on a metered connection and a desktop on a fast one legitimately disagree,
    // and a value that synced would let one device widen the other's off-device
    // volume without anyone at that device choosing it (TB13's consent is
    // per-account, which is exactly why the VOLUME should not be).
    ("chat_history_budget", PrefClass::DeviceLocal),
    ("cli_enabled", PrefClass::DeviceLocal),
    (
        "cli_excluded_folders",
        // An EGRESS CONTROL, so its union stays monotone: a removal is a
        // local act and is never inherited from a peer. See the variant's
        // doc for why a removal clock would be fail-OPEN here.
        PrefClass::Shared(SharedDiscipline::SetUnion {
            folded: true,
            removals_propagate: false,
        }),
    ),
    ("cli_rate_limit_disabled", PrefClass::DeviceLocal),
    (
        "color_groups",
        PrefClass::Shared(SharedDiscipline::WholeValueLww),
    ),
    ("custom_theme", PrefClass::DeviceLocal),
    (
        "daily_date_format",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    (
        "daily_folder",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    (
        "daily_template",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    // myne#279. **Shared**, the `daily_date_format` class exactly: how a date is
    // printed is taste, and a device-local value would mean re-choosing it on
    // every new device.
    (
        "date_format",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    (
        "deliberate_folders",
        PrefClass::Shared(SharedDiscipline::SetUnion {
            folded: true,
            removals_propagate: true,
        }),
    ),
    // developer-mode (MYND-593): gates a device-local model-path override, so
    // a synced flag would read "on" on a device with no override behind it —
    // same reasoning as `ai_enabled` / `attachment_ocr_enabled`.
    ("developer_mode", PrefClass::DeviceLocal),
    (
        "device_names",
        PrefClass::Shared(SharedDiscipline::PerKeyMapMerge),
    ),
    ("editor_content_width", PrefClass::DeviceLocal),
    ("editor_default_view_mode", PrefClass::DeviceLocal),
    ("editor_focus_dim_inactive", PrefClass::DeviceLocal),
    ("editor_focus_typewriter", PrefClass::DeviceLocal),
    ("editor_font_family", PrefClass::DeviceLocal),
    ("editor_layout", PrefClass::DeviceLocal),
    ("editor_line_numbers", PrefClass::DeviceLocal),
    ("editor_line_spacing", PrefClass::DeviceLocal),
    ("editor_slash_hidden", PrefClass::DeviceLocal),
    ("editor_slash_order", PrefClass::DeviceLocal),
    ("editor_text_size", PrefClass::DeviceLocal),
    ("editor_toolbar_hidden", PrefClass::DeviceLocal),
    ("editor_toolbar_order", PrefClass::DeviceLocal),
    // vim-keyboard-mode (MYND-313): device-local, like every other editor
    // preference. Modal editing is a per-device input choice — a desktop with a
    // physical keyboard and a phone with a touch keyboard want different answers —
    // so the local value always survives the merge.
    ("editor_vim_mode", PrefClass::DeviceLocal),
    (
        "favorites",
        PrefClass::Shared(SharedDiscipline::SequenceLww),
    ),
    ("field_clocks", PrefClass::MergeMetadata),
    (
        "folder_icons",
        PrefClass::Shared(SharedDiscipline::PerKeyMapMerge),
    ),
    // myne-md/myne#661: the folder-notes feature off-switch. **Shared**, the
    // `show_task_marker` reasoning: whether folder notes are honoured is a
    // note-list presentation preference (taste), not a device capability, so it
    // should not be re-chosen on every new device. A scalar bool.
    (
        "folder_notes_enabled",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    ("hidden_bar_items", PrefClass::DeviceLocal),
    ("icon", PrefClass::Shared(SharedDiscipline::ScalarLww)),
    (
        "item_colors",
        PrefClass::Shared(SharedDiscipline::PerKeyMapMerge),
    ),
    // MYND-596: promoted from SequenceLww to per-container map merge — each
    // container path races on its own `item_order/<container>` clock, so a
    // reorder in one folder no longer clobbers a concurrent reorder in another
    // (the MYND-562 decoration-map fix, applied to the sidebar order).
    (
        "item_order",
        PrefClass::Shared(SharedDiscipline::PerKeyMapMerge),
    ),
    ("keymap", PrefClass::DeviceLocal),
    ("label", PrefClass::Shared(SharedDiscipline::ScalarLww)),
    ("last_backup_at", PrefClass::DeviceLocal),
    // external-mcp-connection (myne-md/myne#923). **DeviceLocal**, and this is
    // the third time this exact shape would have shipped in this tree: the AI
    // provider consent was shared until myne-md/myne#456, and the plugin
    // feature's post-audit pass found the identical bug in its own design. A
    // synced grant would let a newly enrolled device inherit an approval nobody
    // at that device gave, for opening the vault to a process Myne does not
    // ship. It would also mean something different per device: the frozen scope
    // names folder paths, and two devices can hold different trees after a
    // merge. The local value always survives; a second device is asked again.
    ("mcp_connections", PrefClass::DeviceLocal),
    // Device-local for the same reason and one step further (external-mcp-connection
    // task 13). A queued request is a write WAITING for this device's person to
    // accept it, and accepting widens a grant that only exists on this device: a
    // synced queue would let a peer's request be accepted here against a grant this
    // device does not hold, and the folder paths it names describe one device's tree.
    ("mcp_write_requests", PrefClass::DeviceLocal),
    // Shared / ScalarLww (meeting-ai). The user's custom meeting-AI instruction
    // is vault content they want on every device, so it travels; last-writer-wins
    // is the right merge for a single text value.
    (
        "meeting_ai_prompt",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    (
        "new_note_location",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    (
        "new_note_location_folder",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    ("paired_extensions", PrefClass::DeviceLocal),
    // myne#177: shared, and per-key rather than whole-value for the reason the
    // decoration maps are (MYND-562). The keys are `<period>.<setting>`, so a
    // folder set on one device and a template set on another, to the same
    // period in the same round, race on `periodic_notes/weekly.folder` and
    // `periodic_notes/weekly.template` separately and both survive. Shared
    // rather than device-local because where a weekly note is filed is a vault
    // convention, the `daily_folder` class, not a property of the machine.
    (
        "periodic_notes",
        PrefClass::Shared(SharedDiscipline::PerKeyMapMerge),
    ),
    // myne-md/myne#1037: shared, and per-key for the same reason the decoration
    // maps and `periodic_notes` are. A calendar's colour and the all-day reminder
    // anchor are different settings, so a colour set on one device and an anchor
    // set on another, in the same round, race on `calendar_settings/colours.work`
    // and `calendar_settings/day_reminder_anchor` separately and both survive.
    // **Shared** rather than device-local, and the line matters because the
    // reminder neighbours are the other way round: `reminders_enabled` and
    // `reminder_horizon_days` are per-MACHINE (whether this device may interrupt
    // its user, and how much pending plaintext it hands its OS), while the anchor
    // is when the calendar says an all-day reminder falls, which is a property of
    // the schedule the user carries between their own devices.
    (
        "calendar_settings",
        PrefClass::Shared(SharedDiscipline::PerKeyMapMerge),
    ),
    ("reminder_horizon_days", PrefClass::DeviceLocal),
    ("reminders_enabled", PrefClass::DeviceLocal),
    // myne-md/myne#699. **DeviceLocal**, like every sibling layout pref
    // (`bar_items_order`, `right_panel_tab_order`, the editor_toolbar /
    // editor_slash orders): the rail is how THIS machine's chrome is arranged,
    // so the local value always survives the merge.
    ("ribbon_items", PrefClass::DeviceLocal),
    ("ribbon_visible", PrefClass::DeviceLocal),
    ("right_panel_active_tab", PrefClass::DeviceLocal),
    ("right_panel_hidden_tabs", PrefClass::DeviceLocal),
    ("right_panel_tab_order", PrefClass::DeviceLocal),
    (
        "saved_views",
        PrefClass::Shared(SharedDiscipline::WholeValueLww),
    ),
    ("screen_capture_protection", PrefClass::DeviceLocal),
    ("show_note_timestamps", PrefClass::DeviceLocal),
    // MYND-613. **Shared**, deliberately unlike its lexicographic neighbour
    // `show_note_timestamps` (DeviceLocal): device-local exists because devices
    // genuinely differ in capability, and a marker's visibility is taste, not
    // capability — a device-local value would mean re-choosing it on every new
    // device.
    (
        "show_task_marker",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    ("spell_enabled", PrefClass::DeviceLocal),
    // The one set field that is NOT folded. Its entries are BCP-47 language
    // codes, not folder paths: folding would collapse `de-DE` into `de-de` and
    // silently drop one of two legitimately distinct entries. §10.2 has always
    // said so in prose ("language codes, case-sensitive"); myne#613 moved the
    // distinction into the table so the merge and the stamper derive the clock
    // key from one place instead of each deciding for themselves.
    (
        "spell_languages",
        PrefClass::Shared(SharedDiscipline::SetUnion {
            folded: false,
            removals_propagate: true,
        }),
    ),
    ("startup_open", PrefClass::DeviceLocal),
    ("startup_open_note", PrefClass::DeviceLocal),
    ("theme", PrefClass::DeviceLocal),
    // myne#279. **Shared**, same reasoning as `date_format` above — 12h vs 24h
    // is taste, not a property of the machine.
    (
        "time_format",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    // myne#279. **DeviceLocal**, deliberately unlike its two display siblings.
    // Two reasons point the same way. The right zone for a device is a property
    // of where that device IS — a phone that travels and a desktop that does not
    // should not have to agree — which is the `theme` argument, not the
    // `daily_date_format` one. And an IANA zone is a coarse geolocation datum:
    // `dialect/src/taskFields.ts` keeps it out of note bytes for exactly that
    // reason, and this classification keeps a travelling phone's zone from being
    // overwritten by a stationary desktop's.
    //
    // What it does NOT do, because this comment claimed otherwise until
    // myne-md/myne#609 and four other sites were citing it: keep the zone off
    // the wire. The whole `vault.prefs` blob is pushed and pulled verbatim,
    // device-local fields included, and `sync-protocol.md` 10.2.1 has a newly
    // enrolled device adopt them as starting defaults. This enum decides the
    // MERGE, and nothing else. `prefs_merge.rs` next door already had it right.
    ("timezone", PrefClass::DeviceLocal),
    // MYND-592. **Shared**, for the same reason as `show_task_marker` above and
    // deliberately unlike `ai_enabled` (DeviceLocal): that flag is device-local
    // because it gates a device-local model-path override, and this one gates a
    // bundled model every client carries. Whether the user wants speech-to-text
    // at all is taste, not capability — a device-local value would mean
    // re-choosing it on every new device.
    (
        "transcription_enabled",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    // view-manifests: **DeviceLocal**, and this row is the whole design decision
    // rather than a detail of it. An approval says "the person at THIS device has
    // read what this view can do and allowed it", so a shared map would mean a
    // freshly enrolled device inheriting an approval nobody there gave: exactly
    // the incident recorded for `ai_provider_consent` two rows up, and the reason
    // this field exists as a separate map rather than as a flag on the view
    // definition (which syncs).
    //
    // The cost is stated so the next reader does not rediscover it: the same view
    // asks again on a second device, on purpose. The value is a version number,
    // so a definition that changes anywhere also revokes the approval everywhere
    // it was given, with no clear step. Preserved verbatim from the local side,
    // which is what `.clone()` in `prefs_merge.rs` is doing.
    ("view_approvals", PrefClass::DeviceLocal),
    (
        "view_order",
        PrefClass::Shared(SharedDiscipline::SequenceLww),
    ),
];

/// Look up one field's classification. `None` means the field is unknown to
/// this build — the conformance test makes that unreachable for real fields.
pub fn classify(field: &str) -> Option<PrefClass> {
    CLASSIFICATION
        .iter()
        .find(|(name, _)| *name == field)
        .map(|(_, class)| *class)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::PrefsView;

    /// The drift lock (`sync-protocol.md` §10.2): every [`PrefsView`] field is
    /// classified exactly once. The exhaustive destructure (no `..`) fails
    /// compile the moment a new field lands in the protocol crate, forcing the
    /// author into this file — where `ALL_FIELDS` and the table must gain the
    /// matching row before the build goes green again.
    ///
    /// One field is deliberately NOT classified, and it is destructured here so
    /// this lock stays exhaustive: `opaque_saved_views`, the carried raw
    /// remainder of a `saved_views` array this build could not fully represent.
    /// It has no canonical key and no clock — it is part of the `saved_views`
    /// encoding and follows that field's whole-value LWW in the merge — so a
    /// §10.2 row would invent a field the on-disk format does not have.
    #[test]
    fn every_prefs_field_is_classified_exactly_once() {
        #[allow(clippy::let_underscore_untyped)]
        let PrefsView {
            active_workspace: _,
            ai_enabled: _,
            ai_excluded_folders: _,
            ai_provider: _,
            ai_provider_consent: _,
            ai_provider_key: _,
            ai_provider_model: _,
            archive_disabled: _,
            archived_folders: _,
            attachment_compression_enabled: _,
            attachment_ocr_enabled: _,
            auto_lock_seconds: _,
            auto_tag_enabled: _,
            bar_items_order: _,
            chat_history_budget: _,
            cli_enabled: _,
            cli_excluded_folders: _,
            cli_rate_limit_disabled: _,
            color_groups: _,
            custom_theme: _,
            daily_date_format: _,
            daily_folder: _,
            daily_template: _,
            date_format: _,
            deliberate_folders: _,
            developer_mode: _,
            device_names: _,
            editor_content_width: _,
            editor_default_view_mode: _,
            editor_focus_dim_inactive: _,
            editor_focus_typewriter: _,
            editor_font_family: _,
            editor_layout: _,
            editor_line_numbers: _,
            editor_line_spacing: _,
            editor_slash_hidden: _,
            editor_slash_order: _,
            editor_text_size: _,
            editor_toolbar_hidden: _,
            editor_toolbar_order: _,
            editor_vim_mode: _,
            favorites: _,
            field_clocks: _,
            folder_icons: _,
            folder_notes_enabled: _,
            hidden_bar_items: _,
            icon: _,
            item_colors: _,
            item_order: _,
            keymap: _,
            label: _,
            last_backup_at: _,
            mcp_connections: _,
            mcp_write_requests: _,
            meeting_ai_prompt: _,
            new_note_location: _,
            new_note_location_folder: _,
            paired_extensions: _,
            periodic_notes: _,
            calendar_settings: _,
            right_panel_active_tab: _,
            right_panel_hidden_tabs: _,
            right_panel_tab_order: _,
            saved_views: _,
            // Codec carrier, not a preference: no canonical key, no clock, and
            // no §10.2 row (see this test's doc comment).
            opaque_saved_views: _,
            screen_capture_protection: _,
            show_note_timestamps: _,
            reminders_enabled: _,
            reminder_horizon_days: _,
            ribbon_items: _,
            ribbon_visible: _,
            show_task_marker: _,
            spell_enabled: _,
            spell_languages: _,
            startup_open: _,
            startup_open_note: _,
            theme: _,
            time_format: _,
            timezone: _,
            transcription_enabled: _,
            view_approvals: _,
            view_order: _,
        } = PrefsView::default();

        // Field-name list maintained IN LOCKSTEP with the destructure above
        // (same order). The destructure carries the compile-time completeness;
        // this list carries the names into the table assertions.
        const ALL_FIELDS: &[&str] = &[
            "active_workspace",
            "ai_enabled",
            "ai_excluded_folders",
            "ai_provider",
            "ai_provider_consent",
            "ai_provider_key",
            "ai_provider_model",
            "archive_disabled",
            "archived_folders",
            "attachment_compression_enabled",
            "attachment_ocr_enabled",
            "auto_lock_seconds",
            "auto_tag_enabled",
            "bar_items_order",
            "chat_history_budget",
            "cli_enabled",
            "cli_excluded_folders",
            "cli_rate_limit_disabled",
            "color_groups",
            "custom_theme",
            "daily_date_format",
            "daily_folder",
            "daily_template",
            "date_format",
            "deliberate_folders",
            "developer_mode",
            "device_names",
            "editor_content_width",
            "editor_default_view_mode",
            "editor_focus_dim_inactive",
            "editor_focus_typewriter",
            "editor_font_family",
            "editor_layout",
            "editor_line_numbers",
            "editor_line_spacing",
            "editor_slash_hidden",
            "editor_slash_order",
            "editor_text_size",
            "editor_toolbar_hidden",
            "editor_toolbar_order",
            "editor_vim_mode",
            "favorites",
            "field_clocks",
            "folder_icons",
            "folder_notes_enabled",
            "hidden_bar_items",
            "icon",
            "item_colors",
            "item_order",
            "keymap",
            "label",
            "last_backup_at",
            "mcp_connections",
            "mcp_write_requests",
            "meeting_ai_prompt",
            "new_note_location",
            "new_note_location_folder",
            "paired_extensions",
            "periodic_notes",
            "calendar_settings",
            "reminder_horizon_days",
            "reminders_enabled",
            "ribbon_items",
            "ribbon_visible",
            "right_panel_active_tab",
            "right_panel_hidden_tabs",
            "right_panel_tab_order",
            "saved_views",
            "screen_capture_protection",
            "show_note_timestamps",
            "show_task_marker",
            "spell_enabled",
            "spell_languages",
            "startup_open",
            "startup_open_note",
            "theme",
            "time_format",
            "timezone",
            "transcription_enabled",
            "view_approvals",
            "view_order",
        ];

        // Every field classified…
        for field in ALL_FIELDS {
            assert!(
                classify(field).is_some(),
                "unclassified vault.prefs field '{field}' — add its §10.2 row \
                 (spec table + this module) in the same change"
            );
        }
        // …exactly once, and the table carries no stale rows.
        assert_eq!(
            CLASSIFICATION.len(),
            ALL_FIELDS.len(),
            "classification table and PrefsView field set have diverged"
        );
        for (name, _) in CLASSIFICATION {
            assert!(
                ALL_FIELDS.contains(name),
                "classification row '{name}' names no live PrefsView field"
            );
            assert_eq!(
                CLASSIFICATION.iter().filter(|(n, _)| n == name).count(),
                1,
                "duplicate classification row '{name}'"
            );
        }
    }

    /// The external MCP connection grant (external-mcp-connection task 3) is
    /// **DeviceLocal**, and the two halves of that claim are asserted through the
    /// mechanisms rather than by restating the enum:
    ///
    /// - a grant does not change the SHARED subset, which is what the sync push
    ///   gate compares, so approving a connection opens no traffic; and
    /// - a merge keeps THIS device's grants and drops the peer's, so a newly
    ///   enrolled device is asked again instead of inheriting an approval nobody
    ///   there gave. That is the bug this classification exists to prevent, and it
    ///   would have shipped a third time.
    #[test]
    fn the_mcp_connection_grant_is_device_local_in_both_directions() {
        use crate::plugins::sync::prefs_merge::{merge_prefs, shared_subset_hash};
        use protocol::McpConnectionGrant;

        assert_eq!(classify("mcp_connections"), Some(PrefClass::DeviceLocal));

        let local = PrefsView::default();
        let mut remote = PrefsView::default();
        remote.mcp_connections.insert(
            "claude-desktop".to_string(),
            McpConnectionGrant {
                model: protocol::McpScopeModel::Exclude,
                folders: Vec::new(),
                excluded_folders: vec!["Work/".to_string()],
                approved_at: 1_765_432_100,
                last_used_at: None,
                write_folders: Vec::new(),
            },
        );
        assert_eq!(
            shared_subset_hash(&local),
            shared_subset_hash(&remote),
            "a connection grant must not enter the shared subset the sync push gate compares"
        );
        assert!(
            merge_prefs(&local, &remote).mcp_connections.is_empty(),
            "a peer's approval must never be inherited by this device"
        );

        // And the other direction: what THIS device approved survives a merge
        // with a peer that has none.
        let mut local = PrefsView::default();
        local.mcp_connections.insert(
            "lm-studio".to_string(),
            McpConnectionGrant {
                model: protocol::McpScopeModel::Exclude,
                folders: Vec::new(),
                excluded_folders: vec!["Archive/".to_string()],
                approved_at: 1_765_432_150,
                last_used_at: Some(1_765_432_200),
                write_folders: Vec::new(),
            },
        );
        let merged = merge_prefs(&local, &PrefsView::default());
        assert_eq!(merged.mcp_connections, local.mcp_connections);
    }

    #[test]
    fn spec_reclassifications_hold() {
        // The two deliberate §10.2 reclassifications (MYND-478): both were
        // synced under the original posture, both are device-local now.
        assert_eq!(classify("hidden_bar_items"), Some(PrefClass::DeviceLocal));
        assert_eq!(classify("active_workspace"), Some(PrefClass::DeviceLocal));
        // The third (myne-md/myne#456): `ai_provider_consent` was
        // `Shared(ScalarLww)` and is device-local now. Asserted with its
        // siblings held FIXED beside it, because the property is the SPLIT
        // rather than the one field's class: a change that made the whole AI
        // cluster device-local would satisfy the first assertion alone while
        // breaking revocation, since a revoked key has to reach every device.
        assert_eq!(
            classify("ai_provider_consent"),
            Some(PrefClass::DeviceLocal)
        );
        assert_eq!(
            classify("ai_provider"),
            Some(PrefClass::Shared(SharedDiscipline::ScalarLww))
        );
        assert_eq!(
            classify("ai_provider_key"),
            Some(PrefClass::Shared(SharedDiscipline::ScalarLww))
        );
        assert_eq!(
            classify("ai_provider_model"),
            Some(PrefClass::Shared(SharedDiscipline::ScalarLww))
        );
        // `ai_enabled` was already device-local and is the other half of the
        // pair myne-md/myne#456 rests on, once `developer_mode` left the gate.
        assert_eq!(classify("ai_enabled"), Some(PrefClass::DeviceLocal));
        // And the fields the feature exists for stay shared.
        assert_eq!(
            classify("label"),
            Some(PrefClass::Shared(SharedDiscipline::ScalarLww))
        );
        assert_eq!(
            classify("device_names"),
            Some(PrefClass::Shared(SharedDiscipline::PerKeyMapMerge))
        );
        // MYND-562: folder decorations moved from whole-value LWW to per-key
        // map merge so concurrent edits to different folders no longer clobber.
        assert_eq!(
            classify("item_colors"),
            Some(PrefClass::Shared(SharedDiscipline::PerKeyMapMerge))
        );
        assert_eq!(
            classify("folder_icons"),
            Some(PrefClass::Shared(SharedDiscipline::PerKeyMapMerge))
        );
        // MYND-596: item_order joined the per-key map class so concurrent
        // reorders of DIFFERENT containers no longer clobber (was SequenceLww).
        assert_eq!(
            classify("item_order"),
            Some(PrefClass::Shared(SharedDiscipline::PerKeyMapMerge))
        );
        // Its siblings stay whole-sequence LWW (each is a single flat list, so
        // there is no cross-container clobber to fix).
        assert_eq!(
            classify("favorites"),
            Some(PrefClass::Shared(SharedDiscipline::SequenceLww))
        );
        assert_eq!(
            classify("view_order"),
            Some(PrefClass::Shared(SharedDiscipline::SequenceLww))
        );
        // Privacy-load-bearing exclusion list syncs vault-wide, and is MONOTONE:
        // a removal is a local act and is never inherited from a peer. That is
        // the property `threat-model.md` A17 rests its remote-provider mitigation
        // on, so it is pinned here rather than left to the merge site.
        assert_eq!(
            classify("ai_excluded_folders"),
            Some(PrefClass::Shared(SharedDiscipline::SetUnion {
                folded: true,
                removals_propagate: false
            }))
        );
        // The folded/raw split is the one thing about a set field that a caller
        // cannot guess, so it is pinned here rather than left to the merge site.
        // A folder set folds; language codes do not, and swapping the two is a
        // silent data loss in one direction (`de-DE` merged into `de-de`) and a
        // silent duplicate in the other (`personal/` beside `PERSONAL/`).
        assert_eq!(
            classify("spell_languages"),
            Some(PrefClass::Shared(SharedDiscipline::SetUnion {
                folded: false,
                removals_propagate: true
            }))
        );
        // The clock map is metadata, never merged as a preference.
        assert_eq!(classify("field_clocks"), Some(PrefClass::MergeMetadata));
        // ingest-image-compression: a content-fidelity switch is shared,
        // unlike its device-local compute-budget siblings just below it.
        assert_eq!(
            classify("attachment_compression_enabled"),
            Some(PrefClass::Shared(SharedDiscipline::ScalarLww))
        );
        assert_eq!(
            classify("attachment_ocr_enabled"),
            Some(PrefClass::DeviceLocal)
        );
        assert_eq!(classify("ai_enabled"), Some(PrefClass::DeviceLocal));
    }
}
