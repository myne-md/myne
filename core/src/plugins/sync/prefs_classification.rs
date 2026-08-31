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
    // a vault whose owner said "OpenRouter" has said it about the vault. The
    // three rows below therefore travel together, and the cost of that is
    // recorded rather than hidden: a newly enrolled device inherits the
    // selection, the consent and the key, and begins sending without anyone at
    // that device seeing the consent screen (ledger SYNC-22;
    // `threat-model.md` §5 states the same in the normative text).
    (
        "ai_provider",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    // Shared with the selection it approves — splitting them would produce the
    // worst state of the four: a device that inherited a provider and a key but
    // not the consent would be configured and silently refused, with no screen
    // anywhere to fix it.
    (
        "ai_provider_consent",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
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
    (
        "new_note_location",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    (
        "new_note_location_folder",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    ("paired_extensions", PrefClass::DeviceLocal),
    ("reminder_horizon_days", PrefClass::DeviceLocal),
    ("reminders_enabled", PrefClass::DeviceLocal),
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
    // reason, so putting it on the sync wire would give back at the prefs layer
    // what the note layer refuses to leak.
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
            hidden_bar_items: _,
            icon: _,
            item_colors: _,
            item_order: _,
            keymap: _,
            label: _,
            last_backup_at: _,
            new_note_location: _,
            new_note_location_folder: _,
            paired_extensions: _,
            right_panel_active_tab: _,
            right_panel_hidden_tabs: _,
            right_panel_tab_order: _,
            saved_views: _,
            screen_capture_protection: _,
            show_note_timestamps: _,
            reminders_enabled: _,
            reminder_horizon_days: _,
            show_task_marker: _,
            spell_enabled: _,
            spell_languages: _,
            startup_open: _,
            startup_open_note: _,
            theme: _,
            time_format: _,
            timezone: _,
            transcription_enabled: _,
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
            "hidden_bar_items",
            "icon",
            "item_colors",
            "item_order",
            "keymap",
            "label",
            "last_backup_at",
            "new_note_location",
            "new_note_location_folder",
            "paired_extensions",
            "reminder_horizon_days",
            "reminders_enabled",
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

    #[test]
    fn spec_reclassifications_hold() {
        // The two deliberate §10.2 reclassifications (MYND-478): both were
        // synced under the original posture, both are device-local now.
        assert_eq!(classify("hidden_bar_items"), Some(PrefClass::DeviceLocal));
        assert_eq!(classify("active_workspace"), Some(PrefClass::DeviceLocal));
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
