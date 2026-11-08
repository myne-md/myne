// SPDX-License-Identifier: AGPL-3.0
use super::*;
use crate::subkey::{derive_subkey, SubkeyRole};
use crate::test_vector_fmt::{hex_lower, json_escape};

// Fixed root_key + account_number_hash so KAT-style tests are
// deterministic. Real-world callers source these from `getrandom`
// and `vault.meta` respectively.
fn fixed_root_key() -> [u8; 32] {
    [0x42; 32]
}
fn fixed_account_number_hash() -> [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] {
    [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN]
}
fn fixed_prefs_nonce() -> [u8; AEAD_NONCE_LEN] {
    [0x77; AEAD_NONCE_LEN]
}

// ---- canonical JSON encoder ----------------------------------------

#[test]
fn canonical_json_encodes_true_to_expected_bytes() {
    let prefs = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: true,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: Vec::new(),
        auto_lock_seconds: None,
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn canonical_json_encodes_false_to_expected_bytes() {
    let prefs = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: false,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: Vec::new(),
        auto_lock_seconds: None,
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
        encoded.as_slice(),
        br#"{"screen_capture_protection":false}"#
    );
}

// ---- decoration maps: folder_icons + item_colors (MYND-184 / 185) ----

fn map_of(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (String::from(*k), String::from(*v)))
        .collect()
}

#[test]
fn canonical_json_encodes_decoration_maps_in_canonical_position() {
    // folder_icons ('f') sorts after favorites, item_colors ('i') after
    // folder_icons — both BEFORE screen_capture_protection ('s'). Keys
    // within each object are emitted in lexicographic order.
    let prefs = PrefsView {
        folder_icons: map_of(&[("Projects/Myne/", "book"), ("Archive/2025/", "archive")]),
        folder_notes_enabled: false,
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        item_colors: map_of(&[
            ("Projects/Myne/", "slate"),
            ("0190a000-0000-7000-8000-000000000001", "moss"),
        ]),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"folder_icons":{"Archive/2025/":"archive","Projects/Myne/":"book"},"item_colors":{"0190a000-0000-7000-8000-000000000001":"moss","Projects/Myne/":"slate"},"screen_capture_protection":true}"#
        );
}

#[test]
fn field_clocks_encodes_in_canonical_position() {
    // field_clocks ('fi') sorts after favorites ('fa'), before
    // folder_icons ('fo') — the §9.5.2 canonical slot (MYND-478). Keys
    // within the object are emitted in lexicographic order; values are
    // bare epoch-ms integers (no floats, no trailing .0).
    let mut clocks = BTreeMap::new();
    clocks.insert(String::from("label"), 1_765_432_099_000u64);
    clocks.insert(
        String::from("device_names/3f9ac2d1aabbccdd00112233445566ff"),
        1_765_432_100_000u64,
    );
    let prefs = PrefsView {
        favorites: alloc::vec![String::from("0190a000-0000-7000-8000-000000000002")],
        field_clocks: clocks,
        folder_icons: map_of(&[("Projects/Myne/", "book")]),
        folder_notes_enabled: false,
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"favorites":["0190a000-0000-7000-8000-000000000002"],"field_clocks":{"device_names/3f9ac2d1aabbccdd00112233445566ff":1765432100000,"label":1765432099000},"folder_icons":{"Projects/Myne/":"book"},"screen_capture_protection":true}"#
        );
}

#[test]
fn empty_field_clocks_is_omitted_entirely() {
    // The omit-when-empty discipline: a vault whose shared fields were
    // never clock-stamped (every pre-MYND-478 vault) encodes byte-identically
    // to a build that predates the field — existing golden vectors
    // unaffected.
    let prefs = PrefsView::default();
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    assert!(!encoded
        .windows(b"field_clocks".len())
        .any(|w| w == b"field_clocks"));
}

#[test]
fn a_stale_field_clock_key_never_shadows_its_absent_field() {
    // REGRESSION (MYND-604). `field_clocks` keys ARE field names (§ 9.5.2),
    // so a byte-search for a top-level `"<field>":` used to match the clock
    // entry of a field that had since been UNSET — parse the integer as the
    // field's value, fail, and hand § 9.5.5 a blanket "return defaults".
    // The user-visible bug was total, silent prefs loss (label, favorites,
    // saved views, folder icons, every editor setting) after an ordinary
    // action: delete your last colour rule.
    //
    // Both fields below are parsed from the cursor chain BEFORE
    // `field_clocks` (`col` < `fi`, `fa` < `fi`), which is what made them
    // reachable; `favorites` shows the trap predates `color_groups`.
    for field in ["color_groups", "favorites"] {
        let mut clocks = BTreeMap::new();
        clocks.insert(String::from(field), 1_700_000_000_000u64);
        let view = PrefsView {
            label: Some(String::from("Keepme")),
            item_order: BTreeMap::from([(
                String::from(""),
                alloc::vec![String::from("0190a000-0000-7000-8000-000000000002")],
            )]),
            field_clocks: clocks.clone(),
            ..PrefsView::default()
        };
        let decoded = canonical_json_decode(&canonical_json_encode(&view))
            .expect("a stale clock key must not fail the parse");
        // The rest of the blob survived rather than collapsing to defaults.
        assert_eq!(decoded.label.as_deref(), Some("Keepme"), "{field}");
        assert_eq!(decoded.item_order, view.item_order, "{field}");
        assert_eq!(decoded.field_clocks, clocks, "{field}");
        // …and the shadowed field itself reads as genuinely absent.
        assert!(decoded.color_groups.is_empty(), "{field}");
        assert!(decoded.favorites.is_empty(), "{field}");
    }
}

#[test]
fn top_level_marker_search_ignores_nested_and_value_lookalikes() {
    // The finder keys on structural depth, not on `field_clocks`
    // specifically: a user-controlled map key (`folder_icons` paths) and a
    // string VALUE that spells a field name are both non-matches, while the
    // real top-level field is still found.
    let mut icons = BTreeMap::new();
    icons.insert(String::from("Projects/"), String::from("book"));
    let view = PrefsView {
        // A label whose VALUE is a field name.
        label: Some(String::from("favorites")),
        favorites: alloc::vec![String::from("0190a000-0000-7000-8000-000000000002")],
        folder_icons: icons,
        folder_notes_enabled: false,
        ..PrefsView::default()
    };
    let decoded = canonical_json_decode(&canonical_json_encode(&view)).expect("parses");
    assert_eq!(decoded.favorites, view.favorites);
    assert_eq!(decoded.label.as_deref(), Some("favorites"));
    assert_eq!(decoded.folder_icons, view.folder_icons);
}

#[test]
fn field_clocks_round_trips() {
    // Encode → decode preserves the full map, including a namespaced
    // device_names/<key> entry and a max-magnitude u64 clock.
    let mut clocks = BTreeMap::new();
    clocks.insert(String::from("label"), 1u64);
    clocks.insert(String::from("icon"), u64::MAX);
    clocks.insert(String::from("device_names/00ff"), 1_765_432_100_000u64);
    let prefs = PrefsView {
        field_clocks: clocks.clone(),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    let decoded = canonical_json_decode(&encoded).expect("round-trip decode");
    assert_eq!(decoded.field_clocks, clocks);
    assert_eq!(decoded, prefs);
}

#[test]
fn absent_field_clocks_decodes_to_empty_map() {
    // A pre-MYND-478 plaintext (no field_clocks key) MUST decode with an
    // empty map — absent = every clock 0 to the merge (sync-protocol.md
    // §10.2).
    let plaintext =
        br#"{"favorites":["f1"],"folder_icons":{"P/":"book"},"screen_capture_protection":true}"#;
    let decoded = canonical_json_decode(plaintext).expect("legacy decode");
    assert!(decoded.field_clocks.is_empty());
}

#[test]
fn canonical_json_omits_empty_decoration_maps() {
    // Default (empty maps) must be byte-identical to the screen_capture-only
    // form — the omit-when-empty discipline that keeps pre-feature golden
    // vectors unaffected.
    let encoded = canonical_json_encode(&PrefsView::default());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

// periodic_notes (myne#177): the flat `<period>.<setting>` string map.

#[test]
fn periodic_notes_encodes_between_paired_extensions_and_reminders() {
    let prefs = PrefsView {
        periodic_notes: map_of(&[
            ("monthly.folder", "Monthly/"),
            ("weekly.folder", "Weekly/"),
            ("weekly.format", "gggg-[W]ww"),
        ]),
        paired_extensions: Vec::new(),
        reminder_horizon_days: Some(7),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
        core::str::from_utf8(&encoded).expect("utf8"),
        concat!(
            r#"{"periodic_notes":{"monthly.folder":"Monthly/","weekly.folder":"Weekly/","#,
            r#""weekly.format":"gggg-[W]ww"},"reminder_horizon_days":7,"#,
            r#""screen_capture_protection":true}"#
        )
    );
}

#[test]
fn empty_periodic_notes_is_omitted_so_a_pre_feature_vault_is_byte_identical() {
    // The whole no-migration argument rests on this: a vault that configures
    // no period must encode to exactly what it encoded to before the field
    // existed, or every golden vector moves.
    let encoded = canonical_json_encode(&PrefsView::default());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    assert!(!encoded
        .windows(b"periodic_notes".len())
        .any(|w| w == b"periodic_notes"));
}

#[test]
fn periodic_notes_round_trips_through_blob() {
    let original = PrefsView {
        periodic_notes: map_of(&[
            ("monthly.format", "YYYY-MM"),
            ("weekly.folder", "Weekly/"),
            ("weekly.template", "0190a000-0000-7000-8000-000000000003"),
        ]),
        ..PrefsView::default()
    };
    let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let blob = encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
        .expect("encode");
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).expect("decode");
    assert_eq!(decoded, original);
}

#[test]
fn periodic_notes_keeps_a_period_this_build_does_not_know() {
    // The `<period>.<setting>` grammar is the client's, not the codec's. An
    // entry for a period that ships later (quarterly) has to survive a
    // decode by an older build untouched, or adding a fourth period stops
    // being free and starts being a migration.
    let plaintext = br#"{"periodic_notes":{"quarterly.folder":"Quarterly/","weekly.folder":"Weekly/"},"screen_capture_protection":true}"#;
    let parsed = canonical_json_decode(plaintext).expect("decode");
    assert_eq!(
        parsed.periodic_notes,
        map_of(&[
            ("quarterly.folder", "Quarterly/"),
            ("weekly.folder", "Weekly/"),
        ])
    );
    assert_eq!(
        canonical_json_encode(&parsed).as_slice(),
        plaintext.as_slice()
    );
}

#[test]
fn periodic_notes_does_not_swallow_the_fields_that_follow_it() {
    // The parser walks one monotonic forward cursor, so a field inserted in
    // the middle can silently make every later field take its default. The
    // two immediate neighbours are what this pins.
    let plaintext = br#"{"periodic_notes":{"weekly.folder":"Weekly/"},"reminder_horizon_days":9,"reminders_enabled":false,"screen_capture_protection":true}"#;
    let parsed = canonical_json_decode(plaintext).expect("decode");
    assert_eq!(
        parsed.periodic_notes,
        map_of(&[("weekly.folder", "Weekly/")])
    );
    assert_eq!(parsed.reminder_horizon_days, Some(9));
    assert!(!parsed.reminders_enabled);
}

#[test]
fn decoration_maps_round_trip_through_blob() {
    let original = PrefsView {
        folder_icons: map_of(&[("Archive/2025/", "archive"), ("Projects/Myne/", "book")]),
        folder_notes_enabled: false,
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        item_colors: map_of(&[
            ("0190a000-0000-7000-8000-000000000001", "moss"),
            ("Projects/Myne/", "slate"),
        ]),
        ..PrefsView::default()
    };
    let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let blob = encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
        .expect("encode");
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).expect("decode");
    assert_eq!(decoded, original);
}

#[test]
fn decode_parses_hand_written_decoration_maps() {
    let plaintext = br#"{"folder_icons":{"Projects/":"code"},"item_colors":{"0190a000-0000-7000-8000-000000000002":"clay"},"screen_capture_protection":false}"#;
    let parsed = canonical_json_decode(plaintext).expect("decode");
    assert_eq!(parsed.folder_icons, map_of(&[("Projects/", "code")]));
    assert_eq!(
        parsed.item_colors,
        map_of(&[("0190a000-0000-7000-8000-000000000002", "clay")])
    );
    assert!(!parsed.screen_capture_protection);
}

#[test]
fn device_names_encode_canonical_bytes() {
    // device_names (SYNC-41) encodes as a canonical string→string object
    // (lexicographic keys, NFC) at canonical key 'd' — before
    // screen_capture_protection ('s'). Pins the new field's byte layout.
    let prefs = PrefsView {
        device_names: map_of(&[("bb", "Phone"), ("aa", "Laptop")]),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
        encoded.as_slice(),
        br#"{"device_names":{"aa":"Laptop","bb":"Phone"},"screen_capture_protection":true}"#
    );
}

#[test]
fn device_names_canonical_position_between_deliberate_folders_and_editor() {
    // Load-bearing canonical key order: deliberate_folders (del) <
    // device_names (dev) < editor_content_width (e). Guards the exact slot.
    let prefs = PrefsView {
        deliberate_folders: alloc::vec![alloc::string::String::from("A/")],
        device_names: map_of(&[("d1", "Mac")]),
        editor_content_width: Some(String::from("wide")),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["A/"],"device_names":{"d1":"Mac"},"editor_content_width":"wide","screen_capture_protection":true}"#
        );
}

#[test]
fn device_names_omitted_when_empty_preserves_pre_feature_bytes() {
    // A vault that never named a device must be byte-identical to the
    // pre-feature form — the migration-less additive-field discipline.
    let prefs = PrefsView {
        deliberate_folders: alloc::vec![alloc::string::String::from("A/")],
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    // The exact golden below has no `device_names` key — proof the empty map
    // is omitted and the byte layout is unperturbed.
    assert_eq!(
        encoded.as_slice(),
        br#"{"deliberate_folders":["A/"],"screen_capture_protection":true}"#
    );
}

#[test]
fn device_names_round_trips_through_blob() {
    let original = PrefsView {
        device_names: map_of(&[("0a1b", "Work Laptop"), ("ff00", "Phone")]),
        ..PrefsView::default()
    };
    let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let blob = encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
        .expect("encode");
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).expect("decode");
    assert_eq!(decoded, original);
    assert_eq!(decoded.device_names, original.device_names);
}

#[test]
fn decoration_map_keys_and_values_are_nfc_normalized() {
    // A folder key supplied in NFD ("e" + U+0301 combining acute) must be
    // emitted in NFC (U+00E9) — byte-stability discipline.
    let prefs = PrefsView {
        folder_icons: map_of(&[("Cafe\u{301}/", "book")]),
        folder_notes_enabled: false,
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    // NFC "é" = 0xC3 0xA9; the NFD combining mark 0xCC 0x81 must be absent.
    assert!(find_subslice(&encoded, &[0xC3, 0xA9]).is_some());
    assert!(find_subslice(&encoded, &[0xCC, 0x81]).is_none());
}

#[test]
fn empty_decoration_map_object_decodes_to_empty() {
    // A literal `{}` value (the codec never emits this — caller omits the
    // key — but a hand-tampered-but-AEAD-OK blob could) decodes to empty.
    let plaintext = br#"{"folder_icons":{},"screen_capture_protection":true}"#;
    let parsed = canonical_json_decode(plaintext).expect("decode");
    assert!(parsed.folder_icons.is_empty());
    assert!(parsed.item_colors.is_empty());
}

// ---- canonical JSON decoder ----------------------------------------

#[test]
fn canonical_json_decodes_true() {
    let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
    assert_eq!(
        parsed,
        PrefsView {
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: true,
            folder_notes_enabled: false,
            bar_items_order: Vec::new(),
            chat_history_budget: None,
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            icon: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archived_folders: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            ribbon_items: None,
            ribbon_visible: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            archive_disabled: None,
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            mcp_connections: Default::default(),
            mcp_write_requests: Default::default(),
            meeting_ai_prompt: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            periodic_notes: Default::default(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            opaque_saved_views: Vec::new(),
            view_approvals: Default::default(),
            view_order: Vec::new(),
        }
    );
}

#[test]
fn canonical_json_decodes_false() {
    let parsed = canonical_json_decode(br#"{"screen_capture_protection":false}"#).unwrap();
    assert_eq!(
        parsed,
        PrefsView {
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: false,
            folder_notes_enabled: false,
            bar_items_order: Vec::new(),
            chat_history_budget: None,
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            icon: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archived_folders: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            ribbon_items: None,
            ribbon_visible: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            archive_disabled: None,
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            mcp_connections: Default::default(),
            mcp_write_requests: Default::default(),
            meeting_ai_prompt: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            periodic_notes: Default::default(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            opaque_saved_views: Vec::new(),
            view_approvals: Default::default(),
            view_order: Vec::new(),
        }
    );
}

#[test]
fn canonical_json_decoder_tolerates_future_unknown_fields() {
    // Spec § 9.5.2 forward-compat: a v0.1.0 client reading a
    // v0.1.1+ plaintext with extra fields must still recover the
    // known fields rather than rejecting. `theme` is now KNOWN (so it
    // parses), while `zoom_level` (sorting after `theme`) is a genuinely
    // unknown future field that must be ignored.
    let parsed = canonical_json_decode(
        br#"{"screen_capture_protection":true,"theme":"dark","zoom_level":2}"#,
    )
    .unwrap();
    assert!(parsed.screen_capture_protection);
    assert_eq!(parsed.theme, Some(ThemeChoice::Dark));
}

#[test]
fn canonical_json_decoder_rejects_missing_wrapper() {
    let err = canonical_json_decode(br#""screen_capture_protection":true"#).unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

#[test]
fn canonical_json_decoder_rejects_missing_key() {
    let err = canonical_json_decode(br#"{"other_field":true}"#).unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

#[test]
fn canonical_json_decoder_rejects_non_bool_value() {
    let err = canonical_json_decode(br#"{"screen_capture_protection":42}"#).unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

#[test]
fn canonical_json_decoder_rejects_truncated_after_key() {
    let err = canonical_json_decode(br#"{"screen_capture_protection":}"#).unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

#[test]
fn canonical_json_decoder_rejects_trailing_garbage_after_true() {
    // Strict-suffix discipline: `truefoo` MUST NOT be accepted as
    // `true`. Catches tampered-but-AEAD-OK plaintexts that try to
    // sneak past via prefix matching.
    let err = canonical_json_decode(br#"{"screen_capture_protection":truefoo}"#).unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

#[test]
fn canonical_json_decoder_rejects_trailing_garbage_after_false() {
    let err = canonical_json_decode(br#"{"screen_capture_protection":falseyyy}"#).unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

// ---- theme canonical field (MYND-110) -----------------------------

#[test]
fn encode_omits_theme_when_none() {
    // None ≡ system → byte-identical to a pre-MYND-110 vault.prefs
    // (preserves existing KAT vectors + existing vaults).
    let encoded = canonical_json_encode(&PrefsView {
        theme: None,
        ..PrefsView::default()
    });
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_emits_theme_last_light() {
    // Canonical key order: theme (t) is LAST, after screen_capture_protection (s).
    let encoded = canonical_json_encode(&PrefsView {
        theme: Some(ThemeChoice::Light),
        ..PrefsView::default()
    });
    assert_eq!(
        encoded.as_slice(),
        br#"{"screen_capture_protection":true,"theme":"light"}"#,
    );
}

// ---- label field (MYND-205) --------------------------------------

#[test]
fn encode_omits_label_when_none_byte_identical_to_pre_label() {
    // A vault that never set a label encodes byte-identically to the
    // single-field pre-MYND-205 form (migration-less additive field).
    let encoded = canonical_json_encode(&PrefsView::default());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#,);
}

#[test]
fn encode_places_label_between_item_order_and_screen_capture() {
    // Canonical key order: item_order (i) < label (l) < screen_capture (s).
    let encoded = canonical_json_encode(&PrefsView {
        item_order: BTreeMap::from([(
            alloc::string::String::from(""),
            alloc::vec![alloc::string::String::from("n1")],
        )]),
        label: Some(alloc::string::String::from("Work")),
        ..PrefsView::default()
    });
    assert_eq!(
        encoded.as_slice(),
        br#"{"item_order":{"":["n1"]},"label":"Work","screen_capture_protection":true}"#,
    );
}

// ---- icon field (vault-icons) ------------------------------------

#[test]
fn encode_omits_icon_when_none_byte_identical_to_pre_icon() {
    // A vault that never set an icon encodes byte-identically to the
    // single-field pre-feature form (migration-less additive field, the
    // `label` precedent class — existing golden vectors unaffected).
    let encoded = canonical_json_encode(&PrefsView {
        icon: None,
        ..PrefsView::default()
    });
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#,);
}

#[test]
fn encode_places_icon_between_hidden_bar_items_and_item_colors() {
    // Canonical key order: hidden_bar_items (h) < icon (ico) < item_colors (ite).
    let encoded = canonical_json_encode(&PrefsView {
        hidden_bar_items: alloc::vec![alloc::string::String::from("graph")],
        icon: Some(alloc::string::String::from("book")),
        item_colors: map_of(&[("Projects/", "red")]),
        ..PrefsView::default()
    });
    assert_eq!(
            encoded.as_slice(),
            br#"{"hidden_bar_items":["graph"],"icon":"book","item_colors":{"Projects/":"red"},"screen_capture_protection":true}"#,
        );
}

#[test]
fn icon_round_trips_through_decode() {
    let original = PrefsView {
        icon: Some(alloc::string::String::from("briefcase")),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded.icon, Some(alloc::string::String::from("briefcase")));
}

#[test]
fn decode_absent_icon_is_none() {
    let decoded = canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
    assert_eq!(decoded.icon, None);
}

// ---- keymap (MYND-304 / 366) -------------------------------------------

fn keymap_of(pairs: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
    pairs
        .iter()
        .map(|(k, chords)| {
            (
                alloc::string::String::from(*k),
                chords
                    .iter()
                    .map(|c| alloc::string::String::from(*c))
                    .collect::<Vec<String>>(),
            )
        })
        .collect()
}

#[test]
fn encode_places_keymap_between_item_order_and_label() {
    // Canonical key order: item_order (i) < keymap (k) < label (l).
    let encoded = canonical_json_encode(&PrefsView {
        item_order: BTreeMap::from([(
            alloc::string::String::from(""),
            alloc::vec![alloc::string::String::from("n1")],
        )]),
        keymap: keymap_of(&[("graph.show", &["Mod-Shift-g"])]),
        label: Some(alloc::string::String::from("Work")),
        ..PrefsView::default()
    });
    assert_eq!(
            encoded.as_slice(),
            br#"{"item_order":{"":["n1"]},"keymap":{"graph.show":["Mod-Shift-g"]},"label":"Work","screen_capture_protection":true}"#,
        );
}

#[test]
fn keymap_omitted_when_empty() {
    // An empty keymap produces NO key, so a vault that never rebound a
    // shortcut is byte-identical to a pre-MYND-304 vault.prefs.
    let encoded = canonical_json_encode(&PrefsView::default());
    assert!(find_subslice(&encoded, b"keymap").is_none());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn keymap_round_trips_with_multi_binding_and_unbind() {
    // Three states in one value: an override (multi-binding), an
    // explicit-unbind (`[]`), and an absent command (not in the map).
    let original = PrefsView {
        keymap: keymap_of(&[
            ("app.command-palette", &["Mod-k", "Mod-p"]),
            ("vault.lock", &[]),
        ]),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded.keymap, original.keymap);
    // The empty array is preserved verbatim (explicit-unbind, NOT dropped).
    assert_eq!(
        decoded.keymap.get("vault.lock"),
        Some(&Vec::<String>::new())
    );
    assert!(!decoded.keymap.contains_key("never.bound"));
}

#[test]
fn keymap_chord_array_is_set_canonical() {
    // Chord arrays are NFC + sorted + exact-deduped (binding order does not
    // affect dispatch), and keys are emitted in lexicographic order.
    let encoded = canonical_json_encode(&PrefsView {
        keymap: keymap_of(&[
            ("z.cmd", &["Mod-z"]),
            ("a.cmd", &["Mod-z", "Mod-a", "Mod-z"]),
        ]),
        ..PrefsView::default()
    });
    assert_eq!(
            encoded.as_slice(),
            br#"{"keymap":{"a.cmd":["Mod-a","Mod-z"],"z.cmd":["Mod-z"]},"screen_capture_protection":true}"#,
        );
}

#[test]
fn keymap_empty_array_round_trips_distinct_from_absent() {
    let encoded = canonical_json_encode(&PrefsView {
        keymap: keymap_of(&[("vault.lock", &[])]),
        ..PrefsView::default()
    });
    assert_eq!(
        encoded.as_slice(),
        br#"{"keymap":{"vault.lock":[]},"screen_capture_protection":true}"#,
    );
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(
        decoded.keymap.get("vault.lock"),
        Some(&Vec::<String>::new())
    );
}

#[test]
fn keymap_malformed_value_rejected() {
    // A value that is not a JSON array (a bare string) is a structural
    // malformation → PlaintextParseFailed (the chord set must be an array).
    let plaintext = br#"{"keymap":{"a.cmd":"Mod-a"},"screen_capture_protection":true}"#;
    assert!(matches!(
        canonical_json_decode(plaintext),
        Err(PrefsBlobError::PlaintextParseFailed)
    ));
}

#[test]
fn label_round_trips_through_decode() {
    let original = PrefsView {
        label: Some(alloc::string::String::from("Personal")),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded.label, Some(alloc::string::String::from("Personal")));
    // The rest of the view round-trips to defaults.
    assert_eq!(decoded, original);
}

#[test]
fn encode_omits_typography_when_none_byte_identical_to_pre_feature() {
    // A vault that never customized editor typography encodes byte-
    // identically to the bare pre-feature form (migration-less additive
    // fields — existing golden vectors unaffected).
    let encoded = canonical_json_encode(&PrefsView::default());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#,);
}

#[test]
fn encode_places_typography_around_editor_layout() {
    // Canonical key order: editor_content_width < editor_font_family <
    // editor_layout < editor_line_numbers < editor_line_spacing <
    // editor_text_size (< favorites).
    let encoded = canonical_json_encode(&PrefsView {
        editor_content_width: Some(alloc::string::String::from("wide")),
        editor_font_family: Some(alloc::string::String::from("sans")),
        editor_layout: Some(sample_layout()),
        editor_line_numbers: Some(true),
        editor_line_spacing: Some(alloc::string::String::from("relaxed")),
        editor_text_size: Some(alloc::string::String::from("lg")),
        ..PrefsView::default()
    });
    let s = core::str::from_utf8(&encoded).unwrap();
    let cw = s.find("editor_content_width").unwrap();
    let ff = s.find("editor_font_family").unwrap();
    let el = s.find("editor_layout").unwrap();
    let ln = s.find("editor_line_numbers").unwrap();
    let ls = s.find("editor_line_spacing").unwrap();
    let ts = s.find("editor_text_size").unwrap();
    assert!(
        cw < ff && ff < el && el < ln && ln < ls && ls < ts,
        "canonical order: {s}"
    );
}

#[test]
fn encode_omits_vim_mode_when_none_byte_identical_to_pre_feature() {
    // vim-keyboard-mode (MYND-313): a vault that never touched the vim toggle
    // must encode byte-identically to the pre-feature form, so every existing
    // golden vector stays valid (migration-less additive field on MYP1).
    let encoded = canonical_json_encode(&PrefsView {
        editor_vim_mode: None,
        ..PrefsView::default()
    });
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_places_vim_mode_between_toolbar_order_and_favorites() {
    // Canonical key order: editor_text_size < editor_toolbar_hidden <
    // editor_toolbar_order < editor_vim_mode < favorites
    // (`editor_te` < `editor_to` < `editor_v` < `f`). Getting this wrong
    // breaks cross-implementation byte agreement, so it is pinned here.
    let encoded = canonical_json_encode(&PrefsView {
        editor_text_size: Some(alloc::string::String::from("lg")),
        editor_toolbar_hidden: alloc::vec![alloc::string::String::from("bold")],
        editor_toolbar_order: alloc::vec![alloc::string::String::from("italic")],
        editor_vim_mode: Some(true),
        favorites: alloc::vec![alloc::string::String::from(
            "0192f1a0-0000-7000-8000-000000000000"
        )],
        ..PrefsView::default()
    });
    let s = core::str::from_utf8(&encoded).unwrap();
    let ts = s.find("editor_text_size").unwrap();
    let th = s.find("editor_toolbar_hidden").unwrap();
    let to = s.find("editor_toolbar_order").unwrap();
    let vm = s.find("editor_vim_mode").unwrap();
    let fav = s.find("favorites").unwrap();
    assert!(
        ts < th && th < to && to < vm && vm < fav,
        "canonical order: {s}"
    );
}

#[test]
fn vim_mode_round_trips_through_decode_both_values() {
    // Both explicit values must survive encode→decode. `Some(false)` is a
    // real state (the user turned vim off explicitly) and must NOT collapse
    // into `None` (never set) — the two are distinguishable on disk.
    for value in [true, false] {
        let original = PrefsView {
            editor_vim_mode: Some(value),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded.editor_vim_mode, Some(value));
        assert_eq!(decoded, original);
    }
    // And absent stays absent.
    let decoded =
        canonical_json_decode(&canonical_json_encode(&PrefsView::default())).expect("decode");
    assert_eq!(decoded.editor_vim_mode, None);
}

#[test]
fn files_panel_fields_round_trip_through_decode() {
    // MYND-462 — new_note_location(+folder) and startup_open(+note) round-trip
    // through a full encode/decode, both the mode-only and mode+target forms.
    let original = PrefsView {
        new_note_location: Some(alloc::string::String::from("specific")),
        new_note_location_folder: Some(alloc::string::String::from("Inbox/")),
        startup_open: Some(alloc::string::String::from("specific")),
        startup_open_note: Some(alloc::string::String::from(
            "0192f1a0-0000-7000-8000-000000000000",
        )),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded, original);
}

#[test]
fn files_panel_fields_omitted_when_none_byte_identical_to_pre_feature() {
    // A vault that never touched the Files-panel settings encodes byte-
    // identically to the bare pre-feature form (migration-less additive
    // fields — existing golden vectors unaffected).
    let encoded = canonical_json_encode(&PrefsView {
        new_note_location: None,
        new_note_location_folder: None,
        startup_open: None,
        startup_open_note: None,
        ..PrefsView::default()
    });
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn files_panel_fields_canonical_key_positions() {
    // new_note_location(+folder) sort after last_backup_at, before
    // paired_extensions (before screen_capture_protection); startup_open(+note)
    // sort after spell_languages, before theme (after screen_capture_protection).
    let prefs = PrefsView {
        last_backup_at: Some(42),
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: Some(alloc::string::String::from("current")),
        new_note_location_folder: Some(alloc::string::String::from("Notes/")),
        spell_languages: alloc::vec![alloc::string::String::from("en-US")],
        startup_open: Some(alloc::string::String::from("empty")),
        startup_open_note: Some(alloc::string::String::from("x")),
        theme: Some(ThemeChoice::Dark),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    let s = core::str::from_utf8(&encoded).unwrap();
    let lba = s.find("last_backup_at").unwrap();
    let nnl = s.find("new_note_location\"").unwrap();
    let nnf = s.find("new_note_location_folder").unwrap();
    let scp = s.find("screen_capture_protection").unwrap();
    let spl = s.find("spell_languages").unwrap();
    let sto = s.find("startup_open\"").unwrap();
    let stn = s.find("startup_open_note").unwrap();
    let thm = s.find("theme").unwrap();
    assert!(lba < nnl && nnl < nnf && nnf < scp, "new_note_* order: {s}");
    assert!(
        scp < spl && spl < sto && sto < stn && stn < thm,
        "startup_* order: {s}"
    );
}

#[test]
fn typography_round_trips_through_decode() {
    let original = PrefsView {
        editor_content_width: Some(alloc::string::String::from("narrow")),
        editor_font_family: Some(alloc::string::String::from("sans")),
        editor_line_spacing: Some(alloc::string::String::from("tight")),
        editor_text_size: Some(alloc::string::String::from("xl")),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded, original);
}

// ---- myne#279: display date/time/timezone -----------------------------

#[test]
fn display_datetime_prefs_round_trip_through_decode() {
    let original = PrefsView {
        date_format: Some(alloc::string::String::from("dmy")),
        time_format: Some(alloc::string::String::from("24h")),
        timezone: Some(alloc::string::String::from("Europe/Berlin")),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded, original);
}

#[test]
fn encode_omits_display_datetime_prefs_when_none_byte_identical_to_pre_feature() {
    // A vault that never chose a display format encodes byte-identically to
    // the bare pre-feature form (migration-less additive fields — existing
    // golden vectors unaffected).
    let encoded = canonical_json_encode(&PrefsView {
        date_format: None,
        time_format: None,
        timezone: None,
        ..PrefsView::default()
    });
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_places_date_format_between_daily_template_and_deliberate_folders() {
    // Canonical key order: daily_template (`dai`) < date_format (`dat`) <
    // deliberate_folders (`de`). The exact slot, not merely "somewhere".
    let encoded = canonical_json_encode(&PrefsView {
        daily_template: Some(alloc::string::String::from("t1")),
        date_format: Some(alloc::string::String::from("iso")),
        deliberate_folders: alloc::vec![alloc::string::String::from("A/")],
        ..PrefsView::default()
    });
    assert_eq!(
            encoded.as_slice(),
            br#"{"daily_template":"t1","date_format":"iso","deliberate_folders":["A/"],"screen_capture_protection":true}"#
        );
}

#[test]
fn encode_places_time_fields_between_theme_and_transcription_enabled() {
    // Canonical key order: theme (`th`) < time_format (`ti`) < timezone
    // (`_` < `z`) < transcription_enabled (`ti` < `tr`).
    let encoded = canonical_json_encode(&PrefsView {
        theme: Some(ThemeChoice::Dark),
        time_format: Some(alloc::string::String::from("12h")),
        timezone: Some(alloc::string::String::from("Europe/Istanbul")),
        transcription_enabled: false,
        ..PrefsView::default()
    });
    assert_eq!(
            encoded.as_slice(),
            br#"{"screen_capture_protection":true,"theme":"dark","time_format":"12h","timezone":"Europe/Istanbul","transcription_enabled":false}"#
        );
}

#[test]
fn display_datetime_prefs_survive_a_blob_round_trip() {
    let original = PrefsView {
        date_format: Some(alloc::string::String::from("mdy")),
        time_format: Some(alloc::string::String::from("12h")),
        timezone: Some(alloc::string::String::from("America/New_York")),
        ..PrefsView::default()
    };
    let key = [7u8; 32];
    let hash = [9u8; 16];
    let blob = encode_prefs_blob_raw(&key, &hash, &original, &[3u8; 24]).expect("encode");
    let decoded = decode_prefs_blob(&key, &hash, &blob).expect("decode");
    assert_eq!(decoded, original);
}

#[test]
fn a_non_string_display_pref_decodes_to_none_rather_than_failing() {
    // Forward-compat, the `theme` / `editor_default_view_mode` discipline:
    // these are non-load-bearing display settings, so a value shape this
    // build does not understand means "unset", not "corrupt vault".
    let decoded = canonical_json_decode(
        br#"{"screen_capture_protection":true,"time_format":7,"timezone":null}"#,
    )
    .expect("decode");
    assert_eq!(decoded.time_format, None);
    assert_eq!(decoded.timezone, None);
}

#[test]
fn encode_omits_editor_line_numbers_when_none_byte_identical_to_pre_feature() {
    // A vault that never touched the line-number gutter encodes byte-
    // identically to the bare pre-feature form (migration-less additive
    // field — existing golden vectors unaffected).
    let encoded = canonical_json_encode(&PrefsView {
        editor_line_numbers: None,
        ..PrefsView::default()
    });
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_emits_editor_line_numbers_between_layout_and_line_spacing() {
    // Canonical key order: editor_layout < editor_line_numbers <
    // editor_line_spacing (`editor_la` < `editor_line_n` < `editor_line_s`).
    let on = canonical_json_encode(&PrefsView {
        editor_line_numbers: Some(true),
        ..PrefsView::default()
    });
    assert_eq!(
        on.as_slice(),
        br#"{"editor_line_numbers":true,"screen_capture_protection":true}"#,
    );
    // The non-default `false` is persisted explicitly (Some(false) != None).
    let off = canonical_json_encode(&PrefsView {
        editor_line_numbers: Some(false),
        ..PrefsView::default()
    });
    assert_eq!(
        off.as_slice(),
        br#"{"editor_line_numbers":false,"screen_capture_protection":true}"#,
    );
    // With editor_layout present, the new key sorts after it.
    let with_layout = canonical_json_encode(&PrefsView {
        editor_layout: Some(sample_layout()),
        editor_line_numbers: Some(true),
        editor_line_spacing: Some(alloc::string::String::from("relaxed")),
        ..PrefsView::default()
    });
    let s = core::str::from_utf8(&with_layout).unwrap();
    let el = s.find("editor_layout").unwrap();
    let ln = s.find("editor_line_numbers").unwrap();
    let ls = s.find("editor_line_spacing").unwrap();
    assert!(el < ln && ln < ls, "canonical order: {s}");
}

#[test]
fn editor_line_numbers_round_trips_through_decode() {
    for value in [Some(true), Some(false), None] {
        let original = PrefsView {
            editor_line_numbers: value,
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
        assert_eq!(decoded.editor_line_numbers, value);
    }
}

// ---- ai_enabled / ai_excluded_folders (local-ai, MYND-408, SYNC-12/14) --

#[test]
fn encode_omits_ai_fields_when_default_byte_identical_to_pre_feature() {
    // A vault that never enabled AI (ai_enabled=false, ai_excluded_folders
    // empty — the defaults) encodes byte-identically to the bare pre-feature
    // form: both additive fields are omitted, so existing MYP1 golden vectors
    // are unaffected (SYNC-12/14 migration-less additive discipline).
    let encoded = canonical_json_encode(&PrefsView {
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        ..PrefsView::default()
    });
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_emits_ai_fields_in_canonical_position() {
    // Canonical key order: active_workspace < ai_enabled < ai_excluded_folders
    // < archive_disabled < auto_lock_seconds (`ac` < `ai_en` < `ai_ex` < `ar`
    // < `au`). ai_enabled emits only `true`; ai_excluded_folders is a sorted,
    // deduped, NFC set (mirrors deliberate_folders).
    let encoded = canonical_json_encode(&PrefsView {
        active_workspace: Some(alloc::string::String::from("ws-1")),
        ai_enabled: true,
        ai_excluded_folders: alloc::vec![
            alloc::string::String::from("Zeta/"),
            alloc::string::String::from("Alpha/"),
            alloc::string::String::from("Alpha/"),
        ],
        archive_disabled: Some(true),
        auto_lock_seconds: Some(300),
        ..PrefsView::default()
    });
    assert_eq!(
            encoded.as_slice(),
            br#"{"active_workspace":"ws-1","ai_enabled":true,"ai_excluded_folders":["Alpha/","Zeta/"],"archive_disabled":true,"auto_lock_seconds":300,"screen_capture_protection":true}"#,
        );
}

#[test]
fn ai_enabled_omitted_when_false_emitted_only_when_true() {
    let off = canonical_json_encode(&PrefsView {
        ai_enabled: false,
        ..PrefsView::default()
    });
    assert!(!core::str::from_utf8(&off).unwrap().contains("ai_enabled"));
    let on = canonical_json_encode(&PrefsView {
        ai_enabled: true,
        ..PrefsView::default()
    });
    assert_eq!(
        on.as_slice(),
        br#"{"ai_enabled":true,"screen_capture_protection":true}"#,
    );
}

#[test]
fn developer_mode_omitted_when_false_emitted_only_when_true() {
    let off = canonical_json_encode(&PrefsView {
        developer_mode: false,
        ..PrefsView::default()
    });
    assert!(!core::str::from_utf8(&off)
        .unwrap()
        .contains("developer_mode"));
    let on = canonical_json_encode(&PrefsView {
        developer_mode: true,
        ..PrefsView::default()
    });
    assert_eq!(
        on.as_slice(),
        br#"{"developer_mode":true,"screen_capture_protection":true}"#,
    );
}

#[test]
fn developer_mode_canonical_position_between_deliberate_folders_and_device_names() {
    let encoded = canonical_json_encode(&PrefsView {
        deliberate_folders: alloc::vec![alloc::string::String::from("A/")],
        developer_mode: true,
        device_names: map_of(&[("d1", "Mac")]),
        ..PrefsView::default()
    });
    assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["A/"],"developer_mode":true,"device_names":{"d1":"Mac"},"screen_capture_protection":true}"#,
        );
}

#[test]
fn developer_mode_round_trips_through_decode_both_values() {
    for value in [true, false] {
        let original = PrefsView {
            developer_mode: value,
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode must succeed");
        assert_eq!(decoded.developer_mode, value);
    }
}

#[test]
fn developer_mode_absent_decodes_to_false() {
    let decoded =
        canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode ok");
    assert!(!decoded.developer_mode);
}

/// Cross-branch guard for the develop↔cli-thin-client merge: `cli_*`
/// (between `bar_items_order` and `custom_theme`) and `developer_mode`
/// (after `deliberate_folders`) landed on develop and the CLI branch
/// independently, both auto-merging into the canonical order with no git
/// conflict. The encoder and the decoder each walk keys once through a
/// monotonic forward cursor, so a mis-ordered insertion fails *silently* —
/// the decoder steps past the out-of-order key and reports it absent
/// (defaulted), never an error. Setting a non-default value in every field
/// touched by BOTH sides and asserting each survives a full round-trip is
/// the only thing that catches that: neither branch's own suite exercises
/// the pair together.
#[test]
fn cli_and_develop_prefs_fields_round_trip_together() {
    let original = PrefsView {
        bar_items_order: alloc::vec![alloc::string::String::from("view-mode")], // cli_enabled's left neighbour
        chat_history_budget: None,
        cli_enabled: true,
        cli_excluded_folders: alloc::vec![alloc::string::String::from("Private/")],
        cli_rate_limit_disabled: Some(true),
        developer_mode: true,
        show_task_marker: false, // default true → emitted only when false
        time_format: None,
        timezone: None,
        transcription_enabled: false, // default true → emitted only when false
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);

    // The bytes must be in canonical key order across both branches' fields;
    // a positional decode depends on it.
    let text = core::str::from_utf8(&encoded).expect("utf-8");
    let pos = |k: &str| text.find(k).unwrap_or_else(|| panic!("missing key {k}"));
    assert!(pos("\"bar_items_order\"") < pos("\"cli_enabled\""));
    assert!(pos("\"cli_enabled\"") < pos("\"cli_excluded_folders\""));
    assert!(pos("\"cli_excluded_folders\"") < pos("\"cli_rate_limit_disabled\""));
    assert!(pos("\"cli_rate_limit_disabled\"") < pos("\"developer_mode\""));
    assert!(pos("\"developer_mode\"") < pos("\"show_task_marker\""));
    assert!(pos("\"show_task_marker\"") < pos("\"transcription_enabled\""));

    let decoded = canonical_json_decode(&encoded).expect("decode must succeed");
    assert!(decoded.cli_enabled);
    assert_eq!(decoded.cli_excluded_folders, original.cli_excluded_folders);
    assert_eq!(decoded.cli_rate_limit_disabled, Some(true));
    assert!(decoded.developer_mode);
    assert!(!decoded.show_task_marker);
    assert!(!decoded.transcription_enabled);
}

/// `auto_tag_enabled` (MYND-651) is a default-off positive opt-in, so it is emitted ONLY when
/// `true` — the `ai_enabled` / `cli_enabled` discipline. A vault that never enabled it
/// therefore stays byte-identical to a pre-feature blob, which is what preserves the existing
/// KAT vectors.
#[test]
fn auto_tag_enabled_omitted_when_false_emitted_only_when_true() {
    let off = canonical_json_encode(&PrefsView {
        auto_tag_enabled: false,
        ..PrefsView::default()
    });
    assert!(
        !core::str::from_utf8(&off)
            .unwrap()
            .contains("auto_tag_enabled"),
        "the default must not be written"
    );
    assert_eq!(off, canonical_json_encode(&PrefsView::default()));

    let on = canonical_json_encode(&PrefsView {
        auto_tag_enabled: true,
        ..PrefsView::default()
    });
    assert!(core::str::from_utf8(&on)
        .unwrap()
        .contains(r#""auto_tag_enabled":true"#));
}

/// The positional-decode guard for the new key. `auto_tag_enabled` sits at
/// the boundary between the `strip_prefix`-chained prefix fields and the
/// cursor-located ones (`auto_lock_seconds` < `auto_tag_enabled` <
/// `bar_items_order`), and a mis-ordered insertion there fails *silently* —
/// the decoder steps past the out-of-order key and reports it absent
/// (defaulted), never an error. Setting a non-default value in both
/// neighbours and asserting all three survive one round-trip is the only
/// thing that catches it.
#[test]
fn auto_tag_enabled_round_trips_between_its_canonical_neighbours() {
    let original = PrefsView {
        auto_lock_seconds: Some(300), // left neighbour
        auto_tag_enabled: true,
        bar_items_order: alloc::vec![alloc::string::String::from("view-mode")], // right neighbour
        ai_enabled: true, // the flag the tag pass is co-gated on
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);

    let text = core::str::from_utf8(&encoded).expect("utf-8");
    let pos = |k: &str| text.find(k).unwrap_or_else(|| panic!("missing key {k}"));
    assert!(pos("\"ai_enabled\"") < pos("\"auto_lock_seconds\""));
    assert!(pos("\"auto_lock_seconds\"") < pos("\"auto_tag_enabled\""));
    assert!(pos("\"auto_tag_enabled\"") < pos("\"bar_items_order\""));

    let decoded = canonical_json_decode(&encoded).expect("decode must succeed");
    assert!(decoded.auto_tag_enabled);
    assert_eq!(decoded.auto_lock_seconds, Some(300));
    assert_eq!(decoded.bar_items_order, original.bar_items_order);
    assert!(decoded.ai_enabled);
}

/// A pre-MYND-651 blob decodes with the feature off — the fall-back a
/// decoder that does not find the key MUST apply (spec § 9.5.2).
#[test]
fn auto_tag_enabled_absent_decodes_to_false() {
    let decoded =
        canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode ok");
    assert!(!decoded.auto_tag_enabled);
}

/// The inverse of the `ai_enabled` rule, because this pref defaults to TRUE:
/// it is emitted only when the user turned it OFF. A vault that never
/// touched the toggle therefore stays byte-identical to a pre-MYND-441
/// blob, which is what preserves the existing KAT vectors.
#[test]
fn attachment_ocr_omitted_when_true_emitted_only_when_false() {
    let on = canonical_json_encode(&PrefsView {
        attachment_ocr_enabled: true,
        ..PrefsView::default()
    });
    assert!(
        !core::str::from_utf8(&on)
            .unwrap()
            .contains("attachment_ocr_enabled"),
        "the default must not be written"
    );
    let off = canonical_json_encode(&PrefsView {
        attachment_ocr_enabled: false,
        ..PrefsView::default()
    });
    assert_eq!(
        off.as_slice(),
        br#"{"attachment_ocr_enabled":false,"screen_capture_protection":true}"#,
    );
}

/// **The backward-compatibility assertion that matters.** Every vault in
/// existence has a prefs blob written before this field existed. Decoding
/// one must yield the feature ON — a bare `#[serde(default)]` would have
/// yielded `false` and silently disabled OCR for every existing user.
#[test]
fn a_prefs_blob_predating_the_field_decodes_with_ocr_enabled() {
    let pre_feature = br#"{"screen_capture_protection":true}"#;
    let parsed = canonical_json_decode(pre_feature).expect("decodes");
    assert!(
        parsed.attachment_ocr_enabled,
        "an older blob must decode with OCR ON, not off"
    );
}

/// Round-trip in the non-default direction, including the canonical key
/// position (after `archived_folders`, before `auto_lock_seconds`).
#[test]
fn attachment_ocr_false_round_trips_in_canonical_position() {
    let src = PrefsView {
        attachment_ocr_enabled: false,
        archived_folders: alloc::vec!["Ops/".into()],
        auto_lock_seconds: Some(300),
        ..PrefsView::default()
    };
    let bytes = canonical_json_encode(&src);
    let text = core::str::from_utf8(&bytes).unwrap();
    let i_arch = text
        .find("archived_folders")
        .expect("archived_folders present");
    let i_ocr = text
        .find("attachment_ocr_enabled")
        .expect("attachment_ocr_enabled present");
    let i_auto = text
        .find("auto_lock_seconds")
        .expect("auto_lock_seconds present");
    assert!(
        i_arch < i_ocr && i_ocr < i_auto,
        "canonical key order violated: {text}"
    );
    let back = canonical_json_decode(&bytes).expect("decodes");
    assert!(!back.attachment_ocr_enabled);
    assert_eq!(back.auto_lock_seconds, Some(300));
    assert_eq!(
        back.archived_folders,
        alloc::vec![alloc::string::String::from("Ops/")]
    );
}

/// The inverse of the `ai_enabled` rule, same shape as `attachment_ocr_enabled`'s coverage: it
/// is emitted only when the user turned it OFF. A vault that never touched the toggle therefore
/// stays byte-identical to a pre-feature blob, which is what preserves the existing KAT
/// vectors.
#[test]
fn attachment_compression_omitted_when_true_emitted_only_when_false() {
    let on = canonical_json_encode(&PrefsView {
        attachment_compression_enabled: true,
        ..PrefsView::default()
    });
    assert!(
        !core::str::from_utf8(&on)
            .unwrap()
            .contains("attachment_compression_enabled"),
        "the default must not be written"
    );
    let off = canonical_json_encode(&PrefsView {
        attachment_compression_enabled: false,
        ..PrefsView::default()
    });
    assert_eq!(
        off.as_slice(),
        br#"{"attachment_compression_enabled":false,"screen_capture_protection":true}"#,
    );
}

/// **The backward-compatibility assertion that matters.** Every vault in
/// existence has a prefs blob written before this field existed. Decoding
/// one must yield the feature ON — a bare `#[serde(default)]` would have
/// yielded `false` and silently disabled compression for every existing
/// user.
#[test]
fn a_prefs_blob_predating_the_field_decodes_with_compression_enabled() {
    let pre_feature = br#"{"screen_capture_protection":true}"#;
    let parsed = canonical_json_decode(pre_feature).expect("decodes");
    assert!(
        parsed.attachment_compression_enabled,
        "an older blob must decode with compression ON, not off"
    );
}

/// Round-trip in the non-default direction, including the canonical key
/// position (after `archived_folders`, before `attachment_ocr_enabled`).
#[test]
fn attachment_compression_false_round_trips_in_canonical_position() {
    let src = PrefsView {
        attachment_compression_enabled: false,
        archived_folders: alloc::vec!["Ops/".into()],
        attachment_ocr_enabled: false,
        ..PrefsView::default()
    };
    let bytes = canonical_json_encode(&src);
    let text = core::str::from_utf8(&bytes).unwrap();
    let i_arch = text
        .find("archived_folders")
        .expect("archived_folders present");
    let i_compress = text
        .find("attachment_compression_enabled")
        .expect("attachment_compression_enabled present");
    let i_ocr = text
        .find("attachment_ocr_enabled")
        .expect("attachment_ocr_enabled present");
    assert!(
        i_arch < i_compress && i_compress < i_ocr,
        "canonical key order violated: {text}"
    );
    let back = canonical_json_decode(&bytes).expect("decodes");
    assert!(!back.attachment_compression_enabled);
    assert!(!back.attachment_ocr_enabled);
    assert_eq!(
        back.archived_folders,
        alloc::vec![alloc::string::String::from("Ops/")]
    );
}

#[test]
fn ai_excluded_folders_omitted_when_empty_present_when_set() {
    let empty = canonical_json_encode(&PrefsView {
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        ..PrefsView::default()
    });
    assert!(!core::str::from_utf8(&empty)
        .unwrap()
        .contains("ai_excluded_folders"));
    let set = canonical_json_encode(&PrefsView {
        ai_excluded_folders: alloc::vec![alloc::string::String::from("Secret/")],
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        ..PrefsView::default()
    });
    assert_eq!(
        set.as_slice(),
        br#"{"ai_excluded_folders":["Secret/"],"screen_capture_protection":true}"#,
    );
}

#[test]
fn ai_fields_round_trip_through_decode() {
    // Already-canonical (sorted) input → decode reproduces the original.
    let original = PrefsView {
        ai_enabled: true,
        ai_excluded_folders: alloc::vec![
            alloc::string::String::from("Alpha/"),
            alloc::string::String::from("Beta/"),
        ],
        active_workspace: Some(alloc::string::String::from("ws-2")),
        archive_disabled: Some(false),
        auto_lock_seconds: Some(900),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded, original);
}

#[test]
fn ai_fields_default_off_empty_when_absent_on_decode() {
    // A pre-feature blob (no ai keys) decodes to the defaults (off / empty),
    // spec § 9.5.2 forward-compat fall-back.
    let decoded = canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
    assert!(!decoded.ai_enabled);
    assert!(decoded.ai_excluded_folders.is_empty());
}

// ---- archived_folders (folder-archive) -----------------------------

#[test]
fn archived_folders_omitted_when_empty_present_when_set() {
    let empty = canonical_json_encode(&PrefsView {
        archived_folders: Vec::new(),
        ..PrefsView::default()
    });
    assert!(!core::str::from_utf8(&empty)
        .unwrap()
        .contains("archived_folders"));
    let set = canonical_json_encode(&PrefsView {
        archived_folders: alloc::vec![alloc::string::String::from("Projects/")],
        ..PrefsView::default()
    });
    assert_eq!(
        set.as_slice(),
        br#"{"archived_folders":["Projects/"],"screen_capture_protection":true}"#,
    );
}

/// The remote-provider quartet sits between `ai_excluded_folders` and
/// `archive_disabled`, and the parser is POSITIONAL — a field placed wrong
/// round-trips wrong. Both lexicographic neighbours are named and asserted
/// by position, per the `auto_tag_enabled` precedent above.
#[test]
fn ai_provider_quartet_encodes_between_ai_excluded_folders_and_archive_disabled() {
    let encoded = canonical_json_encode(&PrefsView {
        ai_excluded_folders: alloc::vec![alloc::string::String::from("Private/")],
        ai_provider: Some(alloc::string::String::from("openrouter")),
        ai_provider_consent: Some(alloc::string::String::from("openrouter")),
        ai_provider_key: Some(Zeroizing::new(alloc::string::String::from(
            "sk-sentinel-000",
        ))),
        ai_provider_model: Some(alloc::string::String::from("meta-llama/llama-3.1-8b")),
        archive_disabled: Some(true),
        ..PrefsView::default()
    });
    let text = core::str::from_utf8(&encoded).unwrap();
    let pos = |k: &str| text.find(k).unwrap_or_else(|| panic!("missing {k}"));
    // ai_excluded_folders < ai_provider < ai_provider_consent <
    // ai_provider_key < ai_provider_model < archive_disabled.
    assert!(pos("\"ai_excluded_folders\"") < pos("\"ai_provider\""));
    assert!(pos("\"ai_provider\"") < pos("\"ai_provider_consent\""));
    assert!(pos("\"ai_provider_consent\"") < pos("\"ai_provider_key\""));
    assert!(pos("\"ai_provider_key\"") < pos("\"ai_provider_model\""));
    assert!(pos("\"ai_provider_model\"") < pos("\"archive_disabled\""));
    // And it round-trips through the positional parser.
    let back = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(back.ai_provider.as_deref(), Some("openrouter"));
    assert_eq!(back.ai_provider_consent.as_deref(), Some("openrouter"));
    assert_eq!(
        back.ai_provider_key.as_deref().map(|k| k.as_str()),
        Some("sk-sentinel-000")
    );
    assert_eq!(
        back.ai_provider_model.as_deref(),
        Some("meta-llama/llama-3.1-8b")
    );
    assert_eq!(back.archive_disabled, Some(true));
}

/// The model is the one member of the quartet that is BOTH persisted and
/// allowed across IPC — the panel renders the current selection back, and a
/// published model name is not a credential. Its own test because the
/// nearest field in the file (`ai_provider_key`) is the exact opposite, and
/// a future `skip_serializing` copied one field too far would leave the
/// chooser rendering blank with nothing failing.
#[test]
fn the_chosen_model_crosses_ipc_unlike_the_key_beside_it() {
    const MODEL: &str = "qwen/qwen3-30b";
    let view = PrefsView {
        ai_provider: Some(alloc::string::String::from("openrouter")),
        ai_provider_key: Some(Zeroizing::new(alloc::string::String::from(
            "sk-not-this-one",
        ))),
        ai_provider_model: Some(alloc::string::String::from(MODEL)),
        ..PrefsView::default()
    };
    let json = serde_json::to_string(&view).expect("serialize");
    assert!(
        json.contains(MODEL),
        "the chosen model must reach the panel"
    );
    assert!(!json.contains("sk-not-this-one"), "the key VALUE leaked");
}

/// A model chosen without a provider is a state the UI cannot produce, but
/// the codec must not corrupt it: the positional parser has to skip the
/// three absent siblings and still find the model.
///
/// It does NOT catch a chain wired to the wrong `post_*` variable, though
/// an earlier revision of this comment claimed it did. Every field AFTER
/// the model is absent here too, so nothing ever consumes the cursor the
/// wrong branch would have poisoned. The test below is the one that
/// consumes it.
#[test]
fn the_model_round_trips_with_every_sibling_absent() {
    let encoded = canonical_json_encode(&PrefsView {
        ai_provider_model: Some(alloc::string::String::from("solo")),
        ..PrefsView::default()
    });
    assert_eq!(
        core::str::from_utf8(&encoded).unwrap(),
        r#"{"ai_provider_model":"solo","screen_capture_protection":true}"#,
    );
    let back = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(back.ai_provider_model.as_deref(), Some("solo"));
    assert_eq!(back.ai_provider, None);
}

/// The shape the test above cannot reach: the model present WITH fields
/// after it also present. `archive_disabled` is `Option<bool>` and is
/// omitted unless the user touched the archive toggle, so this is the
/// ordinary state of any vault whose owner named a provider — and it is
/// exactly where a `None =>` arm wired to the wrong `post_*` bites.
///
/// The four fields after `archive_disabled` are located by `strip_prefix`,
/// not by `find_top_level_marker`, so a cursor that rewinds BEHIND
/// `ai_provider_model` makes every one of them miss its marker and take
/// its absent-branch default. Silently: the decode still returns `Ok`.
#[test]
fn the_model_does_not_swallow_the_preferences_that_follow_it() {
    let original = PrefsView {
        ai_provider_model: Some(alloc::string::String::from("meta-llama/llama-3.1-8b")),
        archive_disabled: None,
        archived_folders: alloc::vec![alloc::string::String::from("Old/")],
        attachment_compression_enabled: false,
        attachment_ocr_enabled: false,
        auto_lock_seconds: Some(900),
        ..PrefsView::default()
    };
    let back = canonical_json_decode(&canonical_json_encode(&original)).expect("decode");

    // `auto_lock_seconds` first: losing it silently shortens the vault's
    // protective envelope to DEFAULT_AUTO_LOCK_SECS without the user
    // asking, which is a security setting changing itself.
    assert_eq!(back.auto_lock_seconds, Some(900), "auto-lock was reset");
    assert!(
        !back.attachment_ocr_enabled,
        "an OCR opt-out flipped back on"
    );
    assert!(!back.attachment_compression_enabled);
    assert_eq!(back.archived_folders, original.archived_folders);
    assert_eq!(
        back.ai_provider_model.as_deref(),
        Some("meta-llama/llama-3.1-8b"),
    );
}

/// The DEFAULT STATE leaves no trace in the blob. A vault that never named
/// a provider must encode byte-identically to a pre-feature `vault.prefs`,
/// which is what keeps every existing KAT vector valid — and, separately,
/// what stops the blob from carrying an at-rest "this user configured AI"
/// fingerprint.
#[test]
fn the_ai_provider_triple_is_omitted_entirely_when_unset() {
    let empty = canonical_json_encode(&PrefsView::default());
    let text = core::str::from_utf8(&empty).unwrap();
    assert!(!text.contains("ai_provider"), "got: {text}");
    // The pre-feature baseline: `PrefsView::default()` encodes to exactly
    // the mandatory trailing field and nothing else.
    assert_eq!(text, r#"{"screen_capture_protection":true}"#);
}

/// The credential's buffer wipes when it drops (myne-md/myne#444).
///
/// Asserted at COMPILE time, not by inspecting freed memory. Reading a
/// dropped allocation is undefined behaviour, so a runtime "the bytes are
/// gone" test would be either unsound or — more likely — a test of what the
/// allocator happened to do on one machine, which is the shape of assertion
/// that passes forever and means nothing. The property here is entirely
/// carried by the type: `Zeroizing<T>` wipes in its `Drop`, so pinning the
/// field's type pins the behaviour.
///
/// What this catches is the realistic regression: someone adding a prefs
/// field, copying the line above it, and quietly widening the type back to
/// `String` because that is what every sibling is.
#[test]
fn the_provider_key_field_is_zeroizing_rather_than_a_plain_string() {
    let view = PrefsView {
        ai_provider_key: Some(Zeroizing::new(alloc::string::String::from("sk-x"))),
        ..PrefsView::default()
    };
    // Compiles only while the field is `Option<Zeroizing<String>>`: a plain
    // `String` fails to coerce, and a different wrapper is a different type.
    let _pinned: Option<Zeroizing<alloc::string::String>> = view.ai_provider_key.clone();

    // …and the wrapper is transparent to the codec, so the on-disk bytes are
    // unchanged by the hardening. A format change here would be a silent
    // cross-implementation break — every other client holds a plain string.
    let plain = PrefsView {
        ai_provider_key: None,
        ..PrefsView::default()
    };
    let with_key = canonical_json_encode(&view);
    assert!(
        with_key
            .windows(b"\"ai_provider_key\":\"sk-x\"".len())
            .any(|w| w == b"\"ai_provider_key\":\"sk-x\""),
        "the wrapper must not change the emitted bytes: {}",
        alloc::string::String::from_utf8_lossy(&with_key)
    );
    assert!(!canonical_json_encode(&plain)
        .windows(4)
        .any(|w| w == b"sk-x"));
}

/// **The IPC confinement.** `prefs_read` serializes the whole `PrefsView`
/// to the WebView, so a key without `#[serde(skip_serializing)]` reaches
/// page context on every read. The twin of
/// `prefs_view_serde_serialization_omits_token_value`: the key survives the
/// BLOB round trip (it is encrypted vault content) and is absent from the
/// IPC JSON — both the field NAME and a sentinel VALUE, because asserting
/// only the name would pass against a rename.
#[test]
fn the_provider_key_round_trips_on_disk_and_never_reaches_the_ipc_json() {
    const SENTINEL: &str = "sk-do-not-let-this-cross-ipc";
    let view = PrefsView {
        ai_provider: Some(alloc::string::String::from("openrouter")),
        ai_provider_consent: Some(alloc::string::String::from("openrouter")),
        ai_provider_key: Some(Zeroizing::new(alloc::string::String::from(SENTINEL))),
        ai_provider_model: None,
        ..PrefsView::default()
    };

    // On disk: present, and it comes back.
    let blob = canonical_json_encode(&view);
    let back = canonical_json_decode(&blob).expect("decode");
    assert_eq!(
        back.ai_provider_key.as_deref().map(|k| k.as_str()),
        Some(SENTINEL)
    );

    // Across IPC: absent, by name AND by value.
    let json = serde_json::to_string(&view).expect("serialize");
    assert!(!json.contains("ai_provider_key"), "field name leaked");
    assert!(!json.contains(SENTINEL), "the key VALUE leaked");
    // The two siblings DO cross — the UI needs to render which provider is
    // selected and whether consent was given. Asserting this is what makes
    // the absence above a targeted skip rather than a serialization that
    // silently dropped the whole group.
    assert!(json.contains("ai_provider"), "the selection must cross");
    assert!(json.contains("ai_provider_consent"), "consent must cross");
}

#[test]
fn archived_folders_encode_sorts_dedupes_between_archive_disabled_and_auto_lock() {
    // Canonical key order: archive_disabled < archived_folders <
    // auto_lock_seconds (`archive_` `_`=0x5F < `archived` `d`=0x64; `ar` < `au`).
    // The set is NFC-sorted + exact-deduped like deliberate_folders.
    let encoded = canonical_json_encode(&PrefsView {
        archive_disabled: Some(true),
        archived_folders: alloc::vec![
            alloc::string::String::from("Zeta/"),
            alloc::string::String::from("Alpha/"),
            alloc::string::String::from("Alpha/"),
        ],
        auto_lock_seconds: Some(300),
        ..PrefsView::default()
    });
    assert_eq!(
            encoded.as_slice(),
            br#"{"archive_disabled":true,"archived_folders":["Alpha/","Zeta/"],"auto_lock_seconds":300,"screen_capture_protection":true}"#,
        );
}

#[test]
fn archived_folders_round_trip_through_decode() {
    // Already-canonical (sorted) input → decode reproduces the original,
    // alongside the neighbors that bracket it in canonical order.
    let original = PrefsView {
        archive_disabled: Some(false),
        archived_folders: alloc::vec![
            alloc::string::String::from("Archive/"),
            alloc::string::String::from("Projects/"),
        ],
        auto_lock_seconds: Some(900),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded, original);
}

#[test]
fn archived_folders_default_empty_when_absent_on_decode() {
    // A pre-feature blob (no archived_folders key) decodes to the empty
    // default, spec § 9.5.2 forward-compat fall-back.
    let decoded = canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
    assert!(decoded.archived_folders.is_empty());
}

// ---- archive_disabled (archive-disable, MYND-…) --------------------

#[test]
fn encode_omits_archive_disabled_when_none_byte_identical_to_pre_feature() {
    // A vault that never touched the archive toggle encodes byte-identically
    // to the bare pre-feature form (migration-less additive field — existing
    // golden vectors unaffected).
    let encoded = canonical_json_encode(&PrefsView {
        archive_disabled: None,
        ..PrefsView::default()
    });
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_emits_archive_disabled_between_active_workspace_and_auto_lock() {
    // Canonical key order: active_workspace < archive_disabled <
    // auto_lock_seconds (`ac` < `ar` < `au`).
    let on = canonical_json_encode(&PrefsView {
        archive_disabled: Some(true),
        ..PrefsView::default()
    });
    assert_eq!(
        on.as_slice(),
        br#"{"archive_disabled":true,"screen_capture_protection":true}"#,
    );
    // The non-default `false` is persisted explicitly (Some(false) != None).
    let off = canonical_json_encode(&PrefsView {
        archive_disabled: Some(false),
        ..PrefsView::default()
    });
    assert_eq!(
        off.as_slice(),
        br#"{"archive_disabled":false,"screen_capture_protection":true}"#,
    );
    // With active_workspace + auto_lock_seconds present, the new key sorts
    // strictly between them.
    let with_neighbors = canonical_json_encode(&PrefsView {
        active_workspace: Some(alloc::string::String::from("ws-1")),
        archive_disabled: Some(true),
        auto_lock_seconds: Some(300),
        ..PrefsView::default()
    });
    let s = core::str::from_utf8(&with_neighbors).unwrap();
    let aw = s.find("active_workspace").unwrap();
    let ar = s.find("archive_disabled").unwrap();
    let al = s.find("auto_lock_seconds").unwrap();
    assert!(aw < ar && ar < al, "canonical order: {s}");
}

#[test]
fn archive_disabled_round_trips_through_decode() {
    for value in [Some(true), Some(false), None] {
        let original = PrefsView {
            archive_disabled: value,
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
        assert_eq!(decoded.archive_disabled, value);
    }
}

#[test]
fn chat_history_budget_round_trips_alongside_its_neighbours() {
    // The whole prefix-chained run plus both cursor-region neighbours in one
    // blob. The defect this pins is not hypothetical: the field first
    // shipped as `agent_history_budget`, which sorts INSIDE the
    // strip_prefix run, and its `ai_enabled` arm rewound to the cursor from
    // before the budget was consumed, so with the budget set and AI off
    // every prefix-chained field behind it decoded to its default:
    // `auto_lock_seconds`, `ai_excluded_folders` and the `Zeroizing`
    // provider key among them. `ai_enabled: false` is therefore the arm
    // that matters and it is asserted below in both states.
    for ai_enabled in [true, false] {
        let original = PrefsView {
            active_workspace: Some(alloc::string::String::from("ws-1")),
            ai_enabled,
            ai_excluded_folders: alloc::vec![alloc::string::String::from("Private/")],
            ai_provider_key: Some(Zeroizing::new(alloc::string::String::from("sk-secret"))),
            archive_disabled: Some(true),
            auto_lock_seconds: Some(300),
            bar_items_order: alloc::vec![alloc::string::String::from("graph")],
            chat_history_budget: Some(3000),
            cli_enabled: true,
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original, "ai_enabled = {ai_enabled}");
    }
}

#[test]
fn an_unknown_key_in_the_cursor_region_does_not_blind_the_fields_behind_it() {
    // The forward-compatibility property §9.5.2 states, and the reason
    // `chat_history_budget` is named to sort where it does. An older client
    // meets a key it has never heard of; in the cursor-scanned region
    // `find_top_level_marker` steps over it, so everything behind it still
    // decodes. Injected here rather than asserted in prose, because the
    // failure is silent: the blob decodes SUCCESSFULLY minus the fields it
    // lost, and `update_prefs_with_dir` only refuses to write over a read
    // that ERRORED.
    let original = PrefsView {
        auto_lock_seconds: Some(300),
        bar_items_order: alloc::vec![alloc::string::String::from("graph")],
        cli_enabled: true,
        custom_theme: Some(alloc::string::String::from("midnight")),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let text = core::str::from_utf8(&encoded).expect("utf8");
    // A future field, canonically between bar_items_order and cli_enabled.
    let injected = text.replace(
        "\"cli_enabled\"",
        "\"chat_history_budget_v2\":7,\"cli_enabled\"",
    );
    assert_ne!(injected, text, "the injection point moved");
    let decoded = canonical_json_decode(injected.as_bytes()).expect("decode");
    assert!(decoded.cli_enabled);
    assert_eq!(
        decoded.custom_theme,
        Some(alloc::string::String::from("midnight"))
    );
    assert_eq!(decoded.auto_lock_seconds, Some(300));
}

#[test]
fn archive_disabled_round_trips_alongside_neighbors() {
    // Exercise the strip_prefix decode path with both canonical neighbors
    // present, so a regression in the post_active → post_archive threading
    // (e.g. auto_lock_seconds stripping from the wrong slice) is caught.
    let original = PrefsView {
        active_workspace: Some(alloc::string::String::from("ws-1")),
        archive_disabled: Some(true),
        auto_lock_seconds: Some(300),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded, original);
}

// ---- active_workspace (MYND-308) -----------------------------------

#[test]
fn encode_omits_active_workspace_when_none_byte_identical_to_pre_feature() {
    // A vault that never set an active workspace encodes byte-identically to
    // the bare pre-feature form (migration-less additive field).
    let encoded = canonical_json_encode(&PrefsView {
        active_workspace: None,
        ..PrefsView::default()
    });
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_emits_active_workspace_first_before_auto_lock_seconds() {
    // Canonical key order: active_workspace < auto_lock_seconds ("ac" < "au").
    let encoded = canonical_json_encode(&PrefsView {
        active_workspace: Some(alloc::string::String::from("ws-1")),
        ..PrefsView::default()
    });
    assert_eq!(
        encoded.as_slice(),
        br#"{"active_workspace":"ws-1","screen_capture_protection":true}"#,
    );
    // With auto_lock_seconds present, active_workspace still sorts first.
    let with_auto = canonical_json_encode(&PrefsView {
        active_workspace: Some(alloc::string::String::from("ws-1")),
        auto_lock_seconds: Some(300),
        ..PrefsView::default()
    });
    let s = core::str::from_utf8(&with_auto).unwrap();
    let aw = s.find("active_workspace").unwrap();
    let al = s.find("auto_lock_seconds").unwrap();
    assert!(aw < al, "canonical order: {s}");
}

#[test]
fn active_workspace_is_nfc_normalized_on_encode() {
    // "é" as NFD (e + combining acute) normalizes to NFC single codepoint.
    let nfd = alloc::string::String::from("ws-Cafe\u{0301}");
    let encoded = canonical_json_encode(&PrefsView {
        active_workspace: Some(nfd),
        ..PrefsView::default()
    });
    assert_eq!(
        encoded.as_slice(),
        "{\"active_workspace\":\"ws-Café\",\"screen_capture_protection\":true}".as_bytes(),
    );
}

#[test]
fn active_workspace_round_trips_through_decode() {
    for value in [Some(alloc::string::String::from("ws-1")), None] {
        let original = PrefsView {
            active_workspace: value.clone(),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
        assert_eq!(decoded.active_workspace, value);
    }
    // Round-trips alongside auto_lock_seconds (active_workspace canonically
    // first; auto_lock_seconds is the strip_prefix-matched second field).
    let original = PrefsView {
        active_workspace: Some(alloc::string::String::from("ws-7")),
        auto_lock_seconds: Some(900),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded, original);
}

// ---- editor focus + default-view-mode (MYND-299 / MYND-348) --------

#[test]
fn encode_omits_editor_batch_fields_when_none_byte_identical_to_pre_feature() {
    // A vault that never touched the batch editor fields encodes byte-
    // identically to the bare pre-feature form (migration-less additive
    // fields — existing golden vectors unaffected).
    let encoded = canonical_json_encode(&PrefsView {
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        ..PrefsView::default()
    });
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_places_editor_batch_fields_in_canonical_order() {
    // Canonical editor_* order: editor_content_width <
    // editor_default_view_mode < editor_focus_dim_inactive <
    // editor_focus_typewriter < editor_font_family.
    let encoded = canonical_json_encode(&PrefsView {
        editor_content_width: Some(alloc::string::String::from("wide")),
        editor_default_view_mode: Some(alloc::string::String::from("reading")),
        editor_focus_dim_inactive: Some(true),
        editor_focus_typewriter: Some(false),
        editor_font_family: Some(alloc::string::String::from("sans")),
        ..PrefsView::default()
    });
    let s = core::str::from_utf8(&encoded).unwrap();
    let cw = s.find("editor_content_width").unwrap();
    let dvm = s.find("editor_default_view_mode").unwrap();
    let di = s.find("editor_focus_dim_inactive").unwrap();
    let tw = s.find("editor_focus_typewriter").unwrap();
    let ff = s.find("editor_font_family").unwrap();
    assert!(
        cw < dvm && dvm < di && di < tw && tw < ff,
        "canonical order: {s}"
    );
    // Bools encode as bare true/false; the string view-mode as a JSON string.
    assert_eq!(
            encoded.as_slice(),
            br#"{"editor_content_width":"wide","editor_default_view_mode":"reading","editor_focus_dim_inactive":true,"editor_focus_typewriter":false,"editor_font_family":"sans","screen_capture_protection":true}"#,
        );
}

#[test]
fn editor_default_view_mode_is_nfc_normalized_on_encode() {
    let nfd = alloc::string::String::from("Cafe\u{0301}");
    let encoded = canonical_json_encode(&PrefsView {
        editor_default_view_mode: Some(nfd),
        ..PrefsView::default()
    });
    assert_eq!(
        encoded.as_slice(),
        "{\"editor_default_view_mode\":\"Café\",\"screen_capture_protection\":true}".as_bytes(),
    );
}

#[test]
fn editor_batch_fields_round_trip_through_decode() {
    for dvm in [Some(alloc::string::String::from("source")), None] {
        for di in [Some(true), Some(false), None] {
            for tw in [Some(true), Some(false), None] {
                let original = PrefsView {
                    editor_default_view_mode: dvm.clone(),
                    editor_focus_dim_inactive: di,
                    editor_focus_typewriter: tw,
                    ..PrefsView::default()
                };
                let encoded = canonical_json_encode(&original);
                let decoded = canonical_json_decode(&encoded).expect("decode");
                assert_eq!(decoded, original);
                assert_eq!(decoded.editor_default_view_mode, dvm);
                assert_eq!(decoded.editor_focus_dim_inactive, di);
                assert_eq!(decoded.editor_focus_typewriter, tw);
            }
        }
    }
}

#[test]
fn label_is_nfc_normalized_on_encode() {
    // "é" as NFD (e + combining acute) normalizes to NFC single codepoint.
    let nfd = alloc::string::String::from("Cafe\u{0301}");
    let encoded = canonical_json_encode(&PrefsView {
        label: Some(nfd),
        ..PrefsView::default()
    });
    assert_eq!(
        encoded.as_slice(),
        "{\"label\":\"Café\",\"screen_capture_protection\":true}".as_bytes(),
    );
}

#[test]
fn decode_absent_label_is_none() {
    // A pre-MYND-205 single-field blob decodes with label == None.
    let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
    assert_eq!(parsed.label, None);
}

// ---- last_backup_at field (MYND-58, vault-backup-restore epic) ----

#[test]
fn encode_places_last_backup_at_between_label_and_screen_capture() {
    // Canonical key order: label (lab) < last_backup_at (las) <
    // screen_capture_protection (s).
    let encoded = canonical_json_encode(&PrefsView {
        label: Some(alloc::string::String::from("Work")),
        last_backup_at: Some(1765000000),
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        ..PrefsView::default()
    });
    assert_eq!(
        encoded.as_slice(),
        br#"{"label":"Work","last_backup_at":1765000000,"screen_capture_protection":true}"#,
    );
}

#[test]
fn encode_places_meeting_ai_prompt_between_last_backup_at_and_new_note_location() {
    // Canonical key order (meeting-ai): last_backup_at (l) <
    // meeting_ai_prompt (m) < new_note_location (n).
    let view = PrefsView {
        last_backup_at: Some(1765000000),
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: Some(alloc::string::String::from("Summarize tersely.")),
        new_note_location: Some(alloc::string::String::from("specific")),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&view);
    let text = core::str::from_utf8(&encoded).expect("utf8");
    let pos = |needle: &str| text.find(needle).expect("marker present");
    assert!(pos("\"last_backup_at\"") < pos("\"meeting_ai_prompt\""));
    assert!(pos("\"meeting_ai_prompt\"") < pos("\"new_note_location\""));
    let back = canonical_json_decode(&encoded).expect("decodes");
    assert_eq!(
        back.meeting_ai_prompt.as_deref(),
        Some("Summarize tersely.")
    );
}

#[test]
fn meeting_ai_prompt_is_omitted_when_unset() {
    let encoded = canonical_json_encode(&PrefsView::default());
    let text = core::str::from_utf8(&encoded).expect("utf8");
    assert!(!text.contains("meeting_ai_prompt"), "got: {text}");
}

#[test]
fn last_backup_at_round_trips_through_decode() {
    let original = PrefsView {
        last_backup_at: Some(1765432100),
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded, original);
}

#[test]
fn last_backup_at_u64_beyond_u32_round_trips() {
    // Epoch seconds are u64 — a value past the 2106 u32 horizon must
    // survive (no silent truncation).
    let original = PrefsView {
        last_backup_at: Some(u64::from(u32::MAX) + 12345),
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded.last_backup_at, Some(u64::from(u32::MAX) + 12345));
}

#[test]
fn decode_absent_last_backup_at_is_none() {
    // A pre-MYND-58 blob decodes with last_backup_at == None ("never
    // backed up"); byte-identity of the default encode is asserted by
    // encode_omits_label_when_none_byte_identical_to_pre_label.
    let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
    assert_eq!(parsed.last_backup_at, None);
}

#[test]
fn fractional_last_backup_at_rejects_parse() {
    // Floats are FORBIDDEN (spec §9.5.2): the digits parse, then the
    // strict `,` terminator check rejects the `.`.
    let result = canonical_json_decode(
        br#"{"last_backup_at":1765000000.5,"screen_capture_protection":true}"#,
    );
    assert_eq!(result, Err(PrefsBlobError::PlaintextParseFailed));
}

#[test]
fn encode_emits_theme_last_dark_with_scp_false() {
    let encoded = canonical_json_encode(&PrefsView {
        screen_capture_protection: false,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        theme: Some(ThemeChoice::Dark),
        ..PrefsView::default()
    });
    assert_eq!(
        encoded.as_slice(),
        br#"{"screen_capture_protection":false,"theme":"dark"}"#,
    );
}

#[test]
fn encode_emits_theme_after_all_other_fields() {
    // Full field-mix: a < d < e < f < i < s < t. theme sits last.
    let prefs = PrefsView {
        chat_history_budget: None,
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: true,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        archived_folders: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        deliberate_folders: alloc::vec![alloc::string::String::from("Archive/")],
        auto_lock_seconds: Some(300),
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        favorites: alloc::vec![alloc::string::String::from("f1")],
        field_clocks: Default::default(),
        item_order: BTreeMap::from([(
            alloc::string::String::from(""),
            alloc::vec![alloc::string::String::from("n1")],
        )]),
        editor_layout: Some(EditorLayout {
            left_width: 312,
            right_width: 288,
            left_collapsed: false,
            right_collapsed: true,
        }),
        editor_line_numbers: None,
        theme: Some(ThemeChoice::Dark),
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"auto_lock_seconds":300,"deliberate_folders":["Archive/"],"editor_layout":{"left_collapsed":false,"left_width":312,"right_collapsed":true,"right_width":288},"favorites":["f1"],"item_order":{"":["n1"]},"screen_capture_protection":true,"theme":"dark"}"#,
        );
}

#[test]
fn decode_round_trips_theme_dark() {
    let parsed =
        canonical_json_decode(br#"{"screen_capture_protection":true,"theme":"dark"}"#).unwrap();
    assert_eq!(parsed.theme, Some(ThemeChoice::Dark));
    assert!(parsed.screen_capture_protection);
}

#[test]
fn decode_round_trips_theme_amoled() {
    let parsed =
        canonical_json_decode(br#"{"screen_capture_protection":true,"theme":"amoled"}"#).unwrap();
    assert_eq!(parsed.theme, Some(ThemeChoice::Amoled));
    assert!(parsed.screen_capture_protection);
}

#[test]
fn encode_emits_amoled_theme_value() {
    let prefs = PrefsView {
        theme: Some(ThemeChoice::Amoled),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    // The `theme` key is canonically LAST among the cosmetic fields and
    // serializes the lowercase variant string.
    assert!(find_subslice(&encoded, br#""theme":"amoled""#).is_some());
}

#[test]
fn decode_round_trips_theme_light_with_scp_false() {
    let parsed =
        canonical_json_decode(br#"{"screen_capture_protection":false,"theme":"light"}"#).unwrap();
    assert_eq!(parsed.theme, Some(ThemeChoice::Light));
    assert!(!parsed.screen_capture_protection);
}

#[test]
fn decode_absent_theme_is_none() {
    let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
    assert_eq!(parsed.theme, None);
}

#[test]
fn decode_unknown_theme_value_is_none_tolerant() {
    // A future / unrecognized theme value decodes to None (≡ system),
    // treated as an unknown field per forward-compat — NOT a parse
    // failure that would strand the load-bearing screen_capture_protection.
    let parsed =
        canonical_json_decode(br#"{"screen_capture_protection":true,"theme":"sepia"}"#).unwrap();
    assert_eq!(parsed.theme, None);
    assert!(parsed.screen_capture_protection);
}

#[test]
fn full_blob_round_trip_with_theme() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let original = PrefsView {
        theme: Some(ThemeChoice::Dark),
        ..PrefsView::default()
    };
    let blob =
        encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
    assert_eq!(original, decoded);
    assert_eq!(decoded.theme, Some(ThemeChoice::Dark));
}

#[test]
fn theme_none_round_trips_through_full_blob() {
    // Default (None ≡ system) survives a full encode/decode unchanged
    // and stays byte-identical to a pre-MYND-110 blob (omit-when-None).
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let original = PrefsView::default();
    let blob =
        encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
    assert_eq!(decoded.theme, None);
    assert_eq!(original, decoded);
}

// ---- spell-check fields (MYND-267) --------------------------------

#[test]
fn full_blob_round_trip_with_spell_fields() {
    // spell_enabled + spell_languages survive a full encode/decode.
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let original = PrefsView {
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        spell_enabled: Some(true),
        spell_languages: alloc::vec![String::from("en-US"), String::from("tr")],
        ..PrefsView::default()
    };
    let blob =
        encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
    assert_eq!(original, decoded);
    assert_eq!(decoded.spell_enabled, Some(true));
    assert_eq!(decoded.spell_languages, alloc::vec!["en-US", "tr"]);
}

#[test]
fn spell_languages_canonicalized_sorted_and_deduped() {
    // Set-semantics like deliberate_folders: the encoder NFC-sorts +
    // exact-dedupes, so a caller's unordered/duplicated input round-trips
    // to the canonical form.
    let original = PrefsView {
        spell_languages: alloc::vec![
            String::from("tr"),
            String::from("en-US"),
            String::from("tr"),
        ],
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded.spell_languages, alloc::vec!["en-US", "tr"]);
}

#[test]
fn spell_fields_omitted_when_unset_are_byte_identical() {
    // A vault that never touched spell-check encodes with NO "spell_" key,
    // so it is byte-identical to a pre-MYND-267 vault.prefs.
    let encoded = canonical_json_encode(&PrefsView::default());
    assert!(
        find_subslice(&encoded, b"spell_").is_none(),
        "default prefs must not emit any spell_* key"
    );
}

#[test]
fn spell_enabled_false_round_trips() {
    let original = PrefsView {
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        spell_enabled: Some(false),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded.spell_enabled, Some(false));
}

// ---- show_note_timestamps (sidebar-note-timestamps) ----------------

#[test]
fn encode_omits_show_note_timestamps_when_default() {
    // Default `true` is omit-when-default → a vault that never touched the toggle is
    // byte-identical to a pre-feature vault.prefs (no key emitted).
    let encoded = canonical_json_encode(&PrefsView::default());
    assert!(
        find_subslice(&encoded, b"show_note_timestamps").is_none(),
        "default prefs must not emit the show_note_timestamps key"
    );
}

#[test]
fn encode_emits_show_note_timestamps_false_in_canonical_order() {
    // The non-default `false` IS emitted, immediately after the mandatory
    // screen_capture_protection value (scr < sho < spe).
    let prefs = PrefsView {
        show_note_timestamps: false,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
        encoded.as_slice(),
        br#"{"screen_capture_protection":true,"show_note_timestamps":false}"#
    );
}

#[test]
fn show_note_timestamps_false_round_trips() {
    let original = PrefsView {
        show_note_timestamps: false,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert!(!decoded.show_note_timestamps);
}

// ---- show_task_marker (MYND-613) ----------------------------------

#[test]
fn encode_omits_show_task_marker_when_default() {
    // The default `true` is NOT emitted, so a vault that never touched the
    // toggle stays byte-identical to a pre-MYND-613 vault.prefs — which is
    // what keeps the existing KAT vectors valid.
    let prefs = PrefsView::default();
    let encoded = canonical_json_encode(&prefs);
    assert!(!String::from_utf8_lossy(&encoded).contains("show_task_marker"));
}

#[test]
fn encode_emits_show_task_marker_false_in_canonical_order() {
    // Lexicographic position: after show_note_timestamps (show_n < show_t),
    // before spell_enabled (sho < spe).
    let prefs = PrefsView {
        show_note_timestamps: false,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: false,
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"screen_capture_protection":true,"show_note_timestamps":false,"show_task_marker":false}"#
        );
}

#[test]
fn show_task_marker_false_round_trips() {
    let original = PrefsView {
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: false,
        ..PrefsView::default()
    };
    let decoded = canonical_json_decode(&canonical_json_encode(&original)).expect("decode");
    assert!(!decoded.show_task_marker);
}

#[test]
fn show_task_marker_absent_decodes_to_true() {
    // A pre-MYND-613 blob carries no such key; it must read as shown, not
    // hidden — the omit-when-default rule read backwards.
    let decoded = canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
    assert!(decoded.show_task_marker);
}

// ---- folder_notes_enabled (myne-md/myne#661) ----------------------

#[test]
fn encode_omits_folder_notes_enabled_when_default() {
    // Default is `false` (feature off) and false is NOT emitted, so a vault
    // that never enabled folder notes stays byte-identical to a pre-#661
    // vault.prefs, which keeps the existing KAT vectors valid.
    let prefs = PrefsView::default();
    let encoded = canonical_json_encode(&prefs);
    assert!(!String::from_utf8_lossy(&encoded).contains("folder_notes_enabled"));
}

#[test]
fn encode_emits_folder_notes_enabled_true_in_canonical_order() {
    // Lexicographic position: after folder_icons (folder_i < folder_n),
    // before hidden_bar_items (f < h), before screen_capture_protection.
    let prefs = PrefsView {
        folder_icons: map_of(&[("Projects/", "book")]),
        folder_notes_enabled: true,
        hidden_bar_items: alloc::vec![alloc::string::String::from("graph")],
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"folder_icons":{"Projects/":"book"},"folder_notes_enabled":true,"hidden_bar_items":["graph"],"screen_capture_protection":true}"#
        );
}

#[test]
fn folder_notes_enabled_true_round_trips() {
    let original = PrefsView {
        folder_notes_enabled: true,
        ..PrefsView::default()
    };
    let decoded = canonical_json_decode(&canonical_json_encode(&original)).expect("decode");
    assert!(decoded.folder_notes_enabled);
}

#[test]
fn folder_notes_enabled_absent_decodes_to_false() {
    // A pre-#661 blob carries no such key; it must read as OFF (feature
    // disabled), the omit-when-default rule read backwards.
    let decoded = canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
    assert!(!decoded.folder_notes_enabled);
}

#[test]
fn reminders_enabled_false_round_trips() {
    let original = PrefsView {
        reminders_enabled: false,
        ribbon_items: None,
        ribbon_visible: true,
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    assert_eq!(
        encoded.as_slice(),
        br#"{"reminders_enabled":false,"screen_capture_protection":true}"#
    );
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert!(!decoded.reminders_enabled);
}

#[test]
fn reminders_enabled_absent_decodes_to_true() {
    // A pre-MYND-618 blob carries no such key; it must read as ENABLED, not
    // silenced — the omit-when-default rule read backwards. Silently
    // disabling reminders on every existing vault would be the worst
    // available reading of an absent key.
    let decoded = canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
    assert!(decoded.reminders_enabled);
}

#[test]
fn reminder_horizon_days_round_trips() {
    let original = PrefsView {
        reminder_horizon_days: Some(3),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    assert_eq!(
        encoded.as_slice(),
        br#"{"reminder_horizon_days":3,"screen_capture_protection":true}"#
    );
    assert_eq!(
        canonical_json_decode(&encoded)
            .expect("decode")
            .reminder_horizon_days,
        Some(3)
    );
}

#[test]
fn reminder_horizon_days_absent_decodes_to_none() {
    // `None` means "use the client's built-in horizon", which is what a
    // vault that never touched the setting must get.
    let decoded = canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
    assert_eq!(decoded.reminder_horizon_days, None);
}

#[test]
fn both_reminder_fields_sort_between_paired_extensions_and_right_panel() {
    // The canonical ordering claim, asserted rather than argued: the parser
    // is a sequential prefix matcher, so a field in the wrong position does
    // not merely look untidy — it fails to parse.
    let original = PrefsView {
        reminders_enabled: false,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: Some(14),
        right_panel_active_tab: Some(String::from("backlinks")),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    assert_eq!(
            encoded.as_slice(),
            br#"{"reminder_horizon_days":14,"reminders_enabled":false,"right_panel_active_tab":"backlinks","screen_capture_protection":true}"#
        );
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded.reminder_horizon_days, Some(14));
    assert!(!decoded.reminders_enabled);
    assert_eq!(decoded.right_panel_active_tab.as_deref(), Some("backlinks"));
}

#[test]
fn ribbon_items_none_is_omitted_and_some_round_trips() {
    // `None` (never configured) is omitted so an untouched vault stays
    // byte-identical; `Some(list)` is emitted verbatim (order is payload).
    let none = PrefsView {
        ribbon_items: None,
        ..PrefsView::default()
    };
    assert_eq!(
        canonical_json_encode(&none).as_slice(),
        br#"{"screen_capture_protection":true}"#
    );

    let some = PrefsView {
        ribbon_items: Some(alloc::vec![
            String::from("note.new-tab"),
            String::from("note.open-today"),
        ]),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&some);
    assert_eq!(
        encoded.as_slice(),
        br#"{"ribbon_items":["note.new-tab","note.open-today"],"screen_capture_protection":true}"#
    );
    assert_eq!(
        canonical_json_decode(&encoded)
            .expect("decode")
            .ribbon_items,
        Some(alloc::vec![
            String::from("note.new-tab"),
            String::from("note.open-today"),
        ])
    );
}

#[test]
fn ribbon_items_some_empty_round_trips_as_empty_not_none() {
    // The load-bearing distinction: a deliberately emptied rail must NOT
    // decode back to `None` (which would re-seed the curated defaults).
    let emptied = PrefsView {
        ribbon_items: Some(Vec::new()),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&emptied);
    assert_eq!(
        encoded.as_slice(),
        br#"{"ribbon_items":[],"screen_capture_protection":true}"#
    );
    assert_eq!(
        canonical_json_decode(&encoded)
            .expect("decode")
            .ribbon_items,
        Some(Vec::new())
    );
}

#[test]
fn ribbon_visible_false_round_trips_and_absent_decodes_to_true() {
    let hidden = PrefsView {
        ribbon_visible: false,
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&hidden);
    assert_eq!(
        encoded.as_slice(),
        br#"{"ribbon_visible":false,"screen_capture_protection":true}"#
    );
    assert!(
        !canonical_json_decode(&encoded)
            .expect("decode")
            .ribbon_visible
    );
    // Absent key reads as shown (the default), the omit-when-default rule.
    let decoded = canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
    assert!(decoded.ribbon_visible);
}

#[test]
fn ribbon_fields_sort_between_reminders_and_right_panel() {
    let original = PrefsView {
        reminders_enabled: false,
        ribbon_items: Some(alloc::vec![String::from("palette.toggle")]),
        ribbon_visible: false,
        right_panel_active_tab: Some(String::from("backlinks")),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    assert_eq!(
            encoded.as_slice(),
            br#"{"reminders_enabled":false,"ribbon_items":["palette.toggle"],"ribbon_visible":false,"right_panel_active_tab":"backlinks","screen_capture_protection":true}"#
        );
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(
        decoded.ribbon_items,
        Some(alloc::vec![String::from("palette.toggle")])
    );
    assert!(!decoded.ribbon_visible);
}

#[test]
fn defaults_are_omitted_so_an_untouched_vault_is_byte_identical() {
    // The property the existing KAT vectors depend on: adding two fields
    // must not change one byte of a blob that never set them.
    let encoded = canonical_json_encode(&PrefsView::default());
    assert!(!encoded.windows(b"reminder".len()).any(|w| w == b"reminder"));
}

#[test]
fn show_note_timestamps_absent_decodes_to_true() {
    // The inverted-default proof: a pre-feature blob (no key) decodes to the
    // default `true` (timestamps visible), NOT bool's `false`.
    let decoded = canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
    assert!(decoded.show_note_timestamps);
}

// ---- deliberate_folders canonical array (MYND-144) -----------------

#[test]
fn encode_omits_deliberate_folders_when_empty() {
    // Byte-identical to the v0.1.0 single-field shape → existing vaults +
    // KAT vectors unchanged.
    let encoded = canonical_json_encode(&PrefsView::default());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_emits_sorted_keys_with_nonempty_folders() {
    // Keys sorted: deliberate_folders (d) before screen_capture_protection (s).
    let prefs = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: true,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: alloc::vec![
            alloc::string::String::from("Projects/"),
            alloc::string::String::from("Archive/"),
        ],
        auto_lock_seconds: None,
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
        encoded.as_slice(),
        br#"{"deliberate_folders":["Archive/","Projects/"],"screen_capture_protection":true}"#,
    );
}

#[test]
fn encode_sorts_and_dedupes_folder_elements() {
    let prefs = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: false,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: alloc::vec![
            alloc::string::String::from("b/"),
            alloc::string::String::from("a/"),
            alloc::string::String::from("b/"),
        ],
        auto_lock_seconds: None,
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
        encoded.as_slice(),
        br#"{"deliberate_folders":["a/","b/"],"screen_capture_protection":false}"#,
    );
}

#[test]
fn encode_escapes_quote_in_folder_name() {
    // `"` is allowed in a folder segment (Q5 forbidden set excludes it),
    // so JSON escaping is load-bearing.
    let prefs = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: true,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: alloc::vec![alloc::string::String::from("a\"b/")],
        auto_lock_seconds: None,
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
        encoded.as_slice(),
        br#"{"deliberate_folders":["a\"b/"],"screen_capture_protection":true}"#,
    );
}

#[test]
fn encode_nfc_normalizes_folder_elements() {
    // Decomposed "é" (e + U+0301) → NFC precomposed (U+00E9) at encode.
    let prefs = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: true,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: alloc::vec![alloc::string::String::from("Cafe\u{0301}/")],
        auto_lock_seconds: None,
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
        encoded.as_slice(),
        "{\"deliberate_folders\":[\"Caf\u{00e9}/\"],\"screen_capture_protection\":true}".as_bytes(),
    );
}

#[test]
fn decode_backward_compat_absent_folders_is_empty() {
    // A v0.1.0 blob with no deliberate_folders decodes to an empty list.
    let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
    assert_eq!(
        parsed.deliberate_folders,
        Vec::<alloc::string::String>::new()
    );
    assert!(parsed.screen_capture_protection);
}

#[test]
fn decode_round_trips_nonempty_folders() {
    let parsed = canonical_json_decode(
        br#"{"deliberate_folders":["Archive/","Projects/"],"screen_capture_protection":false}"#,
    )
    .unwrap();
    assert_eq!(
        parsed.deliberate_folders,
        alloc::vec![
            alloc::string::String::from("Archive/"),
            alloc::string::String::from("Projects/"),
        ],
    );
    assert!(!parsed.screen_capture_protection);
}

#[test]
fn decode_unescapes_quote_in_folder_name() {
    let parsed = canonical_json_decode(
        br#"{"deliberate_folders":["a\"b/"],"screen_capture_protection":true}"#,
    )
    .unwrap();
    assert_eq!(
        parsed.deliberate_folders,
        alloc::vec![alloc::string::String::from("a\"b/")],
    );
}

#[test]
fn decode_handles_empty_array() {
    let parsed =
        canonical_json_decode(br#"{"deliberate_folders":[],"screen_capture_protection":true}"#)
            .unwrap();
    assert!(parsed.deliberate_folders.is_empty());
}

#[test]
fn decode_rejects_malformed_folder_array() {
    // Unterminated array → parse failure (caller collapses to defaults).
    let err =
        canonical_json_decode(br#"{"deliberate_folders":["a/","screen_capture_protection":true}"#)
            .unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

#[test]
fn full_blob_round_trip_with_deliberate_folders() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let original = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: false,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: alloc::vec![
            alloc::string::String::from("Projects/Myne/"),
            alloc::string::String::from("Archive/2025/"),
        ],
        auto_lock_seconds: None,
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let blob =
        encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
    // Decoded list is canonical (sorted) — compare against the sorted form.
    assert_eq!(
        decoded.deliberate_folders,
        alloc::vec![
            alloc::string::String::from("Archive/2025/"),
            alloc::string::String::from("Projects/Myne/"),
        ],
    );
    assert!(!decoded.screen_capture_protection);
}

// ---- item_order / favorites canonical arrays (MYND-183) -----------

#[test]
fn encode_omits_order_fields_when_empty() {
    // Empty order lists → byte-identical to the pre-reorder shape.
    let encoded = canonical_json_encode(&PrefsView::default());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_emits_favorites_and_item_order_in_canonical_key_position() {
    // Canonical key order: d < f < i < s. With deliberate_folders,
    // favorites, item_order, and screen_capture_protection all present,
    // favorites sits after deliberate_folders, item_order after
    // favorites, screen_capture_protection last. item_order is
    // HETEROGENEOUS — a folder path interleaved between note UUIDs.
    let prefs = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        field_clocks: Default::default(),
        screen_capture_protection: true,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        deliberate_folders: alloc::vec![alloc::string::String::from("Archive/")],
        auto_lock_seconds: None,
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        favorites: alloc::vec![
            alloc::string::String::from("f2"),
            alloc::string::String::from("f1"),
        ],
        item_order: BTreeMap::from([(
            alloc::string::String::from(""),
            alloc::vec![
                alloc::string::String::from("n1"),
                alloc::string::String::from("Zebra/"),
                alloc::string::String::from("n2"),
            ],
        )]),
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["Archive/"],"favorites":["f2","f1"],"item_order":{"":["n1","Zebra/","n2"]},"screen_capture_protection":true}"#,
        );
}

#[test]
fn encode_preserves_order_does_not_sort_or_dedupe() {
    // item_order is a SEQUENCE: element order is the payload, so the
    // encoder must NOT sort and NOT dedupe (contrast canonical_folder_list
    // which does both). The duplicate "zzz" must survive verbatim.
    let prefs = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: true,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        deliberate_folders: Vec::new(),
        auto_lock_seconds: None,
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        favorites: Vec::new(),
        field_clocks: Default::default(),
        item_order: BTreeMap::from([(
            alloc::string::String::from(""),
            alloc::vec![
                alloc::string::String::from("zzz"),
                alloc::string::String::from("aaa"),
                alloc::string::String::from("mmm"),
                alloc::string::String::from("zzz"),
            ],
        )]),
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
        encoded.as_slice(),
        br#"{"item_order":{"":["zzz","aaa","mmm","zzz"]},"screen_capture_protection":true}"#,
    );
}

#[test]
fn item_order_multi_container_keys_lexicographic_values_ordered() {
    // MYND-596: item_order is a container-keyed map. Container KEYS emit in
    // lexicographic order (root "" first, then "Projects/"), independent of
    // insertion order; each per-container VALUE sequence stays order-
    // preserving (NOT sorted/deduped — the "Projects/" folder sits BETWEEN
    // two notes in the root container). Round-trips verbatim.
    let prefs = PrefsView {
        item_order: BTreeMap::from([
            (
                // Container key is the FOLDED folder key (`projects/`), not
                // the display path — matches the clients' `folderKey`
                // identity so both derive byte-identical keys (MYND-596).
                alloc::string::String::from("projects/"),
                alloc::vec![alloc::string::String::from("Projects/Myne/")],
            ),
            (
                alloc::string::String::from(""),
                alloc::vec![
                    alloc::string::String::from("n2"),
                    alloc::string::String::from("Projects/"),
                    alloc::string::String::from("n1"),
                ],
            ),
        ]),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"item_order":{"":["n2","Projects/","n1"],"projects/":["Projects/Myne/"]},"screen_capture_protection":true}"#,
        );
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded.item_order, prefs.item_order);
}

#[test]
fn decode_round_trips_favorites_and_item_order_preserving_sequence() {
    let parsed = canonical_json_decode(
            br#"{"favorites":["f2","f1"],"item_order":{"":["n1","Zebra/","n2"]},"screen_capture_protection":true}"#,
        )
        .unwrap();
    assert_eq!(
        parsed.favorites,
        alloc::vec![
            alloc::string::String::from("f2"),
            alloc::string::String::from("f1"),
        ],
    );
    assert_eq!(
        parsed.item_order,
        BTreeMap::from([(
            alloc::string::String::from(""),
            alloc::vec![
                alloc::string::String::from("n1"),
                alloc::string::String::from("Zebra/"),
                alloc::string::String::from("n2"),
            ],
        )]),
    );
    assert!(parsed.screen_capture_protection);
}

#[test]
fn decode_absent_order_fields_are_empty() {
    let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
    assert!(parsed.item_order.is_empty());
    assert!(parsed.favorites.is_empty());
}

#[test]
fn full_blob_round_trip_with_all_fields() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let original = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        field_clocks: Default::default(),
        screen_capture_protection: false,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: alloc::vec![
            alloc::string::String::from("graph"),
            alloc::string::String::from("word-count"),
        ],
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        deliberate_folders: alloc::vec![alloc::string::String::from("Projects/")],
        auto_lock_seconds: Some(900),
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        favorites: alloc::vec![alloc::string::String::from(
            "0190a000-0000-7000-8000-000000000002",
        )],
        item_order: BTreeMap::from([(
            alloc::string::String::from(""),
            alloc::vec![
                alloc::string::String::from("0190a000-0000-7000-8000-000000000002"),
                alloc::string::String::from("Projects/"),
                alloc::string::String::from("0190a000-0000-7000-8000-000000000001"),
            ],
        )]),
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let blob =
        encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
    // Sequence fields round-trip VERBATIM; deliberate_folders is canonicalized.
    assert_eq!(original.favorites, decoded.favorites);
    assert_eq!(original.item_order, decoded.item_order);
    assert_eq!(decoded.auto_lock_seconds, Some(900));
    assert!(!decoded.screen_capture_protection);
    // hidden_bar_items is a set field — round-trips canonicalized (sorted).
    assert_eq!(
        decoded.hidden_bar_items,
        alloc::vec![
            alloc::string::String::from("graph"),
            alloc::string::String::from("word-count"),
        ],
    );
}

#[test]
fn encode_places_hidden_bar_items_between_folder_icons_and_item_colors() {
    // Canonical key order: folder_icons (f) < hidden_bar_items (h) <
    // item_colors (i). The set-array is sorted + exact-deduped on encode
    // (graph/word-count out of order + a duplicate collapse to a clean set).
    let prefs = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: true,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: map_of(&[("Projects/", "book")]),
        device_names: Default::default(),
        hidden_bar_items: alloc::vec![
            alloc::string::String::from("word-count"),
            alloc::string::String::from("graph"),
            alloc::string::String::from("graph"),
        ],
        icon: None,
        item_colors: map_of(&[("Projects/", "red")]),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: Vec::new(),
        auto_lock_seconds: None,
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"folder_icons":{"Projects/":"book"},"hidden_bar_items":["graph","word-count"],"item_colors":{"Projects/":"red"},"screen_capture_protection":true}"#,
        );
}

#[test]
fn encode_omits_hidden_bar_items_when_empty() {
    // Empty (the default — bar fully visible) → byte-identical to a pre-feature vault.prefs.
    let encoded = canonical_json_encode(&PrefsView::default());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

// ---- bar_items_order canonical field (MYND bottom-bar reorder) ------

#[test]
fn encode_omits_bar_items_order_when_empty() {
    // Empty (the default — canonical bar order) → byte-identical to a pre-feature vault.prefs.
    let encoded = canonical_json_encode(&PrefsView::default());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_emits_bar_items_order_in_canonical_position() {
    // Canonical key order: auto_lock_seconds (au) < bar_items_order (b) <
    // custom_theme (c) < screen_capture_protection (s). Pin the position
    // between auto_lock_seconds and custom_theme with all three present.
    let prefs = PrefsView {
        auto_lock_seconds: Some(300),
        bar_items_order: alloc::vec!["graph".into(), "tags".into()],
        chat_history_budget: None,
        custom_theme: Some("midnight".into()),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"auto_lock_seconds":300,"bar_items_order":["graph","tags"],"custom_theme":"midnight","screen_capture_protection":true}"#,
        );
}

#[test]
fn bar_items_order_round_trips_verbatim_not_sorted() {
    // Sequence semantics: order is the payload, so a non-sorted input must
    // survive encode→decode VERBATIM (unlike the set-array hidden_bar_items).
    let order: alloc::vec::Vec<String> = alloc::vec![
        "word-count".into(),
        "graph".into(),
        "tags".into(),
        "view-mode".into(),
    ];
    let prefs = PrefsView {
        bar_items_order: order.clone(),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded.bar_items_order, order);
}

// ---- cli_enabled / cli_excluded_folders / cli_rate_limit_disabled
// (myne-cli epic, MYND-490; `cli-thin-client` task 2) ------------------

#[test]
fn cli_enabled_omitted_when_false_emitted_only_when_true() {
    let off = canonical_json_encode(&PrefsView {
        cli_enabled: false,
        ..PrefsView::default()
    });
    assert!(!core::str::from_utf8(&off).unwrap().contains("cli_enabled"));
    let on = canonical_json_encode(&PrefsView {
        cli_enabled: true,
        ..PrefsView::default()
    });
    assert_eq!(
        on.as_slice(),
        br#"{"cli_enabled":true,"screen_capture_protection":true}"#,
    );
}

#[test]
fn cli_excluded_folders_omitted_when_empty_present_when_set() {
    let empty = canonical_json_encode(&PrefsView {
        cli_excluded_folders: Vec::new(),
        ..PrefsView::default()
    });
    assert!(!core::str::from_utf8(&empty)
        .unwrap()
        .contains("cli_excluded_folders"));
    let set = canonical_json_encode(&PrefsView {
        cli_excluded_folders: alloc::vec![alloc::string::String::from("Secret/")],
        ..PrefsView::default()
    });
    assert_eq!(
        set.as_slice(),
        br#"{"cli_excluded_folders":["Secret/"],"screen_capture_protection":true}"#,
    );
}

#[test]
fn cli_excluded_folders_canonicalized_nfc_sorted_deduped() {
    // Same canonical set encoding as ai_excluded_folders / deliberate_folders:
    // NFC-normalized, lexicographically sorted, exact-deduped.
    let nfd_cafe = alloc::string::String::from("Cafe\u{0301}/"); // "Café/" as NFD
    let encoded = canonical_json_encode(&PrefsView {
        cli_excluded_folders: alloc::vec![
            alloc::string::String::from("Zeta/"),
            nfd_cafe,
            alloc::string::String::from("Alpha/"),
            alloc::string::String::from("Alpha/"),
        ],
        ..PrefsView::default()
    });
    assert_eq!(
            encoded.as_slice(),
            "{\"cli_excluded_folders\":[\"Alpha/\",\"Café/\",\"Zeta/\"],\"screen_capture_protection\":true}"
                .as_bytes(),
        );
}

#[test]
fn encode_omits_cli_rate_limit_disabled_when_none_byte_identical_to_pre_feature() {
    let encoded = canonical_json_encode(&PrefsView {
        cli_rate_limit_disabled: None,
        ..PrefsView::default()
    });
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_emits_cli_fields_between_bar_items_order_and_custom_theme() {
    // Canonical key order: bar_items_order (b) < cli_enabled <
    // cli_excluded_folders < cli_rate_limit_disabled < custom_theme (c).
    let encoded = canonical_json_encode(&PrefsView {
        bar_items_order: alloc::vec!["graph".into()],
        cli_enabled: true,
        cli_excluded_folders: alloc::vec![alloc::string::String::from("Work/")],
        cli_rate_limit_disabled: Some(true),
        custom_theme: Some("midnight".into()),
        ..PrefsView::default()
    });
    assert_eq!(
            encoded.as_slice(),
            br#"{"bar_items_order":["graph"],"cli_enabled":true,"cli_excluded_folders":["Work/"],"cli_rate_limit_disabled":true,"custom_theme":"midnight","screen_capture_protection":true}"#,
        );
    // The non-default `false` is persisted explicitly (Some(false) != None).
    let off = canonical_json_encode(&PrefsView {
        cli_rate_limit_disabled: Some(false),
        ..PrefsView::default()
    });
    assert_eq!(
        off.as_slice(),
        br#"{"cli_rate_limit_disabled":false,"screen_capture_protection":true}"#,
    );
}

#[test]
fn cli_fields_round_trip_through_decode() {
    let original = PrefsView {
        bar_items_order: alloc::vec!["tags".into()],
        cli_enabled: true,
        cli_excluded_folders: alloc::vec![
            alloc::string::String::from("Alpha/"),
            alloc::string::String::from("Beta/"),
        ],
        cli_rate_limit_disabled: Some(true),
        custom_theme: Some("midnight".into()),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert_eq!(decoded, original);
}

#[test]
fn cli_fields_default_off_empty_none_when_absent_on_decode() {
    // A pre-feature blob (no cli_* keys) decodes to the defaults — closed
    // door, empty exclusion set, unset rate-limit toggle — spec § 9.5.2
    // forward-compat fall-back.
    let decoded = canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
    assert!(!decoded.cli_enabled);
    assert!(decoded.cli_excluded_folders.is_empty());
    assert_eq!(decoded.cli_rate_limit_disabled, None);
}

#[test]
fn cli_rate_limit_disabled_round_trips_through_decode() {
    for value in [Some(true), Some(false), None] {
        let original = PrefsView {
            cli_rate_limit_disabled: value,
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
        assert_eq!(decoded.cli_rate_limit_disabled, value);
    }
}

// ---- editor toolbar / slash customization (MYND-336) ---------------

#[test]
fn editor_toolbar_slash_customization_round_trips() {
    // order fields are verbatim sequences; hidden fields are sorted+deduped
    // sets (canonical_folder_list), exactly like bar_items_order / hidden_bar_items.
    let prefs = PrefsView {
        editor_toolbar_order: alloc::vec!["link".into(), "bold".into()],
        editor_toolbar_hidden: alloc::vec!["quote".into(), "bold".into(), "quote".into()],
        editor_slash_order: alloc::vec!["table".into()],
        editor_slash_hidden: alloc::vec!["callout".into()],
        ..PrefsView::default()
    };
    let decoded = canonical_json_decode(&canonical_json_encode(&prefs)).expect("decode");
    assert_eq!(decoded.editor_toolbar_order, alloc::vec!["link", "bold"]); // verbatim
    assert_eq!(decoded.editor_slash_order, alloc::vec!["table"]);
    assert_eq!(decoded.editor_toolbar_hidden, alloc::vec!["bold", "quote"]); // sorted+deduped
    assert_eq!(decoded.editor_slash_hidden, alloc::vec!["callout"]);
}

#[test]
fn editor_customization_absent_decodes_to_empty_migration_less() {
    // A default (un-customized) vault.prefs OMITS all four keys — byte-
    // identical to a pre-MYND-336 blob — and decodes with them empty.
    let bytes = canonical_json_encode(&PrefsView::default());
    let s = alloc::string::String::from_utf8(bytes.clone()).unwrap();
    assert!(!s.contains("editor_toolbar"), "omitted when empty: {s}");
    assert!(!s.contains("editor_slash"), "omitted when empty: {s}");
    let decoded = canonical_json_decode(&bytes).expect("decode");
    assert!(decoded.editor_toolbar_order.is_empty());
    assert!(decoded.editor_toolbar_hidden.is_empty());
    assert!(decoded.editor_slash_order.is_empty());
    assert!(decoded.editor_slash_hidden.is_empty());
}

#[test]
fn editor_customization_canonical_key_positions() {
    // editor_slash_* < editor_text_size < editor_toolbar_* in canonical order.
    let prefs = PrefsView {
        editor_text_size: Some("large".into()),
        editor_slash_order: alloc::vec!["a".into()],
        editor_toolbar_order: alloc::vec!["b".into()],
        ..PrefsView::default()
    };
    let s = alloc::string::String::from_utf8(canonical_json_encode(&prefs)).unwrap();
    let slash = s.find("editor_slash_order").unwrap();
    let text = s.find("editor_text_size").unwrap();
    let toolbar = s.find("editor_toolbar_order").unwrap();
    assert!(
        slash < text && text < toolbar,
        "canonical order violated: {s}"
    );
}

// ---- auto_lock_seconds canonical field (MYND-121) -----------------

#[test]
fn encode_omits_auto_lock_seconds_when_none() {
    // None → byte-identical to a pre-MYND-121 vault.prefs (preserves
    // existing KAT vectors + existing vaults).
    let encoded = canonical_json_encode(&PrefsView::default());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_emits_auto_lock_seconds_first_in_canonical_order() {
    // Canonical key order: auto_lock_seconds (a) < screen_capture_protection (s).
    let prefs = PrefsView {
        chat_history_budget: None,
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: true,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: Vec::new(),
        auto_lock_seconds: Some(300),
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
        encoded.as_slice(),
        br#"{"auto_lock_seconds":300,"screen_capture_protection":true}"#,
    );
}

#[test]
fn encode_emits_all_three_fields_in_canonical_order() {
    // a < d < s: auto_lock_seconds, deliberate_folders, screen_capture_protection.
    let prefs = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: false,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: alloc::vec![alloc::string::String::from("Archive/")],
        auto_lock_seconds: Some(900),
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"auto_lock_seconds":900,"deliberate_folders":["Archive/"],"screen_capture_protection":false}"#,
        );
}

#[test]
fn encode_auto_lock_seconds_zero_has_no_leading_zeros() {
    // Sentinel-shaped 0 encodes as the canonical "0" (no leading zeros,
    // no trailing ".0"). The clamp/always-on policy lives in the Tauri
    // layer; the codec faithfully persists whatever integer it is given.
    let prefs = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: true,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: Vec::new(),
        auto_lock_seconds: Some(0),
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
        encoded.as_slice(),
        br#"{"auto_lock_seconds":0,"screen_capture_protection":true}"#,
    );
}

#[test]
fn decode_round_trips_auto_lock_seconds() {
    let parsed =
        canonical_json_decode(br#"{"auto_lock_seconds":900,"screen_capture_protection":false}"#)
            .unwrap();
    assert_eq!(parsed.auto_lock_seconds, Some(900));
    assert!(!parsed.screen_capture_protection);
}

#[test]
fn decode_absent_auto_lock_seconds_is_none() {
    // Acceptance: absent key decodes to "no value" (not an error).
    let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
    assert_eq!(parsed.auto_lock_seconds, None);
}

#[test]
fn decode_auto_lock_seconds_with_folders_and_scp() {
    let parsed = canonical_json_decode(
            br#"{"auto_lock_seconds":1800,"deliberate_folders":["Archive/"],"screen_capture_protection":true}"#,
        )
        .unwrap();
    assert_eq!(parsed.auto_lock_seconds, Some(1800));
    assert_eq!(
        parsed.deliberate_folders,
        alloc::vec![alloc::string::String::from("Archive/")]
    );
    assert!(parsed.screen_capture_protection);
}

#[test]
fn decode_rejects_float_auto_lock_seconds() {
    // Spec § 9.5.2: floats FORBIDDEN. `300.5` parses `300` then hits `.`
    // instead of the required `,` → reject.
    let err =
        canonical_json_decode(br#"{"auto_lock_seconds":300.5,"screen_capture_protection":true}"#)
            .unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

#[test]
fn decode_rejects_non_numeric_auto_lock_seconds() {
    let err =
        canonical_json_decode(br#"{"auto_lock_seconds":abc,"screen_capture_protection":true}"#)
            .unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

#[test]
fn decode_rejects_empty_auto_lock_seconds() {
    let err = canonical_json_decode(br#"{"auto_lock_seconds":,"screen_capture_protection":true}"#)
        .unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

#[test]
fn decode_rejects_overflow_auto_lock_seconds() {
    // 99999999999 > u32::MAX → checked_mul/add overflow → reject.
    let err = canonical_json_decode(
        br#"{"auto_lock_seconds":99999999999,"screen_capture_protection":true}"#,
    )
    .unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

#[test]
fn full_blob_round_trip_with_auto_lock_seconds() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let original = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: true,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: alloc::vec![alloc::string::String::from("Projects/")],
        auto_lock_seconds: Some(1800),
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let blob =
        encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
    assert_eq!(decoded.auto_lock_seconds, Some(1800));
    assert!(decoded.screen_capture_protection);
    assert_eq!(
        decoded.deliberate_folders,
        alloc::vec![alloc::string::String::from("Projects/")]
    );
}

#[test]
fn auto_lock_seconds_none_round_trips_through_full_blob() {
    // Default (None) survives a full encode/decode unchanged.
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let original = PrefsView::default();
    let blob =
        encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
    assert_eq!(decoded.auto_lock_seconds, None);
    assert_eq!(original, decoded);
}

// ---- editor_layout nested object (MYND-137) ------------------------

fn sample_layout() -> EditorLayout {
    EditorLayout {
        left_width: 312,
        right_width: 288,
        left_collapsed: false,
        right_collapsed: true,
    }
}

#[test]
fn encode_omits_editor_layout_when_none() {
    // None → byte-identical to the pre-MYND-137 shape (preserves
    // existing vaults + KAT vectors).
    let encoded = canonical_json_encode(&PrefsView::default());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn encode_emits_editor_layout_in_canonical_key_position() {
    // Canonical top-level key order: d < e < f < i < s. With
    // deliberate_folders, editor_layout, favorites, item_order, and
    // screen_capture_protection all present, editor_layout sits between
    // deliberate_folders and favorites. Nested keys are themselves in
    // canonical order: left_collapsed < left_width < right_collapsed <
    // right_width.
    let prefs = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: true,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        archived_folders: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        deliberate_folders: alloc::vec![alloc::string::String::from("Archive/")],
        auto_lock_seconds: None,
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        favorites: alloc::vec![alloc::string::String::from("f1")],
        field_clocks: Default::default(),
        item_order: BTreeMap::from([(
            alloc::string::String::from(""),
            alloc::vec![alloc::string::String::from("n1")],
        )]),
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        editor_layout: Some(sample_layout()),
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["Archive/"],"editor_layout":{"left_collapsed":false,"left_width":312,"right_collapsed":true,"right_width":288},"favorites":["f1"],"item_order":{"":["n1"]},"screen_capture_protection":true}"#,
        );
}

#[test]
fn encode_editor_layout_alone_with_scp() {
    let prefs = PrefsView {
        editor_layout: Some(EditorLayout {
            left_width: 260,
            right_width: 280,
            left_collapsed: false,
            right_collapsed: false,
        }),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"editor_layout":{"left_collapsed":false,"left_width":260,"right_collapsed":false,"right_width":280},"screen_capture_protection":true}"#,
        );
}

#[test]
fn decode_round_trips_editor_layout() {
    let parsed = canonical_json_decode(
            br#"{"editor_layout":{"left_collapsed":true,"left_width":200,"right_collapsed":false,"right_width":460},"screen_capture_protection":true}"#,
        )
        .unwrap();
    assert_eq!(
        parsed.editor_layout,
        Some(EditorLayout {
            left_width: 200,
            right_width: 460,
            left_collapsed: true,
            right_collapsed: false,
        })
    );
}

#[test]
fn decode_absent_editor_layout_is_none() {
    let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
    assert_eq!(parsed.editor_layout, None);
}

#[test]
fn decode_rejects_float_editor_layout_width() {
    // Spec § 9.5.2: floats FORBIDDEN. `left_width":260.5` parses 260 then
    // hits `.` instead of the required `,` → reject.
    let err = canonical_json_decode(
            br#"{"editor_layout":{"left_collapsed":false,"left_width":260.5,"right_collapsed":false,"right_width":280},"screen_capture_protection":true}"#,
        )
        .unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

#[test]
fn decode_rejects_editor_layout_with_wrong_key_order() {
    // Non-canonical nested key order rejects (the writer is always
    // canonical; a deviation is corruption → fall-back-to-defaults).
    let err = canonical_json_decode(
            br#"{"editor_layout":{"left_width":260,"left_collapsed":false,"right_collapsed":false,"right_width":280},"screen_capture_protection":true}"#,
        )
        .unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

#[test]
fn decode_rejects_editor_layout_missing_field() {
    let err = canonical_json_decode(
            br#"{"editor_layout":{"left_collapsed":false,"left_width":260,"right_collapsed":false},"screen_capture_protection":true}"#,
        )
        .unwrap_err();
    assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
}

#[test]
fn full_blob_round_trip_with_editor_layout() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let original = PrefsView {
        editor_layout: Some(sample_layout()),
        ..PrefsView::default()
    };
    let blob =
        encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
    assert_eq!(original, decoded);
    assert_eq!(decoded.editor_layout, Some(sample_layout()));
}

#[test]
fn editor_layout_none_round_trips_through_full_blob() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let original = PrefsView::default();
    let blob =
        encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
    assert_eq!(decoded.editor_layout, None);
    assert_eq!(original, decoded);
}

#[test]
fn decode_editor_layout_coexists_with_all_other_fields() {
    // Full field-mix smoke: a < d < e < f < i < s all present, parsed
    // through the monotonic cursor without cross-field marker confusion.
    let parsed = canonical_json_decode(
            br#"{"auto_lock_seconds":900,"deliberate_folders":["Archive/"],"editor_layout":{"left_collapsed":false,"left_width":320,"right_collapsed":true,"right_width":300},"favorites":["f1"],"item_order":{"":["n2","n1"]},"screen_capture_protection":false}"#,
        )
        .unwrap();
    assert_eq!(parsed.auto_lock_seconds, Some(900));
    assert_eq!(
        parsed.deliberate_folders,
        alloc::vec![alloc::string::String::from("Archive/")]
    );
    assert_eq!(
        parsed.editor_layout,
        Some(EditorLayout {
            left_width: 320,
            right_width: 300,
            left_collapsed: false,
            right_collapsed: true,
        })
    );
    assert_eq!(
        parsed.favorites,
        alloc::vec![alloc::string::String::from("f1")]
    );
    assert_eq!(
        parsed.item_order,
        BTreeMap::from([(
            alloc::string::String::from(""),
            alloc::vec![
                alloc::string::String::from("n2"),
                alloc::string::String::from("n1"),
            ],
        )])
    );
    assert!(!parsed.screen_capture_protection);
}

// ---- outer envelope structural tests -------------------------------

#[test]
fn encode_emits_myp1_magic_at_offset_0() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let blob = encode_prefs_blob_raw(
        &prefs_key,
        &fixed_account_number_hash(),
        &PrefsView::default(),
        &fixed_prefs_nonce(),
    )
    .unwrap();
    assert_eq!(&blob[0..4], b"MYP1");
}

#[test]
fn encode_emits_protocol_version_0x01_at_offset_4() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let blob = encode_prefs_blob_raw(
        &prefs_key,
        &fixed_account_number_hash(),
        &PrefsView::default(),
        &fixed_prefs_nonce(),
    )
    .unwrap();
    assert_eq!(blob[4], 0x01);
}

#[test]
fn encode_emits_reserved_0x00_at_offset_5() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let blob = encode_prefs_blob_raw(
        &prefs_key,
        &fixed_account_number_hash(),
        &PrefsView::default(),
        &fixed_prefs_nonce(),
    )
    .unwrap();
    assert_eq!(blob[5], 0x00);
}

#[test]
fn encode_emits_prefs_nonce_at_offset_6() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let nonce = fixed_prefs_nonce();
    let blob = encode_prefs_blob_raw(
        &prefs_key,
        &fixed_account_number_hash(),
        &PrefsView::default(),
        &nonce,
    )
    .unwrap();
    assert_eq!(&blob[6..30], &nonce[..]);
}

#[test]
fn encode_emits_ciphertext_len_big_endian_at_offset_30() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let blob = encode_prefs_blob_raw(
        &prefs_key,
        &fixed_account_number_hash(),
        &PrefsView::default(),
        &fixed_prefs_nonce(),
    )
    .unwrap();
    let len_bytes = [blob[30], blob[31], blob[32], blob[33]];
    let ciphertext_len = u32::from_be_bytes(len_bytes) as usize;
    // Default plaintext: {"screen_capture_protection":true} = 34 bytes;
    // ciphertext_len = 34 + 32 (CTX tag) = 66.
    assert_eq!(ciphertext_len, 34 + CTX_COMMITMENT_TAG_LEN);
    assert_eq!(blob.len(), PREFS_BLOB_HEADER_LEN + ciphertext_len);
}

// ---- round-trip ----------------------------------------------------

#[test]
fn round_trip_default_prefs() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let original = PrefsView::default();
    let blob =
        encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
    assert_eq!(original, decoded);
}

#[test]
fn round_trip_toggled_off() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let original = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: false,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: Vec::new(),
        auto_lock_seconds: None,
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let blob =
        encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
    assert_eq!(original, decoded);
}

#[test]
fn round_trip_via_getrandom_convenience() {
    // `encode_prefs_blob` pulls a random nonce; round-trip still
    // holds because the decoder reads the nonce from the header.
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let original = PrefsView {
        attachment_compression_enabled: true,
        developer_mode: false,
        attachment_ocr_enabled: true,
        time_format: None,
        timezone: None,
        transcription_enabled: true,
        screen_capture_protection: false,
        folder_notes_enabled: false,
        bar_items_order: Vec::new(),
        chat_history_budget: None,
        cli_enabled: false,
        cli_excluded_folders: Vec::new(),
        cli_rate_limit_disabled: None,
        color_groups: Vec::new(),
        show_note_timestamps: true,
        reminders_enabled: true,
        ribbon_items: None,
        ribbon_visible: true,
        reminder_horizon_days: None,
        show_task_marker: true,
        folder_icons: Default::default(),
        device_names: Default::default(),
        hidden_bar_items: Vec::new(),
        icon: None,
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        item_order: Default::default(),
        favorites: Vec::new(),
        field_clocks: Default::default(),
        deliberate_folders: Vec::new(),
        auto_lock_seconds: None,
        auto_tag_enabled: false,
        custom_theme: None,
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        active_workspace: None,
        ai_enabled: false,
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archive_disabled: None,
        archived_folders: Vec::new(),
        editor_layout: None,
        editor_line_numbers: None,
        editor_content_width: None,
        editor_default_view_mode: None,
        editor_focus_dim_inactive: None,
        editor_focus_typewriter: None,
        editor_font_family: None,
        editor_line_spacing: None,
        editor_text_size: None,
        editor_vim_mode: None,
        label: None,
        last_backup_at: None,
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: None,
        new_note_location_folder: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        startup_open: None,
        startup_open_note: None,
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let blob = encode_prefs_blob(&prefs_key, &account_hash, &original).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
    assert_eq!(original, decoded);
}

// ---- structural rejection ------------------------------------------

#[test]
fn decode_rejects_short_blob_with_header_too_short() {
    let prefs_key = [0u8; AEAD_KEY_LEN];
    let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &[0u8; 33]).unwrap_err();
    assert_eq!(err, PrefsBlobError::HeaderTooShort);
}

#[test]
fn decode_rejects_wrong_magic() {
    let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
    blob[..4].copy_from_slice(b"MY01"); // .myn magic, not MYP1
    blob[4] = 0x01;
    blob[5] = 0x00;
    let prefs_key = [0u8; AEAD_KEY_LEN];
    let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
    assert_eq!(err, PrefsBlobError::MagicMismatch);
}

#[test]
fn decode_rejects_wrong_protocol_version() {
    let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
    blob[..4].copy_from_slice(&PREFS_BLOB_MAGIC);
    blob[4] = 0x02; // bogus protocol_version
    blob[5] = 0x00;
    let prefs_key = [0u8; AEAD_KEY_LEN];
    let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
    assert_eq!(err, PrefsBlobError::ProtocolVersionMismatch);
}

#[test]
fn decode_rejects_nonzero_reserved_byte() {
    let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
    blob[..4].copy_from_slice(&PREFS_BLOB_MAGIC);
    blob[4] = 0x01;
    blob[5] = 0x01; // reserved byte non-zero
    let prefs_key = [0u8; AEAD_KEY_LEN];
    let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
    assert_eq!(err, PrefsBlobError::ReservedByteNonZero);
}

#[test]
fn decode_rejects_oversize_ciphertext_len() {
    let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
    blob[..4].copy_from_slice(&PREFS_BLOB_MAGIC);
    blob[4] = 0x01;
    blob[5] = 0x00;
    // Set ciphertext_len to 0xFFFFFFFF (4 GiB)
    blob[30..34].copy_from_slice(&u32::MAX.to_be_bytes());
    let prefs_key = [0u8; AEAD_KEY_LEN];
    let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
    assert_eq!(err, PrefsBlobError::CiphertextLenOverflow);
}

#[test]
fn decode_rejects_truncated_blob_with_ciphertext_len_present_but_bytes_missing() {
    let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
    blob[..4].copy_from_slice(&PREFS_BLOB_MAGIC);
    blob[4] = 0x01;
    blob[5] = 0x00;
    // Advertise 100 bytes of ciphertext but provide none
    blob[30..34].copy_from_slice(&100u32.to_be_bytes());
    let prefs_key = [0u8; AEAD_KEY_LEN];
    let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
    assert_eq!(err, PrefsBlobError::CiphertextTruncated);
}

// ---- AEAD non-distinguishing failure (spec § 6.4 + § 9.5.5) -------

#[test]
fn decode_rejects_with_wrong_key_as_cannot_decrypt() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let blob = encode_prefs_blob_raw(
        &prefs_key,
        &account_hash,
        &PrefsView::default(),
        &fixed_prefs_nonce(),
    )
    .unwrap();

    // Wrong root_key → wrong prefs_key
    let mut wrong_root = [0u8; 32];
    wrong_root[0] = 1;
    let wrong_prefs_key = derive_subkey(&wrong_root, SubkeyRole::PrefsKey);

    let err = decode_prefs_blob(&wrong_prefs_key, &account_hash, &blob).unwrap_err();
    assert_eq!(err, PrefsBlobError::CannotDecrypt);
}

#[test]
fn decode_rejects_with_wrong_account_number_hash_as_cannot_decrypt() {
    // Cross-vault scenario: vault A's blob + vault B's
    // account_number_hash → AAD mismatch → AEAD fails.
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let blob = encode_prefs_blob_raw(
        &prefs_key,
        &fixed_account_number_hash(),
        &PrefsView::default(),
        &fixed_prefs_nonce(),
    )
    .unwrap();

    let mut wrong_account_hash = fixed_account_number_hash();
    wrong_account_hash[0] = wrong_account_hash[0].wrapping_add(1);

    let err = decode_prefs_blob(&prefs_key, &wrong_account_hash, &blob).unwrap_err();
    assert_eq!(err, PrefsBlobError::CannotDecrypt);
}

#[test]
fn decode_rejects_with_tampered_ciphertext_as_cannot_decrypt() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let mut blob = encode_prefs_blob_raw(
        &prefs_key,
        &account_hash,
        &PrefsView::default(),
        &fixed_prefs_nonce(),
    )
    .unwrap();

    // Flip one byte in the ciphertext region (header is 34 bytes;
    // ciphertext starts at offset 34).
    blob[40] ^= 0xFF;

    let err = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap_err();
    assert_eq!(err, PrefsBlobError::CannotDecrypt);
}

#[test]
fn decode_rejects_with_tampered_ctx_tag_as_cannot_decrypt() {
    let root_key = fixed_root_key();
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    let account_hash = fixed_account_number_hash();
    let mut blob = encode_prefs_blob_raw(
        &prefs_key,
        &account_hash,
        &PrefsView::default(),
        &fixed_prefs_nonce(),
    )
    .unwrap();

    // Flip a byte in the trailing CTX commitment tag (last 32 bytes).
    let last = blob.len() - 1;
    blob[last] ^= 0xFF;

    let err = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap_err();
    assert_eq!(err, PrefsBlobError::CannotDecrypt);
}

// ---- PrefsView default semantic (spec § 9.5.5) --------------------

#[test]
fn default_prefs_view_has_screen_capture_protection_on() {
    // Spec § 9.5.5 fall-back-to-defaults: defaults to the safer
    // state (protection on) for missing / corrupt vault.prefs.
    assert!(PrefsView::default().screen_capture_protection);
}

// ---- KAT vector regenerator (companion repo) ----------------------

/// Emits hex dumps for the 5 KAT cases consumed by
/// `myne-test-vectors/vectors/vault-prefs/v0.1/cases.json`. Output
/// is written to `/tmp/myne_vault_prefs_vectors.txt`, ready for
/// paste into the companion repo's JSON file.
///
/// `#[ignore]` because regenerating vectors should be a deliberate
/// act, not a side effect of `cargo test`. Run with:
/// `cargo test -p protocol --lib emit_prefs_vectors_for_paste -- --ignored`
///
/// The 6 cases pin (per MYND-160 grill Q6.2 + MYND-183):
/// - `encrypt-default`: PrefsView { screen_capture_protection: true } → expected blob bytes
/// - `encrypt-toggled`: PrefsView { screen_capture_protection: false } → expected blob bytes
/// - `decrypt-default`: golden blob → expected plaintext + struct (round-trip with encrypt-default)
/// - `decrypt-cross-vault`: vault-A blob + vault-B root_key → expected AeadFail
/// - `decrypt-tampered`: vault-A blob with one ciphertext byte flipped → expected AeadFail
/// - `encrypt-populated` (MYND-183): all fields incl. heterogeneous
///   `item_order` (note UUIDs + folder paths interleaved) + `favorites` →
///   expected blob bytes; canonical plaintext computed to self-validate key order
///
/// (The MYND-184/185 decoration-maps vector is emitted separately by
/// [`emit_decorations_prefs_vector`] to keep this generator stable.)
#[test]
#[ignore]
fn emit_decorations_prefs_vector() {
    extern crate std;

    // Vault A — same fixed inputs as the sibling generator, distinct nonce
    // (0xCC×24) so the decorations blob diverges from every other case.
    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
    let nonce: [u8; AEAD_NONCE_LEN] = [0xCC; AEAD_NONCE_LEN];

    let mut folder_icons = BTreeMap::new();
    folder_icons.insert(String::from("Archive/2025/"), String::from("archive"));
    folder_icons.insert(String::from("Projects/Myne/"), String::from("book"));
    let mut item_colors = BTreeMap::new();
    item_colors.insert(
        String::from("0190a000-0000-7000-8000-000000000001"),
        String::from("moss"),
    );
    item_colors.insert(String::from("Projects/Myne/"), String::from("slate"));

    let prefs = PrefsView {
        folder_icons,
        folder_notes_enabled: false,
        item_colors,
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs);
    let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
        .expect("encode decorations");
    // Self-validate the round-trip before emitting.
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
    assert_eq!(decoded, prefs);

    let mut dump = alloc::string::String::new();
    dump.push_str("\n---begin decorations vector---\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "prefs_key_hex: {}\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_str: {}\n",
        std::string::String::from_utf8_lossy(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n",
        hex_lower(&blob)
    ));
    dump.push_str("---end decorations vector---\n");
    std::println!("{dump}");
}

#[test]
#[ignore]
fn emit_prefs_vectors_for_paste() {
    extern crate std;

    // Vault A — canonical case.
    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
    let nonce_default: [u8; AEAD_NONCE_LEN] = [0x77; AEAD_NONCE_LEN];
    let nonce_toggled: [u8; AEAD_NONCE_LEN] = [0x88; AEAD_NONCE_LEN];

    // Vault B — used for cross-vault decrypt failure.
    let root_b: [u8; 32] = [0xAB; 32];
    let prefs_key_b = derive_subkey(&root_b, SubkeyRole::PrefsKey);
    let account_hash_b: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0xCD; PREFS_BLOB_ACCOUNT_HASH_LEN];

    let blob_default = encode_prefs_blob_raw(
        &prefs_key_a,
        &account_hash_a,
        &PrefsView {
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: true,
            folder_notes_enabled: false,
            bar_items_order: Vec::new(),
            chat_history_budget: None,
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            icon: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archived_folders: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            ribbon_items: None,
            ribbon_visible: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            archive_disabled: None,
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            mcp_connections: Default::default(),
            mcp_write_requests: Default::default(),
            meeting_ai_prompt: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            periodic_notes: Default::default(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            opaque_saved_views: Vec::new(),
            view_approvals: Default::default(),
            view_order: Vec::new(),
        },
        &nonce_default,
    )
    .expect("encode default");

    let blob_toggled = encode_prefs_blob_raw(
        &prefs_key_a,
        &account_hash_a,
        &PrefsView {
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: false,
            folder_notes_enabled: false,
            bar_items_order: Vec::new(),
            chat_history_budget: None,
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            icon: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archived_folders: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            ribbon_items: None,
            ribbon_visible: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            archive_disabled: None,
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            mcp_connections: Default::default(),
            mcp_write_requests: Default::default(),
            meeting_ai_prompt: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            periodic_notes: Default::default(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            opaque_saved_views: Vec::new(),
            view_approvals: Default::default(),
            view_order: Vec::new(),
        },
        &nonce_toggled,
    )
    .expect("encode toggled");

    // Fully-populated case (MYND-183): heterogeneous item_order (note UUIDs
    // + folder paths interleaved) + favorites + every other field, matching
    // the spec § 9.5.2 worked example. The canonical plaintext is COMPUTED
    // (not hardcoded) so the generator self-validates the canonical key
    // order + sequence discipline before emitting.
    // MYND-596 + coverage backfill: this "fully-populated" case now sets
    // every previously-unvectored field to a NON-default value, so the
    // golden vectors exercise the canonical slot, the inverse-default emit
    // polarity (the six default-`true` bools emitted only when `false`), and
    // the set-vs-sequence array discipline for each. `canonical_json_encode`
    // self-validates the key order + discipline at mint (round-trip below).
    let prefs_populated = PrefsView {
        // A populated value, so this vector exercises the encoder arm as
        // well as the field's presence (myne-md/myne#617).
        // inverse-default bools (default true → emitted only when false)
        attachment_compression_enabled: false,
        attachment_ocr_enabled: false,
        time_format: None,
        timezone: None,
        transcription_enabled: false,
        show_note_timestamps: false,
        reminders_enabled: false,
        ribbon_items: None,
        ribbon_visible: true,
        show_task_marker: false,
        // positive-opt-in bools
        developer_mode: true,
        cli_enabled: true,
        ai_enabled: false,
        field_clocks: Default::default(),
        screen_capture_protection: true,
        folder_notes_enabled: false,
        // sequence array (order preserved verbatim)
        bar_items_order: alloc::vec![
            alloc::string::String::from("view-mode"),
            alloc::string::String::from("tags"),
            alloc::string::String::from("graph"),
        ],
        chat_history_budget: Some(3000),
        // set array (sorted + deduped)
        cli_excluded_folders: alloc::vec![alloc::string::String::from("Private/")],
        cli_rate_limit_disabled: Some(true),
        // color_groups: one enabled hasTag rule — pins the canonical slot
        // (bar_items_order < color_groups < custom_theme) inside vault.prefs;
        // the array codec itself is pinned by the color-group category.
        color_groups: alloc::vec![crate::color_group::ColorGroup {
            id: alloc::string::String::from("0190a000-0000-7000-8000-000000000007"),
            name: alloc::string::String::from("Work"),
            color: alloc::string::String::from("moss"),
            enabled: true,
            filter: crate::saved_view::FilterNode::HasTag {
                tag: alloc::string::String::from("work"),
            },
        }],
        ai_excluded_folders: Vec::new(),
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        archived_folders: Vec::new(),
        reminder_horizon_days: Some(7),
        folder_icons: Default::default(),
        device_names: Default::default(),
        // set array (sorted + deduped) — the bottom-bar hidden set
        hidden_bar_items: alloc::vec![
            alloc::string::String::from("graph"),
            alloc::string::String::from("word-count"),
        ],
        icon: Some(alloc::string::String::from("book")),
        item_colors: Default::default(),
        keymap: Default::default(),
        theme: None,
        deliberate_folders: alloc::vec![
            alloc::string::String::from("Archive/2025/"),
            alloc::string::String::from("Projects/Myne/"),
        ],
        auto_lock_seconds: Some(300),
        auto_tag_enabled: false,
        custom_theme: Some(alloc::string::String::from("solarized-dark")),
        daily_date_format: None,
        daily_folder: None,
        daily_template: None,
        date_format: None,
        favorites: alloc::vec![alloc::string::String::from(
            "0190a000-0000-7000-8000-000000000002",
        )],
        // MYND-596 container-keyed: the root container interleaves a note,
        // the "Projects/" folder, and another note; "Projects/" then orders
        // its own child sub-folder. Keys emit in lexicographic order
        // ("" < "Projects/"); each value sequence is order-preserving.
        item_order: BTreeMap::from([
            (
                alloc::string::String::from(""),
                alloc::vec![
                    alloc::string::String::from("0190a000-0000-7000-8000-000000000002"),
                    alloc::string::String::from("Projects/"),
                    alloc::string::String::from("0190a000-0000-7000-8000-000000000001"),
                ],
            ),
            (
                // Container key is the FOLDED folder key (`projects/`), not
                // the display path — matches the clients' `folderKey`
                // identity so both derive byte-identical keys (MYND-596).
                alloc::string::String::from("projects/"),
                alloc::vec![alloc::string::String::from("Projects/Myne/")],
            ),
        ]),
        active_workspace: Some(alloc::string::String::from(
            "0190a000-0000-7000-8000-0000000000ff",
        )),
        archive_disabled: None,
        editor_layout: Some(EditorLayout {
            left_width: 312,
            right_width: 288,
            left_collapsed: false,
            right_collapsed: true,
        }),
        editor_line_numbers: Some(true),
        editor_content_width: Some(alloc::string::String::from("wide")),
        editor_default_view_mode: Some(alloc::string::String::from("reading")),
        editor_focus_dim_inactive: Some(true),
        editor_focus_typewriter: Some(false),
        editor_font_family: Some(alloc::string::String::from("sans")),
        editor_line_spacing: Some(alloc::string::String::from("relaxed")),
        editor_text_size: Some(alloc::string::String::from("lg")),
        editor_vim_mode: Some(true),
        label: Some(alloc::string::String::from("Work")),
        last_backup_at: Some(1765432100),
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        new_note_location: Some(alloc::string::String::from("specific")),
        new_note_location_folder: Some(alloc::string::String::from("Inbox/")),
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: Some(alloc::string::String::from("backlinks")),
        // set array (sorted + deduped)
        right_panel_hidden_tabs: alloc::vec![alloc::string::String::from("outline")],
        // sequence array (order preserved verbatim)
        right_panel_tab_order: alloc::vec![
            alloc::string::String::from("backlinks"),
            alloc::string::String::from("unlinked"),
            alloc::string::String::from("outline"),
        ],
        // set arrays (sorted + deduped)
        editor_slash_hidden: alloc::vec![
            alloc::string::String::from("callout"),
            alloc::string::String::from("table"),
        ],
        editor_toolbar_hidden: alloc::vec![
            alloc::string::String::from("quote"),
            alloc::string::String::from("wikilink"),
        ],
        // sequence arrays (order preserved verbatim)
        editor_slash_order: alloc::vec![
            alloc::string::String::from("h1"),
            alloc::string::String::from("todo"),
            alloc::string::String::from("divider"),
        ],
        editor_toolbar_order: alloc::vec![
            alloc::string::String::from("bold"),
            alloc::string::String::from("italic"),
            alloc::string::String::from("link"),
            alloc::string::String::from("heading"),
        ],
        spell_enabled: Some(true),
        // set array (sorted + deduped)
        spell_languages: alloc::vec![
            alloc::string::String::from("en-US"),
            alloc::string::String::from("tr-TR"),
        ],
        startup_open: Some(alloc::string::String::from("specific")),
        startup_open_note: Some(alloc::string::String::from(
            "0190a000-0000-7000-8000-000000000006",
        )),
        saved_views: Vec::new(),
        opaque_saved_views: Vec::new(),
        view_approvals: Default::default(),
        view_order: Vec::new(),
    };
    let nonce_populated: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];
    let canonical_populated = canonical_json_encode(&prefs_populated);
    let blob_populated = encode_prefs_blob_raw(
        &prefs_key_a,
        &account_hash_a,
        &prefs_populated,
        &nonce_populated,
    )
    .expect("encode populated");

    // Themed case (MYND-110): screen_capture_protection=true + an explicit
    // theme=dark. Distinct nonce (0xAA×24). theme is canonical key LAST.
    let prefs_themed = PrefsView {
        theme: Some(ThemeChoice::Dark),
        ..PrefsView::default()
    };
    let nonce_themed: [u8; AEAD_NONCE_LEN] = [0xAA; AEAD_NONCE_LEN];
    let canonical_themed = canonical_json_encode(&prefs_themed);
    let blob_themed =
        encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_themed, &nonce_themed)
            .expect("encode themed");

    // Tampered blob: flip one byte in the ciphertext region (header
    // is 34 bytes; ciphertext starts at offset 34).
    let mut blob_tampered = blob_default.clone();
    blob_tampered[40] ^= 0xFF;

    let canonical_default = b"{\"screen_capture_protection\":true}";
    let canonical_toggled = b"{\"screen_capture_protection\":false}";

    let mut dump = alloc::string::String::new();
    dump.push_str("---begin prefs vectors---\n\n");

    dump.push_str("# case 1/5: encrypt-default (toggle=true)\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "prefs_key_hex (informational): {}\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(canonical_default)
    ));
    dump.push_str(&alloc::format!(
        "prefs_nonce_hex: {}\n",
        hex_lower(&nonce_default)
    ));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n\n",
        hex_lower(&blob_default)
    ));

    dump.push_str("# case 2/5: encrypt-toggled (toggle=false)\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(canonical_toggled)
    ));
    dump.push_str(&alloc::format!(
        "prefs_nonce_hex: {}\n",
        hex_lower(&nonce_toggled)
    ));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n\n",
        hex_lower(&blob_toggled)
    ));

    dump.push_str("# case 3/5: decrypt-default (round-trip with case 1)\n");
    dump.push_str(&alloc::format!(
        "input_blob_hex: {}\n",
        hex_lower(&blob_default)
    ));
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("expected_kind: ok\n");
    dump.push_str(&alloc::format!(
        "expected_plaintext_utf8_hex: {}\n",
        hex_lower(canonical_default)
    ));
    dump.push_str("expected_prefs_view: { \"screen_capture_protection\": true }\n\n");

    dump.push_str("# case 4/5: decrypt-cross-vault (vault A blob + vault B key)\n");
    dump.push_str(&alloc::format!(
        "input_blob_hex: {}\n",
        hex_lower(&blob_default)
    ));
    dump.push_str(&alloc::format!(
        "wrong_root_key_hex: {}\n",
        hex_lower(&root_b)
    ));
    dump.push_str(&alloc::format!(
        "wrong_prefs_key_hex (informational): {}\n",
        hex_lower(&*prefs_key_b)
    ));
    dump.push_str(&alloc::format!(
        "wrong_account_number_hash_hex: {}\n",
        hex_lower(&account_hash_b)
    ));
    dump.push_str("expected_kind: aead_fail\n\n");

    dump.push_str("# case 5/5: decrypt-tampered (vault A blob, ciphertext byte flipped)\n");
    dump.push_str(&alloc::format!(
        "input_blob_hex (tampered): {}\n",
        hex_lower(&blob_tampered)
    ));
    dump.push_str("tamper_offset: 40 (one byte of ciphertext flipped via XOR 0xFF)\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("expected_kind: aead_fail\n\n");

    dump.push_str(
        "# case 6/6: encrypt-populated (heterogeneous item_order + favorites + all fields)\n",
    );
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical_populated)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8: {}\n",
        core::str::from_utf8(&canonical_populated).unwrap_or("<non-utf8>")
    ));
    dump.push_str(&alloc::format!(
        "prefs_nonce_hex: {}\n",
        hex_lower(&nonce_populated)
    ));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n\n",
        hex_lower(&blob_populated)
    ));

    // decrypt-populated — round-trip with encrypt-populated. Generated here
    // (no longer hand-derived) so the expected_prefs_view can never drift
    // from the encrypt case's PrefsView. The canonical plaintext IS valid
    // JSON, so paste `expected_prefs_view` from `plaintext_canonical_utf8`
    // below as the case's `expected_prefs_view` object verbatim.
    dump.push_str("# case: decrypt-populated (round-trip with encrypt-populated)\n");
    dump.push_str(&alloc::format!(
        "input_blob_hex: {}\n",
        hex_lower(&blob_populated)
    ));
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("expected_kind: ok\n");
    dump.push_str(&alloc::format!(
        "expected_plaintext_utf8_hex: {}\n",
        hex_lower(&canonical_populated)
    ));
    dump.push_str(&alloc::format!(
        "expected_prefs_view (canonical JSON — paste as the object verbatim): {}\n\n",
        core::str::from_utf8(&canonical_populated).unwrap_or("<non-utf8>")
    ));

    dump.push_str("# case 7/8: encrypt-themed-dark (theme=dark, MYND-110)\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical_themed)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8: {}\n",
        core::str::from_utf8(&canonical_themed).unwrap_or("<non-utf8>")
    ));
    dump.push_str(&alloc::format!(
        "prefs_nonce_hex: {}\n",
        hex_lower(&nonce_themed)
    ));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n\n",
        hex_lower(&blob_themed)
    ));

    dump.push_str("# case 8/8: decrypt-themed-dark (round-trip with case 7)\n");
    dump.push_str(&alloc::format!(
        "input_blob_hex: {}\n",
        hex_lower(&blob_themed)
    ));
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("expected_kind: ok\n");
    dump.push_str(
        "expected_prefs_view: { \"screen_capture_protection\": true, \"theme\": \"dark\" }\n\n",
    );

    dump.push_str("---end prefs vectors---\n");
    std::fs::write("/tmp/myne_vault_prefs_vectors.txt", dump.as_bytes())
        .expect("write prefs vectors dump");
}

/// Generator for the MYND-205 `label` + §9.5.2 forward-compat vector
/// cases (appended to the companion repo's `vault-prefs` family; the
/// per-feature-generator pattern of [`emit_decorations_prefs_vector`]
/// keeps the original [`emit_prefs_vectors_for_paste`] stable):
///
/// `cargo test -p protocol --lib emit_label_and_tolerance_prefs_vectors -- --ignored`
///
/// - `encrypt-labeled`: `item_order` + `label` set, the label given in
///   NFD in this source (`Cafe\u{0301}`) so the emitted canonical bytes
///   pin the NFC normalization (`Caf\u{e9}`) AND the canonical key order
///   `item_order` (i) < `label` (l) < `screen_capture_protection` (s).
/// - `decrypt-labeled`: round-trip of the blob above; decoders must
///   surface the label.
/// - `decrypt-unknown-field-tolerated`: a blob sealed over a plaintext
///   carrying a genuinely unknown future field (`zz_future_pref`, in
///   sorted position after `theme`); decoders must recover the known
///   fields and ignore the unknown one (spec § 9.5.2 forward-compat).
///   Sealed manually (header assembly mirrors `encode_prefs_blob_raw`)
///   because the typed encoder can only emit canonical v0.1 plaintexts.
#[test]
#[ignore]
fn emit_label_and_tolerance_prefs_vectors() {
    extern crate std;

    // Same fixed vault-A inputs as the sibling generators; nonces 0xDD /
    // 0xEE are the next free entries in the family's nonce registry
    // (0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC are taken).
    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    // --- encrypt-labeled + decrypt-labeled -----------------------------
    let nonce_labeled: [u8; AEAD_NONCE_LEN] = [0xDD; AEAD_NONCE_LEN];
    let prefs_labeled = PrefsView {
        item_order: BTreeMap::from([(
            String::from(""),
            alloc::vec![
                String::from("0190a000-0000-7000-8000-000000000001"),
                String::from("Projects/Myne/"),
            ],
        )]),
        // NFD on purpose: 'e' + U+0301 combining acute. The encoder must
        // emit the NFC form (U+00E9, bytes c3 a9).
        label: Some(String::from("Cafe\u{301}")),
        ..PrefsView::default()
    };
    let canonical_labeled = canonical_json_encode(&prefs_labeled);
    assert_eq!(
            canonical_labeled.as_slice(),
            b"{\"item_order\":{\"\":[\"0190a000-0000-7000-8000-000000000001\",\"Projects/Myne/\"]},\"label\":\"Caf\xc3\xa9\",\"screen_capture_protection\":true}"
                .as_slice(),
            "canonical plaintext must NFC-normalize the label and sort i < l < s",
        );
    let blob_labeled = encode_prefs_blob_raw(
        &prefs_key_a,
        &account_hash_a,
        &prefs_labeled,
        &nonce_labeled,
    )
    .expect("encode labeled");
    // Round-trip self-validation: the decoded view carries the NFC label.
    let expected_labeled_view = PrefsView {
        item_order: prefs_labeled.item_order.clone(),
        label: Some(String::from("Caf\u{e9}")),
        ..PrefsView::default()
    };
    let decoded_labeled =
        decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_labeled).expect("decode");
    assert_eq!(decoded_labeled, expected_labeled_view);

    // --- decrypt-unknown-field-tolerated -------------------------------
    let nonce_tolerance: [u8; AEAD_NONCE_LEN] = [0xEE; AEAD_NONCE_LEN];
    // `zz_future_pref` sorts after `theme` — the cursor-based decoder
    // expects additive fields at their lexicographic position.
    let plaintext_future: &[u8] =
        br#"{"screen_capture_protection":true,"theme":"dark","zz_future_pref":7}"#;
    let aad = aad_prefs_blob(&account_hash_a);
    let sealed =
        aead_seal_ctx(&prefs_key_a, &nonce_tolerance, plaintext_future, &aad).expect("seal");
    let mut blob_tolerance = Vec::with_capacity(PREFS_BLOB_HEADER_LEN + sealed.len());
    blob_tolerance.extend_from_slice(&PREFS_BLOB_MAGIC);
    blob_tolerance.push(PREFS_BLOB_PROTOCOL_VERSION);
    blob_tolerance.push(PREFS_BLOB_RESERVED);
    blob_tolerance.extend_from_slice(&nonce_tolerance);
    blob_tolerance.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
    blob_tolerance.extend_from_slice(&sealed);

    let expected_tolerance_view = PrefsView {
        theme: Some(ThemeChoice::Dark),
        ..PrefsView::default()
    };
    let decoded_tolerance = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_tolerance)
        .expect("decode tolerance blob");
    assert_eq!(
        decoded_tolerance, expected_tolerance_view,
        "unknown future field must be ignored, known fields recovered",
    );
    // The canonical re-encode of the decoded view — what the runner pins
    // as expected_plaintext_canonical_utf8_hex (NOT the sealed bytes).
    let canonical_tolerance = canonical_json_encode(&decoded_tolerance);
    assert_eq!(
        canonical_tolerance.as_slice(),
        br#"{"screen_capture_protection":true,"theme":"dark"}"#.as_slice(),
    );

    let mut dump = alloc::string::String::new();
    dump.push_str("---begin label + tolerance prefs vectors---\n\n");

    dump.push_str("# case 1/3: encrypt-labeled (MYND-205; NFD source -> NFC bytes; i<l<s)\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "prefs_key_hex (informational): {}\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical_labeled)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8: {}\n",
        core::str::from_utf8(&canonical_labeled).unwrap_or("<non-utf8>")
    ));
    dump.push_str(&alloc::format!(
        "prefs_nonce_hex: {}\n",
        hex_lower(&nonce_labeled)
    ));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n\n",
        hex_lower(&blob_labeled)
    ));

    dump.push_str("# case 2/3: decrypt-labeled (round-trip with case 1)\n");
    dump.push_str(&alloc::format!(
        "input_blob_hex: {}\n",
        hex_lower(&blob_labeled)
    ));
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("expected_kind: ok\n");
    dump.push_str(&alloc::format!(
        "expected_plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical_labeled)
    ));
    dump.push_str(
            "expected_prefs_view: { \"item_order\": { \"\": [\"0190a000-0000-7000-8000-000000000001\", \"Projects/Myne/\"] }, \"label\": \"Café\", \"screen_capture_protection\": true }\n\n",
        );

    dump.push_str(
        "# case 3/3: decrypt-unknown-field-tolerated (spec \u{a7}9.5.2 forward-compat)\n",
    );
    dump.push_str(&alloc::format!(
        "input_blob_hex: {}\n",
        hex_lower(&blob_tolerance)
    ));
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "informational_sealed_plaintext_utf8_hex: {}\n",
        hex_lower(plaintext_future)
    ));
    dump.push_str(&alloc::format!(
        "informational_sealed_plaintext_utf8: {}\n",
        core::str::from_utf8(plaintext_future).unwrap_or("<non-utf8>")
    ));
    dump.push_str("expected_kind: ok\n");
    dump.push_str(&alloc::format!(
        "expected_plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical_tolerance)
    ));
    dump.push_str(
        "expected_prefs_view: { \"screen_capture_protection\": true, \"theme\": \"dark\" }\n\n",
    );

    dump.push_str("---end label + tolerance prefs vectors---\n");
    std::fs::write("/tmp/myne_vault_prefs_label_vectors.txt", dump.as_bytes())
        .expect("write label prefs vectors dump");
}

/// Mint the two `vault-prefs` cases pinning the **remote-provider triple**
/// (myne#415). A separate per-feature generator, per this family's
/// convention — `emit_prefs_vectors_for_paste` and its siblings stay
/// byte-stable so already-shipped vectors never move.
///
/// It emits ready-to-append **JSON case objects** rather than the
/// human-transcribed "paste" text the older siblings produce: the
/// transcription step is where a hand-copied hex digit goes wrong, and
/// there is no reason to keep paying for it.
///
/// Nonce `0xF1` — the next free entry in this family's nonce registry
/// (0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE are taken).
#[test]
#[ignore = "generator: mints vault-prefs provider-triple cases for the companion repo"]
#[cfg_attr(coverage_nightly, coverage(off))]
fn emit_ai_provider_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
    let nonce: [u8; AEAD_NONCE_LEN] = [0xF1; AEAD_NONCE_LEN];

    // Both lexicographic neighbours are present, so the case pins the
    // quartet's canonical POSITION and not merely its presence.
    let view = PrefsView {
        ai_excluded_folders: alloc::vec![String::from("Private/")],
        ai_provider: Some(String::from("openrouter")),
        ai_provider_consent: Some(alloc::string::String::from("openrouter")),
        ai_provider_key: Some(Zeroizing::new(String::from("sk-vector-fixture-000"))),
        ai_provider_model: Some(String::from("meta-llama/llama-3.1-8b")),
        archive_disabled: Some(true),
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&view);
    assert_eq!(
            canonical.as_slice(),
            br#"{"ai_excluded_folders":["Private/"],"ai_provider":"openrouter","ai_provider_consent":"openrouter","ai_provider_key":"sk-vector-fixture-000","ai_provider_model":"meta-llama/llama-3.1-8b","archive_disabled":true,"screen_capture_protection":true}"#.as_slice(),
            "canonical order must be ai_excluded_folders < ai_provider < ai_provider_consent < ai_provider_key < ai_provider_model < archive_disabled < screen_capture_protection",
        );
    let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &view, &nonce)
        .expect("encode provider triple");
    // Self-validating at mint: the blob decodes back to the same view.
    let back = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
    assert_eq!(back, view);

    let mut dump = alloc::string::String::new();
    dump.push_str("[\n");
    dump.push_str("  {\n");
    dump.push_str("    \"vector_id\": \"vault-prefs/v0.1/encrypt-ai-provider\",\n");
    dump.push_str("    \"description\": \"myne#415 remote-provider quartet. PrefsView carries BOTH lexicographic neighbours (ai_excluded_folders before, archive_disabled after) so the case pins the canonical POSITION of ai_provider < ai_provider_consent < ai_provider_key < ai_provider_model, not merely their presence. ai_provider_key is present in the ENCRYPTED blob and MUST NOT cross the host->UI boundary in any implementation (protocol.md 9.5.2). Generated by `cargo test -p protocol --lib emit_ai_provider_prefs_vectors -- --ignored` (in protocol/src/prefs.rs). LEGACY CONSENT VALUE, kept for its published bytes: ai_provider_consent here is the BARE wire name, which is the shape a pre-myne-md/myne#633 vault holds and which the remote-inference gate now REFUSES. The grammar an implementation must write is pinned by encrypt-ai-consent-device-scoped / decrypt-ai-consent-device-scoped beside this case.\",\n");
    dump.push_str("    \"case_kind\": \"encrypt\",\n");
    dump.push_str(&alloc::format!(
        "    \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_prefs_nonce_hex\": \"{}\",\n",
        hex_lower(&nonce)
    ));
    dump.push_str(&alloc::format!(
        "    \"informational_prefs_key_hex\": \"{}\",\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"expected_prefs_blob_hex\": \"{}\"\n",
        hex_lower(&blob)
    ));
    dump.push_str("  },\n");
    dump.push_str("  {\n");
    dump.push_str("    \"vector_id\": \"vault-prefs/v0.1/decrypt-ai-provider\",\n");
    dump.push_str("    \"description\": \"Round-trip with encrypt-ai-provider: the blob decodes back to a PrefsView carrying the provider selection, the consent name, the key and the chosen model, each read from its canonical position between ai_excluded_folders and archive_disabled. A decoder that mis-orders the quartet fails here rather than silently returning a shifted value. The consent value it returns is the legacy bare form; see decrypt-ai-consent-device-scoped for the device-scoped grammar the gate accepts and for the predicate that separates the two.\",\n");
    dump.push_str("    \"case_kind\": \"decrypt_ok\",\n");
    dump.push_str(&alloc::format!(
        "    \"input_blob_hex\": \"{}\",\n",
        hex_lower(&blob)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str("    \"expected_prefs_view\": {\n");
    dump.push_str("      \"ai_excluded_folders\": [\"Private/\"],\n");
    dump.push_str("      \"ai_provider\": \"openrouter\",\n");
    dump.push_str("      \"ai_provider_consent\": \"openrouter\",\n");
    dump.push_str("      \"ai_provider_key\": \"sk-vector-fixture-000\",\n");
    dump.push_str("      \"ai_provider_model\": \"meta-llama/llama-3.1-8b\",\n");
    dump.push_str("      \"archive_disabled\": true,\n");
    dump.push_str("      \"screen_capture_protection\": true\n");
    dump.push_str("    }\n");
    dump.push_str("  }\n");
    dump.push_str("]\n");

    std::fs::write(
        "/tmp/myne_vault_prefs_provider_vectors.json",
        dump.as_bytes(),
    )
    .expect("write provider prefs vectors dump");
}

/// Generator for the DEVICE-SCOPED `ai_provider_consent` pair — the grammar
/// `provider_gate` actually requires (myne-md/myne#633), which the published
/// vectors did not describe.
///
/// **Why this is a correctness gap and not a coverage nicety.**
/// `encrypt-ai-provider` pins `ai_provider_consent: "openrouter"`, a BARE
/// wire name. Since #633 that value is exactly what
/// `core/src/inference/provider_gate.rs` REFUSES: it calls
/// [`consent_is_device_scoped`], which requires the
/// [`CONSENT_DEVICE_SUFFIX`] tail. So an independent implementation that
/// conformed to the published vector wrote a consent that never opens the
/// gate, and the failure surfaced as "the AI does nothing" with a stored
/// preference that looks correct in the blob.
///
/// Nothing reported it, and nothing could. The byte-level suite passes
/// because the emitter and the fixture agree; they agree on the pre-#633
/// grammar, which is a check comparing a value against a second copy of
/// itself. Only a case that carries the CURRENT grammar can tell them apart.
///
/// The bare case is deliberately NOT rewritten. Its bytes are published and
/// a port may already conform to them, and it is the legacy shape a real
/// migrated vault still holds, so it stays as the thing a reader must be
/// able to recognise. What changes is that this pair exists beside it and
/// says which of the two the gate accepts. `decrypt-ai-consent-device-scoped`
/// carries `expected_consent_is_device_scoped` and
/// `expected_consent_is_legacy` for BOTH values, so the predicate itself is
/// pinned rather than left to be re-derived from the suffix by hand.
///
/// Nonce `0xF9` — the next free entry in this family's registry
/// (0x77..0xF8 taken).
///
/// `cargo test -p protocol --lib emit_ai_consent_scope_prefs_vectors -- --ignored`
#[test]
#[ignore]
fn emit_ai_consent_scope_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
    let nonce: [u8; AEAD_NONCE_LEN] = [0xF9; AEAD_NONCE_LEN];

    // The value is BUILT by the grammar function rather than written as a
    // literal, so the case cannot drift from the implementation it pins:
    // change the suffix and this fixture changes with it, loudly, instead of
    // continuing to assert a string nothing produces any more.
    let consent = device_scoped_consent("openrouter");
    assert_eq!(consent.as_str(), "openrouter@device");
    assert!(consent_is_device_scoped(
        Some(consent.as_str()),
        "openrouter"
    ));
    assert!(!consent_is_legacy(Some(consent.as_str()), "openrouter"));
    // And the other direction, which is the whole reason the pair exists.
    assert!(!consent_is_device_scoped(Some("openrouter"), "openrouter"));
    assert!(consent_is_legacy(Some("openrouter"), "openrouter"));
    // A consent recorded for a DIFFERENT provider is neither. The gate reads
    // an equality, not a flag, so this is a distinct answer rather than a
    // degenerate one.
    assert!(!consent_is_device_scoped(
        Some(consent.as_str()),
        "anthropic"
    ));
    assert!(!consent_is_legacy(Some(consent.as_str()), "anthropic"));

    // Same neighbours as `emit_ai_provider_prefs_vectors`, so the two cases
    // differ in exactly one value and a port can diff them directly.
    let view = PrefsView {
        ai_excluded_folders: alloc::vec![String::from("Private/")],
        ai_provider: Some(String::from("openrouter")),
        ai_provider_consent: Some(consent.clone()),
        ai_provider_key: Some(Zeroizing::new(String::from("sk-vector-fixture-000"))),
        ai_provider_model: Some(String::from("meta-llama/llama-3.1-8b")),
        archive_disabled: Some(true),
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&view);
    assert_eq!(
            canonical.as_slice(),
            br#"{"ai_excluded_folders":["Private/"],"ai_provider":"openrouter","ai_provider_consent":"openrouter@device","ai_provider_key":"sk-vector-fixture-000","ai_provider_model":"meta-llama/llama-3.1-8b","archive_disabled":true,"screen_capture_protection":true}"#.as_slice(),
            "the suffix must not move the field out of its canonical slot",
        );
    let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &view, &nonce)
        .expect("encode device-scoped consent");
    let back = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
    assert_eq!(back, view);

    let mut dump = alloc::string::String::new();
    dump.push_str("[\n");
    dump.push_str("  {\n");
    dump.push_str("    \"vector_id\": \"vault-prefs/v0.1/encrypt-ai-consent-device-scoped\",\n");
    dump.push_str("    \"description\": \"The DEVICE-SCOPED ai_provider_consent grammar (myne-md/myne#633). The stored value is the provider's wire name followed by the literal suffix '@device' — 'openrouter@device' here — and it is that whole string, not the bare wire name, that the remote-inference gate accepts. Identical to encrypt-ai-provider in every other byte, so a port can diff the two blobs and see that the only change is the consent value, still in its canonical slot between ai_provider and ai_provider_key. The suffix is device-local by construction: consent is not a vault-wide grant that follows the blob to another machine, so a vault synced to a second device arrives with a consent that device has not given and the gate refuses it there. A port that stores the bare wire name produces a preference that reads correctly and never opens the gate. Generated by `cargo test -p protocol --lib emit_ai_consent_scope_prefs_vectors -- --ignored` (in protocol/src/prefs.rs).\",\n");
    dump.push_str("    \"case_kind\": \"encrypt\",\n");
    dump.push_str(&alloc::format!(
        "    \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_prefs_nonce_hex\": \"{}\",\n",
        hex_lower(&nonce)
    ));
    dump.push_str(&alloc::format!(
        "    \"informational_prefs_key_hex\": \"{}\",\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"expected_prefs_blob_hex\": \"{}\"\n",
        hex_lower(&blob)
    ));
    dump.push_str("  },\n");
    dump.push_str("  {\n");
    dump.push_str("    \"vector_id\": \"vault-prefs/v0.1/decrypt-ai-consent-device-scoped\",\n");
    dump.push_str("    \"description\": \"Round-trip with encrypt-ai-consent-device-scoped, plus the PREDICATE the grammar exists for. expected_consent_is_device_scoped and expected_consent_is_legacy are given for both the device-scoped value and the bare wire name encrypt-ai-provider pins, against the same provider and against a different one. A port implements two questions here: does this stored value carry the suffix AND name this provider (accept), and is it the bare name of this provider (a legacy grant, refused — it is what a pre-#633 vault holds, so recognising it is how an implementation knows to ask again rather than to fail silently). A stored consent naming a DIFFERENT provider answers no to both: the gate is an equality against the provider about to receive the text, never a flag.\",\n");
    dump.push_str("    \"case_kind\": \"decrypt_ok\",\n");
    dump.push_str(&alloc::format!(
        "    \"input_blob_hex\": \"{}\",\n",
        hex_lower(&blob)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "    \"expected_consent_device_suffix\": \"{}\",\n",
        CONSENT_DEVICE_SUFFIX
    ));
    dump.push_str("    \"expected_consent_predicate\": [\n");
    for (stored, provider) in [
        (consent.as_str(), "openrouter"),
        ("openrouter", "openrouter"),
        (consent.as_str(), "anthropic"),
    ] {
        dump.push_str("      {\n");
        dump.push_str(&alloc::format!(
            "        \"stored\": \"{}\",\n        \"provider_wire\": \"{}\",\n",
            stored,
            provider
        ));
        dump.push_str(&alloc::format!(
                "        \"expected_consent_is_device_scoped\": {},\n        \"expected_consent_is_legacy\": {}\n",
                consent_is_device_scoped(Some(stored), provider),
                consent_is_legacy(Some(stored), provider)
            ));
        dump.push_str("      },\n");
    }
    // Trim the trailing comma of the last predicate entry.
    while dump.ends_with(",\n") {
        dump.truncate(dump.len() - 2);
        dump.push('\n');
    }
    dump.push_str("    ],\n");
    dump.push_str("    \"expected_prefs_view\": {\n");
    dump.push_str("      \"ai_excluded_folders\": [\"Private/\"],\n");
    dump.push_str("      \"ai_provider\": \"openrouter\",\n");
    dump.push_str(&alloc::format!(
        "      \"ai_provider_consent\": \"{}\",\n",
        consent
    ));
    dump.push_str("      \"ai_provider_key\": \"sk-vector-fixture-000\",\n");
    dump.push_str("      \"ai_provider_model\": \"meta-llama/llama-3.1-8b\",\n");
    dump.push_str("      \"archive_disabled\": true,\n");
    dump.push_str("      \"screen_capture_protection\": true\n");
    dump.push_str("    }\n");
    dump.push_str("  }\n");
    dump.push_str("]\n");

    std::fs::write(
        "/tmp/myne_vault_prefs_consent_scope_vectors.json",
        dump.as_bytes(),
    )
    .expect("write consent-scope prefs vectors dump");
}

/// Generator for the OpenCode provider pair (appended to the companion
/// repo's `vault-prefs` family; per-feature generator, keeps the published
/// cases byte-stable), pinning the two wire values `decisions/ai/0773` added
/// to the CLOSED `ai_provider` set, `"opencode-zen"` and `"opencode-go"`.
///
/// The set is closed and an independent port enumerates it, so a value that
/// exists only in the reference implementation's `from_wire` is a value a
/// port cannot accept. `encrypt-ai-provider-opencode` carries the `go`
/// value with its device-scoped consent, and its predicate block answers
/// the two gate questions for BOTH new names plus a cross-provider negative,
/// so "one host, two providers" is pinned as behaviour rather than as prose.
///
/// Nonce `0xFC`: not used by any other generator in this module, so this
/// case's ciphertext shares no byte with theirs. (The parenthetical this
/// comment used to carry claimed `0x77..0xFB` were all taken, which is
/// arithmetically false: 36 nonces are in use here and the range has 133
/// values. The claim that matters is the one above.)
///
/// `cargo test -p protocol --lib emit_opencode_provider_prefs_vectors -- --ignored`
#[test]
#[ignore]
fn emit_opencode_provider_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
    let nonce: [u8; AEAD_NONCE_LEN] = [0xFC; AEAD_NONCE_LEN];

    // Built by the grammar function, not written as a literal: change the
    // suffix and this fixture changes with it instead of asserting a string
    // nothing produces any more (the `emit_ai_consent_scope_prefs_vectors`
    // discipline, applied to the new wire name).
    let consent = device_scoped_consent("opencode-go");
    assert_eq!(consent.as_str(), "opencode-go@device");
    assert!(consent_is_device_scoped(
        Some(consent.as_str()),
        "opencode-go"
    ));
    assert!(!consent_is_legacy(Some(consent.as_str()), "opencode-go"));

    // Same neighbours as the `openrouter` pair, so a port can diff the two
    // DECRYPTED views and account for every difference: THREE values move
    // (`ai_provider`, `ai_provider_consent` and `ai_provider_model`), and the
    // sealed blobs share nothing at all because each is sealed under its own
    // nonce. Stated precisely because the earlier wording claimed the provider
    // name was the only value that moved, which a port that diffed the
    // plaintext would find untrue (myne-md/myne#972 review, D4).
    let view = PrefsView {
        ai_excluded_folders: alloc::vec![String::from("Private/")],
        ai_provider: Some(String::from("opencode-go")),
        ai_provider_consent: Some(consent.clone()),
        ai_provider_key: Some(Zeroizing::new(String::from("sk-vector-fixture-000"))),
        ai_provider_model: Some(String::from("kimi-k3")),
        archive_disabled: Some(true),
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&view);
    assert_eq!(
            canonical.as_slice(),
            br#"{"ai_excluded_folders":["Private/"],"ai_provider":"opencode-go","ai_provider_consent":"opencode-go@device","ai_provider_key":"sk-vector-fixture-000","ai_provider_model":"kimi-k3","archive_disabled":true,"screen_capture_protection":true}"#.as_slice(),
            "a longer wire name must not move the field out of its canonical slot",
        );
    let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &view, &nonce)
        .expect("encode opencode-go provider");
    let back = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
    assert_eq!(back, view);

    let mut dump = alloc::string::String::new();
    dump.push_str("[\n");
    dump.push_str("  {\n");
    dump.push_str("    \"vector_id\": \"vault-prefs/v0.1/encrypt-ai-provider-opencode\",\n");
    dump.push_str("    \"description\": \"The two OpenCode wire values (myne-md/myne#970, decisions/ai/0773). `ai_provider` is a CLOSED set, so a value the reference implementation accepts but this enum omits is a value an independent port cannot accept at all; the case carries `opencode-go`, the subscription plan, with its device-scoped consent. Zen and Go are products of one operator that share the host `opencode.ai` and are told apart by base PATH alone, so the destination is still not in the blob: both are compiled-in client constants. Neighbours are the ones encrypt-ai-provider pins, so a port can diff the two DECRYPTED views and account for every difference: exactly three values move (`ai_provider`, `ai_provider_consent`, `ai_provider_model`), while the sealed blobs share no byte because each is sealed under its own nonce. Generated by `cargo test -p protocol --lib emit_opencode_provider_prefs_vectors -- --ignored` (in protocol/src/prefs.rs).\",\n");
    dump.push_str("    \"case_kind\": \"encrypt\",\n");
    dump.push_str(&alloc::format!(
        "    \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_prefs_nonce_hex\": \"{}\",\n",
        hex_lower(&nonce)
    ));
    dump.push_str(&alloc::format!(
        "    \"informational_prefs_key_hex\": \"{}\",\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"expected_prefs_blob_hex\": \"{}\"\n",
        hex_lower(&blob)
    ));
    dump.push_str("  },\n");
    dump.push_str("  {\n");
    dump.push_str("    \"vector_id\": \"vault-prefs/v0.1/decrypt-ai-provider-opencode\",\n");
    dump.push_str("    \"description\": \"Round-trip with encrypt-ai-provider-opencode, plus the consent PREDICATE for both new names. The gate compares the stored value against the provider about to receive the text, so `opencode-zen@device` is not a consent for `opencode-go` even though one host serves both: an approval for one product must not open the other, which is the whole reason they are two wire values rather than one. The bare `opencode-go` entry is the legacy shape the gate refuses.\",\n");
    dump.push_str("    \"case_kind\": \"decrypt_ok\",\n");
    dump.push_str(&alloc::format!(
        "    \"input_blob_hex\": \"{}\",\n",
        hex_lower(&blob)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "    \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "    \"expected_consent_device_suffix\": \"{}\",\n",
        CONSENT_DEVICE_SUFFIX
    ));
    dump.push_str("    \"expected_consent_predicate\": [\n");
    for (stored, provider) in [
        (consent.as_str(), "opencode-go"),
        ("opencode-go", "opencode-go"),
        ("opencode-zen@device", "opencode-go"),
        ("opencode-go@device", "opencode-zen"),
    ] {
        dump.push_str("      {\n");
        dump.push_str(&alloc::format!(
            "        \"stored\": \"{}\",\n        \"provider_wire\": \"{}\",\n",
            stored,
            provider
        ));
        dump.push_str(&alloc::format!(
                "        \"expected_consent_is_device_scoped\": {},\n        \"expected_consent_is_legacy\": {}\n",
                consent_is_device_scoped(Some(stored), provider),
                consent_is_legacy(Some(stored), provider)
            ));
        dump.push_str("      },\n");
    }
    // Trim the trailing comma of the last predicate entry.
    while dump.ends_with(",\n") {
        dump.truncate(dump.len() - 2);
        dump.push('\n');
    }
    dump.push_str("    ],\n");
    dump.push_str("    \"expected_prefs_view\": {\n");
    dump.push_str("      \"ai_excluded_folders\": [\"Private/\"],\n");
    dump.push_str("      \"ai_provider\": \"opencode-go\",\n");
    dump.push_str(&alloc::format!(
        "      \"ai_provider_consent\": \"{}\",\n",
        consent
    ));
    dump.push_str("      \"ai_provider_key\": \"sk-vector-fixture-000\",\n");
    dump.push_str("      \"ai_provider_model\": \"kimi-k3\",\n");
    dump.push_str("      \"archive_disabled\": true,\n");
    dump.push_str("      \"screen_capture_protection\": true\n");
    dump.push_str("    }\n");
    dump.push_str("  }\n");
    dump.push_str("]\n");

    std::fs::write(
        "/tmp/myne_vault_prefs_opencode_provider_vectors.json",
        dump.as_bytes(),
    )
    .expect("write opencode-provider prefs vectors dump");
}

/// Generator for the `device_names` vector pair (appended to the companion
/// repo's `vault-prefs` family; per-feature generator, keeps the originals
/// byte-stable) — pins the MYND-459 / SYNC-41 `device_names` additive field
/// (`docs/spec/protocol.md` §9.5). Golden AEAD bytes cannot be hand-authored,
/// so this `#[ignore]` emitter is the mechanism even though the companion
/// vectors are the deliverable — it emits, it is not a runtime test.
///
/// `cargo test -p protocol --lib emit_device_names_prefs_vectors -- --ignored --nocapture`
#[test]
#[ignore]
fn emit_device_names_prefs_vectors() {
    extern crate std;
    // Same fixed vault-A inputs as the sibling generators. Nonce 0xF6 is the
    // next free entry in the family's nonce registry (0x77–0xF5 taken;
    // 0xB1/0xB2 = paired_extensions).
    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
    let nonce: [u8; AEAD_NONCE_LEN] = [0xF6; AEAD_NONCE_LEN];

    // Two device_id (hex) → friendly-name entries. `map_of` collects into a
    // BTreeMap; the encoder emits keys in lexicographic order regardless of
    // insertion order, so the sort is load-bearing (1a2b… < f9e8…).
    let prefs = PrefsView {
        device_names: map_of(&[
            ("f9e8d7c6b5a4938271605f4e3d2c1b0a", "Phone"),
            ("1a2b3c4d5e6f708192a3b4c5d6e7f809", "Work Laptop"),
        ]),
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs);
    assert_eq!(
            canonical.as_slice(),
            br#"{"device_names":{"1a2b3c4d5e6f708192a3b4c5d6e7f809":"Work Laptop","f9e8d7c6b5a4938271605f4e3d2c1b0a":"Phone"},"screen_capture_protection":true}"#.as_slice(),
            "device_names sorts keys lexicographically + sits at canonical 'd' before screen_capture_protection",
        );
    let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
        .expect("encode device_names");
    // Round-trip self-validation.
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
    assert_eq!(decoded, prefs);

    std::println!("---begin device_names prefs vectors---");
    std::println!("input_root_key_hex: {}", hex_lower(&root_a));
    std::println!(
        "input_account_number_hash_hex: {}",
        hex_lower(&account_hash_a)
    );
    std::println!("input_prefs_nonce_hex: {}", hex_lower(&nonce));
    std::println!("informational_prefs_key_hex: {}", hex_lower(&*prefs_key_a));
    std::println!(
        "input_plaintext_canonical_utf8_hex: {}",
        hex_lower(&canonical)
    );
    std::println!("expected_prefs_blob_hex: {}", hex_lower(&blob));
    std::println!("---end device_names prefs vectors---");
}

/// Generator for the `paired_extensions` vector pair (appended to the
/// companion repo's `vault-prefs` family; per-feature generator, keeps the
/// originals byte-stable):
///
/// `cargo test -p protocol --lib emit_paired_extensions_prefs_vectors -- --ignored`
///
/// Pins the MYND-443 browser-clipper pairing-token persistence + the
/// MYND-442 `paired_at` additive field (`docs/decisions.md` 2026-06-21):
///
/// - `encrypt-paired-extensions`: a `PrefsView` carrying a two-record
///   `paired_extensions` array — one record WITHOUT `paired_at` (the
///   pre-feature, byte-identical encoding; `revoked: true`) and one WITH
///   `paired_at` (`revoked: false`). Pins (a) the canonical record key
///   order `extension_id < paired_at < revoked < token_value` with
///   `paired_at` emitted as a bare decimal u64 in its canonical slot, (b)
///   the omitted-when-`None` rule (record 1 is identical to a pre-MYND-442
///   record), (c) the array sort by `(extension_id, token_value)` — the
///   records are constructed out of sort order here so the encoder's sort
///   is load-bearing — and (d) the `paired_extensions` (p) < `screen_
///   capture_protection` (s) field order on `PrefsView`.
/// - `decrypt-paired-extensions`: round-trip of the blob above; decoders
///   must surface both records, including the `paired_at` on record 2 and
///   its absence (`None`) on record 1.
///
/// Nonce `0xB1` is the next free entry in the family's nonce registry
/// (0x77–0xF5 partially taken; 0xB1/0xB2 free).
#[test]
#[ignore]
fn emit_paired_extensions_prefs_vectors() {
    extern crate std;
    use crate::paired_extension::PairedExtension;

    // Same fixed vault-A inputs as the sibling generators.
    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
    let nonce_paired: [u8; AEAD_NONCE_LEN] = [0xB1; AEAD_NONCE_LEN];

    // 64-hex token values (hex of 32 CSPRNG bytes); fixed test patterns.
    let token_a = String::from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    let token_b = String::from("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    // Constructed OUT of canonical sort order (Firefox record first) so the
    // encoder's `(extension_id, token_value)` sort is exercised: the Chrome
    // record (`abcd…` < `clipper@…`) must lead in the emitted bytes.
    let prefs_paired = PrefsView {
        paired_extensions: alloc::vec![
            PairedExtension {
                extension_id: String::from("clipper@myne.md"),
                token_value: token_a.clone(),
                revoked: false,
                paired_at: Some(1_750_000_000),
            },
            PairedExtension {
                extension_id: String::from("abcdefghijklmnopabcdefghijklmnop"),
                token_value: token_b.clone(),
                revoked: true,
                paired_at: None,
            },
        ],
        ..PrefsView::default()
    };
    let canonical_paired = canonical_json_encode(&prefs_paired);
    // The Chrome record (no `paired_at`, `revoked:true`) leads; the Firefox
    // record carries `paired_at` in its canonical slot between extension_id
    // and revoked. `paired_extensions` (p) sorts before screen_capture (s).
    assert_eq!(
        core::str::from_utf8(&canonical_paired).unwrap(),
        "{\"paired_extensions\":[\
{\"extension_id\":\"abcdefghijklmnopabcdefghijklmnop\",\"revoked\":true,\
\"token_value\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"},\
{\"extension_id\":\"clipper@myne.md\",\"paired_at\":1750000000,\"revoked\":false,\
\"token_value\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\
],\"screen_capture_protection\":true}",
        "paired_at omitted on record 1, present (bare u64) on record 2; array sorted; p<s",
    );
    let blob_paired =
        encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_paired, &nonce_paired)
            .expect("encode paired");
    // Round-trip: decoder surfaces both records incl. the paired_at split.
    let decoded_paired =
        decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_paired).expect("decode");
    assert_eq!(decoded_paired.paired_extensions.len(), 2);
    // Decoded order follows the canonical (sorted) bytes: Chrome then Firefox.
    assert_eq!(decoded_paired.paired_extensions[0].paired_at, None);
    assert_eq!(
        decoded_paired.paired_extensions[1].paired_at,
        Some(1_750_000_000)
    );

    let mut dump = alloc::string::String::new();
    dump.push_str("---begin paired_extensions prefs vectors---\n\n");

    dump.push_str(
            "# case 1/2: encrypt-paired-extensions (MYND-443/442; paired_at omitted|present; sort; p<s)\n",
        );
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "prefs_key_hex (informational): {}\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical_paired)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8: {}\n",
        core::str::from_utf8(&canonical_paired).unwrap_or("<non-utf8>")
    ));
    dump.push_str(&alloc::format!(
        "prefs_nonce_hex: {}\n",
        hex_lower(&nonce_paired)
    ));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n\n",
        hex_lower(&blob_paired)
    ));

    dump.push_str("# case 2/2: decrypt-paired-extensions (round-trip with case 1)\n");
    dump.push_str(&alloc::format!(
        "input_blob_hex: {}\n",
        hex_lower(&blob_paired)
    ));
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("expected_kind: ok\n");
    dump.push_str(&alloc::format!(
        "expected_plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical_paired)
    ));
    dump.push_str(
            "expected_prefs_view: { \"paired_extensions\": [ \
{ \"extension_id\": \"abcdefghijklmnopabcdefghijklmnop\", \"revoked\": true, \"token_value\": \"bbbb…(64)\" }, \
{ \"extension_id\": \"clipper@myne.md\", \"paired_at\": 1750000000, \"revoked\": false, \"token_value\": \"aaaa…(64)\" } \
], \"screen_capture_protection\": true }\n\n",
        );

    dump.push_str("---end paired_extensions prefs vectors---\n");
    std::fs::write(
        "/tmp/myne_vault_prefs_paired_extensions_vectors.txt",
        dump.as_bytes(),
    )
    .expect("write paired_extensions prefs vectors dump");
}

/// Generator for the AMOLED `theme` vector case (appended to the companion
/// repo's `vault-prefs` family; per-feature generator, keeps the originals
/// byte-stable):
///
/// `cargo test -p protocol --lib emit_amoled_theme_prefs_vector -- --ignored`
///
/// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying the
/// third explicit theme value (`ThemeChoice::Amoled` → canonical
/// `"theme":"amoled"`). Pins the lowercase variant string the serializer
/// emits and the round-trip back through the decoder, the cross-impl
/// contract for the AMOLED theme. Nonce `0xA0` is the next free entry in
/// the family's nonce registry (0x77–0xEE taken by the sibling generators).
#[test]
#[ignore]
fn emit_amoled_theme_prefs_vector() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    let nonce_amoled: [u8; AEAD_NONCE_LEN] = [0xA0; AEAD_NONCE_LEN];
    let prefs_amoled = PrefsView {
        theme: Some(ThemeChoice::Amoled),
        ..PrefsView::default()
    };
    let canonical_amoled = canonical_json_encode(&prefs_amoled);
    assert_eq!(
        canonical_amoled.as_slice(),
        br#"{"screen_capture_protection":true,"theme":"amoled"}"#.as_slice(),
        "canonical plaintext must emit the lowercase amoled variant, theme last",
    );
    let blob_amoled =
        encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_amoled, &nonce_amoled)
            .expect("encode amoled");
    let decoded_amoled =
        decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_amoled).expect("decode amoled");
    assert_eq!(decoded_amoled, prefs_amoled);
    assert_eq!(decoded_amoled.theme, Some(ThemeChoice::Amoled));

    let mut dump = alloc::string::String::new();
    dump.push_str("---begin amoled theme prefs vectors---\n\n");

    dump.push_str("# case 1/2: encrypt-themed-amoled\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical_amoled)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8: {}\n",
        core::str::from_utf8(&canonical_amoled).unwrap_or("<non-utf8>")
    ));
    dump.push_str(&alloc::format!(
        "prefs_nonce_hex: {}\n",
        hex_lower(&nonce_amoled)
    ));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n\n",
        hex_lower(&blob_amoled)
    ));

    dump.push_str("# case 2/2: decrypt-themed-amoled (round-trip with case 1)\n");
    dump.push_str(&alloc::format!(
        "input_blob_hex: {}\n",
        hex_lower(&blob_amoled)
    ));
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("expected_kind: ok\n");
    dump.push_str(&alloc::format!(
        "expected_plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical_amoled)
    ));
    dump.push_str(
        "expected_prefs_view: { \"screen_capture_protection\": true, \"theme\": \"amoled\" }\n\n",
    );

    dump.push_str("---end amoled theme prefs vectors---\n");
    std::fs::write("/tmp/myne_vault_prefs_amoled_vectors.txt", dump.as_bytes())
        .expect("write amoled prefs vectors dump");
}

/// Generator for the local-ai `ai_enabled` + `ai_excluded_folders` vector
/// cases (MYND-408 / SYNC-12/14; appended to the companion repo's
/// `vault-prefs` family — per-feature generator, keeps the originals
/// byte-stable):
///
/// `cargo test -p protocol --lib emit_ai_prefs_vectors -- --ignored`
///
/// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying the two
/// additive local-AI fields — `ai_enabled: true` and a one-entry
/// `ai_excluded_folders: ["Private/"]`. Pins the canonical key positions
/// (`ai_enabled` < `ai_excluded_folders` < `screen_capture_protection`, all
/// alphabetical) + the folder-set encoding (same `canonical_folder_list`
/// codec as `deliberate_folders`), the cross-impl MYP1 contract for the AI
/// prefs. Nonce `0xA1` (next free after `0xA0` amoled).
#[test]
#[ignore]
fn emit_ai_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    let nonce_ai: [u8; AEAD_NONCE_LEN] = [0xA1; AEAD_NONCE_LEN];
    let prefs_ai = PrefsView {
        ai_enabled: true,
        ai_excluded_folders: alloc::vec![alloc::string::String::from("Private/")],
        ai_provider: None,
        ai_provider_consent: None,
        ai_provider_key: None,
        ai_provider_model: None,
        ..PrefsView::default()
    };
    let canonical_ai = canonical_json_encode(&prefs_ai);
    assert_eq!(
            canonical_ai.as_slice(),
            br#"{"ai_enabled":true,"ai_excluded_folders":["Private/"],"screen_capture_protection":true}"#.as_slice(),
            "canonical plaintext must emit ai_enabled < ai_excluded_folders < screen_capture_protection",
        );
    let blob_ai = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_ai, &nonce_ai)
        .expect("encode ai");
    let decoded_ai = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_ai).expect("decode ai");
    assert_eq!(decoded_ai, prefs_ai);
    assert!(decoded_ai.ai_enabled);
    assert_eq!(
        decoded_ai.ai_excluded_folders,
        alloc::vec![alloc::string::String::from("Private/")]
    );

    let mut dump = alloc::string::String::new();
    dump.push_str("---begin local-ai prefs vectors---\n\n");

    dump.push_str("# case 1/2: encrypt-ai-enabled-excluded\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical_ai)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8: {}\n",
        core::str::from_utf8(&canonical_ai).unwrap_or("<non-utf8>")
    ));
    dump.push_str(&alloc::format!(
        "prefs_nonce_hex: {}\n",
        hex_lower(&nonce_ai)
    ));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n\n",
        hex_lower(&blob_ai)
    ));

    dump.push_str("# case 2/2: decrypt-ai-enabled-excluded (round-trip with case 1)\n");
    dump.push_str(&alloc::format!("input_blob_hex: {}\n", hex_lower(&blob_ai)));
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("expected_kind: ok\n");
    dump.push_str(&alloc::format!(
        "expected_plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical_ai)
    ));
    dump.push_str(
            "expected_prefs_view: { \"ai_enabled\": true, \"ai_excluded_folders\": [\"Private/\"], \"screen_capture_protection\": true }\n\n",
        );

    dump.push_str("---end local-ai prefs vectors---\n");
    std::fs::write("/tmp/myne_vault_prefs_ai_vectors.txt", dump.as_bytes())
        .expect("write ai prefs vectors dump");
}

/// Generator for the MYND-273 `saved_views` + `view_order` vector cases
/// (appended to the companion repo's `vault-prefs` family; per-feature
/// generator, keeps the originals byte-stable):
///
/// `cargo test -p protocol --lib emit_saved_views_prefs_vector -- --ignored`
///
/// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying a single
/// saved view (a card view over `Books/` with a typed `rating > 4` filter,
/// a sort, columns, and image fields) plus a `view_order`, pinning the
/// canonical key positions `saved_views` (before `screen_capture_protection`)
/// and `view_order` (last, after `theme`) and the saved-view sub-object's own
/// lexicographic key + filter-AST encoding.
#[test]
#[ignore]
fn emit_saved_views_prefs_vector() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
    // 0xF0 is the next free nonce in the family registry (…0xDD, 0xEE taken).
    let nonce: [u8; AEAD_NONCE_LEN] = [0xF0; AEAD_NONCE_LEN];

    let view = crate::saved_view::SavedView {
        id: String::from("0190a000-0000-7000-8000-000000000005"),
        name: String::from("Books"),
        view_type: crate::saved_view::ViewType::Cards,
        filters: crate::saved_view::FilterNode::And {
            children: alloc::vec![
                crate::saved_view::FilterNode::InFolder {
                    path: String::from("Books/"),
                },
                crate::saved_view::FilterNode::Property {
                    key: String::from("rating"),
                    op: crate::saved_view::PropertyOp::Gt,
                    value: String::from("4"),
                },
            ],
        },
        sort: Some(crate::saved_view::ViewSort {
            key: String::from("finished"),
            direction: crate::saved_view::SortDirection::Desc,
        }),
        group_by: Some(String::from("status")),
        columns: alloc::vec![String::from("author"), String::from("rating")],
        card_size: Some(300),
        image: Some(String::from("image")),
        image_aspect_ratio: Some(String::from("1.65")),
        // Neither manifest field set: this is the pre-feature view shape, and
        // the golden bytes below are unchanged by this format's arrival:
        // which is the byte-identity claim in the assertion's own message.
        version: None,
        write_fields: Vec::new(),
        lanes: Vec::new(),
        template: None,
    };
    let prefs = PrefsView {
        saved_views: alloc::vec![view],
        opaque_saved_views: Vec::new(),
        view_order: alloc::vec![String::from("0190a000-0000-7000-8000-000000000005")],
        ..PrefsView::default()
    };

    let canonical = canonical_json_encode(&prefs);
    assert_eq!(
            canonical.as_slice(),
            br#"{"saved_views":[{"card_size":300,"columns":["author","rating"],"filters":{"children":[{"kind":"inFolder","path":"Books/"},{"key":"rating","kind":"property","op":">","value":"4"}],"kind":"and"},"group_by":"status","id":"0190a000-0000-7000-8000-000000000005","image":"image","image_aspect_ratio":"1.65","name":"Books","sort":{"direction":"desc","key":"finished"},"view_type":"cards"}],"screen_capture_protection":true,"view_order":["0190a000-0000-7000-8000-000000000005"]}"#.as_slice(),
            "canonical plaintext must place saved_views before screen_capture_protection and view_order last, with the saved-view sub-object + filter AST in lexicographic key order",
        );
    let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
        .expect("encode saved_views");
    // Round-trip self-validation.
    assert_eq!(
        decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode"),
        prefs,
    );

    let mut dump = alloc::string::String::new();
    dump.push_str("---begin saved_views prefs vector (MYND-273)---\n\n");
    dump.push_str("# case: encrypt-saved-views\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "prefs_key_hex (informational): {}\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8: {}\n",
        core::str::from_utf8(&canonical).unwrap_or("<non-utf8>")
    ));
    dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n",
        hex_lower(&blob)
    ));
    dump.push_str("---end saved_views prefs vector---\n");
    std::fs::write(
        "/tmp/myne_vault_prefs_saved_views_vector.txt",
        dump.as_bytes(),
    )
    .expect("write saved_views prefs vector dump");
}

/// Generator for the MYND-58 `last_backup_at` vector cases (appended to
/// the companion repo's `vault-prefs` family; per-feature-generator
/// pattern of [`emit_label_and_tolerance_prefs_vectors`]):
///
/// `cargo test -p protocol --lib emit_last_backup_at_prefs_vectors -- --ignored`
///
/// - `encrypt-last-backup-at`: `label` + `last_backup_at` both set so the
///   emitted canonical bytes pin the order of the two 'l' keys
///   (`label` [lab] < `last_backup_at` [las] < `screen_capture_protection`)
///   and the bare-decimal u64 epoch encoding.
/// - `decrypt-last-backup-at`: round-trip of the blob above; decoders
///   must surface the epoch value.
#[test]
#[ignore = "vector generator; run explicitly and splice the JSON into myne-test-vectors"]
fn emit_ribbon_fields_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
    // 0xF3, the next entry free after the sibling generators' 0xF1 and the
    // periodic-notes case's 0xF2. (0xF2 was used here once and collided.)
    let nonce: [u8; AEAD_NONCE_LEN] = [0xF3; AEAD_NONCE_LEN];
    let prefs = PrefsView {
        ribbon_items: Some(alloc::vec![
            String::from("note.new"),
            String::from("periodic.open-this-week"),
        ]),
        ribbon_visible: false,
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs);
    assert_eq!(
            canonical.as_slice(),
            br#"{"ribbon_items":["note.new","periodic.open-this-week"],"ribbon_visible":false,"screen_capture_protection":true}"#.as_slice(),
        );
    let blob =
        encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce).expect("encode");
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
    assert_eq!(decoded, prefs);

    let desc_enc = "myne-md/myne#699 left-ribbon fields (vault.prefs). ribbon_items is Some([...]) (a CONFIGURED rail; order is the payload, preserved verbatim) and ribbon_visible is false, the only value the encoder emits because true is omitted. Pins the canonical key order ribbon_items < ribbon_visible < screen_capture_protection. Generated by `cargo test -p protocol --lib emit_ribbon_fields_prefs_vectors -- --ignored`.";
    let desc_dec = "Round-trip with encrypt-ribbon-fields: the blob decodes back to a PrefsView carrying ribbon_items + ribbon_visible=false + screen_capture_protection=true under the same root_key + account_number_hash. Verifies decoders surface the two fields from their canonical position between reminders_enabled and right_panel_active_tab, and that an explicitly emptied rail (Some([])) is distinct from a never-configured one (absent).";

    let enc_line = alloc::format!(
                "{{\n \"vector_id\": \"vault-prefs/v0.1/encrypt-ribbon-fields\",\n \"description\": \"{}\",\n \"case_kind\": \"encrypt\",\n \"input_root_key_hex\": \"{}\",\n \"input_account_number_hash_hex\": \"{}\",\n \"input_plaintext_canonical_utf8_hex\": \"{}\",\n \"input_prefs_nonce_hex\": \"{}\",\n \"informational_prefs_key_hex\": \"{}\",\n \"expected_prefs_blob_hex\": \"{}\"\n}}",
                json_escape(desc_enc),
                hex_lower(&root_a),
                hex_lower(&account_hash_a),
                hex_lower(&canonical),
                hex_lower(&nonce),
                hex_lower(&*prefs_key_a),
                hex_lower(&blob),
        );
    let dec_line = alloc::format!(
                "{{\n \"vector_id\": \"vault-prefs/v0.1/decrypt-ribbon-fields\",\n \"description\": \"{}\",\n \"case_kind\": \"decrypt_ok\",\n \"input_blob_hex\": \"{}\",\n \"input_root_key_hex\": \"{}\",\n \"input_account_number_hash_hex\": \"{}\",\n \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n \"expected_prefs_view\": {{\n  \"ribbon_items\": [\"note.new\", \"periodic.open-this-week\"],\n  \"ribbon_visible\": false,\n  \"screen_capture_protection\": true\n }}\n}}",
                json_escape(desc_dec),
                hex_lower(&blob),
                hex_lower(&root_a),
                hex_lower(&account_hash_a),
                hex_lower(&canonical),
        );
    std::println!("{enc_line}");
    std::println!("{dec_line}");
}

#[test]
#[ignore]
fn emit_last_backup_at_prefs_vectors() {
    extern crate std;

    // Same fixed vault-A inputs as the sibling generators; nonce 0xF1 is
    // the next free entry in the family's nonce registry (0x77, 0x88,
    // 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE are taken).
    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    let nonce: [u8; AEAD_NONCE_LEN] = [0xF1; AEAD_NONCE_LEN];
    let prefs = PrefsView {
        label: Some(String::from("Work")),
        last_backup_at: Some(1765432100),
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        paired_extensions: Vec::new(),
        periodic_notes: Default::default(),
        right_panel_active_tab: None,
        right_panel_hidden_tabs: Vec::new(),
        right_panel_tab_order: Vec::new(),
        editor_slash_hidden: Vec::new(),
        editor_slash_order: Vec::new(),
        editor_toolbar_hidden: Vec::new(),
        editor_toolbar_order: Vec::new(),
        spell_enabled: None,
        spell_languages: Vec::new(),
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs);
    assert_eq!(
        canonical.as_slice(),
        br#"{"label":"Work","last_backup_at":1765432100,"screen_capture_protection":true}"#
            .as_slice(),
        "canonical plaintext must sort label < last_backup_at < screen_capture_protection",
    );
    let blob =
        encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce).expect("encode");
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
    assert_eq!(decoded, prefs);

    let mut dump = alloc::string::String::new();
    dump.push_str("---begin last_backup_at prefs vectors---\n\n");

    dump.push_str("# case 1/2: encrypt-last-backup-at (MYND-58; lab < las < s; bare u64)\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "prefs_key_hex (informational): {}\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8: {}\n",
        core::str::from_utf8(&canonical).unwrap_or("<non-utf8>")
    ));
    dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n\n",
        hex_lower(&blob)
    ));

    dump.push_str("# case 2/2: decrypt-last-backup-at (round-trip with case 1)\n");
    dump.push_str(&alloc::format!("input_blob_hex: {}\n", hex_lower(&blob)));
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("expected_kind: ok\n");
    dump.push_str(&alloc::format!(
        "expected_plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical)
    ));
    dump.push_str(
            "expected_prefs_view: { \"label\": \"Work\", \"last_backup_at\": 1765432100, \"screen_capture_protection\": true }\n\n",
        );

    dump.push_str("---end last_backup_at prefs vectors---\n");
    std::fs::write(
        "/tmp/myne_vault_prefs_last_backup_vectors.txt",
        dump.as_bytes(),
    )
    .expect("write last_backup_at prefs vectors dump");
}

/// Generator for the editor-line-numbers (MYND-314) `editor_line_numbers` vector cases
/// (appended to the companion repo's `vault-prefs` family; per-feature generator, keeps the
/// originals byte-stable — the [`emit_amoled_theme_prefs_vector`] pattern):
///
/// `cargo test -p protocol --lib emit_line_numbers_prefs_vector -- --ignored`
///
/// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying the optional line-number
/// gutter toggle (`editor_line_numbers: Some(true)` → canonical `"editor_line_numbers":true`).
/// Pins the bool encoding and its canonical key slot (after `editor_layout`, before
/// `screen_capture_protection`) plus the round-trip back through the decoder. Nonce `0xF4` is
/// the next free entry in the family's nonce registry (0x77–0xF3 taken by the sibling
/// generators). Omit-when-`None` keeps an untouched vault byte-identical to a pre-feature blob
/// (no encrypt case needed for that — `encrypt-default` already pins the bare form).
#[test]
#[ignore]
fn emit_line_numbers_prefs_vector() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    let nonce: [u8; AEAD_NONCE_LEN] = [0xF4; AEAD_NONCE_LEN];
    let prefs = PrefsView {
        editor_line_numbers: Some(true),
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs);
    assert_eq!(
            canonical.as_slice(),
            br#"{"editor_line_numbers":true,"screen_capture_protection":true}"#.as_slice(),
            "canonical plaintext must place editor_line_numbers before screen_capture_protection as a bare bool",
        );
    let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
        .expect("encode line_numbers");
    // Round-trip self-validation.
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
    assert_eq!(decoded, prefs);
    assert_eq!(decoded.editor_line_numbers, Some(true));

    let mut dump = alloc::string::String::new();
    dump.push_str("---begin editor_line_numbers prefs vectors (MYND-314)---\n\n");

    dump.push_str("# case 1/2: encrypt-editor-line-numbers\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "prefs_key_hex (informational): {}\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8: {}\n",
        core::str::from_utf8(&canonical).unwrap_or("<non-utf8>")
    ));
    dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n\n",
        hex_lower(&blob)
    ));

    dump.push_str("# case 2/2: decrypt-editor-line-numbers (round-trip with case 1)\n");
    dump.push_str(&alloc::format!("input_blob_hex: {}\n", hex_lower(&blob)));
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("expected_kind: ok\n");
    dump.push_str(&alloc::format!(
        "expected_plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical)
    ));
    dump.push_str(
            "expected_prefs_view: { \"editor_line_numbers\": true, \"screen_capture_protection\": true }\n\n",
        );

    dump.push_str("---end editor_line_numbers prefs vectors---\n");
    std::fs::write(
        "/tmp/myne_vault_prefs_line_numbers_vector.txt",
        dump.as_bytes(),
    )
    .expect("write line_numbers prefs vector dump");
}

/// Generator for the `archive_disabled` (archive-disable) vector cases — appended to the
/// companion repo's `vault-prefs` family (per-feature generator, keeps the originals
/// byte-stable — the [`emit_line_numbers_prefs_vector`] pattern):
///
/// `cargo test -p protocol --lib emit_archive_disabled_prefs_vector -- --ignored`
///
/// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying the optional archive-disable
/// toggle (`archive_disabled: Some(true)` → canonical `"archive_disabled":true`). Pins the bool
/// encoding and its canonical key slot (after `active_workspace`, before `auto_lock_seconds`)
/// plus the round-trip back through the decoder. Nonce `0xA7` is a free entry in the family's
/// nonce registry. Omit-when-`None` keeps an untouched vault byte-identical to a pre-feature
/// blob (no encrypt case needed for that — `encrypt-default` already pins the bare form).
#[test]
#[ignore]
fn emit_archive_disabled_prefs_vector() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    let nonce: [u8; AEAD_NONCE_LEN] = [0xA7; AEAD_NONCE_LEN];
    let prefs = PrefsView {
        archive_disabled: Some(true),
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs);
    assert_eq!(
            canonical.as_slice(),
            br#"{"archive_disabled":true,"screen_capture_protection":true}"#.as_slice(),
            "canonical plaintext must place archive_disabled before screen_capture_protection as a bare bool",
        );
    let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
        .expect("encode archive_disabled");
    // Round-trip self-validation.
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
    assert_eq!(decoded, prefs);
    assert_eq!(decoded.archive_disabled, Some(true));

    let mut dump = alloc::string::String::new();
    dump.push_str("---begin archive_disabled prefs vectors (archive-disable)---\n\n");

    dump.push_str("# case 1/2: encrypt-archive-disabled\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "prefs_key_hex (informational): {}\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8: {}\n",
        core::str::from_utf8(&canonical).unwrap_or("<non-utf8>")
    ));
    dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n\n",
        hex_lower(&blob)
    ));

    dump.push_str("# case 2/2: decrypt-archive-disabled (round-trip with case 1)\n");
    dump.push_str(&alloc::format!("input_blob_hex: {}\n", hex_lower(&blob)));
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("expected_kind: ok\n");
    dump.push_str(&alloc::format!(
        "expected_plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical)
    ));
    dump.push_str(
            "expected_prefs_view: { \"archive_disabled\": true, \"screen_capture_protection\": true }\n\n",
        );

    dump.push_str("---end archive_disabled prefs vectors---\n");
    std::fs::write(
        "/tmp/myne_vault_prefs_archive_disabled_vector.txt",
        dump.as_bytes(),
    )
    .expect("write archive_disabled prefs vector dump");
}

/// Generator for the `archived_folders` (folder-archive) vector cases — appended to the
/// companion repo's `vault-prefs` family (per-feature generator, keeps the originals
/// byte-stable — the [`emit_archive_disabled_prefs_vector`] pattern):
///
/// `cargo test -p protocol --lib emit_archived_folders_prefs_vectors -- --ignored`
///
/// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying the folder-archive set
/// (`archived_folders: ["Alpha/","Zeta/"]`, given unsorted with a duplicate to pin the
/// set-canonical sort+dedup). Its canonical key slot sits between `archive_disabled` and
/// `auto_lock_seconds`, so both neighbors are present to pin the exact ordering. Nonce `0xAF`
/// is a free entry in the family's nonce registry. Omit-when-empty keeps an untouched vault
/// byte-identical to a pre-feature blob (`encrypt-default` pins the bare form).
#[test]
#[ignore]
fn emit_archived_folders_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    let nonce: [u8; AEAD_NONCE_LEN] = [0xAF; AEAD_NONCE_LEN];
    let prefs = PrefsView {
        archive_disabled: Some(true),
        archived_folders: alloc::vec![
            alloc::string::String::from("Zeta/"),
            alloc::string::String::from("Alpha/"),
            alloc::string::String::from("Alpha/"),
        ],
        auto_lock_seconds: Some(300),
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs);
    assert_eq!(
            canonical.as_slice(),
            br#"{"archive_disabled":true,"archived_folders":["Alpha/","Zeta/"],"auto_lock_seconds":300,"screen_capture_protection":true}"#.as_slice(),
            "canonical plaintext must sort+dedupe archived_folders and place it between archive_disabled and auto_lock_seconds",
        );
    let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
        .expect("encode archived_folders");
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
    // The encoder sorts + dedupes the set, so the decoded form carries the
    // canonical `["Alpha/","Zeta/"]` (not the unsorted+dup input struct).
    assert_eq!(
        decoded.archived_folders,
        alloc::vec![
            alloc::string::String::from("Alpha/"),
            alloc::string::String::from("Zeta/"),
        ]
    );
    assert_eq!(decoded.archive_disabled, Some(true));
    assert_eq!(decoded.auto_lock_seconds, Some(300));

    let mut dump = alloc::string::String::new();
    dump.push_str("---begin archived_folders prefs vectors (folder-archive)---\n\n");

    dump.push_str("# case 1/2: encrypt-archived-folders\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "prefs_key_hex (informational): {}\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8: {}\n",
        core::str::from_utf8(&canonical).unwrap_or("<non-utf8>")
    ));
    dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n\n",
        hex_lower(&blob)
    ));

    dump.push_str("# case 2/2: decrypt-archived-folders (round-trip with case 1)\n");
    dump.push_str(&alloc::format!("input_blob_hex: {}\n", hex_lower(&blob)));
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("expected_kind: ok\n");
    dump.push_str(&alloc::format!(
        "expected_plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical)
    ));
    dump.push_str(
            "expected_prefs_view: { \"archive_disabled\": true, \"archived_folders\": [\"Alpha/\", \"Zeta/\"], \"auto_lock_seconds\": 300, \"screen_capture_protection\": true }\n\n",
        );

    dump.push_str("---end archived_folders prefs vectors---\n");
    std::fs::write(
        "/tmp/myne_vault_prefs_archived_folders_vectors.txt",
        dump.as_bytes(),
    )
    .expect("write archived_folders prefs vector dump");
}

/// Generator for the batch editor-prefs (MYND-308 / MYND-299 / MYND-348) vector cases (appended
/// to the companion repo's `vault-prefs` family; per-feature generator, keeps the originals
/// byte-stable — the [`emit_line_numbers_prefs_vector`] pattern):
///
/// `cargo test -p protocol --lib emit_batch_editor_prefs_vector -- --ignored`
///
/// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying all four optional batch
/// fields at once — `active_workspace` (canonical FIRST key), `editor_default_view_mode`
/// (string), `editor_focus_dim_inactive` + `editor_focus_typewriter` (bools). Pins the
/// canonical key slots (active_workspace < … < editor_content_width < editor_default_view_mode
/// < editor_focus_dim_inactive < editor_focus_typewriter < editor_font_family) and the
/// string-vs-bare-bool encoding plus the round-trip back through the decoder. Nonce `0x95` is a
/// free entry in the family's nonce registry. Omit-when-`None` keeps an untouched vault
/// byte-identical to a pre-feature blob (no encrypt case needed for that — `encrypt-default`
/// already pins it).
#[test]
#[ignore]
fn emit_batch_editor_prefs_vector() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    let nonce: [u8; AEAD_NONCE_LEN] = [0x95; AEAD_NONCE_LEN];
    let prefs = PrefsView {
        active_workspace: Some(alloc::string::String::from(
            "0190a000-0000-7000-8000-0000000000ff",
        )),
        editor_default_view_mode: Some(alloc::string::String::from("reading")),
        editor_focus_dim_inactive: Some(true),
        editor_focus_typewriter: Some(false),
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs);
    assert_eq!(
            canonical.as_slice(),
            br#"{"active_workspace":"0190a000-0000-7000-8000-0000000000ff","editor_default_view_mode":"reading","editor_focus_dim_inactive":true,"editor_focus_typewriter":false,"screen_capture_protection":true}"#.as_slice(),
            "canonical plaintext must place active_workspace first then the editor batch fields in canonical order",
        );
    let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
        .expect("encode batch editor prefs");
    // Round-trip self-validation.
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
    assert_eq!(decoded, prefs);

    let mut dump = alloc::string::String::new();
    dump.push_str("---begin batch editor prefs vectors (MYND-308/299/348)---\n\n");

    dump.push_str("# case 1/2: encrypt-batch-editor-prefs\n");
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "prefs_key_hex (informational): {}\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8_hex: {}\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "plaintext_canonical_utf8: {}\n",
        core::str::from_utf8(&canonical).unwrap_or("<non-utf8>")
    ));
    dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
    dump.push_str(&alloc::format!(
        "expected_prefs_blob_hex: {}\n\n",
        hex_lower(&blob)
    ));

    dump.push_str("# case 2/2: decrypt-batch-editor-prefs (round-trip with case 1)\n");
    dump.push_str(&alloc::format!("input_blob_hex: {}\n", hex_lower(&blob)));
    dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
    dump.push_str(&alloc::format!(
        "account_number_hash_hex: {}\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("expected_kind: ok\n");
    dump.push_str(&alloc::format!(
        "expected_plaintext_canonical_utf8_hex: {}\n\n",
        hex_lower(&canonical)
    ));

    dump.push_str("---end batch editor prefs vectors---\n");
    std::fs::write(
        "/tmp/myne_vault_prefs_batch_editor_vector.txt",
        dump.as_bytes(),
    )
    .expect("write batch editor prefs vector dump");
}

/// Generator for the MYND-304 `keymap` vector cases (hotkeys epic;
/// appended to the companion repo's `vault-prefs` family; per-feature-
/// generator pattern of [`emit_label_and_tolerance_prefs_vectors`], keeping
/// the original generators byte-stable). Emits a JSON **array fragment** of
/// 3 case objects at `/tmp/myne_vault_prefs_keymap_vectors.json`, spliced by
/// hand into the existing `cases` array.
///
/// `cargo test -p protocol --lib emit_keymap_prefs_vectors -- --ignored`
///
/// - `encrypt-keymap`: `item_order` + `keymap` + `label` set so the canonical
///   bytes pin the key order item_order (i) < keymap (k) < label (l) < scp (s),
///   the inner string→array object (command id → chord set), the set-canonical
///   chord array (sorted + deduped), and the explicit-unbind state (`[]`,
///   distinct from an absent command, preserved verbatim).
/// - `decrypt-keymap`: round-trip of the blob above.
/// - `parse-fail-keymap-value-not-array`: a validly-sealed envelope whose inner
///   plaintext gives a `keymap` value as a bare string instead of an array;
///   AEAD passes, the canonical-JSON parse rejects (`plaintext_parse_failed`).
///   Sealed manually (the typed encoder can only emit canonical v0.1 plaintexts).
#[test]
#[ignore]
fn emit_keymap_prefs_vectors() {
    extern crate std;
    use crate::aead::{aad_prefs_blob, aead_seal_ctx, CTX_COMMITMENT_TAG_LEN};

    // Same fixed vault-A inputs as the sibling generators; nonces 0xF4 / 0xF5
    // are the next free entries in the family's nonce registry (0x77, 0x88,
    // 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xF1, 0xF2, 0xF3 are taken).
    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    // --- encrypt-keymap + decrypt-keymap -------------------------------
    let nonce_keymap: [u8; AEAD_NONCE_LEN] = [0xF4; AEAD_NONCE_LEN];
    let mut keymap = BTreeMap::new();
    keymap.insert(
        String::from("app.command-palette"),
        alloc::vec![String::from("Mod-k"), String::from("Mod-p")],
    );
    keymap.insert(String::from("vault.lock"), Vec::new()); // explicit-unbind
    let prefs_keymap = PrefsView {
        item_order: BTreeMap::from([(String::from(""), alloc::vec![String::from("n1")])]),
        keymap: keymap.clone(),
        label: Some(String::from("Work")),
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs_keymap);
    assert_eq!(
            canonical.as_slice(),
            br#"{"item_order":{"":["n1"]},"keymap":{"app.command-palette":["Mod-k","Mod-p"],"vault.lock":[]},"label":"Work","screen_capture_protection":true}"#.as_slice(),
            "canonical bytes must pin i<k<l<s, set-canonical chords, and the []-unbind state",
        );
    let blob_keymap =
        encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_keymap, &nonce_keymap)
            .expect("encode keymap");
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_keymap).expect("decode");
    assert_eq!(decoded, prefs_keymap, "keymap blob must round-trip exactly");
    assert_eq!(
        decoded.keymap.get("vault.lock"),
        Some(&Vec::<String>::new()),
        "explicit-unbind []  must survive round-trip",
    );

    // --- parse-fail-keymap-value-not-array -----------------------------
    let nonce_bad: [u8; AEAD_NONCE_LEN] = [0xF5; AEAD_NONCE_LEN];
    // keymap value is a bare string, not an array → structural parse reject.
    let bad_plaintext: &[u8] = br#"{"keymap":{"a.cmd":"Mod-a"},"screen_capture_protection":true}"#;
    let aad = aad_prefs_blob(&account_hash_a);
    let sealed = aead_seal_ctx(&prefs_key_a, &nonce_bad, bad_plaintext, &aad).expect("seal bad");
    debug_assert_eq!(sealed.len(), bad_plaintext.len() + CTX_COMMITMENT_TAG_LEN);
    let mut blob_bad = Vec::with_capacity(PREFS_BLOB_HEADER_LEN + sealed.len());
    blob_bad.extend_from_slice(&PREFS_BLOB_MAGIC);
    blob_bad.push(PREFS_BLOB_PROTOCOL_VERSION);
    blob_bad.push(PREFS_BLOB_RESERVED);
    blob_bad.extend_from_slice(&nonce_bad);
    blob_bad.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
    blob_bad.extend_from_slice(&sealed);
    assert_eq!(
        decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_bad).as_ref(),
        Err(&PrefsBlobError::PlaintextParseFailed),
        "a non-array keymap value must reject at the canonical-JSON parse stage",
    );

    let mut dump = alloc::string::String::new();
    dump.push_str("[\n");

    // case 1/3: encrypt-keymap
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/encrypt-keymap\",\n");
    dump.push_str("      \"description\": \"MYND-304 keymap overrides. PrefsView carries item_order + keymap (a string->array object: command id -> chord set) + label, pinning the canonical key order item_order (i) < keymap (k) < label (l) < screen_capture_protection (s), the inner lexicographic key order (app.command-palette < vault.lock), the set-canonical chord array (sorted Mod-k < Mod-p), and the explicit-unbind state (vault.lock -> [], preserved verbatim and distinct from an absent command). Same vault-A inputs as the sibling cases; prefs_nonce=0xF4x24. Generated by emit_keymap_prefs_vectors in protocol/src/prefs.rs.\",\n");
    dump.push_str("      \"case_kind\": \"encrypt\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_prefs_nonce_hex\": \"{}\",\n",
        hex_lower(&nonce_keymap)
    ));
    dump.push_str(&alloc::format!(
        "      \"informational_prefs_key_hex\": \"{}\",\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_prefs_blob_hex\": \"{}\"\n",
        hex_lower(&blob_keymap)
    ));
    dump.push_str("    },\n");

    // case 2/3: decrypt-keymap
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/decrypt-keymap\",\n");
    dump.push_str("      \"description\": \"Round-trip with encrypt-keymap: the blob decodes back to a PrefsView carrying item_order + the keymap override map + label under the same root_key + account_number_hash. Verifies decoders surface the MYND-304 keymap from its canonical position between item_order and label, parse the inner string->array object, and preserve the []-unbind entry verbatim.\",\n");
    dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_blob_hex\": \"{}\",\n",
        hex_lower(&blob_keymap)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str("      \"expected_prefs_view\": {\n");
    dump.push_str("        \"screen_capture_protection\": true,\n");
    dump.push_str("        \"item_order\": { \"\": [\"n1\"] },\n");
    dump.push_str("        \"keymap\": { \"app.command-palette\": [\"Mod-k\", \"Mod-p\"], \"vault.lock\": [] },\n");
    dump.push_str("        \"label\": \"Work\"\n");
    dump.push_str("      }\n");
    dump.push_str("    },\n");

    // case 3/3: parse-fail-keymap-value-not-array
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/parse-fail-keymap-value-not-array\",\n");
    dump.push_str("      \"description\": \"A structurally valid envelope sealed under the REAL prefs_key + AAD whose inner plaintext gives a keymap value as a bare string (a.cmd -> \\\"Mod-a\\\") instead of an array. AEAD verification succeeds; the reject fires at the canonical-JSON parse stage (the chord set MUST be an array). Distinguishable plaintext_parse_failed, not a CannotDecrypt. Sealed manually (the typed encoder can only emit canonical v0.1 plaintexts); prefs_nonce=0xF5x24.\",\n");
    dump.push_str("      \"case_kind\": \"parse_fail\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_blob_hex\": \"{}\",\n",
        hex_lower(&blob_bad)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str("      \"expected_error\": \"plaintext_parse_failed\",\n");
    dump.push_str("      \"informational_tamper_description\": \"validly-sealed inner plaintext with a non-array keymap value (nonce 0xf5x24)\"\n");
    dump.push_str("    }\n");

    dump.push_str("]\n");

    std::fs::write("/tmp/myne_vault_prefs_keymap_vectors.json", dump.as_bytes())
        .expect("write vault-prefs keymap vectors dump");
}

/// Generator for the right-panel-tabs vault-prefs vectors (right-panel tabs;
/// per-feature-generator pattern of [`emit_keymap_prefs_vectors`]). Emits a
/// 2-case JSON **array fragment** (encrypt + decrypt_ok) at
/// `/tmp/myne_vault_prefs_right_panel_vectors.json`, spliced by hand into the
/// existing `cases` array. Exercises the three additive fields
/// `right_panel_active_tab` (Option<String> pointer) / `right_panel_hidden_tabs`
/// (set-canonical: sorted+deduped) / `right_panel_tab_order` (sequence:
/// verbatim). Same fixed vault-A inputs as the sibling generators;
/// prefs_nonce=0xF6 (the next free entry in the family's nonce registry —
/// 0x77/0x88/0x99/0xAA/0xBB/0xCC/0xDD/0xEE/0xF1..0xF5 are taken).
///
/// `cargo test -p protocol --lib emit_right_panel_prefs_vectors -- --ignored`
#[test]
#[ignore]
fn emit_right_panel_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    let nonce_rp: [u8; AEAD_NONCE_LEN] = [0xF6; AEAD_NONCE_LEN];
    let prefs_rp = PrefsView {
        right_panel_active_tab: Some(String::from("backlinks")),
        right_panel_hidden_tabs: alloc::vec![String::from("outline")],
        right_panel_tab_order: alloc::vec![
            String::from("backlinks"),
            String::from("unlinked"),
            String::from("outline"),
        ],
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs_rp);
    assert_eq!(
            canonical.as_slice(),
            br#"{"right_panel_active_tab":"backlinks","right_panel_hidden_tabs":["outline"],"right_panel_tab_order":["backlinks","unlinked","outline"],"screen_capture_protection":true}"#.as_slice(),
            "canonical bytes must pin right_panel_active_tab < right_panel_hidden_tabs < right_panel_tab_order < screen_capture_protection (all between paired_extensions and saved_views), set-canonical hidden tabs, verbatim tab order",
        );
    let blob_rp = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_rp, &nonce_rp)
        .expect("encode right-panel");
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_rp).expect("decode");
    assert_eq!(
        decoded, prefs_rp,
        "right-panel blob must round-trip exactly"
    );

    let mut dump = alloc::string::String::new();
    dump.push_str("[\n");

    // case 1/2: encrypt-right-panel-tabs
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/encrypt-right-panel-tabs\",\n");
    dump.push_str("      \"description\": \"Right-panel tabs. PrefsView carries right_panel_active_tab (an Option<String> pointer) + right_panel_hidden_tabs (set-canonical: sorted+deduped) + right_panel_tab_order (sequence: verbatim), pinning the canonical key order right_panel_active_tab (r-a) < right_panel_hidden_tabs (r-h) < right_panel_tab_order (r-t) < screen_capture_protection (s), all sorting between paired_extensions (p) and saved_views (sav). Same vault-A inputs as the sibling cases; prefs_nonce=0xF6x24. Generated by emit_right_panel_prefs_vectors in protocol/src/prefs.rs.\",\n");
    dump.push_str("      \"case_kind\": \"encrypt\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_prefs_nonce_hex\": \"{}\",\n",
        hex_lower(&nonce_rp)
    ));
    dump.push_str(&alloc::format!(
        "      \"informational_prefs_key_hex\": \"{}\",\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_prefs_blob_hex\": \"{}\"\n",
        hex_lower(&blob_rp)
    ));
    dump.push_str("    },\n");

    // case 2/2: decrypt-right-panel-tabs
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/decrypt-right-panel-tabs\",\n");
    dump.push_str("      \"description\": \"Round-trip with encrypt-right-panel-tabs: the blob decodes back to a PrefsView carrying the active-tab pointer + the hidden-tabs set + the tab-order sequence under the same root_key + account_number_hash. Verifies decoders surface the three right-panel fields from their canonical positions between paired_extensions and saved_views, canonicalize the hidden set (sorted+deduped), and preserve the order sequence verbatim.\",\n");
    dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_blob_hex\": \"{}\",\n",
        hex_lower(&blob_rp)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str("      \"expected_prefs_view\": {\n");
    dump.push_str("        \"screen_capture_protection\": true,\n");
    dump.push_str("        \"right_panel_active_tab\": \"backlinks\",\n");
    dump.push_str("        \"right_panel_hidden_tabs\": [\"outline\"],\n");
    dump.push_str(
        "        \"right_panel_tab_order\": [\"backlinks\", \"unlinked\", \"outline\"]\n",
    );
    dump.push_str("      }\n");
    dump.push_str("    }\n");

    dump.push_str("]\n");

    std::fs::write(
        "/tmp/myne_vault_prefs_right_panel_vectors.json",
        dump.as_bytes(),
    )
    .expect("write vault-prefs right-panel vectors dump");
}

/// Generator for the MYND-478 `field_clocks` vault-prefs vectors (Phase 2
/// prefs sync; per-feature-generator pattern of
/// [`emit_right_panel_prefs_vectors`]). Emits a 2-case JSON **array
/// fragment** (encrypt + decrypt_ok) at
/// `/tmp/myne_vault_prefs_field_clocks_vectors.json`, spliced by hand into
/// the existing `cases` array. Exercises the additive
/// `field_clocks` map (string key → epoch-ms u64) in its canonical slot
/// between `favorites` (fa) and `folder_icons` (fo), including a
/// namespaced `device_names/<key>` entry. Same fixed vault-A inputs as the
/// sibling generators; prefs_nonce=0xF7 (the next free entry in the
/// family's nonce registry — 0x77..0xEE + 0xF1..0xF6 are taken).
///
/// `cargo test -p protocol --lib emit_field_clocks_prefs_vectors -- --ignored`
#[test]
#[ignore]
fn emit_field_clocks_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    let nonce_fc: [u8; AEAD_NONCE_LEN] = [0xF7; AEAD_NONCE_LEN];
    let mut clocks = BTreeMap::new();
    clocks.insert(String::from("label"), 1_765_432_099_000u64);
    clocks.insert(
        String::from("device_names/3f9ac2d1aabbccdd00112233445566ff"),
        1_765_432_100_000u64,
    );
    let prefs_fc = PrefsView {
        favorites: alloc::vec![String::from("0190a000-0000-7000-8000-000000000002")],
        field_clocks: clocks,
        folder_icons: {
            let mut m = BTreeMap::new();
            m.insert(String::from("Projects/Myne/"), String::from("book"));
            m
        },
        label: Some(String::from("Work")),
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs_fc);
    assert_eq!(
            canonical.as_slice(),
            br#"{"favorites":["0190a000-0000-7000-8000-000000000002"],"field_clocks":{"device_names/3f9ac2d1aabbccdd00112233445566ff":1765432100000,"label":1765432099000},"folder_icons":{"Projects/Myne/":"book"},"label":"Work","screen_capture_protection":true}"#.as_slice(),
            "canonical bytes must pin favorites (fa) < field_clocks (fi) < folder_icons (fo) < label (l) < screen_capture_protection (s), lexicographic clock keys, bare-decimal epoch-ms values",
        );
    let blob_fc = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_fc, &nonce_fc)
        .expect("encode field-clocks");
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_fc).expect("decode");
    assert_eq!(
        decoded, prefs_fc,
        "field-clocks blob must round-trip exactly"
    );

    let mut dump = alloc::string::String::new();
    dump.push_str("[\n");

    // case 1/2: encrypt-field-clocks
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/encrypt-field-clocks\",\n");
    dump.push_str("      \"description\": \"Per-field LWW clocks (MYND-478, Phase 2 prefs sync). PrefsView carries the additive field_clocks map (string key -> epoch-ms u64; here the 'label' field clock plus a namespaced device_names/<key> per-entry clock) beside favorites, folder_icons and label, pinning the canonical key order favorites (fa) < field_clocks (fi) < folder_icons (fo) < label (l) < screen_capture_protection (s), lexicographic clock-key order inside the map, and bare-decimal integer values (floats forbidden). Same vault-A inputs as the sibling cases; prefs_nonce=0xF7x24. Generated by emit_field_clocks_prefs_vectors in protocol/src/prefs.rs.\",\n");
    dump.push_str("      \"case_kind\": \"encrypt\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_prefs_nonce_hex\": \"{}\",\n",
        hex_lower(&nonce_fc)
    ));
    dump.push_str(&alloc::format!(
        "      \"informational_prefs_key_hex\": \"{}\",\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_prefs_blob_hex\": \"{}\"\n",
        hex_lower(&blob_fc)
    ));
    dump.push_str("    },\n");

    // case 2/2: decrypt-field-clocks
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/decrypt-field-clocks\",\n");
    dump.push_str("      \"description\": \"Round-trip with encrypt-field-clocks: the blob decodes back to a PrefsView carrying the field_clocks map (label clock + namespaced device_names/<key> clock) under the same root_key + account_number_hash. Verifies decoders surface field_clocks from its canonical position between favorites and folder_icons and parse the inner string->integer object; a decoder that does not know the field (pre-MYND-478) tolerates it per the §9.5.2 forward-compat rule and treats every clock as absent (= 0 to the sync-protocol.md §10.2 merge).\",\n");
    dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_blob_hex\": \"{}\",\n",
        hex_lower(&blob_fc)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str("      \"expected_prefs_view\": {\n");
    dump.push_str("        \"screen_capture_protection\": true,\n");
    dump.push_str("        \"favorites\": [\"0190a000-0000-7000-8000-000000000002\"],\n");
    dump.push_str("        \"field_clocks\": { \"device_names/3f9ac2d1aabbccdd00112233445566ff\": 1765432100000, \"label\": 1765432099000 },\n");
    dump.push_str("        \"folder_icons\": { \"Projects/Myne/\": \"book\" },\n");
    dump.push_str("        \"label\": \"Work\"\n");
    dump.push_str("      }\n");
    dump.push_str("    }\n");

    dump.push_str("]\n");

    std::fs::write(
        "/tmp/myne_vault_prefs_field_clocks_vectors.json",
        dump.as_bytes(),
    )
    .expect("write vault-prefs field-clocks vectors dump");
}

/// Generator for the `chat_history_budget` `vault-prefs` cases
/// (myne-md/myne#617, the agent chat-history seed budget).
///
/// Writes `/tmp/myne_vault_prefs_chat_history_budget_vectors.json`, a JSON
/// array fragment spliced by hand into the companion repo's existing
/// `cases` array.
///
/// **Why the field needs a vector at all**, since it is one optional
/// integer: `vault.prefs` is canonical JSON, so key ORDER is part of the
/// bytes, and this field's slot is the load-bearing half of its own design.
/// It sorts between `bar_items_order` (`b`) and `cli_enabled` (`cl`), which
/// puts it in the region `find_top_level_marker` scans forward through;
/// named `agent_history_budget` it would have landed inside the
/// prefix-matched run that ends at `auto_lock_seconds`, where an
/// unrecognised key blinds every field behind it in a client that predates
/// it (`docs/spec/protocol.md` §9.5.2, schema-evolution paragraph). A port
/// that emits the right value in the wrong slot produces a blob this crate
/// cannot decode, and until these cases existed no vector said so: the
/// companion repo carried a schema property with the claim written in prose
/// and nothing behind it.
///
/// **Both canonical NEIGHBOURS are present in the fixture**, which is what
/// makes this a slot pin rather than a value pin. The blob carries
/// `bar_items_order` and `cli_enabled` either side of it.
///
/// The value is 3000, deliberately not the host's 12000 ceiling: the
/// ceiling is a host policy applied in the SETTER and is not a property of
/// the format, so pinning it here would put a second copy of a host
/// constant in another repository, where drift is silent. What the vectors
/// pin is the bare-decimal integer encoding, the canonical slot, and the
/// omitted-when-unset rule (every other case in the family carries no
/// `chat_history_budget` key at all and stays byte-identical to its
/// pre-feature self).
///
/// Nonce `0xF8` — the next free entry in this family's registry
/// (0x77..0xF7 taken).
///
/// `cargo test -p protocol --lib emit_chat_history_budget_prefs_vectors -- --ignored`
#[test]
#[ignore]
fn emit_chat_history_budget_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    let nonce_chb: [u8; AEAD_NONCE_LEN] = [0xF8; AEAD_NONCE_LEN];
    let prefs_chb = PrefsView {
        bar_items_order: alloc::vec![
            String::from("view-mode"),
            String::from("tags"),
            String::from("graph"),
        ],
        chat_history_budget: Some(3000),
        cli_enabled: true,
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs_chb);
    assert_eq!(
            canonical.as_slice(),
            br#"{"bar_items_order":["view-mode","tags","graph"],"chat_history_budget":3000,"cli_enabled":true,"screen_capture_protection":true}"#.as_slice(),
            "canonical bytes must pin bar_items_order (b) < chat_history_budget (ch) < cli_enabled (cl), and the budget as a bare decimal integer",
        );
    let blob_chb = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_chb, &nonce_chb)
        .expect("encode chat-history-budget");
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_chb).expect("decode");
    assert_eq!(
        decoded, prefs_chb,
        "chat-history-budget blob must round-trip exactly"
    );

    // The omit-when-unset half, asserted rather than described: the same
    // view with the field back to `None` must encode to bytes carrying no
    // `chat_history_budget` key at all, so a vault that never overrode the
    // host default stays byte-identical to its pre-feature self.
    let prefs_unset = PrefsView {
        chat_history_budget: None,
        ..prefs_chb.clone()
    };
    let canonical_unset = canonical_json_encode(&prefs_unset);
    assert_eq!(
            canonical_unset.as_slice(),
            br#"{"bar_items_order":["view-mode","tags","graph"],"cli_enabled":true,"screen_capture_protection":true}"#.as_slice(),
            "an unset budget must be omitted entirely, not encoded as 0",
        );

    let mut dump = alloc::string::String::new();
    dump.push_str("[\n");

    // case 1/2: encrypt-chat-history-budget
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/encrypt-chat-history-budget\",\n");
    dump.push_str("      \"description\": \"The agent chat-history seed budget (myne-md/myne#617). An optional unsigned integer encoded as a BARE DECIMAL, pinned between both of its canonical neighbours: bar_items_order (b) < chat_history_budget (ch) < cli_enabled (cl). That slot is the load-bearing half of the field's design -- it sits in the region a decoder scans forward through, so an older client steps over it, whereas a name sorting before auto_lock_seconds would have landed in the prefix-matched run where an unknown key blinds every field behind it (protocol.md 9.5.2 schema evolution). The value 3000 is deliberately not the host's clamp ceiling: that ceiling is applied in the SETTER and is host policy rather than format, so no vector pins it. Unset is OMITTED ENTIRELY rather than encoded as 0, which every other case in this family demonstrates by carrying no such key and staying byte-identical to its pre-feature self. Same vault-A inputs as the sibling cases; prefs_nonce=0xF8x24. Generated by emit_chat_history_budget_prefs_vectors in protocol/src/prefs.rs.\",\n");
    dump.push_str("      \"case_kind\": \"encrypt\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_prefs_nonce_hex\": \"{}\",\n",
        hex_lower(&nonce_chb)
    ));
    dump.push_str(&alloc::format!(
        "      \"informational_prefs_key_hex\": \"{}\",\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_prefs_blob_hex\": \"{}\"\n",
        hex_lower(&blob_chb)
    ));
    dump.push_str("    },\n");

    // case 2/2: decrypt-chat-history-budget
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/decrypt-chat-history-budget\",\n");
    dump.push_str("      \"description\": \"Round-trip with encrypt-chat-history-budget: the blob decodes back to a PrefsView carrying chat_history_budget=3000 between bar_items_order and cli_enabled under the same root_key + account_number_hash. A decoder that does not know the field (pre-myne#617) tolerates it per the 9.5.2 forward-compat rule and treats the budget as ABSENT rather than as 0 -- absent means the host applies its own default, which is a third state distinct from 'seed nothing'. That distinction is why this case exists beside the encrypt one: a port that maps a missing key to 0 decodes this blob correctly and its own default-carrying blob incorrectly.\",\n");
    dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_blob_hex\": \"{}\",\n",
        hex_lower(&blob_chb)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str("      \"expected_prefs_view\": {\n");
    dump.push_str("        \"screen_capture_protection\": true,\n");
    dump.push_str("        \"bar_items_order\": [\"view-mode\", \"tags\", \"graph\"],\n");
    dump.push_str("        \"chat_history_budget\": 3000,\n");
    dump.push_str("        \"cli_enabled\": true\n");
    dump.push_str("      }\n");
    dump.push_str("    }\n");

    dump.push_str("]\n");

    std::fs::write(
        "/tmp/myne_vault_prefs_chat_history_budget_vectors.json",
        dump.as_bytes(),
    )
    .expect("write vault-prefs chat-history-budget vectors dump");
}

/// Generator for the **meeting AI prompt** `vault-prefs` cases (meeting-ai).
///
/// `cargo test -p protocol --lib emit_meeting_ai_prompt_prefs_vectors -- --ignored`
///
/// A new shipped v0.1.x `PrefsView` field owes an `encrypt-*` /
/// `decrypt_ok-*` pair plus its schema property (`protocol/AGENTS.md`
/// "Adding a `PrefsView` field is four edits": the fifth edit is the
/// `vault-prefs` vector family, and "Prefs are not a vector surface" is the
/// wrong intuition). The load-bearing half here is the canonical SLOT:
/// `last_backup_at` (l) < `meeting_ai_prompt` (m) < `new_note_location` (n),
/// which sits in the region the decoder scans forward through, so an older
/// client steps over the unknown key and reads the following fields
/// correctly. Unset is OMITTED ENTIRELY rather than encoded as an empty
/// string, so a vault that never set it stays byte-identical to its
/// pre-feature self.
#[test]
#[ignore]
fn emit_meeting_ai_prompt_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    let nonce_maip: [u8; AEAD_NONCE_LEN] = [0xE0; AEAD_NONCE_LEN];
    let prefs_maip = PrefsView {
        last_backup_at: Some(1765432100),
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: Some(String::from("Summarize tersely, decisions first.")),
        new_note_location: Some(String::from("specific")),
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs_maip);
    assert_eq!(
            canonical.as_slice(),
            br#"{"last_backup_at":1765432100,"meeting_ai_prompt":"Summarize tersely, decisions first.","new_note_location":"specific","screen_capture_protection":true}"#.as_slice(),
            "canonical bytes must pin last_backup_at (l) < meeting_ai_prompt (m) < new_note_location (n)",
        );
    let blob_maip = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_maip, &nonce_maip)
        .expect("encode meeting-ai-prompt");
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_maip).expect("decode");
    assert_eq!(
        decoded, prefs_maip,
        "meeting-ai-prompt blob must round-trip exactly"
    );

    // Omit-when-unset: the same neighbours with the field back to `None`
    // must carry no `meeting_ai_prompt` key at all.
    let prefs_unset = PrefsView {
        meeting_ai_prompt: None,
        ..prefs_maip.clone()
    };
    let canonical_unset = canonical_json_encode(&prefs_unset);
    assert_eq!(
            canonical_unset.as_slice(),
            br#"{"last_backup_at":1765432100,"new_note_location":"specific","screen_capture_protection":true}"#.as_slice(),
            "an unset meeting_ai_prompt must be omitted entirely",
        );

    let mut dump = alloc::string::String::new();
    dump.push_str("[\n");

    // case 1/2: encrypt-meeting-ai-prompt
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/encrypt-meeting-ai-prompt\",\n");
    dump.push_str("      \"description\": \"The meeting AI prompt (meeting-ai). An optional free-text string, NFC-normalized, pinned between both canonical neighbours: last_backup_at (l) < meeting_ai_prompt (m) < new_note_location (n). That slot is the load-bearing half: it sits in the region a decoder scans forward through, so an older client steps over the unknown key and reads the following fields correctly. Unset is OMITTED ENTIRELY rather than encoded as an empty string, so a vault that never set it stays byte-identical to its pre-feature self. Same vault-A inputs as the sibling cases; prefs_nonce=0xE0x24. Generated by emit_meeting_ai_prompt_prefs_vectors in protocol/src/prefs.rs.\",\n");
    dump.push_str("      \"case_kind\": \"encrypt\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_prefs_nonce_hex\": \"{}\",\n",
        hex_lower(&nonce_maip)
    ));
    dump.push_str(&alloc::format!(
        "      \"informational_prefs_key_hex\": \"{}\",\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_prefs_blob_hex\": \"{}\"\n",
        hex_lower(&blob_maip)
    ));
    dump.push_str("    },\n");

    // case 2/2: decrypt-meeting-ai-prompt
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/decrypt-meeting-ai-prompt\",\n");
    dump.push_str("      \"description\": \"Round-trip with encrypt-meeting-ai-prompt: the blob decodes back to a PrefsView carrying meeting_ai_prompt between last_backup_at and new_note_location under the same root_key + account_number_hash. A decoder that does not know the field tolerates it per the 9.5.2 forward-compat rule and treats the prompt as ABSENT rather than as an empty string; absent means the built-in default instruction applies, which is a different state from 'a blank custom prompt'.\",\n");
    dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_blob_hex\": \"{}\",\n",
        hex_lower(&blob_maip)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str("      \"expected_prefs_view\": {\n");
    dump.push_str("        \"screen_capture_protection\": true,\n");
    dump.push_str("        \"last_backup_at\": 1765432100,\n");
    dump.push_str("        \"meeting_ai_prompt\": \"Summarize tersely, decisions first.\",\n");
    dump.push_str("        \"new_note_location\": \"specific\"\n");
    dump.push_str("      }\n");
    dump.push_str("    }\n");

    dump.push_str("]\n");

    std::fs::write(
        "/tmp/myne_vault_prefs_meeting_ai_prompt_vectors.json",
        dump.as_bytes(),
    )
    .expect("write vault-prefs meeting-ai-prompt vectors dump");
}

/// Generator for the **set-entry removal clock** `vault-prefs` cases
/// (myne-md/myne#613).
///
/// `cargo test -p protocol --lib emit_set_removal_clock_prefs_vectors -- --ignored`
///
/// The suite had exactly one `field_clocks` case before this
/// (`encrypt-field-clocks`), and its clocks are a bare field name plus a
/// `device_names/<key>` entry. Neither is the shape myne#613 introduces:
/// a clock keyed by a **set** entry, and the same clock with the entry
/// **absent**, which is how a removal is expressed at rest. A port that
/// encoded either differently would diverge on bytes that no existing case
/// covers, and `sync-protocol.md` §10.2 now rests on those bytes meaning the
/// same thing on both sides of a sync.
///
/// The third case is the one that catches an encoder rather than a merge:
/// a folded non-ASCII folder key sitting beside an ASCII one, which pins
/// that `field_clocks` keys sort by **byte** order (so `deliberate_folders/b`
/// precedes `deliberate_folders/bücher/`) and that the multi-byte key is
/// emitted as raw UTF-8 rather than `\u`-escaped. An implementation that
/// sorted by code point, or escaped non-ASCII, would produce a different
/// blob for the same vault and lose the entry on every merge.
#[test]
#[ignore]
fn emit_set_removal_clock_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

    // Case 1: the entry is LIVE and carries its own clock.
    let nonce_live: [u8; AEAD_NONCE_LEN] = [0xE1; AEAD_NONCE_LEN];
    let mut clocks_live = BTreeMap::new();
    clocks_live.insert(
        String::from("deliberate_folders/projects/myne/"),
        1_765_432_101_000u64,
    );
    let prefs_live = PrefsView {
        deliberate_folders: alloc::vec![String::from("Projects/Myne/")],
        field_clocks: clocks_live,
        ..PrefsView::default()
    };
    let canonical_live = canonical_json_encode(&prefs_live);
    assert_eq!(
            canonical_live.as_slice(),
            br#"{"deliberate_folders":["Projects/Myne/"],"field_clocks":{"deliberate_folders/projects/myne/":1765432101000},"screen_capture_protection":true}"#.as_slice(),
            "canonical bytes must pin deliberate_folders (d) < field_clocks (fi) < screen_capture_protection (s), and the clock key as the FOLDED entry identity while the set holds the raw display form",
        );
    let blob_live = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_live, &nonce_live)
        .expect("encode set-entry live");
    assert_eq!(
        decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_live).expect("decode"),
        prefs_live,
        "live set-entry blob must round-trip exactly"
    );

    // Case 2: the SAME clock with the entry gone. This is a removal at rest.
    // `deliberate_folders` is omit-when-empty, so the set key disappears
    // entirely and the clock is the only thing left saying it ever existed.
    let nonce_removed: [u8; AEAD_NONCE_LEN] = [0xE2; AEAD_NONCE_LEN];
    let mut clocks_removed = BTreeMap::new();
    clocks_removed.insert(
        String::from("deliberate_folders/projects/myne/"),
        1_765_432_102_000u64,
    );
    let prefs_removed = PrefsView {
        field_clocks: clocks_removed,
        ..PrefsView::default()
    };
    let canonical_removed = canonical_json_encode(&prefs_removed);
    assert_eq!(
            canonical_removed.as_slice(),
            br#"{"field_clocks":{"deliberate_folders/projects/myne/":1765432102000},"screen_capture_protection":true}"#.as_slice(),
            "a removal encodes as a clock with NO corresponding set key: the empty set is omitted entirely, so the stamp is the whole claim",
        );
    let blob_removed = encode_prefs_blob_raw(
        &prefs_key_a,
        &account_hash_a,
        &prefs_removed,
        &nonce_removed,
    )
    .expect("encode set-entry removed");
    assert_eq!(
        decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_removed).expect("decode"),
        prefs_removed,
        "removal blob must round-trip exactly"
    );

    // Case 3: a folded non-ASCII key beside an ASCII one.
    let nonce_folded: [u8; AEAD_NONCE_LEN] = [0xE3; AEAD_NONCE_LEN];
    let mut clocks_folded = BTreeMap::new();
    clocks_folded.insert(
        String::from("deliberate_folders/bücher/"),
        1_765_432_103_000u64,
    );
    clocks_folded.insert(
        String::from("deliberate_folders/archive/"),
        1_765_432_104_000u64,
    );
    let prefs_folded = PrefsView {
        deliberate_folders: alloc::vec![String::from("Archive/"), String::from("Bücher/")],
        field_clocks: clocks_folded,
        ..PrefsView::default()
    };
    let canonical_folded = canonical_json_encode(&prefs_folded);
    assert_eq!(
            canonical_folded.as_slice(),
            r#"{"deliberate_folders":["Archive/","Bücher/"],"field_clocks":{"deliberate_folders/archive/":1765432104000,"deliberate_folders/bücher/":1765432103000},"screen_capture_protection":true}"#.as_bytes(),
            "pins how a non-ASCII folder key is escaped and where it sorts among the clock keys; an implementation that disagrees produces a different blob for the same vault",
        );
    let blob_folded =
        encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_folded, &nonce_folded)
            .expect("encode set-entry folded");
    assert_eq!(
        decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_folded).expect("decode"),
        prefs_folded,
        "folded-key blob must round-trip exactly"
    );

    let mut dump = alloc::string::String::new();
    dump.push_str("[\n");

    let mut case =
        |id: &str, desc: &str, canonical: &[u8], nonce: &[u8], blob: &[u8], last: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!("      \"vector_id\": \"{id}\",\n"));
            dump.push_str(&alloc::format!("      \"description\": \"{desc}\",\n"));
            dump.push_str("      \"case_kind\": \"encrypt\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n",
                hex_lower(&root_a)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                hex_lower(&account_hash_a)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
                hex_lower(canonical)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_prefs_nonce_hex\": \"{}\",\n",
                hex_lower(nonce)
            ));
            dump.push_str(&alloc::format!(
                "      \"informational_prefs_key_hex\": \"{}\",\n",
                hex_lower(&*prefs_key_a)
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_prefs_blob_hex\": \"{}\"\n",
                hex_lower(blob)
            ));
            dump.push_str(if last { "    }\n" } else { "    },\n" });
        };

    case(
            "vault-prefs/v0.1/encrypt-set-entry-clock-live",
            "Set-entry removal clock, live half (myne-md/myne#613, sync-protocol.md \\u00a710.2). A set-union field carries a per-entry clock under `<field>/<entry>`, where the entry key is the FOLDED folder identity (`projects/myne/`) while the set itself holds the raw display form (`Projects/Myne/`). Pins the canonical key order deliberate_folders (d) < field_clocks (fi) < screen_capture_protection (s) with a set-keyed clock present. Same vault-A inputs as the sibling cases; prefs_nonce=0xE1x24. Generated by emit_set_removal_clock_prefs_vectors in protocol/src/prefs.rs.",
            &canonical_live,
            &nonce_live,
            &blob_live,
            false,
        );
    case(
            "vault-prefs/v0.1/encrypt-set-entry-clock-removed",
            "Set-entry removal clock, removed half (myne-md/myne#613). The SAME clock key with no corresponding set entry: `deliberate_folders` is omit-when-empty so the set key is absent entirely, and the stamp is the whole claim that the entry was deleted rather than never held. This is the shape sync-protocol.md \\u00a710.2 resolves against a peer that still holds the entry. What this ENCRYPT case pins is that the orphan key survives the encode and is present in the plaintext, byte for byte: it does not, and cannot, pin that a DECODER preserves it, because an encrypt case never hands a port a blob to read. The decode half is asserted in the reference implementation by the round-trip in `emit_set_removal_clock_prefs_vectors`'s own module tests, and a port that wants the same assurance owes itself a decode of this blob; a decoder that dropped the orphan key would silently undo every folder deletion on a multi-device vault, and nothing in this file would say so. Same vault-A inputs; prefs_nonce=0xE2x24. Generated by emit_set_removal_clock_prefs_vectors in protocol/src/prefs.rs.",
            &canonical_removed,
            &nonce_removed,
            &blob_removed,
            false,
        );
    case(
            "vault-prefs/v0.1/encrypt-set-entry-clock-folded-non-ascii",
            "Set-entry removal clock with a non-ASCII folded key (myne-md/myne#613). Two clock keys, one ASCII and one multi-byte, beside their raw set entries. Pins two things a port can get wrong with no test noticing. First, non-ASCII is emitted as RAW UTF-8 and never \\\\u-escaped, in both the set entry and the clock key: an implementation whose JSON writer escapes by default (many do) produces a different plaintext, a different AEAD tag, and a blob the other side cannot decrypt. Second, the multi-byte key sorts in the same sequence as its ASCII sibling, which pins that a port sorts the clock map at all and does not reorder around a non-ASCII key. It deliberately does NOT claim to discriminate byte order from code-point order: UTF-8 byte order and code-point order are identical by construction, so no case can separate them, and the only ordering a vector here could discriminate is UTF-16 code-unit order, which needs an astral character against a BMP one and is not what these two keys are. Same vault-A inputs; prefs_nonce=0xE3x24. Generated by emit_set_removal_clock_prefs_vectors in protocol/src/prefs.rs.",
            &canonical_folded,
            &nonce_folded,
            &blob_folded,
            true,
        );

    dump.push_str("]\n");

    std::fs::write(
        "/tmp/myne_vault_prefs_set_removal_clock_vectors.json",
        dump.as_bytes(),
    )
    .expect("write vault-prefs set-removal-clock vectors dump");
}

/// Generator for the display-formatting quartet's `vault-prefs` cases —
/// `auto_tag_enabled`, `date_format`, `time_format`, `timezone`.
///
/// `cargo test -p protocol --lib emit_datetime_quartet_prefs_vectors -- --ignored`
///
/// These four shipped without a single companion-repo vector between them:
/// each is exercised by `#[cfg(test)]` unit tests here and by nothing a port
/// can run. That is a real cross-implementation gap rather than a tidiness
/// one, because `vault.prefs` is canonical JSON — **key order is part of the
/// bytes**, so a port that emits a correct value in the wrong slot produces a
/// blob this crate cannot decode, and no existing vector would have said so.
///
/// Each field is therefore pinned **beside both of its canonical neighbours**,
/// which is what makes the case a slot pin rather than a value pin:
///
/// * `auto_lock_seconds` < `auto_tag_enabled` < `bar_items_order`
/// * `daily_template` < `date_format` < `deliberate_folders`
/// * `theme` < `time_format` < `timezone` < `transcription_enabled`
///
/// `auto_tag_enabled` is additionally the one member of the quartet with the
/// emit-only-when-`true` convention, so it is set `true` here — set `false`
/// it would vanish from the bytes and pin nothing at all.
#[test]
#[ignore]
fn emit_datetime_quartet_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
    let nonce_dq: [u8; AEAD_NONCE_LEN] = [0xD4; AEAD_NONCE_LEN];

    let prefs_dq = PrefsView {
        auto_lock_seconds: Some(300),
        auto_tag_enabled: true,
        bar_items_order: alloc::vec![String::from("search"), String::from("graph")],
        daily_template: Some(String::from("Templates/Daily.md")),
        date_format: Some(String::from("iso")),
        deliberate_folders: alloc::vec![String::from("Archive/")],
        theme: Some(ThemeChoice::Dark),
        time_format: Some(String::from("24h")),
        timezone: Some(String::from("Europe/Istanbul")),
        transcription_enabled: false,
        ..PrefsView::default()
    };

    let canonical = canonical_json_encode(&prefs_dq);
    let canonical_str = core::str::from_utf8(&canonical).expect("canonical JSON is UTF-8");

    // Slot assertions, stated as ordering rather than as one frozen string:
    // a future field landing between any of these pairs must not silently
    // invalidate the pin it is not related to.
    let pos = |needle: &str| -> usize {
        canonical_str
            .find(needle)
            .unwrap_or_else(|| panic!("canonical JSON is missing {needle}: {canonical_str}"))
    };
    assert!(
        pos("\"auto_lock_seconds\"") < pos("\"auto_tag_enabled\"")
            && pos("\"auto_tag_enabled\"") < pos("\"bar_items_order\""),
        "auto_tag_enabled must sit between auto_lock_seconds and bar_items_order: {canonical_str}"
    );
    assert!(
        pos("\"daily_template\"") < pos("\"date_format\"")
            && pos("\"date_format\"") < pos("\"deliberate_folders\""),
        "date_format must sit between daily_template and deliberate_folders: {canonical_str}"
    );
    assert!(
        pos("\"theme\"") < pos("\"time_format\"")
            && pos("\"time_format\"") < pos("\"timezone\"")
            && pos("\"timezone\"") < pos("\"transcription_enabled\""),
        "time_format < timezone must sit between theme and transcription_enabled: {canonical_str}"
    );

    let blob_dq = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_dq, &nonce_dq)
        .expect("encode datetime quartet");
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_dq).expect("decode");
    assert_eq!(
        decoded, prefs_dq,
        "datetime-quartet blob must round-trip exactly"
    );

    let mut dump = alloc::string::String::new();
    dump.push_str("[\n");

    // case 1/2: encrypt-datetime-quartet
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/encrypt-datetime-quartet\",\n");
    dump.push_str("      \"description\": \"The four display-formatting preferences that had no cross-implementation vector: auto_tag_enabled (on-device tag suggestion, emitted only when true), date_format, time_format and timezone (myne#279 display overrides). Each is written beside BOTH of its canonical neighbours so the case pins its slot rather than merely its value: auto_lock_seconds < auto_tag_enabled < bar_items_order; daily_template < date_format < deliberate_folders; theme < time_format < timezone < transcription_enabled. vault.prefs is canonical JSON, so key order is part of the bytes: a port emitting a correct value in the wrong slot produces a blob the reference decoder rejects. All four values are display-only: none ever enters a .myn file as a formatting instruction. They do live in this blob, which is what the case encodes, and date_format/time_format are shared across devices by design. Same vault-A inputs as the sibling cases; prefs_nonce=0xD4x24. Generated by emit_datetime_quartet_prefs_vectors in protocol/src/prefs.rs.\",\n");
    dump.push_str("      \"case_kind\": \"encrypt\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_prefs_nonce_hex\": \"{}\",\n",
        hex_lower(&nonce_dq)
    ));
    dump.push_str(&alloc::format!(
        "      \"informational_prefs_key_hex\": \"{}\",\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_prefs_blob_hex\": \"{}\"\n",
        hex_lower(&blob_dq)
    ));
    dump.push_str("    },\n");

    // case 2/2: decrypt-datetime-quartet
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/decrypt-datetime-quartet\",\n");
    dump.push_str("      \"description\": \"Round-trip with encrypt-datetime-quartet: the blob decodes back to a PrefsView carrying all four display-formatting fields at their canonical positions. A decoder that does not know one of them tolerates it per the §9.5.2 forward-compat rule and falls back to that field's default (auto_tag_enabled=false, the other three = 'follow the OS locale'), which is exactly what a pre-feature client does — the point of the case is that skipping a field must not desynchronise the positional cursor and swallow the fields that follow it.\",\n");
    dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_blob_hex\": \"{}\",\n",
        hex_lower(&blob_dq)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str("      \"expected_prefs_view\": {\n");
    dump.push_str("        \"screen_capture_protection\": true,\n");
    dump.push_str("        \"auto_lock_seconds\": 300,\n");
    dump.push_str("        \"auto_tag_enabled\": true,\n");
    dump.push_str("        \"bar_items_order\": [\"search\", \"graph\"],\n");
    dump.push_str("        \"daily_template\": \"Templates/Daily.md\",\n");
    dump.push_str("        \"date_format\": \"iso\",\n");
    dump.push_str("        \"deliberate_folders\": [\"Archive/\"],\n");
    dump.push_str("        \"theme\": \"dark\",\n");
    dump.push_str("        \"time_format\": \"24h\",\n");
    dump.push_str("        \"timezone\": \"Europe/Istanbul\",\n");
    dump.push_str("        \"transcription_enabled\": false\n");
    dump.push_str("      }\n");
    dump.push_str("    }\n");

    dump.push_str("]\n");

    std::fs::write(
        "/tmp/myne_vault_prefs_datetime_quartet_vectors.json",
        dump.as_bytes(),
    )
    .expect("write vault-prefs datetime-quartet vectors dump");
    std::println!("canonical JSON: {canonical_str}");
}

/// Generator for the MYND-227 structural `parse_fail` vector cases
/// (appended to the companion repo's `vault-prefs` family; per-feature-
/// generator pattern of [`emit_label_and_tolerance_prefs_vectors`]).
/// Emits a JSON **array fragment** of 7 case objects at
/// `/tmp/myne_vault_prefs_parse_fail_vectors.json`, spliced by hand
/// into the existing `cases` array.
///
/// `cargo test -p protocol --lib emit_prefs_parse_fail_vectors -- --ignored`
///
/// One case per distinguishable `PrefsBlobError` reject reachable from
/// a decode-a-blob vector: the 6 pre-AEAD structural rejects
/// (vault-search parity) + the post-AEAD `plaintext_parse_failed`
/// (a validly-sealed blob whose inner plaintext is not canonical JSON —
/// possible only with the real `prefs_key`, which every case therefore
/// carries). Encode-side `CiphertextLenOverflow` + `RandomnessUnavailable`
/// cannot be expressed as decode cases and stay unvectored.
#[test]
#[ignore]
fn emit_prefs_parse_fail_vectors() {
    extern crate std;
    use crate::aead::{aad_prefs_blob, aead_seal_ctx, CTX_COMMITMENT_TAG_LEN};

    // Same fixed vault-A inputs as the sibling generators; nonces 0xF2 +
    // 0xF3 are the next free entries in the family's nonce registry
    // (0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xF1 are taken).
    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
    let nonce_base: [u8; AEAD_NONCE_LEN] = [0xF2; AEAD_NONCE_LEN];
    let nonce_bad_inner: [u8; AEAD_NONCE_LEN] = [0xF3; AEAD_NONCE_LEN];

    // Base blob for the structural tampers: default PrefsView under the
    // real key. The header bytes are NOT bound into the AAD, so a port
    // that skips a structural check will decrypt the tampered blob
    // successfully and return Ok — which the runner catches. That is
    // why these cases carry the real root_key instead of a dummy.
    let base = encode_prefs_blob_raw(
        &prefs_key_a,
        &account_hash_a,
        &PrefsView::default(),
        &nonce_base,
    )
    .expect("encode base");

    let header_short: Vec<u8> = PREFS_BLOB_MAGIC.to_vec();
    let mut magic_tamper = base.clone();
    magic_tamper[0] = b'X';
    let mut version_tamper = base.clone();
    version_tamper[4] = 0x02;
    let mut reserved_tamper = base.clone();
    reserved_tamper[5] = 0x01;
    let mut len_overflow = base.clone();
    len_overflow[30..34].copy_from_slice(&0xFFFF_FFFFu32.to_be_bytes());
    let mut truncated = base.clone();
    truncated.truncate(truncated.len() - 1);

    // plaintext_parse_failed: a hand-assembled envelope (same header
    // layout as encode_prefs_blob_raw) sealing bytes that are NOT
    // canonical JSON. AEAD verification passes — the reject happens at
    // the inner-plaintext parse stage, distinguishable per §9.5.5.
    let bad_plaintext = b"this is not canonical json";
    let aad = aad_prefs_blob(&account_hash_a);
    let sealed =
        aead_seal_ctx(&prefs_key_a, &nonce_bad_inner, bad_plaintext, &aad).expect("seal bad inner");
    debug_assert_eq!(sealed.len(), bad_plaintext.len() + CTX_COMMITMENT_TAG_LEN);
    let mut bad_inner = Vec::with_capacity(PREFS_BLOB_HEADER_LEN + sealed.len());
    bad_inner.extend_from_slice(&PREFS_BLOB_MAGIC);
    bad_inner.push(PREFS_BLOB_PROTOCOL_VERSION);
    bad_inner.push(PREFS_BLOB_RESERVED);
    bad_inner.extend_from_slice(&nonce_bad_inner);
    bad_inner.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
    bad_inner.extend_from_slice(&sealed);

    let cases: [(&str, &str, &[u8], PrefsBlobError, &str); 7] = [
            (
                "parse-fail-header-too-short",
                "Only the 4-byte MYP1 magic — no room for the 34-byte header (magic + version + reserved + 24-byte nonce + 4-byte ciphertext_len). Rejected before any field read.",
                header_short.as_slice(),
                PrefsBlobError::HeaderTooShort,
                "blob is the 4 magic bytes only (4 < 34)",
            ),
            (
                "parse-fail-magic-mismatch",
                "First byte of the MYP1 magic corrupted to 'X'. Rejected at offset 0 before any decryption — a foreign file, different artifact type, or forward-incompatible MYP5 blob all fail here.",
                magic_tamper.as_slice(),
                PrefsBlobError::MagicMismatch,
                "byte 0 (magic[0]) 'M' → 'X'",
            ),
            (
                "parse-fail-protocol-version-mismatch",
                "protocol_version byte (offset 4) set to 0x02 instead of 0x01. A v0.1 decoder rejects an unknown protocol version before decrypting.",
                version_tamper.as_slice(),
                PrefsBlobError::ProtocolVersionMismatch,
                "byte 4 (protocol_version) 0x01 → 0x02",
            ),
            (
                "parse-fail-reserved-nonzero",
                "reserved byte (offset 5) set to 0x01 instead of 0x00. Spec §9.5.1 makes non-zero an unconditional parse rejection — reserved bytes are flag carriers for future v0.1.x revisions and a v0.1.0 client cannot honor unknown flags.",
                reserved_tamper.as_slice(),
                PrefsBlobError::ReservedByteNonZero,
                "byte 5 (reserved) 0x00 → 0x01",
            ),
            (
                "parse-fail-ciphertext-len-overflow",
                "ciphertext_len field (offset 30..34) set to 0xFFFFFFFF, far above MAX_PREFS_PLAINTEXT_LEN + 32 (64 KiB + 32). The overflow guard rejects before any slice indexing — a port MUST bound-check ciphertext_len before allocating or indexing (DoS-allocation defense, §9.5.4).",
                len_overflow.as_slice(),
                PrefsBlobError::CiphertextLenOverflow,
                "bytes 30..34 (ciphertext_len) → 0xffffffff",
            ),
            (
                "parse-fail-ciphertext-truncated",
                "Valid header advertising ciphertext_len = N, but the blob is one byte shorter than header + N. Rejected before the AEAD stage.",
                truncated.as_slice(),
                PrefsBlobError::CiphertextTruncated,
                "final byte dropped (blob shorter than header + advertised ciphertext_len)",
            ),
            (
                "parse-fail-plaintext-parse-failed",
                "A structurally valid envelope sealed under the REAL prefs_key + AAD whose inner plaintext is 'this is not canonical json'. AEAD verification succeeds — the reject fires at the canonical-JSON parse stage. Distinguishable from CannotDecrypt because the tag check already proved the bytes came from a prefs_key holder (corruption past that point is structural, not adversarial). A port that returns its AEAD-failure error here has merged two distinct failure surfaces.",
                bad_inner.as_slice(),
                PrefsBlobError::PlaintextParseFailed,
                "validly-sealed non-JSON inner plaintext (nonce 0xf3×24)",
            ),
        ];

    let expected_error_str = |e: &PrefsBlobError| -> &'static str {
        match e {
            PrefsBlobError::HeaderTooShort => "header_too_short",
            PrefsBlobError::MagicMismatch => "magic_mismatch",
            PrefsBlobError::ProtocolVersionMismatch => "protocol_version_mismatch",
            PrefsBlobError::ReservedByteNonZero => "reserved_byte_nonzero",
            PrefsBlobError::CiphertextLenOverflow => "ciphertext_len_overflow",
            PrefsBlobError::CiphertextTruncated => "ciphertext_truncated",
            PrefsBlobError::PlaintextParseFailed => "plaintext_parse_failed",
            other => panic!("unexpected expected-error variant {other:?}"),
        }
    };

    let mut dump = alloc::string::String::new();
    dump.push_str("[\n");
    for (i, (slug, description, blob, expected, tamper)) in cases.iter().enumerate() {
        assert_eq!(
            decode_prefs_blob(&prefs_key_a, &account_hash_a, blob).as_ref(),
            Err(expected),
            "[{slug}] tampered blob must reject with {expected:?}"
        );
        dump.push_str("    {\n");
        dump.push_str(&alloc::format!(
            "      \"vector_id\": \"vault-prefs/v0.1/{}\",\n",
            slug
        ));
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape(description)
        ));
        dump.push_str("      \"case_kind\": \"parse_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(blob)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_error\": \"{}\",\n",
            expected_error_str(expected)
        ));
        dump.push_str(&alloc::format!(
            "      \"informational_tamper_description\": \"{}\"\n",
            json_escape(tamper)
        ));
        if i + 1 < cases.len() {
            dump.push_str("    },\n");
        } else {
            dump.push_str("    }\n");
        }
    }
    dump.push_str("]\n");

    std::fs::write(
        "/tmp/myne_vault_prefs_parse_fail_vectors.json",
        dump.as_bytes(),
    )
    .expect("write vault-prefs parse_fail vectors dump");
}

// ---- daily-notes fields (MYND-191) ---------------------------------

#[test]
fn daily_fields_omitted_when_default_are_byte_stable() {
    // A vault with all-default (None) daily fields encodes byte-identical to
    // one that never had them — preserving pre-MYND-191 golden vectors.
    let encoded = canonical_json_encode(&PrefsView::default());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn daily_fields_encode_in_canonical_key_order() {
    // daily_date_format < daily_folder < daily_template < deliberate_folders
    // < screen_capture_protection.
    let prefs = PrefsView {
        daily_date_format: Some("YYYY-MM-DD".into()),
        daily_folder: Some("Journal/".into()),
        daily_template: Some("0190-aaaa".into()),
        date_format: None,
        deliberate_folders: alloc::vec!["Journal/".into()],
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&prefs);
    assert_eq!(
            encoded.as_slice(),
            br#"{"daily_date_format":"YYYY-MM-DD","daily_folder":"Journal/","daily_template":"0190-aaaa","deliberate_folders":["Journal/"],"screen_capture_protection":true}"#,
        );
}

#[test]
fn daily_fields_round_trip_through_encode_decode() {
    let prefs = PrefsView {
        daily_date_format: Some("YYYY-MM-DD".into()),
        daily_folder: Some("Daily/".into()),
        daily_template: Some("0190-tmpl-uuid".into()),
        date_format: None,
        ..PrefsView::default()
    };
    let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
    let hash = fixed_account_number_hash();
    let blob = encode_prefs_blob_raw(&prefs_key, &hash, &prefs, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &hash, &blob).unwrap();
    assert_eq!(decoded, prefs);
}

#[test]
fn daily_template_absent_decodes_to_none() {
    // The canonical "blank daily note" state — no daily_template key.
    let parsed =
        canonical_json_decode(br#"{"daily_folder":"Daily/","screen_capture_protection":true}"#)
            .unwrap();
    assert_eq!(parsed.daily_folder, Some("Daily/".into()));
    assert_eq!(parsed.daily_template, None);
    assert_eq!(parsed.daily_date_format, None);
}

#[test]
fn daily_fields_compose_with_other_prefs() {
    // Round-trip alongside auto_lock_seconds (before) + theme (after) to pin
    // the cursor discipline across the full canonical key range.
    let prefs = PrefsView {
        auto_lock_seconds: Some(300),
        daily_folder: Some("Journal/".into()),
        theme: Some(ThemeChoice::Dark),
        ..PrefsView::default()
    };
    let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
    let hash = fixed_account_number_hash();
    let blob = encode_prefs_blob_raw(&prefs_key, &hash, &prefs, &fixed_prefs_nonce()).unwrap();
    assert_eq!(decode_prefs_blob(&prefs_key, &hash, &blob).unwrap(), prefs);
}

// ---- color_groups (graph-connection-ux-polish, MYND-604) ---------------

fn sample_color_group(id: &str, name: &str) -> crate::color_group::ColorGroup {
    crate::color_group::ColorGroup {
        id: id.into(),
        name: name.into(),
        color: "moss".into(),
        enabled: true,
        filter: crate::saved_view::FilterNode::HasTag { tag: "work".into() },
    }
}

#[test]
fn color_groups_round_trips_and_positions_b_before_col_before_cus() {
    // Round-trip alongside bar_items_order (before, 'b') + custom_theme
    // (after, 'cus') to pin color_groups' canonical position ('col').
    let prefs = PrefsView {
        bar_items_order: alloc::vec!["graph".into()],
        color_groups: alloc::vec![
            sample_color_group("g1", "Work"),
            sample_color_group("g2", "Rest")
        ],
        custom_theme: Some("solarized-dark".into()),
        ..PrefsView::default()
    };
    let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
    let hash = fixed_account_number_hash();
    let blob = encode_prefs_blob_raw(&prefs_key, &hash, &prefs, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &hash, &blob).unwrap();
    assert_eq!(decoded, prefs);
    // Order preserved verbatim — precedence, not id-sorted (g1 before g2).
    assert_eq!(decoded.color_groups[0].id, "g1");
    assert_eq!(decoded.color_groups[1].id, "g2");

    let json = canonical_json_encode(&prefs);
    let s = core::str::from_utf8(&json).unwrap();
    let b = s.find("bar_items_order").unwrap();
    let cg = s.find("color_groups").unwrap();
    let cus = s.find("custom_theme").unwrap();
    assert!(
        b < cg && cg < cus,
        "canonical order must be b < col < cus: {s}"
    );
}

#[test]
fn color_groups_omitted_when_empty_byte_identical_to_pre_feature_blob() {
    // A vault that never opens the feature re-encodes byte-identically to
    // a pre-MYND-604 vault.prefs (story 36) — the field must not appear
    // at all, not merely as `[]`.
    let prefs = PrefsView::default();
    let json = canonical_json_encode(&prefs);
    let s = core::str::from_utf8(&json).unwrap();
    assert!(
        !s.contains("color_groups"),
        "empty color_groups must be omitted: {s}"
    );
}

#[test]
fn color_groups_disabled_rule_round_trips() {
    let mut g = sample_color_group("g1", "Muted");
    g.enabled = false;
    let prefs = PrefsView {
        color_groups: alloc::vec![g],
        ..PrefsView::default()
    };
    let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
    let hash = fixed_account_number_hash();
    let blob = encode_prefs_blob_raw(&prefs_key, &hash, &prefs, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &hash, &blob).unwrap();
    assert_eq!(decoded, prefs);
    assert!(!decoded.color_groups[0].enabled);
}

// ---- custom_theme (custom-themes epic, MYND-297) -----------------------

#[test]
fn custom_theme_round_trips_and_positions_a_before_c_before_t() {
    // Round-trip alongside auto_lock_seconds (before, 'a') + theme (after, 't')
    // to pin custom_theme's canonical position ('c') across the codec.
    let prefs = PrefsView {
        custom_theme: Some("solarized-dark".into()),
        auto_lock_seconds: Some(300),
        theme: Some(ThemeChoice::Dark),
        ..PrefsView::default()
    };
    let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
    let hash = fixed_account_number_hash();
    let blob = encode_prefs_blob_raw(&prefs_key, &hash, &prefs, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &hash, &blob).unwrap();
    assert_eq!(decoded, prefs);
    assert_eq!(decoded.custom_theme.as_deref(), Some("solarized-dark"));

    let json = canonical_json_encode(&prefs);
    let s = core::str::from_utf8(&json).unwrap();
    let al = s.find("auto_lock_seconds").unwrap();
    let ct = s.find("custom_theme").unwrap();
    let th = s.find("\"theme\"").unwrap();
    assert!(al < ct && ct < th, "canonical order must be a < c < t: {s}");
}

#[test]
fn custom_theme_omitted_when_none_is_byte_identical() {
    // A vault with no custom theme must not emit the key at all, so it stays
    // byte-identical to a pre-MYND-297 vault.prefs.
    let prefs = PrefsView {
        theme: Some(ThemeChoice::Light),
        ..PrefsView::default()
    };
    let json = canonical_json_encode(&prefs);
    assert!(
        find_subslice(&json, b"custom_theme").is_none(),
        "absent custom_theme must not appear in canonical JSON"
    );
}

// ---- saved_views + view_order (MYND-273) -------------------------------

fn sample_view(id: &str, name: &str) -> crate::saved_view::SavedView {
    use crate::saved_view::{FilterNode, SavedView, ViewType};
    SavedView {
        id: String::from(id),
        name: String::from(name),
        view_type: ViewType::Cards,
        filters: FilterNode::InFolder {
            path: String::from("Books/"),
        },
        sort: None,
        group_by: None,
        columns: alloc::vec![String::from("author")],
        card_size: Some(300),
        image: Some(String::from("image")),
        image_aspect_ratio: Some(String::from("1.65")),
        version: None,
        write_fields: Vec::new(),
        lanes: Vec::new(),
        template: None,
    }
}

#[test]
fn saved_views_and_view_order_round_trip_through_blob() {
    let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
    let hash = fixed_account_number_hash();
    let original = PrefsView {
        saved_views: alloc::vec![sample_view("v2", "Books"), sample_view("v1", "Films")],
        opaque_saved_views: Vec::new(),
        view_order: alloc::vec![String::from("v2"), String::from("v1")],
        ..PrefsView::default()
    };
    let blob = encode_prefs_blob_raw(&prefs_key, &hash, &original, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &hash, &blob).unwrap();
    // saved_views decode in canonical (id-sorted) order; view_order verbatim.
    assert_eq!(decoded.saved_views.len(), 2);
    assert_eq!(decoded.saved_views[0].id, "v1");
    assert_eq!(decoded.saved_views[1].id, "v2");
    assert_eq!(decoded.view_order, alloc::vec!["v2", "v1"]);
    assert_eq!(decoded.saved_views[1].name, "Books");
}

#[test]
fn empty_saved_views_and_view_order_are_byte_identical_to_pre_feature() {
    // A vault with no views emits NO "saved_views"/"view_order" key, so it
    // is byte-identical to a pre-MYND-273 vault.prefs (existing golden
    // vectors unaffected — migration-less additive fields).
    let encoded = canonical_json_encode(&PrefsView::default());
    assert!(find_subslice(&encoded, b"saved_views").is_none());
    assert!(find_subslice(&encoded, b"view_order").is_none());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

// ---- view_approvals (view-manifests) -------------------------------

#[test]
fn empty_view_approvals_is_byte_identical_to_a_pre_feature_blob() {
    // The whole point of omit-when-empty for this field: a vault that never
    // approves a shared view must not gain a byte from the feature existing.
    // Asserted on the SAME single-field form the two tests around this one
    // pin, so a future field cannot make this pass by accident.
    let encoded = canonical_json_encode(&PrefsView::default());
    assert!(find_subslice(&encoded, b"view_approvals").is_none());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);

    // …and a vault carrying views but no approvals is unchanged too: the
    // map is independent of whether there are views to approve.
    let with_views = PrefsView {
        saved_views: alloc::vec![sample_view("v1", "Books")],
        view_order: alloc::vec![String::from("v1")],
        ..PrefsView::default()
    };
    let bytes = canonical_json_encode(&with_views);
    assert!(find_subslice(&bytes, b"view_approvals").is_none());
}

#[test]
fn view_approvals_round_trip_in_canonical_key_order_before_view_order() {
    let mut approvals = BTreeMap::new();
    // Inserted out of order on purpose: the encoder sorts by NFC key.
    approvals.insert(String::from("v2"), 7u64);
    approvals.insert(String::from("v1"), 3u64);
    let original = PrefsView {
        view_approvals: approvals,
        view_order: alloc::vec![String::from("v2"), String::from("v1")],
        ..PrefsView::default()
    };
    let bytes = canonical_json_encode(&original);
    let s = core::str::from_utf8(&bytes).unwrap();
    // Canonical position and inner key order, asserted on the bytes rather
    // than on the decoded struct: `transcription_enabled` < `view_approvals`
    // < `view_order`, and the map's own keys are lexicographic.
    assert!(
        s.find("\"view_approvals\":{\"v1\":3,\"v2\":7}").is_some(),
        "view_approvals must be an NFC-keyed, lexicographic integer map; got {s}"
    );
    assert!(s.find("\"view_approvals\"").unwrap() < s.find("\"view_order\"").unwrap());
    // The encoded map's version is a BARE integer (no quotes, no `.0`).
    assert!(!s.contains("\"v1\":\"3\""));

    let decoded = canonical_json_decode(&bytes).expect("decode");
    assert_eq!(decoded.view_approvals.len(), 2);
    assert_eq!(decoded.view_approvals.get("v1"), Some(&3u64));
    assert_eq!(decoded.view_approvals.get("v2"), Some(&7u64));
    assert_eq!(decoded.view_order, alloc::vec!["v2", "v1"]);
}

#[test]
fn malformed_view_approvals_reads_as_empty_rather_than_defaulting_the_blob() {
    // Tolerant on damage, and the DIRECTION is the assertion. A refused parse
    // would drive §9.5.5's whole-blob fall-back to defaults, clearing the
    // theme/keymap/favorites alongside the approvals and pushing that loss on
    // the next write. Reading as "nothing approved" keeps every other field
    // and leaves pending views pending, which heals by approving again.
    let bytes = br#"{"screen_capture_protection":true,"view_approvals":{"v1":"not-a-number"}}"#;
    let decoded = canonical_json_decode(bytes).expect("damaged map must not fail the blob");
    assert!(decoded.view_approvals.is_empty());
    assert!(decoded.screen_capture_protection);
}

#[test]
fn view_order_preserves_sequence_not_sorted_or_deduped() {
    // Sequence semantics (like item_order/favorites): order verbatim, dupes
    // kept — the codec performs no GC.
    let original = PrefsView {
        view_order: alloc::vec![String::from("v3"), String::from("v1"), String::from("v3"),],
        ..PrefsView::default()
    };
    let decoded = canonical_json_decode(&canonical_json_encode(&original)).expect("decode");
    assert_eq!(decoded.view_order, alloc::vec!["v3", "v1", "v3"]);
}

#[test]
fn saved_views_encoded_sorted_by_id() {
    // The set's array order is canonical (id-sorted) regardless of caller
    // order; the display order lives in view_order.
    let original = PrefsView {
        saved_views: alloc::vec![sample_view("zzz", "Z"), sample_view("aaa", "A")],
        opaque_saved_views: Vec::new(),
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let s = core::str::from_utf8(&encoded).unwrap();
    let pos_a = s.find("\"id\":\"aaa\"").unwrap();
    let pos_z = s.find("\"id\":\"zzz\"").unwrap();
    assert!(pos_a < pos_z, "saved_views must be encoded sorted by id");
}

#[test]
fn saved_views_canonical_key_position() {
    // saved_views sorts before screen_capture_protection; view_order is last.
    let original = PrefsView {
        saved_views: alloc::vec![sample_view("v1", "A")],
        opaque_saved_views: Vec::new(),
        view_order: alloc::vec![String::from("v1")],
        ..PrefsView::default()
    };
    let s = String::from_utf8(canonical_json_encode(&original)).unwrap();
    let sv = s.find("\"saved_views\":").unwrap();
    let scp = s.find("\"screen_capture_protection\":").unwrap();
    let vo = s.find("\"view_order\":").unwrap();
    assert!(sv < scp, "saved_views before screen_capture_protection");
    assert!(scp < vo, "view_order last");
}

/// A canonical prefs plaintext carrying one view this build represents and
/// one it does not (`view_type: "timeline"`), plus a field beside them so the
/// "did the whole blob fall back?" question is observable.
fn prefs_plaintext_with_an_unsupported_view() -> &'static [u8] {
    br#"{"label":"Work","saved_views":[{"filters":{"kind":"all"},"id":"a","name":"Cards","view_type":"cards"},{"filters":{"kind":"all"},"id":"b","name":"Timeline","view_type":"timeline"}],"screen_capture_protection":true}"#
}

#[test]
fn unsupported_view_type_no_longer_collapses_the_blob_to_defaults() {
    // §9.5.5: an entry this build cannot REPRESENT is carried verbatim
    // rather than failing the whole prefs plaintext. Before this, one
    // `view_type: "timeline"` reset every preference in the blob (the label
    // included), and because a prefs write is a whole-blob rewrite, this
    // client would then push those defaults to every device.
    let input = prefs_plaintext_with_an_unsupported_view();
    let decoded = canonical_json_decode(input).expect("whole-blob parse must succeed");
    assert_eq!(decoded.label.as_deref(), Some("Work"));
    assert_eq!(decoded.saved_views.len(), 1);
    assert_eq!(decoded.saved_views[0].id, "a");
    assert_eq!(decoded.opaque_saved_views.len(), 1);
    assert_eq!(decoded.opaque_saved_views[0].id_bytes(), b"b");
    // ...and the re-encode reproduces the input bytes exactly, so the
    // carried entry is neither lost nor rewritten.
    assert_eq!(canonical_json_encode(&decoded), input);
}

#[test]
fn opaque_saved_views_survive_the_full_blob_round_trip() {
    // The carry has to survive the actual `MYP1` envelope, not just the
    // plaintext codec: the host reads a blob, sets an unrelated preference,
    // and writes the whole view back.
    let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
    let hash = fixed_account_number_hash();
    let carried =
        canonical_json_decode(prefs_plaintext_with_an_unsupported_view()).expect("decode");
    let blob = encode_prefs_blob_raw(&prefs_key, &hash, &carried, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &hash, &blob).unwrap();
    assert_eq!(decoded, carried);
    assert_eq!(
        canonical_json_encode(&decoded),
        prefs_plaintext_with_an_unsupported_view()
    );
}

#[test]
fn structurally_broken_saved_views_still_collapse_to_parse_failed() {
    // Only an Unrepresentable entry is carried. Structural damage stays
    // fatal: retaining garbage is a weaker promise than retaining a
    // well-formed entry this schema happens not to express.
    let wrong_type = br#"{"saved_views":[{"filters":{"kind":"all"},"id":7,"name":"n","view_type":"table"}],"screen_capture_protection":true}"#;
    assert_eq!(
        canonical_json_decode(wrong_type),
        Err(PrefsBlobError::PlaintextParseFailed)
    );
    let missing_required = br#"{"saved_views":[{"id":"x"}],"screen_capture_protection":true}"#;
    assert_eq!(
        canonical_json_decode(missing_required),
        Err(PrefsBlobError::PlaintextParseFailed)
    );
}

#[test]
fn pre_feature_saved_views_blob_is_byte_identical_after_round_trip() {
    // No opaque entry → nothing about the encoding may move for existing
    // vaults (the `saved_views` golden vectors are unmoved by this change).
    let original = PrefsView {
        label: Some(String::from("Work")),
        saved_views: alloc::vec![sample_view("v2", "Books"), sample_view("v1", "Films")],
        opaque_saved_views: Vec::new(),
        view_order: alloc::vec![String::from("v2"), String::from("v1")],
        ..PrefsView::default()
    };
    let encoded = canonical_json_encode(&original);
    let decoded = canonical_json_decode(&encoded).expect("decode");
    assert!(decoded.opaque_saved_views.is_empty());
    assert_eq!(canonical_json_encode(&decoded), encoded);
}

// ---- paired_extensions (MYND-443, browser-clipper pairing-token persistence) ----

fn sample_paired(ext: &str, tok: &str, revoked: bool) -> crate::paired_extension::PairedExtension {
    crate::paired_extension::PairedExtension {
        extension_id: String::from(ext),
        token_value: String::from(tok),
        revoked,
        paired_at: None,
    }
}

#[test]
fn paired_extensions_round_trip_through_blob() {
    let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
    let hash = fixed_account_number_hash();
    let original = PrefsView {
        paired_extensions: alloc::vec![
            sample_paired("ext-a", "aa11", false),
            sample_paired("ext-b", "bb22", true),
        ],
        ..PrefsView::default()
    };
    let blob = encode_prefs_blob_raw(&prefs_key, &hash, &original, &fixed_prefs_nonce()).unwrap();
    let decoded = decode_prefs_blob(&prefs_key, &hash, &blob).unwrap();
    assert_eq!(decoded.paired_extensions.len(), 2);
    // Encoded sorted by (extension_id, token_value): ext-a then ext-b.
    assert_eq!(decoded.paired_extensions[0].extension_id, "ext-a");
    assert!(!decoded.paired_extensions[0].revoked);
    assert_eq!(decoded.paired_extensions[1].extension_id, "ext-b");
    assert!(decoded.paired_extensions[1].revoked);
}

#[test]
fn empty_paired_extensions_is_byte_identical_to_pre_feature() {
    // A vault that never paired an extension emits NO "paired_extensions"
    // key, so it is byte-identical to a pre-MYND-443 vault.prefs (existing
    // golden vectors unaffected — migration-less additive field).
    let encoded = canonical_json_encode(&PrefsView::default());
    assert!(find_subslice(&encoded, b"paired_extensions").is_none());
    assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
}

#[test]
fn paired_extensions_canonical_key_position() {
    // paired_extensions sorts after last_backup_at and before saved_views.
    let original = PrefsView {
        last_backup_at: Some(1_700_000_000),
        mcp_connections: Default::default(),
        mcp_write_requests: Default::default(),
        meeting_ai_prompt: None,
        paired_extensions: alloc::vec![sample_paired("e", "t", false)],
        saved_views: alloc::vec![sample_view("v1", "A")],
        opaque_saved_views: Vec::new(),
        ..PrefsView::default()
    };
    let s = String::from_utf8(canonical_json_encode(&original)).unwrap();
    let lba = s.find("\"last_backup_at\":").unwrap();
    let pe = s.find("\"paired_extensions\":").unwrap();
    let sv = s.find("\"saved_views\":").unwrap();
    assert!(lba < pe, "paired_extensions after last_backup_at");
    assert!(pe < sv, "paired_extensions before saved_views");
}

#[test]
fn malformed_paired_extension_collapses_to_parse_failed() {
    // A structurally-bad record (missing token_value) makes the whole prefs
    // plaintext fail to parse — the caller falls back to the empty registry
    // (§9.5.5), so the extension must re-pair (never a partial grant).
    let bad = br#"{"paired_extensions":[{"extension_id":"x","revoked":false}],"screen_capture_protection":true}"#;
    assert_eq!(
        canonical_json_decode(bad),
        Err(PrefsBlobError::PlaintextParseFailed)
    );
}

#[test]
fn prefs_view_serde_serialization_omits_token_value() {
    // H1 regression: `prefs_read` returns `PrefsView` to the WebView via
    // serde. The bearer `token_value` must NEVER cross that IPC boundary
    // (`#[serde(skip_serializing)]` on `PairedExtension.token_value`); a
    // WebView that could read it would replay it to the 0600 relay and mint
    // clips without the pairing dialog. The Settings UI gets ids/timestamps
    // through the dedicated `pairing_list_paired` command, not `prefs_read`.
    // (On-disk persistence is hand-rolled canonical JSON and is unaffected —
    // `paired_extensions_round_trip_through_blob` covers that direction.)
    let view = PrefsView {
        paired_extensions: alloc::vec![sample_paired(
            "ext-a",
            "SECRET-bearer-token-must-not-leak",
            false,
        )],
        ..PrefsView::default()
    };
    let json = serde_json::to_string(&view).expect("PrefsView serializes");
    assert!(
        !json.contains("token_value"),
        "prefs_read JSON must not carry the token_value key: {json}"
    );
    assert!(
        !json.contains("SECRET-bearer-token-must-not-leak"),
        "prefs_read JSON must not carry the bearer secret value: {json}"
    );
    // We skip ONLY the bearer secret — the non-secret record fields still
    // serialize (so this is a confinement fix, not a blanket field removal).
    assert!(
        json.contains("ext-a"),
        "non-secret extension_id should still serialize: {json}"
    );
}

/// Emit the two `periodic_notes` cases (myne#177) as ready-to-paste JSON
/// case objects, appended to the `vault-prefs` family rather than folded
/// into an existing generator, so every earlier case stays byte-stable.
///
/// Two cases, the family's encrypt + decrypt_ok pair:
/// - `encrypt-periodic-notes`: a view carrying five `<period>.<setting>`
///   entries across two periods. Pins the canonical position of the field
///   (between `paired_extensions` and `reminder_horizon_days`) and the
///   lexicographic key order INSIDE the map, which is what makes two
///   implementations that build the map in different orders agree.
/// - `decrypt-periodic-notes`: the round trip.
///
/// Nonce `0xF2` is the next free entry in the family's nonce registry.
///
/// `cargo test -p protocol --lib emit_periodic_notes_prefs_vectors -- --ignored`
#[test]
#[ignore]
fn emit_periodic_notes_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
    let nonce: [u8; AEAD_NONCE_LEN] = [0xF2; AEAD_NONCE_LEN];

    // FOUR properties in one fixture, and three of them were unpinned when
    // this generator first shipped.
    //
    // 1. The lexicographic key order INSIDE the map. The entries go in in a
    //    deliberately non-sorted order across two periods, so a port that
    //    emits insertion order produces different bytes. (`BTreeMap::from`
    //    sorts on construction, so this is a statement about what the
    //    ENCODER must do with an arbitrary source order rather than about
    //    this literal; the assertion below is what holds it.)
    //
    // 2. The field's CANONICAL SLOT, and this is the correction. The first
    //    version's description claimed to pin "after paired_extensions,
    //    before reminder_horizon_days" over a blob containing neither: the
    //    field had no left neighbour at all and its right neighbour was
    //    `screen_capture_protection`. `vectors/vault-prefs/schema.md` states
    //    the invariant that every field is pinned beside BOTH of its
    //    canonical neighbours, because `vault.prefs` is canonical JSON and
    //    key order is part of the bytes, so a case that pins a value alone
    //    cannot notice a wrong slot. Both neighbours are present now.
    //
    // 3. An UNRECOGNISED period key, `quarterly.folder`. The field's own
    //    schema text says a decoder MUST re-encode an entry whose period it
    //    does not recognise, which is what makes a fourth period free, and
    //    no case anywhere contained one. The corpus carried an actively
    //    misleading precedent instead: `decrypt-unknown-field-tolerated`
    //    pins an unknown TOP-LEVEL field being DROPPED from the re-encode,
    //    which is the opposite of what this map requires.
    //
    // 4. NFC normalisation, fed in DECOMPOSED form. Every string in the
    //    first fixture was pure ASCII, so the NFC claim in the same sentence
    //    was unpinned too. `Wöchentlich/` is written here as `o` + U+0308
    //    COMBINING DIAERESIS; the encoder must emit U+00F6, so the expected
    //    bytes differ from the input literal and a port that skips the fold
    //    fails on the blob rather than on a comparison it might not make.
    //    `encrypt-labeled` uses exactly this device for `label`.
    let prefs = PrefsView {
        periodic_notes: BTreeMap::from([
            (
                String::from("weekly.template"),
                String::from("0190a000-0000-7000-8000-000000000009"),
            ),
            (String::from("monthly.folder"), String::from("Monthly/")),
            // NFD on input: `o` + U+0308, folded to U+00F6 on encode.
            (
                String::from("weekly.folder"),
                String::from("Wo\u{308}chentlich/"),
            ),
            (String::from("monthly.format"), String::from("YYYY-MM")),
            (String::from("weekly.format"), String::from("gggg-[W]ww")),
            // A period no build in this tree knows. It must survive the
            // round trip verbatim rather than being dropped.
            (String::from("quarterly.folder"), String::from("Quarterly/")),
        ]),
        // The two canonical NEIGHBOURS, so the slot is pinned rather than
        // only the value: `paired_extensions` (p) < `periodic_notes` (pe)
        // < `reminder_horizon_days` (r).
        paired_extensions: alloc::vec![crate::paired_extension::PairedExtension {
            extension_id: String::from("clipper@myne.md"),
            paired_at: Some(1_765_432_000),
            revoked: false,
            token_value: String::from("9c1fb7a4"),
        }],
        reminder_horizon_days: Some(7),
        ..PrefsView::default()
    };
    let canonical = canonical_json_encode(&prefs);
    assert_eq!(
        core::str::from_utf8(&canonical).expect("utf8"),
        concat!(
            r#"{"paired_extensions":[{"extension_id":"clipper@myne.md","paired_at":1765432000,"#,
            r#""revoked":false,"token_value":"9c1fb7a4"}],"#,
            r#""periodic_notes":{"monthly.folder":"Monthly/","monthly.format":"YYYY-MM","#,
            // PRECOMPOSED here (U+00F6) against the DECOMPOSED input above
            // (`o` + U+0308). That difference is the NFC pin: if the encoder
            // skipped the fold this literal would not match.
            "\"quarterly.folder\":\"Quarterly/\",\"weekly.folder\":\"W\u{f6}chentlich/\",",
            r#""weekly.format":"gggg-[W]ww","#,
            r#""weekly.template":"0190a000-0000-7000-8000-000000000009"},"#,
            r#""reminder_horizon_days":7,"screen_capture_protection":true}"#
        ),
        "four things at once: the field sorts between paired_extensions (p) and \
             reminder_horizon_days (r), its keys are emitted lexicographically, an \
             unrecognised period survives verbatim, and the NFD input is folded to NFC \
             (the literal above carries U+00F6, the input carried o + U+0308)",
    );

    let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
        .expect("encode periodic_notes");
    let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");

    // NOT `assert_eq!(decoded, prefs)`, and the difference is the NFC pin
    // rather than a weaker assertion. The encoder normalises, so the decoded
    // view carries `W` + U+00F6 where the source view carried `o` + U+0308:
    // a round trip through this format is exact in BYTES and idempotent in
    // VALUES, and it is not the identity on a decomposed input. Comparing
    // against the source would have forced the fixture back to ASCII, which
    // is how the NFC claim went unpinned in the first place.
    let expected_decoded = PrefsView {
        periodic_notes: {
            let mut m = prefs.periodic_notes.clone();
            m.insert(
                String::from("weekly.folder"),
                String::from("W\u{f6}chentlich/"),
            );
            m
        },
        ..prefs.clone()
    };
    assert_eq!(
        decoded, expected_decoded,
        "round trip must be exact, with the decomposed input folded to NFC",
    );
    // And it is a FIXED POINT: re-encoding what came back reproduces the
    // same bytes, which is the property a port needs and the one an
    // idempotence claim actually rests on.
    assert_eq!(
        encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &decoded, &nonce).expect("re-encode"),
        blob,
        "the decoded view must re-encode to the same bytes",
    );

    // THE INPUT THE ENCRYPT CASE SHIPS IS THE DECOMPOSED ONE, and that is
    // the whole NFC pin rather than a detail.
    //
    // The runner parses `input_plaintext_canonical_utf8_hex` into a
    // `PrefsView`, RE-ENCODES it and compares against
    // `expected_prefs_blob_hex`. Ship the canonical (precomposed) bytes as
    // the input and `nfc()` is the identity on them, so a port that skips
    // the fold entirely produces the expected blob and passes. Measured, not
    // assumed: deleting the `.nfc()` from `push_canonical_string_map` left
    // this case green until the input became decomposed.
    //
    // `encrypt-labeled` has the same shape and the same gap: its description
    // says the label "is supplied in NFD in the generator source", which is
    // true of the generator's `#[cfg(test)]` assertion and not of anything a
    // PORT can run. This case is the one that closes it, and the field name
    // is not a contradiction: the field is the ENCODER'S INPUT, and the
    // encoder is what canonicalises.
    let decomposed_plaintext: Vec<u8> = {
        let text = core::str::from_utf8(&canonical).expect("utf8");
        text.replace("W\u{f6}chentlich/", "Wo\u{308}chentlich/")
            .into_bytes()
    };
    assert_ne!(
        decomposed_plaintext, canonical,
        "the substitution must actually have happened, or this case pins nothing",
    );
    assert_eq!(
        encode_prefs_blob_raw(
            &prefs_key_a,
            &account_hash_a,
            &serde_json::from_slice::<PrefsView>(&decomposed_plaintext).expect("parse"),
            &nonce,
        )
        .expect("encode from decomposed"),
        blob,
        "a decomposed input must encode to the SAME bytes as the precomposed one",
    );

    let mut dump = alloc::string::String::new();
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/encrypt-periodic-notes\",\n");
    dump.push_str("      \"description\": \"myne#177 periodic-notes settings: a string map keyed <period>.<setting> holding the weekly equivalents of the three daily_* fields plus the two monthly ones. Pins FOUR things a port can get wrong independently. (1) The field's canonical position, and BOTH neighbours are in this blob rather than named in prose: paired_extensions (p) < periodic_notes (pe) < reminder_horizon_days (r). An earlier version of this case named those two neighbours and contained neither, so it pinned a value alone and could not have noticed a wrong slot. (2) The lexicographic key order INSIDE the map. Read that as a statement about the ENCODER rather than about this artefact: the shipped plaintext and view are both already sorted, so nothing here records an insertion order and no port can observe one. What the case actually holds is that these bytes are the sorted form, so an implementation that emits its own source order produces different bytes whenever that order differs. The generator feeds a deliberately unsorted literal, which is where the round trip is exercised, and that is a main-repo assertion a port cannot run. (3) An UNRECOGNISED period: quarterly.folder is a period no build in the reference tree knows, and it must be re-encoded verbatim, which is what makes a fourth period free without a format change. (4) NFC: weekly.folder is fed in DECOMPOSED form (o + U+0308) and these bytes carry the PRECOMPOSED U+00F6, so a port that skips the fold fails on the blob. Daily is NOT in this map by design and keeps its three top-level fields.\",\n");
    dump.push_str("      \"case_kind\": \"encrypt\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&decomposed_plaintext)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_prefs_nonce_hex\": \"{}\",\n",
        hex_lower(&nonce)
    ));
    dump.push_str(&alloc::format!(
        "      \"informational_prefs_key_hex\": \"{}\",\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_prefs_blob_hex\": \"{}\"\n",
        hex_lower(&blob)
    ));
    dump.push_str("    },\n");
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/decrypt-periodic-notes\",\n");
    dump.push_str("      \"description\": \"Round trip with encrypt-periodic-notes: the blob decodes back to the same six entries, and a decoder that dropped or reordered a key fails here rather than silently losing a period's settings. TWO round-trip properties beyond that. quarterly.folder is a period NO build knows, and it must come back verbatim, because the format's forward-compat rule for this map is re-encode-what-you-do-not-recognise, which is the OPPOSITE of decrypt-unknown-field-tolerated one case over: an unknown TOP-LEVEL field is dropped from the re-encode, an unknown period key inside this map is not. And weekly.folder went in DECOMPOSED (o + U+0308) and comes back PRECOMPOSED (U+00F6), so the round trip is exact in bytes and idempotent in values without being the identity on a decomposed input; a port that skips the NFC fold produces different blob bytes rather than a comparison it might not make.\",\n");
    dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_blob_hex\": \"{}\",\n",
        hex_lower(&blob)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical)
    ));
    dump.push_str("      \"expected_prefs_view\": {\n");
    dump.push_str("        \"screen_capture_protection\": true,\n");
    dump.push_str("        \"paired_extensions\": [{ \"extension_id\": \"clipper@myne.md\", \"paired_at\": 1765432000, \"revoked\": false, \"token_value\": \"9c1fb7a4\" }],\n");
    dump.push_str("        \"periodic_notes\": {\n");
    dump.push_str("          \"monthly.folder\": \"Monthly/\",\n");
    dump.push_str("          \"monthly.format\": \"YYYY-MM\",\n");
    dump.push_str("          \"quarterly.folder\": \"Quarterly/\",\n");
    dump.push_str("          \"weekly.folder\": \"W\u{f6}chentlich/\",\n");
    dump.push_str("          \"weekly.format\": \"gggg-[W]ww\",\n");
    dump.push_str("          \"weekly.template\": \"0190a000-0000-7000-8000-000000000009\"\n");
    dump.push_str("        },\n");
    dump.push_str("        \"reminder_horizon_days\": 7\n");
    dump.push_str("      }\n");
    dump.push_str("    }\n");

    std::fs::write("/tmp/myne_periodic_notes_prefs_cases.json", dump.as_bytes())
        .expect("write periodic-notes prefs cases");
}

/// Generator for the `view_approvals` `vault-prefs` cases (`view-manifests`,
/// myne-md/myne#922).
///
/// `cargo test -p protocol --lib emit_view_approval_prefs_vectors -- --ignored`
///
/// Writes `/tmp/myne_view_approval_prefs_cases.json`, a JSON array fragment
/// spliced by hand into the companion repo's existing `cases` array.
///
/// **Two halves, and the ABSENT half is the load-bearing one.**
/// `docs/spec/protocol.md` §9.5.2 says the map is omitted when empty, so a
/// vault that has approved nothing encodes byte-identically to a
/// pre-feature blob, and a freshly enrolled device's approval state cannot
/// be manufactured by re-writing the prefs. A suite that pinned only the
/// populated map would leave that claim untested, and "the bytes did not
/// change" is the claim most likely to be false on the one path nobody ran.
/// The absent case's expected bytes are asserted against the exact literal a
/// pre-feature encoder produced for the same vault.
///
/// **Both canonical neighbours are present** in the populated fixture
/// (`transcription_enabled` < `view_approvals` < `view_order`), because
/// `vault.prefs` is canonical JSON and key ORDER is part of the bytes: a
/// port that emits the right map in the wrong slot produces a blob this
/// crate rejects, and a case that pinned the value alone would not notice.
///
/// Two entries in the map, inserted in reverse id order, pin the
/// lexicographic key order inside it. Values are bare non-negative integers,
/// because the comparison against a view's `version` is an equality and a
/// float would never match.
///
/// Nonces 0xFA (populated) and 0xFB (absent): free in this family's
/// registry (…0xF8 and 0xF9 are taken).
#[test]
#[ignore]
fn emit_view_approval_prefs_vectors() {
    extern crate std;

    let root_a: [u8; 32] = [0x42; 32];
    let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
    let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
    let nonce_populated: [u8; AEAD_NONCE_LEN] = [0xFA; AEAD_NONCE_LEN];
    let nonce_absent: [u8; AEAD_NONCE_LEN] = [0xFB; AEAD_NONCE_LEN];

    // Case 1/2: the map POPULATED, beside both canonical neighbours.
    let prefs_populated = PrefsView {
        // `false` because the field is omit-when-TRUE (its default is on),
        // so this is the value that actually emits the left neighbour.
        transcription_enabled: false,
        view_approvals: BTreeMap::from([
            // Inserted in the order opposite to their sorted order on
            // purpose: the emitted map is ordered by the ENCODER, not by the
            // caller.
            (String::from("0190a000-0000-7000-8000-000000000006"), 1u64),
            (String::from("0190a000-0000-7000-8000-000000000005"), 3u64),
        ]),
        view_order: alloc::vec![
            String::from("0190a000-0000-7000-8000-000000000006"),
            String::from("0190a000-0000-7000-8000-000000000005"),
        ],
        ..PrefsView::default()
    };
    let canonical_populated = canonical_json_encode(&prefs_populated);
    assert_eq!(
            canonical_populated.as_slice(),
            br#"{"screen_capture_protection":true,"transcription_enabled":false,"view_approvals":{"0190a000-0000-7000-8000-000000000005":3,"0190a000-0000-7000-8000-000000000006":1},"view_order":["0190a000-0000-7000-8000-000000000006","0190a000-0000-7000-8000-000000000005"]}"#.as_slice(),
            "canonical bytes must pin the slot transcription_enabled (t) < view_approvals (view_a) < view_order (view_o), the map's lexicographic key order, and bare-decimal integer values",
        );
    let blob_populated = encode_prefs_blob_raw(
        &prefs_key_a,
        &account_hash_a,
        &prefs_populated,
        &nonce_populated,
    )
    .expect("encode view_approvals populated");
    assert_eq!(
        decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_populated).expect("decode"),
        prefs_populated,
        "populated view_approvals blob must round-trip exactly",
    );

    // Case 2/2: the map ABSENT from a vault that DOES carry views, which is
    // the shape the spec's byte-identity sentence is about. The expected
    // bytes below are the literal a pre-feature encoder produced for the
    // same vault: no `view_approvals` key anywhere in the plaintext.
    let books = crate::saved_view::SavedView {
        id: String::from("0190a000-0000-7000-8000-000000000005"),
        name: String::from("Books"),
        view_type: crate::saved_view::ViewType::Cards,
        filters: crate::saved_view::FilterNode::And {
            children: alloc::vec![
                crate::saved_view::FilterNode::InFolder {
                    path: String::from("Books/"),
                },
                crate::saved_view::FilterNode::Property {
                    key: String::from("rating"),
                    op: crate::saved_view::PropertyOp::Gt,
                    value: String::from("4"),
                },
            ],
        },
        sort: Some(crate::saved_view::ViewSort {
            key: String::from("finished"),
            direction: crate::saved_view::SortDirection::Desc,
        }),
        group_by: Some(String::from("status")),
        columns: alloc::vec![String::from("author"), String::from("rating")],
        card_size: Some(300),
        image: Some(String::from("image")),
        image_aspect_ratio: Some(String::from("1.65")),
        version: None,
        write_fields: Vec::new(),
        lanes: Vec::new(),
        template: None,
    };
    let prefs_absent = PrefsView {
        saved_views: alloc::vec![books],
        view_order: alloc::vec![String::from("0190a000-0000-7000-8000-000000000005")],
        ..PrefsView::default()
    };
    let canonical_absent = canonical_json_encode(&prefs_absent);
    assert_eq!(
            canonical_absent.as_slice(),
            br#"{"saved_views":[{"card_size":300,"columns":["author","rating"],"filters":{"children":[{"kind":"inFolder","path":"Books/"},{"key":"rating","kind":"property","op":">","value":"4"}],"kind":"and"},"group_by":"status","id":"0190a000-0000-7000-8000-000000000005","image":"image","image_aspect_ratio":"1.65","name":"Books","sort":{"direction":"desc","key":"finished"},"view_type":"cards"}],"screen_capture_protection":true,"view_order":["0190a000-0000-7000-8000-000000000005"]}"#.as_slice(),
            "a vault with views but NO approvals must encode byte-identically to its pre-feature self: this literal is the pre-view_approvals encoding of the same vault (the saved_views family's own fixture), so any emitted `view_approvals` key here is a format change",
        );
    assert!(
            !core::str::from_utf8(&canonical_absent)
                .expect("utf8")
                .contains("view_approvals"),
            "the omitted-when-empty rule is the whole sentence: an empty map must emit NO key at all, not `{{}}`",
        );
    let blob_absent =
        encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_absent, &nonce_absent)
            .expect("encode view_approvals absent");
    let decoded_absent =
        decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_absent).expect("decode");
    assert_eq!(
        decoded_absent, prefs_absent,
        "absent-approval blob must round-trip exactly",
    );
    assert!(
        decoded_absent.view_approvals.is_empty(),
        "an absent map decodes as empty rather than as an error or a default entry",
    );

    let mut dump = alloc::string::String::new();
    dump.push_str("[\n");

    // case 1/2: encrypt-view-approvals
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/encrypt-view-approvals\",\n");
    dump.push_str("      \"description\": \"Device-local saved-view approvals (view-manifests, myne-md/myne#922). PrefsView carries the additive view_approvals map (view id -> the definition version this DEVICE approved) beside transcription_enabled and view_order, pinning the canonical slot transcription_enabled (t) < view_approvals (view_a) < view_order (view_o), the map's lexicographic key order (two entries written here in reverse id order), and bare-decimal non-negative integer values. The approval is an EQUALITY against the view's current version rather than a flag, which is why the values are pinned as integers. Same vault-A inputs as the sibling cases; prefs_nonce=0xFAx24. Generated by emit_view_approval_prefs_vectors in protocol/src/prefs.rs.\",\n");
    dump.push_str("      \"case_kind\": \"encrypt\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical_populated)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_prefs_nonce_hex\": \"{}\",\n",
        hex_lower(&nonce_populated)
    ));
    dump.push_str(&alloc::format!(
        "      \"informational_prefs_key_hex\": \"{}\",\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_prefs_blob_hex\": \"{}\"\n",
        hex_lower(&blob_populated)
    ));
    dump.push_str("    },\n");

    // case 2/2: decrypt-view-approvals
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/decrypt-view-approvals\",\n");
    dump.push_str("      \"description\": \"Round-trip with encrypt-view-approvals: the blob decodes back to a PrefsView carrying view_approvals under the same root_key + account_number_hash. A decoder that does not know the field (pre-#922) tolerates it per the §9.5.2 forward-compat rule and sees no approvals, which is the fail-closed direction: an unapproved view is not opened. Nothing here is a value a peer can be told to approve, which is why the field is device-local and never arrives by sync.\",\n");
    dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_blob_hex\": \"{}\",\n",
        hex_lower(&blob_populated)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical_populated)
    ));
    dump.push_str("      \"expected_prefs_view\": {\n");
    dump.push_str("        \"screen_capture_protection\": true,\n");
    dump.push_str("        \"transcription_enabled\": false,\n");
    dump.push_str("        \"view_approvals\": { \"0190a000-0000-7000-8000-000000000005\": 3, \"0190a000-0000-7000-8000-000000000006\": 1 },\n");
    dump.push_str(
            "        \"view_order\": [\"0190a000-0000-7000-8000-000000000006\", \"0190a000-0000-7000-8000-000000000005\"]\n",
        );
    dump.push_str("      }\n");
    dump.push_str("    },\n");

    // case 3/4: encrypt-no-view-approvals
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/encrypt-no-view-approvals\",\n");
    dump.push_str("      \"description\": \"The ABSENT half of the approval pair, and the one that pins §9.5.2's sentence rather than a value: a vault carrying a saved view and no approvals encodes BYTE-IDENTICALLY to its pre-#922 self, and the expected bytes below are exactly that pre-feature encoding (the saved_views family's own fixture). An implementation that emitted an empty `view_approvals` object, or wrote a default entry for a view nobody approved, would produce a different blob for every existing vault and push it on the next write. Same vault-A inputs; prefs_nonce=0xFBx24. Generated by emit_view_approval_prefs_vectors in protocol/src/prefs.rs.\",\n");
    dump.push_str("      \"case_kind\": \"encrypt\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical_absent)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_prefs_nonce_hex\": \"{}\",\n",
        hex_lower(&nonce_absent)
    ));
    dump.push_str(&alloc::format!(
        "      \"informational_prefs_key_hex\": \"{}\",\n",
        hex_lower(&*prefs_key_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_prefs_blob_hex\": \"{}\"\n",
        hex_lower(&blob_absent)
    ));
    dump.push_str("    },\n");

    // case 4/4: decrypt-no-view-approvals
    dump.push_str("    {\n");
    dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/decrypt-no-view-approvals\",\n");
    dump.push_str("      \"description\": \"Round-trip with encrypt-no-view-approvals: the pre-feature blob decodes with NO `view_approvals` key in expected_prefs_view, so an absence and an empty map are the same value rather than two states a decoder has to distinguish. A port whose schema made the field required would fail here rather than on a live vault.\",\n");
    dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
    dump.push_str(&alloc::format!(
        "      \"input_blob_hex\": \"{}\",\n",
        hex_lower(&blob_absent)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_root_key_hex\": \"{}\",\n",
        hex_lower(&root_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"input_account_number_hash_hex\": \"{}\",\n",
        hex_lower(&account_hash_a)
    ));
    dump.push_str(&alloc::format!(
        "      \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
        hex_lower(&canonical_absent)
    ));
    dump.push_str("      \"expected_prefs_view\": {\n");
    dump.push_str("        \"screen_capture_protection\": true,\n");
    dump.push_str("        \"saved_views\": [{\n");
    dump.push_str("          \"card_size\": 300,\n");
    dump.push_str("          \"columns\": [\"author\", \"rating\"],\n");
    dump.push_str("          \"filters\": { \"children\": [{ \"kind\": \"inFolder\", \"path\": \"Books/\" }, { \"key\": \"rating\", \"kind\": \"property\", \"op\": \">\", \"value\": \"4\" }], \"kind\": \"and\" },\n");
    dump.push_str("          \"group_by\": \"status\",\n");
    dump.push_str("          \"id\": \"0190a000-0000-7000-8000-000000000005\",\n");
    dump.push_str("          \"image\": \"image\",\n");
    dump.push_str("          \"image_aspect_ratio\": \"1.65\",\n");
    dump.push_str("          \"name\": \"Books\",\n");
    dump.push_str("          \"sort\": { \"direction\": \"desc\", \"key\": \"finished\" },\n");
    dump.push_str("          \"view_type\": \"cards\"\n");
    dump.push_str("        }],\n");
    dump.push_str("        \"view_order\": [\"0190a000-0000-7000-8000-000000000005\"]\n");
    dump.push_str("      }\n");
    dump.push_str("    }\n");

    dump.push_str("]\n");

    std::fs::write("/tmp/myne_view_approval_prefs_cases.json", dump.as_bytes())
        .expect("write view-approval prefs cases dump");
}
