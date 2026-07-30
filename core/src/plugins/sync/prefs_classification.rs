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
    /// Sorted, de-duplicated union of both sides; clockless.
    SetUnion,
    /// The whole ordered list is replaced by the newer side; one clock per list.
    SequenceLww,
    /// The whole array/map value is replaced by the newer side; one clock.
    WholeValueLww,
    /// Union of keys; a key edited on both sides resolves LWW on its own
    /// `<field>/<key>` clock (e.g. `device_names/<key>`,
    /// `item_colors/<folderKey>`, `folder_icons/<folderKey>` — MYND-562).
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
        PrefClass::Shared(SharedDiscipline::SetUnion),
    ),
    (
        "archive_disabled",
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    (
        "archived_folders",
        PrefClass::Shared(SharedDiscipline::SetUnion),
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
    ("bar_items_order", PrefClass::DeviceLocal),
    ("cli_enabled", PrefClass::DeviceLocal),
    (
        "cli_excluded_folders",
        PrefClass::Shared(SharedDiscipline::SetUnion),
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
    (
        "deliberate_folders",
        PrefClass::Shared(SharedDiscipline::SetUnion),
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
    (
        "item_order",
        PrefClass::Shared(SharedDiscipline::SequenceLww),
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
    (
        "spell_languages",
        PrefClass::Shared(SharedDiscipline::SetUnion),
    ),
    ("startup_open", PrefClass::DeviceLocal),
    ("startup_open_note", PrefClass::DeviceLocal),
    ("theme", PrefClass::DeviceLocal),
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
            archive_disabled: _,
            archived_folders: _,
            attachment_compression_enabled: _,
            attachment_ocr_enabled: _,
            auto_lock_seconds: _,
            bar_items_order: _,
            cli_enabled: _,
            cli_excluded_folders: _,
            cli_rate_limit_disabled: _,
            color_groups: _,
            custom_theme: _,
            daily_date_format: _,
            daily_folder: _,
            daily_template: _,
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
            "archive_disabled",
            "archived_folders",
            "attachment_compression_enabled",
            "attachment_ocr_enabled",
            "auto_lock_seconds",
            "bar_items_order",
            "cli_enabled",
            "cli_excluded_folders",
            "cli_rate_limit_disabled",
            "color_groups",
            "custom_theme",
            "daily_date_format",
            "daily_folder",
            "daily_template",
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
        // Privacy-load-bearing exclusion list syncs vault-wide.
        assert_eq!(
            classify("ai_excluded_folders"),
            Some(PrefClass::Shared(SharedDiscipline::SetUnion))
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
