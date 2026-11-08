// SPDX-License-Identifier: AGPL-3.0
use super::*;
use crate::plugins::vault_unlock::state::{fixture_unlocked_with_keys, test_vault_id};
use crate::test_support::ScopedTempDir;
use protocol::{encode_prefs_blob_raw, AEAD_NONCE_LEN};

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime build")
}

/// A `Hooks` that overrides nothing.
///
/// **It CLAMPS**, and an earlier version of this doc said the opposite
/// ("a no-op, returns the value unchanged, the core has no desktop clamp
/// range"). Since myne-md/myne#479 the envelope is shared and
/// `VaultLifecycleHooks::effective_auto_lock_secs` is defaulted to it, which
/// `NoopHooks` inherits. A test written on the old belief would assert
/// against a clamped value and read as passing for the wrong reason.
fn noop_hooks() -> crate::hooks::Hooks {
    std::sync::Arc::new(crate::hooks::NoopHooks)
}

// `CountingHooks` moved to `crate::hooks` (#266) so the themes plugin's
// identical sync-window assertion uses the same double instead of a second
// 26-method copy.
use crate::hooks::test_hooks::CountingHooks;

fn counting_hooks() -> (
    crate::hooks::Hooks,
    std::sync::Arc<std::sync::atomic::AtomicU64>,
) {
    let counter = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    (
        std::sync::Arc::new(CountingHooks::new(counter.clone())),
        counter,
    )
}

#[test]
fn shared_pref_edit_bumps_the_sync_push_window() {
    // MYND-517: a shared-LWW edit (the vault rename that motivated the
    // bug) must call bump_local_change so the sync scheduler opens the
    // coalesced push window — without it a prefs-only change waits for an
    // unrelated note push forever.
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let (hooks, bumps) = counting_hooks();
        vault_set_label_with_dir(
            tmp.path(),
            &state,
            &hooks,
            Some("Renamed".into()),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("set label");
        assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 1);
    });
}

// folder_notes_enabled setter (myne-md/myne#661): default off, round-trips.

#[test]
fn set_folder_notes_enabled_persists_and_reads_back() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let io = crate::vault_io::StdVaultIo;

        // Default off: a fresh vault never enabled folder notes.
        let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read prefs");
        assert!(!prefs.folder_notes_enabled);

        // Turn it on, read it back.
        set_folder_notes_enabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("enable folder notes");
        let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read prefs");
        assert!(prefs.folder_notes_enabled);

        // Turn it back off.
        set_folder_notes_enabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("disable folder notes");
        let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read prefs");
        assert!(!prefs.folder_notes_enabled);
    });
}

// periodic_notes setter (myne#177).

#[test]
fn set_periodic_note_setting_writes_the_composed_key_and_registers_the_folder() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        set_periodic_note_setting_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "weekly".into(),
            "folder".into(),
            Some("Weekly/".into()),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set weekly folder");

        let prefs = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read prefs");
        assert_eq!(
            prefs
                .periodic_notes
                .get("weekly.folder")
                .map(String::as_str),
            Some("Weekly/")
        );
        // The daily folder's discipline (MYND-144): without this the folder
        // is invisible in the sidebar until the first note lands in it, so
        // the setting looks like it did nothing.
        assert!(prefs.deliberate_folders.iter().any(|f| f == "Weekly/"));
    });
}

#[test]
fn set_periodic_note_setting_clears_by_removing_the_key() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let io = crate::vault_io::StdVaultIo;
        for (setting, value) in [("folder", "Weekly/"), ("template", "0190a000-tmpl")] {
            set_periodic_note_setting_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "weekly".into(),
                setting.into(),
                Some(value.into()),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("set");
        }
        set_periodic_note_setting_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "weekly".into(),
            "template".into(),
            None,
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear template");

        let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read prefs");
        assert!(!prefs.periodic_notes.contains_key("weekly.template"));
        // Clearing one setting must not disturb the period's others.
        assert_eq!(
            prefs
                .periodic_notes
                .get("weekly.folder")
                .map(String::as_str),
            Some("Weekly/")
        );
    });
}

/// **The clear the UNDO reaches for two of the twelve intents**
/// (myne-md/myne#850, from the 2026-10-14 review). `set_daily_folder` takes a
/// required value, so the undo of "the run set this for the first time" has
/// no setter to reach; these two exist for exactly that state, and neither
/// had a test, so emptying either body left every gate green.
#[test]
fn clear_daily_folder_empties_the_pointer_and_keeps_the_folder_on_record() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let io = crate::vault_io::StdVaultIo;
        set_daily_folder_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "Daily/".into(),
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("set");
        clear_daily_folder_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear");

        let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read prefs");
        assert!(prefs.daily_folder.is_none());
        // The NAME stays on record: that record is what keeps the folder
        // alive as a virtual folder, and clearing the pointer is the state
        // the user had before the run.
        assert!(prefs.deliberate_folders.iter().any(|f| f == "Daily/"));
    });
}

/// The `daily_date_format` twin, and the same deletion-test reasoning.
#[test]
fn clear_daily_date_format_empties_the_pointer() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let io = crate::vault_io::StdVaultIo;
        set_daily_date_format_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "YYYY-MM-DD".into(),
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("set");
        clear_daily_date_format_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear");

        let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read prefs");
        assert!(prefs.daily_date_format.is_none());
    });
}

#[test]
fn set_periodic_note_setting_refuses_an_unknown_setting_or_a_dotted_period() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let io = crate::vault_io::StdVaultIo;
        for (period, setting) in [
            ("weekly", "colour"),       // not one of the three
            ("weekly.extra", "folder"), // a dot makes the key ambiguous
            ("", "folder"),             // empty period
            ("Weekly", "folder"),       // not a bare lowercase word
            // Daily keeps its three flat fields; an entry here would write,
            // sync and be read by nothing, which is a second home for one
            // setting.
            ("daily", "folder"),
            ("daily", "format"),
            ("daily", "template"),
        ] {
            let err = set_periodic_note_setting_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                period.into(),
                setting.into(),
                Some("x".into()),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect_err("must refuse");
            assert!(
                matches!(err, PrefsWriteError::InvalidValue),
                "{period}.{setting}"
            );
        }
        // Refusing means writing nothing, not writing something odd.
        let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read prefs");
        assert!(prefs.periodic_notes.is_empty());
    });
}

#[test]
fn set_periodic_note_setting_accepts_a_period_this_build_has_no_ui_for() {
    // The period is validated as a GRAMMAR, not against a closed list. That
    // is what makes a fourth period a client-side change with no codec,
    // spec or vector edit behind it.
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let io = crate::vault_io::StdVaultIo;
        set_periodic_note_setting_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "quarterly".into(),
            "folder".into(),
            Some("Quarterly/".into()),
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("set quarterly folder");
        let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read prefs");
        assert_eq!(
            prefs
                .periodic_notes
                .get("quarterly.folder")
                .map(String::as_str),
            Some("Quarterly/")
        );
    });
}

#[test]
fn set_union_pref_edit_bumps_the_sync_push_window() {
    // MYND-517: set-union fields are SHARED but clockless (never stamped
    // by stamp_changed_shared_fields) — the bump gate is the shared-subset
    // hash, which sees the value change itself, so they bump too.
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let (hooks, bumps) = counting_hooks();
        set_spell_languages_with_dir(
            tmp.path(),
            &state,
            &hooks,
            SetMutation::adding_all(vec!["en".into()]),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set spell languages");
        assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 1);
    });
}

#[test]
fn device_local_pref_edit_never_bumps() {
    // MYND-517 no-traffic discipline (§10.2.1): a device-local edit
    // re-encrypts the blob but leaves the shared subset unchanged — it
    // must NOT open a push window (resolution-blur; a poll-only device
    // stays poll-only).
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let (hooks, bumps) = counting_hooks();
        set_theme_with_dir(
            tmp.path(),
            &state,
            &hooks,
            Some(protocol::ThemeChoice::Dark),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set theme");
        assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 0);
    });
}

#[test]
fn noop_shared_pref_write_never_bumps() {
    // MYND-517: re-writing the SAME shared value changes neither the field
    // clocks nor the shared subset — no pointless push cycle.
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let (hooks, bumps) = counting_hooks();
        vault_set_label_with_dir(
            tmp.path(),
            &state,
            &hooks,
            Some("Same".into()),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("first set");
        vault_set_label_with_dir(
            tmp.path(),
            &state,
            &hooks,
            Some("Same".into()),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("no-op re-set");
        assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 1);
    });
}

// ── device_names (MYND-548 / SYNC-41) ────────────────────────────────────

/// A device id key shaped like the real thing (32 lowercase hex chars).
const DEV_HEX: &str = "3f9ac2d1aabbccdd00112233445566ff";

#[test]
fn device_name_round_trips_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x41).await;
        set_device_name_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            DEV_HEX.into(),
            "Studio Mac".into(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set device name");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read prefs");
        assert_eq!(
            view.device_names.get(DEV_HEX).map(String::as_str),
            Some("Studio Mac")
        );
    });
}

#[test]
fn device_name_write_stamps_its_per_key_field_clock() {
    // sync-protocol.md §10.2: device_names races per KEY, on a namespaced
    // `device_names/<key>` clock — not one clock for the whole map.
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x42).await;
        set_device_name_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            DEV_HEX.into(),
            "Laptop".into(),
            &crate::vault_io::StdVaultIo,
            &crate::host::test_host::TestHost::new(tmp.path()),
        )
        .await
        .expect("set device name");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read prefs");
        let clock = view
            .field_clocks
            .get(&format!("device_names/{DEV_HEX}"))
            .copied();
        assert!(
            clock.is_some_and(|c| c > 0),
            "expected a stamped per-key clock, got {clock:?}"
        );
        // The whole-field name must NOT be stamped — that would make one
        // device's rename clobber every other device's name on merge.
        assert!(!view.field_clocks.contains_key("device_names"));
    });
}

#[test]
fn device_name_edit_bumps_the_sync_push_window_once() {
    // MYND-517: device_names is SHARED, so a name change must open the
    // coalesced push window; re-writing the SAME name must not.
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x43).await;
        let (hooks, bumps) = counting_hooks();
        set_device_name_with_dir(
            tmp.path(),
            &state,
            &hooks,
            DEV_HEX.into(),
            "Phone".into(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("first set");
        assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 1);

        set_device_name_with_dir(
            tmp.path(),
            &state,
            &hooks,
            DEV_HEX.into(),
            "Phone".into(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("no-op re-set");
        assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 1);
    });
}

#[test]
fn device_name_is_nfc_normalized_through_the_codec() {
    // The setter does not normalize; push_canonical_string_map folds keys
    // AND values to NFC on encode (the spell_languages precedent). Writing
    // a decomposed "é" must read back precomposed, or two devices could
    // encode byte-different blobs for the same visible name.
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;
        set_device_name_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            DEV_HEX.into(),
            "Cafe\u{0301} Mac".into(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set device name");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read prefs");
        assert_eq!(
            view.device_names.get(DEV_HEX).map(String::as_str),
            Some("Caf\u{00e9} Mac")
        );
    });
}

#[test]
fn device_name_is_storable_for_an_unknown_device_id() {
    // The map is keyed independently of the server roster: a name can be
    // written for a device the roster has never reported (the enrolling
    // device names ITSELF before approval, and a removed device keeps its
    // entry — sync-protocol.md §4 never prunes).
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x45).await;
        set_device_name_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "ffffffffffffffffffffffffffffffff".into(),
            "Retired phone".into(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set device name");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read prefs");
        assert_eq!(view.device_names.len(), 1);
    });
}

#[test]
fn empty_device_name_is_a_no_op_and_preserves_the_previous_name() {
    // Empty submit == cancel. There is no clear path (the §10.2 union merge
    // cannot propagate a deletion), so a blank must never reach the blob.
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x46).await;
        let (hooks, bumps) = counting_hooks();
        set_device_name_with_dir(
            tmp.path(),
            &state,
            &hooks,
            DEV_HEX.into(),
            "Desk".into(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set device name");

        for blank in ["", "   ", "\t\n"] {
            set_device_name_with_dir(
                tmp.path(),
                &state,
                &hooks,
                DEV_HEX.into(),
                blank.into(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("blank is Ok, not an error");
        }

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read prefs");
        assert_eq!(
            view.device_names.get(DEV_HEX).map(String::as_str),
            Some("Desk")
        );
        // A refused write must not open a push window either.
        assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 1);
    });
}

#[test]
fn device_name_is_trimmed_before_storage() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x47).await;
        set_device_name_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            DEV_HEX.into(),
            "  Work Mac \n".into(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set device name");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read prefs");
        assert_eq!(
            view.device_names.get(DEV_HEX).map(String::as_str),
            Some("Work Mac")
        );
    });
}

#[test]
fn malformed_device_id_is_refused() {
    // The key is permanent and replicates; a junk one could never be removed
    // from the account afterwards.
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x48).await;
        for bad in [
            "",
            "short",
            "AA11BB22CC33DD44EE55FF6677889900",
            "zz11bb22cc33dd44ee55ff6677889900",
        ] {
            set_device_name_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                bad.into(),
                "Nope".into(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("refusal is Ok, not an error");
        }
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read prefs");
        assert!(view.device_names.is_empty());
    });
}

/// The unattended self-naming path (myne-md/myne#973): an approved device with
/// no name adopts the platform suggestion on its own. These four cases are the
/// refusal set — a write that lands when it should not is silent, because the
/// row renders the id-derived label either way.
#[test]
fn self_name_writes_once_when_the_device_has_never_had_a_name() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x49).await;
        // The prefs blob has to exist already, or the ABSENT gate below is
        // what refuses and this case proves nothing about the write itself.
        set_spell_languages_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            SetMutation::adding_all(vec!["en".into()]),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("seed the prefs blob");

        let wrote = self_name_device_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            DEV_HEX.into(),
            "Studio Mac".into(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("self name");
        assert!(wrote, "an unnamed device should have named itself");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read prefs");
        assert_eq!(
            view.device_names.get(DEV_HEX).map(String::as_str),
            Some("Studio Mac")
        );
    });
}

/// The automatic name must never outrank a name a person chose
/// (`decisions/sync/0770`, and the D8 finding that made it a bound).
///
/// `has_stored_device_name` reads THIS device's blob, so it cannot see a
/// rename that landed on a peer and has not merged here yet: a device that has
/// been offline since somebody renamed it holds no entry, the check passes,
/// and a `now` stamp would beat the human write in §10.2's per-key merge on
/// every device, with no history to recover it from. The fix is to write the
/// entry with no clock at all, and this asserts the outcome rather than the
/// mechanism: the merge of (this device's clockless auto name) with (a peer's
/// rename at a real clock) keeps the rename.
///
/// Injected: return `MutationClock::Stamped(None)` there instead of
/// `MutationClock::Unstamped` and the merge below keeps "Studio Mac", so this
/// goes red on the human name.
#[test]
fn an_automatic_name_loses_to_a_human_name_it_never_saw() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x4b).await;
        // `TestHost`, not `NoopHost`: NoopHost's clock is 0, so a mutation that
        // stamped the host clock here would be invisible against a peer at zero
        // and this test would prove nothing. The peer's clock below has to be a
        // real, earlier number for the injection to be detectable.
        let host = crate::host::test_host::TestHost::new(tmp.path());
        set_spell_languages_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            SetMutation::adding_all(vec!["en".into()]),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("seed the prefs blob");

        self_name_device_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            DEV_HEX.into(),
            "Studio Mac".into(),
            &crate::vault_io::StdVaultIo,
            &host,
        )
        .await
        .expect("self name");

        let mine = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read prefs");
        assert_eq!(
            mine.field_clocks
                .get(&format!("device_names/{DEV_HEX}"))
                .copied(),
            None,
            "the automatic name must carry no clock at all, not a real one"
        );

        // A peer renamed this device while it was offline, EARLIER in wall-clock
        // time than the auto write that follows it here. §10.2 keeps the later
        // clock, so a real stamp on this side would win the key on every device
        // and the rename would be gone with no history.
        let mut peer = mine.clone();
        peer.device_names
            .insert(DEV_HEX.into(), "Kid's iPad".into());
        peer.field_clocks
            .insert(format!("device_names/{DEV_HEX}"), 1_699_000_000_000);

        let merged = crate::plugins::sync::prefs_merge::merge_prefs(&mine, &peer);
        assert_eq!(
            merged.device_names.get(DEV_HEX).map(String::as_str),
            Some("Kid's iPad"),
            "a human name must outrank an automatic one on every device"
        );
    });
}

/// The Rust half of a vector that also lives in
/// `tests/client-core/deviceName.test.ts`, and the two must answer alike:
/// the client decides whether to ASK, and this decides whether to WRITE. A
/// divergence is silent in the direction that matters (the client asks, the
/// backend refuses, the device stays unnamed with nothing said), so the same
/// cases are asserted on both sides rather than the agreement being claimed
/// in a comment.
#[test]
fn has_stored_device_name_matches_the_client_predicate() {
    let mut prefs = PrefsView::default();
    assert!(!has_stored_device_name(&prefs, DEV_HEX), "absent");
    prefs.device_names.insert(DEV_HEX.into(), String::new());
    assert!(!has_stored_device_name(&prefs, DEV_HEX), "empty");
    prefs.device_names.insert(DEV_HEX.into(), "   ".into());
    assert!(!has_stored_device_name(&prefs, DEV_HEX), "whitespace only");
    prefs.device_names.insert(DEV_HEX.into(), " Mac ".into());
    assert!(has_stored_device_name(&prefs, DEV_HEX), "a real name");
}

/// The command's advertised contract is "resolves to whether it wrote", and
/// `set_device_name_with_dir` refuses two shapes without writing: an id that
/// is not 32-char lowercase hex, and a name that trims to empty (the clients'
/// own "blank means cancel"). Both used to answer `true` through
/// `.map(|()| true)`, which is the "sink that resolves on a refused write"
/// shape. Injected: put the `.map` back and the two `false` assertions go red.
#[test]
fn set_device_name_reports_a_refused_value_as_not_written() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x4c).await;
        let io = crate::vault_io::StdVaultIo;
        let host = crate::host::NoopHost;

        let blank = set_device_name_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            DEV_HEX.into(),
            "   ".into(),
            &io,
            &host,
        )
        .await
        .expect("a blank name is a cancel, not an error");
        assert!(!blank, "a blank name did not write anything");

        let bad_id = set_device_name_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "not-a-device-id".into(),
            "Studio Mac".into(),
            &io,
            &host,
        )
        .await
        .expect("a malformed id is refused, not an error");
        assert!(!bad_id, "a malformed device id did not write anything");

        let real = set_device_name_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            DEV_HEX.into(),
            "Studio Mac".into(),
            &io,
            &host,
        )
        .await
        .expect("a real rename writes");
        assert!(real);
    });
}

/// The gate that keeps a joining device's device-local preferences: the
/// enrollment wholesale seed is keyed on `vault.prefs` being ABSENT, so a name
/// written here must not create the blob first (§10.2.1). Injected: drop the
/// `PrefsOrigin::Absent` refusal and this test goes red on the file's existence.
#[test]
fn self_name_refuses_rather_than_creating_an_absent_prefs_blob() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x4a).await;
        let io = crate::vault_io::StdVaultIo;
        let prefs_path = tmp.path().join("vault.prefs");
        assert!(
            !prefs_path.exists(),
            "fixture must start with no vault.prefs, or the gate is untested"
        );

        let wrote = self_name_device_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            DEV_HEX.into(),
            "Studio Mac".into(),
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("self name");
        assert!(!wrote, "an absent prefs blob must refuse, not be created");
        assert!(
            !prefs_path.exists(),
            "the refusal wrote the blob, which costs this device its seed"
        );
    });
}

/// A peer names this device from its own copy, the merge lands, and then this
/// device's panel mounts: the automatic write must not replace a human-chosen
/// label. Checked inside the write mutex rather than from the client's snapshot,
/// because one nonce of staleness is exactly the window this closes.
#[test]
fn self_name_never_overwrites_a_name_a_peer_already_wrote() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x4b).await;
        set_device_name_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            DEV_HEX.into(),
            "Chosen by hand".into(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("the manual setter");
        let prefs_path = tmp.path().join("vault.prefs");
        let before = std::fs::read(&prefs_path).expect("prefs blob");

        let wrote = self_name_device_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            DEV_HEX.into(),
            "Linux PC".into(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("self name");
        assert!(!wrote, "an existing name is never replaced unattended");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read prefs");
        assert_eq!(
            view.device_names.get(DEV_HEX).map(String::as_str),
            Some("Chosen by hand")
        );
        // Byte equality, not value equality: encoding the unchanged view would
        // re-encrypt under a fresh nonce, and §10.2.1's push gate reads "same
        // nonce" as "provably unchanged". A refusal has to leave the blob alone
        // for that proof to survive.
        assert_eq!(
            std::fs::read(&prefs_path).expect("prefs blob"),
            before,
            "the refused write still touched the blob"
        );
    });
}

/// On a member session the roster is that person's own ACCOUNT, while
/// `device_names` lives in the ACTIVE VAULT's prefs and replicates to every
/// co-member of a group-shared map with no deletion. The id would label no row
/// of the vault's roster, so the unattended path stays quiet; a person renaming
/// a row by hand still writes, because they can see what they are labelling.
#[test]
fn self_name_refuses_on_a_member_session() {
    use crate::plugins::vault_unlock::state::UnlockedVault;

    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x4c).await;
        let io = crate::vault_io::StdVaultIo;
        // The same items key with no root key, which is what `authority()`
        // reads as `Member` — the shape a joined device holds. Installed
        // BEFORE the prefs blob exists, so the blob is sealed under the group
        // tier the way a real member vault's is; a member can then write prefs,
        // which is why this case needs a refusal that is not the Degraded arm.
        state
            .set_unlocked(
                test_vault_id(),
                UnlockedVault::member(
                    zeroize::Zeroizing::new([0x11; protocol::AEAD_KEY_LEN]),
                    zeroize::Zeroizing::new([0x99; protocol::AEAD_KEY_LEN]),
                    [1u8; 16],
                    0,
                    [0xFF; 32],
                ),
            )
            .await;
        set_spell_languages_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            SetMutation::adding_all(vec!["en".into()]),
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("seed the prefs blob");
        let prefs_path = tmp.path().join("vault.prefs");
        let before = std::fs::read(&prefs_path).expect("prefs blob");

        let wrote = self_name_device_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            DEV_HEX.into(),
            "Studio Mac".into(),
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("self name");
        assert!(
            !wrote,
            "a person-plane roster must not name a vault prefs key"
        );
        // Byte equality: a write would re-encrypt under a fresh nonce even if
        // the map came out identical, so this is what says "nothing landed".
        assert_eq!(
            std::fs::read(&prefs_path).expect("prefs blob"),
            before,
            "the refused write still touched the blob"
        );
    });
}

/// #250: the key comes from the unlocked slot and the directory comes from
/// the caller. A caller holding a stale "which vault is active" answer used
/// to encrypt this vault's prefs under that vault's key and write them over
/// the other vault's real blob — silently, because `read_or_default`
/// degrades an unreadable blob to defaults instead of failing.
#[test]
fn a_prefs_write_aimed_at_another_vault_is_refused() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        // A directory that derives a DIFFERENT VaultId than the slot holds.
        let other = tmp
            .path()
            .join("vaults")
            .join("33333333-3333-7333-8333-333333333333");
        std::fs::create_dir_all(&other).expect("create sibling vault dir");
        seed_real_vault_meta(&other, 0x44);

        let err = vault_set_label_with_dir(
            &other,
            &state,
            &noop_hooks(),
            Some("Work".into()),
            &crate::vault_io::StdVaultIo,
            &crate::host::test_host::TestHost::new(tmp.path()),
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect_err("a write aimed at a non-active vault must be refused");
        assert!(
            matches!(err, PrefsWriteError::VaultTargetMismatch),
            "expected VaultTargetMismatch, got {err:?}"
        );
        // And it must have written NOTHING — the refusal happens before the
        // read-modify-write, so the other vault's blob never appears.
        assert!(
            !other.join("vault.prefs").exists(),
            "the refused write must not have created the other vault's prefs blob"
        );
    });
}

/// test-audit #40: a write whose READ degraded must refuse, not persist
/// defaults over the blob it could not read.
///
/// The loss this prevents is total and silent. §9.5.5 says an undecodable
/// `vault.prefs` degrades to defaults so the vault stays openable — a READ
/// rule. Carrying it into the write means the next toggle bases its
/// read-modify-write on `PrefsView::default()` and persists that, over a
/// blob that may be intact and merely unreadable at this instant. And
/// because the SHARED subset syncs, the defaults do not stay local.
#[test]
fn a_prefs_write_is_refused_when_the_current_prefs_cannot_be_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let vault_dir = tmp.path().to_path_buf();

        // Write real prefs first, so there is something to lose.
        vault_set_label_with_dir(
            &vault_dir,
            &state,
            &noop_hooks(),
            Some("Work".into()),
            &crate::vault_io::StdVaultIo,
            &crate::host::test_host::TestHost::new(tmp.path()),
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("seed a real prefs blob");
        let stored = std::fs::read(vault_dir.join("vault.prefs")).expect("prefs on disk");
        assert!(!stored.is_empty(), "the fixture must have written prefs");

        // Corrupt it: the magic survives, the ciphertext does not decode.
        // This is the shape a torn write or a bit-rotted blob has, and the
        // one `read_or_default` degrades to defaults on.
        let mut corrupt = stored.clone();
        let tail = corrupt.len() - 1;
        corrupt[tail] ^= 0xff;
        std::fs::write(vault_dir.join("vault.prefs"), &corrupt).expect("corrupt the blob");

        let err = vault_set_label_with_dir(
            &vault_dir,
            &state,
            &noop_hooks(),
            Some("Home".into()),
            &crate::vault_io::StdVaultIo,
            &crate::host::test_host::TestHost::new(tmp.path()),
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect_err("a write over an unreadable prefs blob must be refused");
        assert!(
            matches!(err, PrefsWriteError::PrefsUnreadable),
            "expected PrefsUnreadable, got {err:?}"
        );

        // The refusal has teeth: the bytes on disk are untouched, so a
        // transient read failure leaves the real prefs recoverable.
        let after = std::fs::read(vault_dir.join("vault.prefs")).expect("prefs still there");
        assert_eq!(
            after, corrupt,
            "the refused write must not have replaced the blob it could not read"
        );
    });
}

/// The other half of #40, and the reason this is not simply "refuse on any
/// non-Stored read": an ABSENT blob is an answer, not a failure. Every
/// vault that has never opened Settings is in that state, so refusing there
/// would make the first setting change impossible.
#[test]
fn a_prefs_write_still_works_when_no_prefs_have_ever_been_written() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let vault_dir = tmp.path().to_path_buf();
        assert!(
            !vault_dir.join("vault.prefs").exists(),
            "this test needs a vault that has never written prefs"
        );
        vault_set_label_with_dir(
            &vault_dir,
            &state,
            &noop_hooks(),
            Some("First".into()),
            &crate::vault_io::StdVaultIo,
            &crate::host::test_host::TestHost::new(tmp.path()),
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("an absent blob must not block the first write");
        let view = prefs_read_with_dir(&vault_dir, &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read prefs");
        assert_eq!(view.label.as_deref(), Some("First"));
    });
}

#[test]
fn shared_field_setter_stamps_its_field_clock() {
    // MYND-478: every setter routed through update_prefs_with_dir stamps
    // the changed SHARED field's clock; a device-local setter stamps
    // nothing (sync-protocol.md §10.2).
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        vault_set_label_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some("Work".into()),
            &crate::vault_io::StdVaultIo,
            &crate::host::test_host::TestHost::new(tmp.path()),
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("set label");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        let label_clock = *view.field_clocks.get("label").expect("label stamped");
        assert!(label_clock > 0, "epoch-ms clock must be non-zero");

        // Device-local setter: no stamp, and the label clock survives.
        set_theme_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(protocol::ThemeChoice::Dark),
            &crate::vault_io::StdVaultIo,
            &crate::host::test_host::TestHost::new(tmp.path()),
        )
        .await
        .expect("set theme");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert!(!view.field_clocks.contains_key("theme"));
        assert_eq!(view.field_clocks.get("label"), Some(&label_clock));
    });
}

#[test]
fn record_last_backup_at_round_trips_through_prefs() {
    // MYND-58: the export engine's best-effort recorder writes the
    // §9.5.2 `last_backup_at` field via the standard setter discipline.
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        record_last_backup_at_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            1765432100,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("record");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(view.last_backup_at, Some(1765432100));
    });
}

// ---- helpers -------------------------------------------------------

async fn make_temp_vault_with_unlocked_state(
    seed_account_hash: u8,
) -> (ScopedTempDir, VaultRuntimeState) {
    let tmp = ScopedTempDir::new("prefs-it").expect("scoped tempdir");
    seed_real_vault_meta(tmp.path(), seed_account_hash);
    let state = VaultRuntimeState::default();
    // root_key matches the fixture's deterministic key material.
    // fixture_unlocked_with_keys(seed_root, seed_items, salts_seed)
    // derives root_key from `seed_root` (filling [u8; 32] with the
    // seed byte). Match that here so test assertions can recompute
    // prefs_key off the same root_key.
    let unlocked = fixture_unlocked_with_keys(0x42, 0x99, 1);
    state.set_unlocked(test_vault_id(), unlocked).await;
    (tmp, state)
}

/// Build a real 345-byte vault.meta blob with `account_number_hash`
/// filled by `seed_byte` repeating. Other fields are filler bytes —
/// the prefs code only consumes account_number_hash, so the other
/// fields just need to parse-pass.
fn seed_real_vault_meta(dir: &Path, seed_byte: u8) {
    let meta = protocol::VaultMeta {
        account_number_hash: [seed_byte; VAULT_META_ACCOUNT_HASH_LEN],
        kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
        random_salt_password: [1u8; 16],
        random_salt_recovery: [2u8; 16],
        nonce_password_wrap: [3u8; 24],
        enc_root_key_password: [4u8; 64],
        nonce_recovery_wrap: [5u8; 24],
        enc_root_key_recovery: [6u8; 64],
        items_key_id: [7u8; 16],
        items_key_nonce: [8u8; 24],
        enc_items_key: [9u8; 64],
        membership: None,
        person_binding: None,
    };
    std::fs::write(
        dir.join("vault.meta"),
        protocol::serialize_vault_meta(&meta),
    )
    .expect("seed vault.meta");
}

/// Compute the prefs_key the same way the production codec does,
/// so encrypt-side test fixtures can seed a vault.prefs blob that
/// the production decoder will accept.
fn compute_prefs_key(seed_root: u8) -> [u8; 32] {
    let root_key = [seed_root; 32];
    let derived = protocol::derive_subkey(&root_key, SubkeyRole::PrefsKey);
    *derived
}

// ---- Slot precondition --------------------------------------------

#[test]
fn prefs_read_rejects_when_slot_empty() {
    rt().block_on(async {
        let tmp = ScopedTempDir::new("prefs-empty").expect("scoped tempdir");
        let state = VaultRuntimeState::default();
        let result = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo).await;
        assert!(matches!(result, Err(PrefsReadError::SlotNotUnlocked)));
    });
}

#[test]
fn set_screen_capture_protection_rejects_when_slot_empty() {
    rt().block_on(async {
        let tmp = ScopedTempDir::new("prefs-write-empty").expect("scoped tempdir");
        let state = VaultRuntimeState::default();
        let result = set_screen_capture_protection_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await;
        assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
    });
}

// ---- read fall-back-to-defaults (§ 9.5.5) -------------------------

#[test]
fn prefs_read_returns_default_when_vault_prefs_absent() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        // vault.meta is seeded, vault.prefs is absent.
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("absent vault.prefs collapses to defaults");
        assert_eq!(view, PrefsView::default());
        assert!(
            view.screen_capture_protection,
            "default state has protection on per spec § 9.5.5"
        );
    });
}

#[test]
fn prefs_read_returns_default_when_vault_prefs_tampered() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        // Seed a valid encrypted vault.prefs, then flip a byte.
        let prefs_key = compute_prefs_key(0x42);
        let account_hash = [0x33u8; VAULT_META_ACCOUNT_HASH_LEN];
        let mut blob = encode_prefs_blob_raw(
            &prefs_key,
            &account_hash,
            &PrefsView {
                attachment_compression_enabled: true,
                developer_mode: false,
                ribbon_items: None,
                ribbon_visible: true,
                attachment_ocr_enabled: true,
                time_format: None,
                timezone: None,
                transcription_enabled: true,
                screen_capture_protection: false,
                ai_enabled: false,
                ai_excluded_folders: Vec::new(),
                ai_provider: None,
                ai_provider_consent: None,
                ai_provider_key: None,
                ai_provider_model: None,
                meeting_ai_prompt: None,
                bar_items_order: Vec::new(),
                cli_enabled: false,
                cli_excluded_folders: Vec::new(),
                cli_rate_limit_disabled: None,
                color_groups: Vec::new(),
                editor_toolbar_order: Vec::new(),
                editor_toolbar_hidden: Vec::new(),
                editor_slash_order: Vec::new(),
                editor_slash_hidden: Vec::new(),
                show_note_timestamps: true,
                reminders_enabled: true,
                reminder_horizon_days: None,
                show_task_marker: true,
                folder_icons: Default::default(),
                folder_notes_enabled: false,
                hidden_bar_items: Vec::new(),
                icon: None,
                item_colors: Default::default(),
                theme: None,
                deliberate_folders: Vec::new(),
                device_names: Default::default(),
                auto_lock_seconds: None,
                auto_tag_enabled: false,
                custom_theme: None,
                daily_date_format: None,
                daily_folder: None,
                daily_template: None,
                date_format: None,
                favorites: Vec::new(),
                field_clocks: Default::default(),
                item_order: Default::default(),
                keymap: Default::default(),
                active_workspace: None,
                chat_history_budget: None,
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
                new_note_location: None,
                new_note_location_folder: None,
                paired_extensions: Vec::new(),
                periodic_notes: Default::default(),
                right_panel_active_tab: None,
                right_panel_hidden_tabs: Vec::new(),
                right_panel_tab_order: Vec::new(),
                spell_enabled: None,
                spell_languages: Vec::new(),
                startup_open: None,
                startup_open_note: None,
                saved_views: Vec::new(),
                opaque_saved_views: Vec::new(),
                view_approvals: Default::default(),
                view_order: Vec::new(),
            },
            &[0x77; AEAD_NONCE_LEN],
        )
        .expect("encode");
        blob[40] ^= 0xFF;
        std::fs::write(tmp.path().join("vault.prefs"), &blob).expect("seed tampered prefs");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("tampered vault.prefs collapses to defaults");
        assert_eq!(view, PrefsView::default());
    });
}

// ---- round-trip via the plugin's own write+read --------------------

#[test]
fn round_trip_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

        // Toggle off via the plugin.
        set_screen_capture_protection_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write must succeed");

        // Disk file now exists.
        assert!(
            tmp.path().join("vault.prefs").exists(),
            "set_screen_capture_protection must create vault.prefs"
        );

        // Read back via the plugin.
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read must succeed after write");
        assert!(
            !view.screen_capture_protection,
            "toggled-off value must round-trip"
        );

        // Toggle back on.
        set_screen_capture_protection_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("second write must succeed");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read must succeed after second write");
        assert!(
            view.screen_capture_protection,
            "toggled-on value must round-trip"
        );
    });
}

// ---- editor_layout setter (MYND-137) ------------------------------

#[test]
fn editor_layout_round_trips_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

        let layout = EditorLayout {
            left_width: 312,
            right_width: 248,
            left_collapsed: false,
            right_collapsed: true,
        };
        set_editor_layout_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            layout,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write must succeed");

        assert!(
            tmp.path().join("vault.prefs").exists(),
            "set_editor_layout must create vault.prefs"
        );

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read must succeed after write");
        assert_eq!(
            view.editor_layout,
            Some(layout),
            "editor_layout value must round-trip through disk"
        );

        // A second write overwrites (last-write-wins on the whole object).
        let layout2 = EditorLayout {
            left_width: 200,
            right_width: 460,
            left_collapsed: true,
            right_collapsed: false,
        };
        set_editor_layout_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            layout2,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("second write must succeed");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read must succeed after second write");
        assert_eq!(view.editor_layout, Some(layout2));
    });
}

// ---- deliberate_folders setter (MYND-144) -------------------------

// ---- auto_lock_seconds setter (MYND-121) --------------------------

#[test]
fn auto_lock_timeout_round_trips_and_caches_effective() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

        set_auto_lock_timeout_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            900,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write must succeed");

        // Disk: prefs_read returns the raw stored value.
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read must succeed after write");
        assert_eq!(view.auto_lock_seconds, Some(900));

        // Effect: the cached effective timeout the idle timer reads is
        // updated (900 is in-range → unchanged by the clamp).
        assert_eq!(state.auto_lock_timeout_secs(), 900);
    });
}

// The clamp-WIRING test (`set_auto_lock_timeout_stores_raw_but_caches_clamped`)
// asserts the cached effective timeout is clamped to the ceiling, and it
// still lives desktop-side (`src-tauri/src/plugins/prefs/mod.rs` tests) for
// historical reasons rather than because the clamp is desktop-only: since
// myne-md/myne#479 it is shared and defaulted, so `noop_hooks()` above
// clamps too. The clamp FUNCTION is unit-tested beside itself in
// `core/src/lib.rs::auto_lock_envelope_tests`, and the trait DEFAULT is
// covered in `core/src/hooks.rs`.

#[test]
fn deliberate_folders_round_trip_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

        set_deliberate_folders_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            SetMutation::adding_all(alloc_vec(["Projects/Myne/", "Archive/2025/"])),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write must succeed");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read must succeed after write");
        // Canonical sort applies at encode → read-back is sorted.
        assert_eq!(
            view.deliberate_folders,
            alloc_vec(["Archive/2025/", "Projects/Myne/"]),
        );
        // screen_capture_protection untouched (defaults on).
        assert!(view.screen_capture_protection);

        // Empty set round-trips (and re-encodes byte-identical to v0.1.0).
        set_deliberate_folders_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            SetMutation {
                add: Vec::new(),
                add_unless_removed: Vec::new(),
                remove: vec!["Projects/Myne/".to_string(), "Archive/2025/".to_string()],
                remove_prefix: Vec::new(),
                rename_prefix: Vec::new(),
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear must succeed");
        let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after clear");
        assert!(cleared.deliberate_folders.is_empty());
    });
}

// ---- archived_folders setter (folder-archive) ---------------------

#[test]
fn archived_folders_round_trip_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x34).await;

        set_archived_folders_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            SetMutation::adding_all(alloc_vec(["Projects/Myne/", "Archive/2025/"])),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write must succeed");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read must succeed after write");
        // Canonical sort applies at encode → read-back is sorted.
        assert_eq!(
            view.archived_folders,
            alloc_vec(["Archive/2025/", "Projects/Myne/"]),
        );
        // Independent of deliberate_folders (the two sets don't interfere).
        assert!(view.deliberate_folders.is_empty());

        // Empty set round-trips (and re-encodes byte-identical to pre-feature).
        set_archived_folders_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            SetMutation {
                add: Vec::new(),
                add_unless_removed: Vec::new(),
                remove: vec!["Projects/Myne/".to_string(), "Archive/2025/".to_string()],
                remove_prefix: Vec::new(),
                rename_prefix: Vec::new(),
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear must succeed");
        let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after clear");
        assert!(cleared.archived_folders.is_empty());
    });
}

// ---- AI prefs setters (local-ai, ai-ux-surface MYND-408) ----------

#[test]
fn ai_prefs_round_trip_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x51).await;

        // Defaults: AI off, no exclusions.
        let base = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert!(!base.ai_enabled);
        assert!(base.ai_excluded_folders.is_empty());

        // Enable + set exclusions (unsorted input).
        set_ai_enabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("enable must succeed");
        set_ai_excluded_folders_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            SetMutation::adding_all(alloc_vec(["Private/", "Archive/2025/"])),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set exclusions must succeed");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after write");
        assert!(view.ai_enabled);
        // Canonical sort applies at encode → read-back is sorted.
        assert_eq!(
            view.ai_excluded_folders,
            alloc_vec(["Archive/2025/", "Private/"]),
        );
        // Unrelated fields untouched (defaults on).
        assert!(view.screen_capture_protection);

        // Disable + clear → back to defaults (byte-identical to pre-field).
        set_ai_enabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("disable must succeed");
        set_ai_excluded_folders_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            SetMutation {
                add: Vec::new(),
                add_unless_removed: Vec::new(),
                remove: vec!["Private/".to_string(), "Archive/2025/".to_string()],
                remove_prefix: Vec::new(),
                rename_prefix: Vec::new(),
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear must succeed");
        let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after clear");
        assert!(!cleared.ai_enabled);
        assert!(cleared.ai_excluded_folders.is_empty());
    });
}

// ---- Developer mode setter (developer-mode, MYND-593) -------------

/// **The clamp is the control, so it is asserted through the COMMAND, not
/// through a helper** (myne-md/myne#617). This number bounds how much of the
/// user's plaintext one agent run sends to a provider, multiplied by the
/// loop's iteration ceiling, and TB13 records that no other per-run volume
/// cap exists. A test that called a clamping function directly would prove
/// the function clamps and say nothing about whether the write path uses it,
/// which is exactly the gap between a host-side rule and a host-side rule
/// whose trigger came from the caller.
#[test]
fn chat_history_budget_is_clamped_at_the_write_not_in_the_ui() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x53).await;
        let io = crate::vault_io::StdVaultIo;
        let max = crate::plugins::agent::history::MAX_HISTORY_BUDGET as u32;

        // Unset by default: the host applies its own, and the field is
        // omitted from the blob entirely.
        let base = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read");
        assert_eq!(base.chat_history_budget, None);

        // A value over the ceiling is STORED at the ceiling. Read back from
        // disk rather than trusted from the return value: a host that
        // reported success and wrote the raw number would pass a
        // return-value assertion.
        set_chat_history_budget_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(max + 50_000),
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("write must succeed");
        let over = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read");
        assert_eq!(
            over.chat_history_budget,
            Some(max),
            "an over-ceiling budget must be stored at the ceiling, not as sent"
        );

        // An ordinary value survives unchanged, which is the direction that
        // would make the clamp a bug rather than a bound.
        set_chat_history_budget_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(1_500),
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("write must succeed");
        let ordinary = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read");
        assert_eq!(ordinary.chat_history_budget, Some(1_500));

        // And `None` clears the override rather than storing a zero: unset
        // and "seed nothing" are different states, and only one of them is
        // the default.
        set_chat_history_budget_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            None,
            &io,
            &crate::host::NoopHost,
        )
        .await
        .expect("write must succeed");
        let cleared = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read");
        assert_eq!(cleared.chat_history_budget, None);
    });
}

#[test]
fn developer_mode_persist_and_reload_round_trip() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x52).await;

        // Default: off.
        let base = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert!(!base.developer_mode);

        // Enable, then reload from a fresh read (persist-and-reload).
        set_developer_mode_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("enable must succeed");
        let enabled = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after enable");
        assert!(enabled.developer_mode);
        // Unrelated fields untouched.
        assert!(enabled.screen_capture_protection);

        // Disable → back to default (byte-identical to pre-field, since the
        // codec emits the key only when true).
        set_developer_mode_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("disable must succeed");
        let disabled = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after disable");
        assert!(!disabled.developer_mode);
    });
}

// ---- CLI prefs setters (myne-cli epic, MYND-490; task 2) ----------

#[test]
fn cli_prefs_round_trip_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x52).await;

        // Defaults: door closed, no exclusions, rate limit untouched.
        let base = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert!(!base.cli_enabled);
        assert!(base.cli_excluded_folders.is_empty());
        assert_eq!(base.cli_rate_limit_disabled, None);

        // Enable + set exclusions (unsorted input) + disable the rate limit.
        set_cli_enabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("enable must succeed");
        set_cli_excluded_folders_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            SetMutation::adding_all(alloc_vec(["Private/", "Archive/2025/"])),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set exclusions must succeed");
        set_cli_rate_limit_disabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("disable rate limit must succeed");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after write");
        assert!(view.cli_enabled);
        // Canonical sort applies at encode → read-back is sorted.
        assert_eq!(
            view.cli_excluded_folders,
            alloc_vec(["Archive/2025/", "Private/"]),
        );
        assert_eq!(view.cli_rate_limit_disabled, Some(true));
        // Unrelated fields untouched (defaults on).
        assert!(view.screen_capture_protection);

        // Disable + clear → back to defaults (door closed, empty set); the
        // rate-limit toggle persists an explicit Some(false), not back to
        // None (the archive_disabled precedent).
        set_cli_enabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("disable must succeed");
        set_cli_excluded_folders_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            SetMutation {
                add: Vec::new(),
                add_unless_removed: Vec::new(),
                remove: vec!["Private/".to_string(), "Archive/2025/".to_string()],
                remove_prefix: Vec::new(),
                rename_prefix: Vec::new(),
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear must succeed");
        set_cli_rate_limit_disabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("re-enable rate limit must succeed");
        let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after clear");
        assert!(!cleared.cli_enabled);
        assert!(cleared.cli_excluded_folders.is_empty());
        assert_eq!(cleared.cli_rate_limit_disabled, Some(false));
    });
}

// ---- "Files" panel setters (MYND-462) -----------------------------

#[test]
fn new_note_location_specific_registers_deliberate_folder() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

        // "specific" mode with a target folder: the pair round-trips AND the
        // folder is registered as a deliberate folder so it survives empty.
        set_new_note_location_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some("specific".to_string()),
            Some("Inbox/".to_string()),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write must succeed");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read must succeed after write");
        assert_eq!(view.new_note_location.as_deref(), Some("specific"));
        assert_eq!(view.new_note_location_folder.as_deref(), Some("Inbox/"));
        assert!(view.deliberate_folders.contains(&"Inbox/".to_string()));

        // Switching back to "root" clears the target (caller passes None).
        set_new_note_location_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some("root".to_string()),
            None,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("second write must succeed");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after second write");
        assert_eq!(view.new_note_location.as_deref(), Some("root"));
        assert_eq!(view.new_note_location_folder, None);
        // The deliberate folder persists (designating then un-designating a
        // folder does not delete it — the daily_folder discipline).
        assert!(view.deliberate_folders.contains(&"Inbox/".to_string()));
    });
}

#[test]
fn startup_open_specific_round_trips_through_disk() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x45).await;

        set_startup_open_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some("specific".to_string()),
            Some("0192f1a0-0000-7000-8000-000000000000".to_string()),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write must succeed");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read must succeed after write");
        assert_eq!(view.startup_open.as_deref(), Some("specific"));
        assert_eq!(
            view.startup_open_note.as_deref(),
            Some("0192f1a0-0000-7000-8000-000000000000")
        );

        // "empty" mode clears the note pointer (caller passes None).
        set_startup_open_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some("empty".to_string()),
            None,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("second write must succeed");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after second write");
        assert_eq!(view.startup_open.as_deref(), Some("empty"));
        assert_eq!(view.startup_open_note, None);
    });
}

// ---- decoration maps: item_colors / folder_icons (MYND-184/185) --

#[test]
fn item_colors_round_trip_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

        let colors = std::collections::BTreeMap::from([
            (
                String::from("0190a000-0000-7000-8000-000000000001"),
                String::from("moss"),
            ),
            (String::from("Projects/Myne/"), String::from("slate")),
        ]);
        set_item_colors_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            colors.clone(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write must succeed");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after write");
        assert_eq!(view.item_colors, colors);
        // screen_capture_protection untouched (defaults on).
        assert!(view.screen_capture_protection);

        // Empty map round-trips (re-encodes byte-identical to a pre-feature blob).
        set_item_colors_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            std::collections::BTreeMap::new(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear must succeed");
        let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after clear");
        assert!(cleared.item_colors.is_empty());
    });
}

#[test]
fn folder_icons_round_trip_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

        let icons = std::collections::BTreeMap::from([
            (String::from("Archive/2025/"), String::from("archive")),
            (String::from("Projects/Myne/"), String::from("book")),
        ]);
        set_folder_icons_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            icons.clone(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write must succeed");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after write");
        assert_eq!(view.folder_icons, icons);

        set_folder_icons_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            std::collections::BTreeMap::new(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear must succeed");
        let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after clear");
        assert!(cleared.folder_icons.is_empty());
    });
}

// ---- item_order / favorites setters (MYND-183) -------------------

/// A single-root-container `item_order` map (`"" → [ids…]`) — the shape a
/// test writes when it exercises just one container (MYND-596).
fn root_order<const N: usize>(ids: [&str; N]) -> std::collections::BTreeMap<String, Vec<String>> {
    std::collections::BTreeMap::from([(String::new(), ids.iter().map(|s| s.to_string()).collect())])
}

#[test]
fn item_order_and_favorites_round_trip_preserving_sequence() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

        // item_order is a heterogeneous sequence (note UUIDs + folder paths)
        // — element order is the payload, so it round-trips VERBATIM (not
        // sorted, unlike deliberate_folders). A folder path is interleaved
        // between note UUIDs to exercise the heterogeneity.
        set_item_order_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            root_order(["n-zzz", "Zebra/", "n-aaa"]),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write item_order");
        set_favorites_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            alloc_vec(["n-zzz", "n-aaa"]),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write favorites");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after order writes");
        assert_eq!(view.item_order, root_order(["n-zzz", "Zebra/", "n-aaa"]));
        assert_eq!(view.favorites, alloc_vec(["n-zzz", "n-aaa"]));
        // The pre-existing screen_capture default is untouched.
        assert!(view.screen_capture_protection);

        // Clearing item_order round-trips back to empty; favorites is
        // an independent field and stays set.
        set_item_order_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            std::collections::BTreeMap::new(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear item_order");
        let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after clear");
        assert!(cleared.item_order.is_empty());
        assert_eq!(cleared.favorites, alloc_vec(["n-zzz", "n-aaa"]));
    });
}

fn alloc_vec(items: impl IntoIterator<Item = &'static str>) -> Vec<String> {
    items.into_iter().map(String::from).collect()
}

// ---- hidden_bar_items setter (bottom-bar customization) -----------

#[test]
fn hidden_bar_items_round_trips_as_canonicalized_set() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

        // hidden_bar_items is a SET — the codec sorts + dedupes on encode,
        // so an out-of-order, duplicated input reads back canonicalized.
        set_hidden_bar_items_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            alloc_vec(["word-count", "graph", "graph"]),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write hidden_bar_items");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after hidden_bar_items write");
        assert_eq!(view.hidden_bar_items, alloc_vec(["graph", "word-count"]));
        assert!(view.screen_capture_protection);

        // Clearing round-trips back to empty (bar fully visible default).
        set_hidden_bar_items_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Vec::new(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear hidden_bar_items");
        let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after clear");
        assert!(cleared.hidden_bar_items.is_empty());
    });
}

// ---- saved-view CRUD (MYND-273) -----------------------------------

fn test_view(id: &str, name: &str) -> SavedView {
    use protocol::{FilterNode, ViewType};
    SavedView {
        id: String::from(id),
        name: String::from(name),
        view_type: ViewType::Cards,
        filters: FilterNode::InFolder {
            path: String::from("Books/"),
        },
        sort: None,
        group_by: None,
        columns: alloc_vec(["author"]),
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
fn upsert_saved_view_round_trips_and_edits_by_id() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

        // Save v1 → read returns it.
        upsert_saved_view_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            test_view("v1", "Books"),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("save v1");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(view.saved_views.len(), 1);
        assert_eq!(view.saved_views[0].name, "Books");

        // Edit v1 (same id, new name) → still one view, updated (no duplicate).
        upsert_saved_view_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            test_view("v1", "Reading"),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("edit v1");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(view.saved_views.len(), 1);
        assert_eq!(view.saved_views[0].name, "Reading");

        // Save a second view → two distinct entries.
        upsert_saved_view_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            test_view("v2", "Films"),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("save v2");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(view.saved_views.len(), 2);
        // The pre-existing screen_capture default is untouched.
        assert!(view.screen_capture_protection);
    });
}

// The browser-clipper paired-extension persistence acceptance tests
// (`paired_extensions_persist_and_read_round_trip_valid_and_revoked` +
// `paired_extensions_persist_rejects_when_slot_empty`) exercise the core
// `persist_paired_extensions_with_dir` path but build/validate the records
// through the desktop-only `clipper::token::TokenRegistry`, so they live
// desktop-side (`src-tauri/src/plugins/prefs/mod.rs` tests). The protocol
// round-trip of the `paired_extensions` field is covered in `protocol`.

#[test]
fn upsert_over_cap_fails_and_leaves_prior_prefs_intact() {
    // Story 13: a save whose encoded prefs exceeds the 64 KiB §9.5.4 cap
    // fails PrefsEncodeFailed BEFORE the atomic write — the prior on-disk
    // view set is untouched.
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x45).await;
        upsert_saved_view_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            test_view("v1", "Small"),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("save small");

        // A view with a >64 KiB name blows the cap on encode.
        let mut huge = test_view("v2", "");
        huge.name = "x".repeat(70 * 1024);
        let result = upsert_saved_view_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            huge,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await;
        assert!(matches!(result, Err(PrefsWriteError::PrefsEncodeFailed)));

        // Prior prefs intact: still exactly the one small view.
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(view.saved_views.len(), 1);
        assert_eq!(view.saved_views[0].id, "v1");
    });
}

#[test]
fn delete_and_set_view_order_reject_when_slot_empty() {
    rt().block_on(async {
        let tmp = ScopedTempDir::new("prefs-sv-del-empty").expect("scoped tempdir");
        let state = VaultRuntimeState::default();
        assert!(matches!(
            delete_saved_view_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                String::from("v1"),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost
            )
            .await,
            Err(PrefsWriteError::SlotNotUnlocked)
        ));
        assert!(matches!(
            set_view_order_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                alloc_vec(["v1"]),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost
            )
            .await,
            Err(PrefsWriteError::SlotNotUnlocked)
        ));
    });
}

#[test]
fn delete_saved_view_removes_and_prunes_view_order() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x46).await;
        upsert_saved_view_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            test_view("v1", "A"),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("save v1");
        upsert_saved_view_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            test_view("v2", "B"),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("save v2");
        set_view_order_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            alloc_vec(["v2", "v1"]),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("order");

        // Delete v1 → gone from saved_views AND pruned from view_order.
        delete_saved_view_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            String::from("v1"),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("delete v1");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(view.saved_views.len(), 1);
        assert_eq!(view.saved_views[0].id, "v2");
        assert_eq!(view.view_order, alloc_vec(["v2"]));

        // Deleting an absent id is an idempotent no-op success.
        delete_saved_view_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            String::from("ghost"),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("delete absent is ok");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(view.saved_views.len(), 1);
    });
}

// ---- view_approvals (view-manifests) -------------------------------

/// The plain APPROVAL action: a pending view becomes approved at a version,
/// and nothing about the definition changes.
#[test]
fn set_view_approval_records_the_version_against_this_device() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x5a).await;
        let mut def = test_view("v1", "Books");
        def.version = Some(1);
        upsert_saved_view_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            def,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("save v1");

        // Before approval: stored, readable, NOT approved.
        let before = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert!(before.view_approvals.is_empty());
        assert!(!protocol::is_view_approved(
            &before.view_approvals,
            &before.saved_views[0]
        ));

        set_view_approval_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            ViewApproval {
                view_id: String::from("v1"),
                version: Some(1),
                definition: None,
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("approve v1");

        let after = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(after.view_approvals.get("v1"), Some(&1u64));
        assert!(protocol::is_view_approved(
            &after.view_approvals,
            &after.saved_views[0]
        ));
        // The definition is untouched by an approval.
        assert_eq!(after.saved_views[0].name, "Books");
    });
}

/// A version bump makes the view unapproved WITHOUT the map being touched:
/// the whole "no clear step to forget" property, asserted on the SAME stored
/// approval rather than on a fresh one.
#[test]
fn a_version_bump_makes_the_view_unapproved_without_touching_the_map() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x5b).await;
        let mut def = test_view("v1", "Books");
        def.version = Some(1);
        upsert_saved_view_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            def,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("save v1");
        set_view_approval_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            ViewApproval {
                view_id: String::from("v1"),
                version: Some(1),
                definition: None,
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("approve v1");
        assert!(
            protocol::is_view_approved(
                &prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                    .await
                    .expect("read")
                    .view_approvals,
                &{
                    let mut v = test_view("v1", "Books");
                    v.version = Some(1);
                    v
                }
            ),
            "v1 at version 1 is approved after the approval write"
        );

        // The definition moves to version 2 by an ORDINARY upsert, which is
        // exactly what an app-side edit does.
        let mut bumped = test_view("v1", "Books, revised");
        bumped.version = Some(2);
        upsert_saved_view_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            bumped.clone(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("bump to v2");

        let after = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        // The map still names version 1. Nothing cleared it …
        assert_eq!(after.view_approvals.get("v1"), Some(&1u64));
        // … and the view is nonetheless NOT approved, which is the property.
        assert!(!protocol::is_view_approved(&after.view_approvals, &bumped));
    });
}

/// A LOCAL edit lands the definition and its approval in ONE write, which is
/// what keeps editing your own view from leaving it unapproved. The import
/// path deliberately does not use this arm.
#[test]
fn a_local_edit_records_the_definition_and_its_approval_in_one_write() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x5c).await;
        let mut def = test_view("v1", "Books");
        def.version = Some(4);
        set_view_approval_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            ViewApproval {
                view_id: String::from("v1"),
                version: Some(4),
                definition: Some(def.clone()),
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("local edit + approve");

        let after = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(after.saved_views.len(), 1);
        assert_eq!(after.saved_views[0].version, Some(4));
        assert_eq!(after.view_approvals.get("v1"), Some(&4u64));
        assert!(protocol::is_view_approved(
            &after.view_approvals,
            &after.saved_views[0]
        ));
    });
}

/// An id mismatch between the map key and the definition is refused, and the
/// refusal writes NOTHING: approving one view while storing another would be
/// an approval of bytes nobody was shown.
#[test]
fn a_definition_naming_a_different_view_is_refused_and_writes_nothing() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x5d).await;
        let mut def = test_view("v2", "Other");
        def.version = Some(1);
        let err = set_view_approval_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            ViewApproval {
                view_id: String::from("v1"),
                version: Some(1),
                definition: Some(def),
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect_err("mismatched id must be refused");
        assert!(matches!(err, PrefsWriteError::InvalidValue));

        let after = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert!(after.saved_views.is_empty(), "no definition was stored");
        assert!(after.view_approvals.is_empty(), "no approval was recorded");
    });
}

/// `version: None` clears the entry, and deleting the view prunes it: a stale
/// approval would pre-approve a re-imported definition of the same id.
#[test]
fn clearing_and_deleting_remove_the_approval_entry() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x5e).await;
        for id in ["v1", "v2"] {
            let mut def = test_view(id, "Books");
            def.version = Some(1);
            upsert_saved_view_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                def,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("save");
            set_view_approval_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                ViewApproval {
                    view_id: String::from(id),
                    version: Some(1),
                    definition: None,
                },
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("approve");
        }
        let both = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(both.view_approvals.len(), 2);

        // Explicit clear.
        set_view_approval_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            ViewApproval {
                view_id: String::from("v1"),
                version: None,
                definition: None,
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear v1");
        // Delete prunes the other.
        delete_saved_view_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            String::from("v2"),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("delete v2");

        let after = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert!(
            after.view_approvals.is_empty(),
            "a cleared approval and a deleted view's approval must both be gone; got {:?}",
            after.view_approvals
        );
    });
}

#[test]
fn set_view_order_preserves_sequence_verbatim_no_gc() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x47).await;
        // A reorder over ids that don't (yet) exist is tolerated — no codec GC.
        set_view_order_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            alloc_vec(["v3", "v1", "v3"]),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set order");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(view.view_order, alloc_vec(["v3", "v1", "v3"]));
    });
}

// ---- bar_items_order setter (bottom-bar reorder) ------------------

#[test]
fn set_bar_items_order_preserves_sequence_verbatim() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x49).await;
        // Sequence semantics — order is the payload, preserved verbatim
        // (NOT sorted/deduped, unlike the hidden_bar_items set).
        set_bar_items_order_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            alloc_vec(["word-count", "graph", "tags", "view-mode"]),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set order");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(
            view.bar_items_order,
            alloc_vec(["word-count", "graph", "tags", "view-mode"])
        );

        // Clearing round-trips back to empty.
        set_bar_items_order_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Vec::new(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear order");
        let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert!(cleared.bar_items_order.is_empty());
    });
}

// ---- ribbon setters (myne-md/myne#699) ----------------------------

#[test]
fn set_ribbon_items_writes_some_so_emptied_stays_emptied() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x4a).await;
        // Sequence semantics: order is the payload, preserved verbatim.
        set_ribbon_items_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            alloc_vec(["note.new", "daily.open-today"]),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set items");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(
            view.ribbon_items,
            Some(alloc_vec(["note.new", "daily.open-today"]))
        );

        // Emptying writes `Some([])`, NOT `None`: a deliberately emptied
        // rail must not decode back to "never configured" and re-seed.
        set_ribbon_items_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Vec::new(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear items");
        let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(cleared.ribbon_items, Some(Vec::new()));
    });
}

#[test]
fn set_ribbon_items_rejects_over_cap_count_and_length() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x4c).await;
        // 129 ids: one past MAX_RIBBON_ITEMS.
        let too_many: Vec<String> = (0..129).map(|i| format!("cmd.{i}")).collect();
        let result = set_ribbon_items_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            too_many,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await;
        assert!(matches!(result, Err(PrefsWriteError::InvalidValue)));
        // One id past MAX_RIBBON_ITEM_LEN.
        let too_long: Vec<String> = vec!["x".repeat(201)];
        let result = set_ribbon_items_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            too_long,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await;
        assert!(matches!(result, Err(PrefsWriteError::InvalidValue)));
        // Neither refusal wrote: the rail is still unconfigured.
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(view.ribbon_items, None);
    });
}

#[test]
fn set_ribbon_visible_round_trips() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x4b).await;
        set_ribbon_visible_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("hide ribbon");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert!(!view.ribbon_visible);
    });
}

// ---- color-groups setter (graph-connection-ux-polish) -------------

fn test_color_group(id: &str, color: &str, enabled: bool) -> ColorGroup {
    ColorGroup {
        id: id.to_string(),
        name: id.to_string(),
        color: color.to_string(),
        enabled,
        filter: protocol::FilterNode::All,
    }
}

#[test]
fn set_color_groups_preserves_order_verbatim_and_round_trips() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x4a).await;
        // Order is precedence here — no separate `*_order` field, so the
        // codec must preserve caller order VERBATIM (not id-sorted).
        let groups = vec![
            test_color_group("g2", "group-fern", true),
            test_color_group("g1", "group-olive", false),
        ];
        set_color_groups_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            groups.clone(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("set color groups");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(view.color_groups, groups);

        // Clearing round-trips back to empty (omit-when-empty on disk).
        set_color_groups_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Vec::new(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear color groups");
        let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert!(cleared.color_groups.is_empty());
    });
}

#[test]
fn color_groups_edit_stamps_its_lww_clock_and_opens_the_push_window() {
    // MYND-635: the two things that must be true on the AUTHORING device
    // before a color group can reach a second synced device at all. The
    // round-trip above proves neither — it passes `NoopHost` + `noop_hooks`,
    // which swallow both signals — and neither follows from the §10.2
    // classification row on its own.
    //
    //   1. the write stamps `field_clocks["color_groups"]`. The field is
    //      `Shared(WholeValueLww)`, so ordering IS the clock. Left
    //      unstamped it reads as 0 and ties with a peer's untouched empty
    //      list, at which point the equal-clock tiebreak (canonical-encoding
    //      bytes) decides whether the authored rules survive — i.e. luck.
    //   2. the write calls `bump_local_change` — the MYND-517 coalesced
    //      push window. Without it the blob sits on disk until some
    //      unrelated note push carries it along, which on a phone is
    //      effectively never.
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x4b).await;
        let (hooks, bumps) = counting_hooks();
        let host = crate::host::test_host::TestHost::new(tmp.path());
        let bumped = || bumps.load(std::sync::atomic::Ordering::Relaxed);
        let groups = vec![test_color_group("g1", "group-olive", true)];

        set_color_groups_with_dir(
            tmp.path(),
            &state,
            &hooks,
            groups.clone(),
            &crate::vault_io::StdVaultIo,
            &host,
        )
        .await
        .expect("author color groups");

        let authored_clock = {
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            *view
                .field_clocks
                .get("color_groups")
                .expect("color_groups stamped")
        };
        assert_eq!(authored_clock, host.now_unix_millis());
        assert!(authored_clock > 0, "epoch-ms clock must be non-zero");
        assert_eq!(bumped(), 1, "authoring opens the push window");

        // A no-op re-write of the IDENTICAL list must neither re-stamp nor
        // re-bump, even though the clock has advanced in between: the gate
        // is the shared-subset hash, not "a setter ran". A device that
        // re-stamped here would win every race by writing nothing.
        host.set_now(1_700_000_500);
        set_color_groups_with_dir(
            tmp.path(),
            &state,
            &hooks,
            groups.clone(),
            &crate::vault_io::StdVaultIo,
            &host,
        )
        .await
        .expect("no-op re-write");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(view.field_clocks.get("color_groups"), Some(&authored_clock));
        assert_eq!(bumped(), 1, "a no-op write must not bump");

        // Clearing must advance the clock and bump again — otherwise the
        // deletion loses to a stale peer still holding the rules and they
        // come back on the next merge.
        set_color_groups_with_dir(
            tmp.path(),
            &state,
            &hooks,
            Vec::new(),
            &crate::vault_io::StdVaultIo,
            &host,
        )
        .await
        .expect("clear color groups");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        let cleared_clock = *view
            .field_clocks
            .get("color_groups")
            .expect("clearing stamps too");
        assert!(
            cleared_clock > authored_clock,
            "a delete must out-rank the write it deletes ({cleared_clock} vs {authored_clock})"
        );
        assert_eq!(bumped(), 2, "clearing opens the push window too");
    });
}

// ---- theme setter (MYND-110) --------------------------------------

#[test]
fn theme_round_trips_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

        // Explicit Dark persists (disk-first) + round-trips.
        set_theme_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(ThemeChoice::Dark),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write theme");
        assert!(
            tmp.path().join("vault.prefs").exists(),
            "set_theme must create vault.prefs"
        );
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after theme write");
        assert_eq!(view.theme, Some(ThemeChoice::Dark));
        // The pre-existing screen_capture default is untouched.
        assert!(view.screen_capture_protection);

        // Switching to Light overwrites.
        set_theme_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(ThemeChoice::Light),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write light");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after light");
        assert_eq!(view.theme, Some(ThemeChoice::Light));

        // System (None) clears the field back to "no explicit choice".
        set_theme_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            None,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write system");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after system");
        assert_eq!(view.theme, None);
    });
}

#[test]
fn custom_theme_round_trips_and_coexists_with_theme() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

        // Select a custom theme (disk-first) + round-trip.
        set_custom_theme_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(String::from("solarized-dark")),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write custom_theme");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after custom_theme write");
        assert_eq!(view.custom_theme.as_deref(), Some("solarized-dark"));

        // A built-in theme can be set alongside it; both persist (precedence
        // — custom_theme winning — is resolved client-side).
        set_theme_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(ThemeChoice::Dark),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write theme");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after theme write");
        assert_eq!(view.custom_theme.as_deref(), Some("solarized-dark"));
        assert_eq!(view.theme, Some(ThemeChoice::Dark));

        // Clearing custom_theme (None) drops the field back to "no custom".
        set_custom_theme_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            None,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear custom_theme");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after clear");
        assert_eq!(view.custom_theme, None);
        assert_eq!(view.theme, Some(ThemeChoice::Dark));
    });
}

// ---- editor-typography setters ------------------------------------

#[test]
fn typography_presets_round_trip_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

        set_typography_field_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "editor_text_size",
            |p| {
                p.editor_text_size = Some(String::from("lg"));
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write text size");
        set_typography_field_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "editor_font_family",
            |p| {
                p.editor_font_family = Some(String::from("sans"));
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write font family");
        assert!(tmp.path().join("vault.prefs").exists());

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after typography write");
        assert_eq!(view.editor_text_size.as_deref(), Some("lg"));
        assert_eq!(view.editor_font_family.as_deref(), Some("sans"));
        // Pre-existing defaults untouched.
        assert!(view.screen_capture_protection);

        // None clears the field back to the default (omitted on disk).
        set_typography_field_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "editor_text_size",
            |p| {
                p.editor_text_size = None;
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear text size");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after clear");
        assert_eq!(view.editor_text_size, None);
        assert_eq!(view.editor_font_family.as_deref(), Some("sans"));
    });
}

// ---- spell-check setters (MYND-267) -------------------------------

#[test]
fn spell_prefs_round_trip_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

        // Enable persists (disk-first) + round-trips.
        set_spell_enabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write spell_enabled");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after enable");
        assert_eq!(view.spell_enabled, Some(true));
        // Pre-existing screen_capture default untouched.
        assert!(view.screen_capture_protection);

        // Languages set: codec NFC-sorts + dedupes (caller order/dupes
        // collapse to canonical form).
        set_spell_languages_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            SetMutation::adding_all(vec![
                "tr".to_string(),
                "en-US".to_string(),
                "tr".to_string(),
            ]),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write spell_languages");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after languages");
        assert_eq!(
            view.spell_languages,
            vec!["en-US".to_string(), "tr".to_string()]
        );
        // spell_enabled still set (independent field).
        assert_eq!(view.spell_enabled, Some(true));

        // Disable overwrites.
        set_spell_enabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write disable");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after disable");
        assert_eq!(view.spell_enabled, Some(false));
    });
}

// ---- show_note_timestamps setter (sidebar-note-timestamps) --------

#[test]
fn show_note_timestamps_round_trips_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x45).await;

        // Default (no write yet) reads back as `true` (visible).
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read default");
        assert!(view.show_note_timestamps);

        // Turn OFF persists (disk-first) + round-trips.
        set_show_note_timestamps_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write off");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after off");
        assert!(!view.show_note_timestamps);
        // Pre-existing screen_capture default untouched.
        assert!(view.screen_capture_protection);

        // Turn back ON overwrites (re-encodes byte-identical to pre-feature).
        set_show_note_timestamps_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write on");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after on");
        assert!(view.show_note_timestamps);
    });
}

// ---- editor_line_numbers setter (editor-line-numbers, MYND-314) ---

#[test]
fn editor_line_numbers_round_trips_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x46).await;

        // Default (no write yet) reads back as `None` (host default-OFF).
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read default");
        assert_eq!(view.editor_line_numbers, None);

        // Turn ON persists (disk-first) + round-trips.
        set_editor_line_numbers_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write on");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after on");
        assert_eq!(view.editor_line_numbers, Some(true));
        // Pre-existing screen_capture default untouched.
        assert!(view.screen_capture_protection);

        // Turn OFF overwrites (explicit Some(false), not back to None).
        set_editor_line_numbers_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write off");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after off");
        assert_eq!(view.editor_line_numbers, Some(false));
    });
}

// ---- editor_vim_mode setter (vim-keyboard-mode, MYND-313) ---------

#[test]
fn editor_vim_mode_round_trips_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x4d).await;

        // Default (no write yet) reads back as `None` — the host applies the
        // default-OFF policy; modal editing is opt-in.
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read default");
        assert_eq!(view.editor_vim_mode, None);

        // Turn ON persists (disk-first) + round-trips.
        set_editor_vim_mode_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write on");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after on");
        assert_eq!(view.editor_vim_mode, Some(true));
        // Pre-existing screen_capture default untouched.
        assert!(view.screen_capture_protection);

        // Turn OFF overwrites (explicit Some(false), NOT back to None) — an
        // explicit off stays distinguishable from never-set on disk.
        set_editor_vim_mode_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write off");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after off");
        assert_eq!(view.editor_vim_mode, Some(false));
    });
}

#[test]
fn editor_vim_mode_write_leaves_neighbouring_prefs_untouched() {
    // The vim toggle is a read-modify-write on a shared blob; a sibling
    // editor pref written first must survive the write intact.
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x4e).await;

        set_editor_line_numbers_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write line numbers");
        set_editor_vim_mode_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write vim mode");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after both");
        assert_eq!(view.editor_line_numbers, Some(true));
        assert_eq!(view.editor_vim_mode, Some(true));
    });
}

// ---- archive_disabled setter (archive-disable, MYND-…) ------------

#[test]
fn archive_disabled_round_trips_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x47).await;

        // Default (no write yet) reads back as `None` (host default-OFF —
        // archiving enabled).
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read default");
        assert_eq!(view.archive_disabled, None);

        // Turn ON persists (disk-first) + round-trips.
        set_archive_disabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write on");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after on");
        assert_eq!(view.archive_disabled, Some(true));
        // Pre-existing screen_capture default untouched.
        assert!(view.screen_capture_protection);

        // Turn OFF overwrites (explicit Some(false), not back to None).
        set_archive_disabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write off");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after off");
        assert_eq!(view.archive_disabled, Some(false));
    });
}

// ---- attachment_compression_enabled setter -------------------------

#[test]
fn attachment_compression_enabled_round_trips_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x53).await;

        // Default (no write yet) reads back as `true` — compression on.
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read default");
        assert!(view.attachment_compression_enabled);

        // Turn OFF persists (disk-first) + round-trips.
        set_attachment_compression_enabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write off");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after off");
        assert!(!view.attachment_compression_enabled);
        // Pre-existing screen_capture default untouched.
        assert!(view.screen_capture_protection);

        // Simulate a lock/unlock cycle: a fresh VaultRuntimeState reading
        // the same on-disk vault.prefs must still observe the persisted
        // value (the setter's disk write, not any in-memory cache, is
        // what the value survives on). Match `make_temp_vault_with_unlocked_state`'s
        // fixture key material (0x42, 0x99, 1) so the re-derived prefs_key
        // can decrypt the blob written above.
        let reunlocked_state = VaultRuntimeState::default();
        let unlocked = fixture_unlocked_with_keys(0x42, 0x99, 1);
        reunlocked_state
            .set_unlocked(test_vault_id(), unlocked)
            .await;
        let view = prefs_read_with_dir(tmp.path(), &reunlocked_state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after simulated re-unlock");
        assert!(!view.attachment_compression_enabled);

        // Turn back ON overwrites (explicit true again).
        set_attachment_compression_enabled_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write on");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after on");
        assert!(view.attachment_compression_enabled);
    });
}

// ---- batch editor setters (MYND-308 / MYND-299 / MYND-348) --------

#[test]
fn editor_focus_toggles_round_trip_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x47).await;

        // Default (no write yet) reads back as `None`.
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read default");
        assert_eq!(view.editor_focus_dim_inactive, None);
        assert_eq!(view.editor_focus_typewriter, None);

        // Enable both persists (disk-first) + round-trips.
        set_editor_focus_dim_inactive_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            true,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write dim on");
        set_editor_focus_typewriter_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            false,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write typewriter off");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after writes");
        assert_eq!(view.editor_focus_dim_inactive, Some(true));
        assert_eq!(view.editor_focus_typewriter, Some(false));
        // Pre-existing screen_capture default untouched.
        assert!(view.screen_capture_protection);
    });
}

#[test]
fn active_workspace_and_default_view_mode_round_trip_via_set_then_read() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x48).await;

        // Set both string fields (via the shared typography core, the
        // command wrappers' read-modify-write helper).
        set_typography_field_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "active_workspace",
            |p| {
                p.active_workspace = Some(String::from("ws-7"));
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write active_workspace");
        set_typography_field_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "editor_default_view_mode",
            |p| {
                p.editor_default_view_mode = Some(String::from("reading"));
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write default view mode");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after writes");
        assert_eq!(view.active_workspace.as_deref(), Some("ws-7"));
        assert_eq!(view.editor_default_view_mode.as_deref(), Some("reading"));
        assert!(view.screen_capture_protection);

        // None clears active_workspace back to the default (omitted on disk).
        set_typography_field_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "active_workspace",
            |p| {
                p.active_workspace = None;
            },
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear active_workspace");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after clear");
        assert_eq!(view.active_workspace, None);
        assert_eq!(view.editor_default_view_mode.as_deref(), Some("reading"));
    });
}

// ---- set_keymap_binding setter (hotkeys epic, MYND-304) -----------

#[test]
fn keymap_binding_round_trips_three_states() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x4B).await;

        // Default (no write yet) reads back as an empty keymap.
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read default");
        assert!(view.keymap.is_empty());

        // Override: Some(non-empty) persists; codec NFC-sorts + dedupes the
        // chord set (caller order/dupes collapse to canonical form).
        set_keymap_binding_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "app.command-palette".to_string(),
            Some(vec![
                "Mod-p".to_string(),
                "Mod-k".to_string(),
                "Mod-p".to_string(),
            ]),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write override");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after override");
        assert_eq!(
            view.keymap.get("app.command-palette"),
            Some(&vec!["Mod-k".to_string(), "Mod-p".to_string()])
        );
        // Pre-existing screen_capture default untouched.
        assert!(view.screen_capture_protection);

        // Explicit-unbind: Some(empty) persists `[]` (distinct from absent).
        set_keymap_binding_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "vault.lock".to_string(),
            Some(Vec::new()),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write unbind");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after unbind");
        assert_eq!(view.keymap.get("vault.lock"), Some(&Vec::<String>::new()));
        // The earlier override is independent + untouched.
        assert_eq!(
            view.keymap.get("app.command-palette"),
            Some(&vec!["Mod-k".to_string(), "Mod-p".to_string()])
        );

        // Remove: None drops the entry (revert to the code default).
        set_keymap_binding_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            "app.command-palette".to_string(),
            None,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write remove");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after remove");
        assert!(!view.keymap.contains_key("app.command-palette"));
        // The unbind entry survives the unrelated remove.
        assert_eq!(view.keymap.get("vault.lock"), Some(&Vec::<String>::new()));
    });
}

// ---- vault_set_label setter (MYND-205) ----------------------------

/// The label round-trips through the encrypted `vault.prefs` (disk-first),
/// AND the per-session RAM cache is refreshed so `vault_list` reflects the
/// rename immediately. Clearing (`None`) round-trips back to no-label and
/// removes the cache entry.
#[test]
fn vault_set_label_round_trips_and_updates_cache() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

        // Before any write, the cache holds no label for the active vault.
        assert_eq!(state.cached_label(test_vault_id()).await, None);

        // Set a label — persists on disk + caches in RAM.
        vault_set_label_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(String::from("Work")),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("write label");
        assert!(
            tmp.path().join("vault.prefs").exists(),
            "vault_set_label must create vault.prefs"
        );
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after label write");
        assert_eq!(view.label, Some(String::from("Work")));
        // The pre-existing screen_capture default is untouched.
        assert!(view.screen_capture_protection);
        // RAM cache reflects the label immediately (the switcher source).
        assert_eq!(
            state.cached_label(test_vault_id()).await,
            Some(String::from("Work"))
        );

        // Rename overwrites both disk + cache.
        vault_set_label_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(String::from("Personal")),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("rename label");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after rename");
        assert_eq!(view.label, Some(String::from("Personal")));
        assert_eq!(
            state.cached_label(test_vault_id()).await,
            Some(String::from("Personal"))
        );

        // Clearing (None) removes the label on disk AND evicts the cache.
        vault_set_label_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            None,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("clear label");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after clear");
        assert_eq!(view.label, None);
        assert_eq!(state.cached_label(test_vault_id()).await, None);
    });
}

// ---- myne-md/myne#411: the rename writes THROUGH to `MYL1` ---------
//
// `vault.prefs` is sealed under a `root_key`-derived KEK, so the rename
// above is invisible to the LOCKED picker until the vault is unlocked
// again. These pin the second write that closes that gap, and its two
// rules: the hide flag suppresses it, and clearing removes the file.
//
// A `TestHost` rather than `NoopHost` in this block, deliberately: the
// write-through resolves the hide flag through `app_config_dir`, and
// `NoopHost` resolves none, which is exactly what keeps the tests ABOVE
// free of a sealed file they never asked for.

#[test]
fn a_rename_writes_through_to_the_sealed_label_store() {
    use crate::vault_label::fake_keychain::FakeKeychain;
    use crate::vault_label::store::{read_label, LabelRead};

    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let host = crate::host::test_host::TestHost::new(tmp.path());
        let keychain = FakeKeychain::empty();

        vault_set_label_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(String::from("Work")),
            &crate::vault_io::StdVaultIo,
            &host,
            &keychain,
        )
        .await
        .expect("rename");

        assert_eq!(
            read_label(
                &crate::vault_io::StdVaultIo,
                tmp.path(),
                test_vault_id(),
                &keychain
            )
            .await
            .expect("read the sealed name back"),
            LabelRead::Label(String::from("Work")),
            "a rename must reach the locked picker without waiting for the \
                 next unlock"
        );
    });
}

#[test]
fn clearing_the_label_removes_the_sealed_file_rather_than_storing_an_empty_one() {
    use crate::vault_label::fake_keychain::FakeKeychain;
    use crate::vault_label::store::label_path;

    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let host = crate::host::test_host::TestHost::new(tmp.path());
        let keychain = FakeKeychain::empty();

        vault_set_label_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(String::from("Work")),
            &crate::vault_io::StdVaultIo,
            &host,
            &keychain,
        )
        .await
        .expect("rename");
        assert!(label_path(tmp.path()).exists(), "seeded");

        vault_set_label_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            None,
            &crate::vault_io::StdVaultIo,
            &host,
            &keychain,
        )
        .await
        .expect("clear");

        assert!(
            !label_path(tmp.path()).exists(),
            "the codec refuses a zero-length plaintext, so an empty name has \
                 to be a removal by construction"
        );
    });
}

#[test]
fn a_rename_writes_no_name_while_names_are_hidden() {
    use crate::vault_label::fake_keychain::FakeKeychain;
    use crate::vault_label::hide_flag::{
        hide_flag_path_from_host, write_hide_vault_names, HideVaultNamesConfig,
    };
    use crate::vault_label::store::label_path;

    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let host = crate::host::test_host::TestHost::new(tmp.path());
        let keychain = FakeKeychain::empty();

        let flag_path = hide_flag_path_from_host(&host, &crate::vault_io::StdVaultIo)
            .await
            .expect("flag path");
        write_hide_vault_names(
            &crate::vault_io::StdVaultIo,
            &flag_path,
            HideVaultNamesConfig { hidden: true },
        )
        .await
        .expect("turn the option on");

        vault_set_label_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(String::from("Work")),
            &crate::vault_io::StdVaultIo,
            &host,
            &keychain,
        )
        .await
        .expect("the rename itself must still succeed");

        // The rename landed where it always did.
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(view.label, Some(String::from("Work")));

        // And nowhere else.
        assert!(!label_path(tmp.path()).exists());
        assert!(keychain.accounts().is_empty(), "no wrap key was minted");
    });
}

#[test]
fn a_rename_on_a_keychainless_device_still_renames() {
    // The device-local name cache is a convenience for the picker. Failing
    // a rename because a Linux box has no secret-service daemon would trade
    // a real operation for a cosmetic one.
    use crate::vault_label::store::label_path;

    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let host = crate::host::test_host::TestHost::new(tmp.path());

        vault_set_label_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(String::from("Work")),
            &crate::vault_io::StdVaultIo,
            &host,
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("rename");

        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read");
        assert_eq!(view.label, Some(String::from("Work")));
        assert!(
            !label_path(tmp.path()).exists(),
            "and in particular no plaintext fallback was written"
        );
    });
}

// ---- vault_set_icon setter (vault-icons) ---------------------------

/// The icon round-trips through the encrypted `vault.prefs` (disk-first),
/// AND the per-session RAM icon cache is refreshed so `vault_list` reflects
/// the change immediately. Clearing (`None`) round-trips back to no-icon and
/// evicts the cache entry — the switcher falls back to the neutral wordmark.
#[test]
fn vault_set_icon_round_trips_and_updates_cache() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

        // Before any write, the cache holds no icon for the active vault.
        assert_eq!(state.cached_icon(test_vault_id()).await, None);

        // Set an icon — persists on disk + caches in RAM.
        vault_set_icon_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(String::from("book")),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("write icon");
        assert!(
            tmp.path().join("vault.prefs").exists(),
            "vault_set_icon must create vault.prefs"
        );
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after icon write");
        assert_eq!(view.icon, Some(String::from("book")));
        // The pre-existing screen_capture default is untouched.
        assert!(view.screen_capture_protection);
        // RAM cache reflects the icon immediately (the switcher source).
        assert_eq!(
            state.cached_icon(test_vault_id()).await,
            Some(String::from("book"))
        );

        // Changing the icon overwrites both disk + cache.
        vault_set_icon_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(String::from("code")),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("change icon");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after change");
        assert_eq!(view.icon, Some(String::from("code")));
        assert_eq!(
            state.cached_icon(test_vault_id()).await,
            Some(String::from("code"))
        );

        // Clearing (None) removes the icon on disk AND evicts the cache.
        vault_set_icon_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            None,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("clear icon");
        let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
            .await
            .expect("read after clear");
        assert_eq!(view.icon, None);
        assert_eq!(state.cached_icon(test_vault_id()).await, None);
    });
}

/// DENY-list: the user-supplied label value must NEVER appear in any
/// tracing payload (it is AS3-sensitive input). The emitted
/// `prefs_written` event carries only the field name + `cleared` flag.
#[test]
#[tracing_test::traced_test]
fn vault_set_label_does_not_log_the_label_value() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
        let secret_label = "TopSecretProjectName";
        vault_set_label_with_dir(
            tmp.path(),
            &state,
            &noop_hooks(),
            Some(String::from(secret_label)),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
            &crate::vault_label::key::UnavailableKeychain,
        )
        .await
        .expect("write label");
        assert!(
            logs_contain("field=\"label\""),
            "expected the prefs_written event with field=label"
        );
        assert!(
            !logs_contain(secret_label),
            "the label value must NEVER cross the tracing boundary (DENY-list)"
        );
    });
}

// ---- vault.meta IO failure surfaces ------------------------------

#[test]
fn prefs_read_surfaces_io_error_when_vault_meta_missing() {
    rt().block_on(async {
        let tmp = ScopedTempDir::new("prefs-no-meta").expect("scoped tempdir");
        let state = VaultRuntimeState::default();
        // Don't seed vault.meta — just set slot to unlocked.
        state
            .set_unlocked(test_vault_id(), fixture_unlocked_with_keys(0x42, 0x99, 1))
            .await;
        let result = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo).await;
        // vault.meta absent → Io error (NOT collapsed to defaults
        // like vault.prefs absent — vault.meta is structural).
        assert!(matches!(result, Err(PrefsReadError::Io { .. })));
    });
}

// ---- closed-enum helper -------------------------------------------

#[test]
fn prefs_blob_error_kind_maps_aead_fail_to_static_label() {
    assert_eq!(
        prefs_blob_error_kind(&PrefsBlobError::CannotDecrypt),
        "aead_fail"
    );
}

#[test]
fn prefs_blob_error_kind_maps_magic_mismatch_to_static_label() {
    assert_eq!(
        prefs_blob_error_kind(&PrefsBlobError::MagicMismatch),
        "magic_mismatch"
    );
}

// ---- external MCP connection grants (external-mcp-connection task 3) ----

/// The end-to-end acceptance for the grant field: approve two connections
/// through the real write path, read them back through the real read path,
/// resolve an unapproved name to nothing, then revoke ONE and prove the other
/// survives.
///
/// The write path is asserted rather than assumed: `update_prefs_with_dir` is
/// the only way in, which is what keeps the nonce bump and the
/// degrade-on-read refusal on the same path every other setter takes.
#[test]
fn mcp_connection_grants_round_trip_and_revoke_leaves_the_others() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x37).await;
        let hooks = noop_hooks();
        let io = crate::vault_io::StdVaultIo;
        let host = crate::host::test_host::TestHost::new(tmp.path());
        host.set_now(1_765_432_100);

        let approved = set_mcp_connection_grant_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            vec![String::from("Work/"), String::from("Projects/")],
            Vec::new(),
            &io,
            &host,
        )
        .await
        .expect("approve the first connection");
        assert!(approved, "the grant fits, so it must be accepted");

        let approved = set_mcp_connection_grant_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("lm-studio"),
            vec![String::from("Archive/")],
            Vec::new(),
            &io,
            &host,
        )
        .await
        .expect("approve the second connection");
        assert!(approved);

        // Read back through the production read path, not the raw codec.
        let stored = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read the stored prefs");
        assert_eq!(stored.mcp_connections.len(), 2);
        let claude = stored
            .mcp_connections
            .get("claude-desktop")
            .expect("the first grant survives");
        assert_eq!(
            claude.model,
            protocol::McpScopeModel::Exclude,
            "the approval screen selects what to leave out, so this is the \
                 model every approval writes"
        );
        assert_eq!(
            claude.excluded_folders,
            vec![String::from("projects/"), String::from("work/")],
            "the exclusion set is canonical: lower-cased, trailing-slashed, \
                 sorted, because it is a set"
        );
        assert!(
            claude.folders.is_empty(),
            "the retired allow list stays empty: two arrays describing two \
                 rules is a grant the decoder refuses"
        );
        assert_eq!(
            claude.approved_at, 1_765_432_100,
            "the approval stamp is the HOST's clock, not the caller's"
        );
        assert_eq!(claude.last_used_at, None, "never used yet");
        // A third name nobody approved resolves to no grant at all.
        assert!(!stored.mcp_connections.contains_key("cursor"));

        // Revoke one; the other must be untouched.
        let removed = revoke_mcp_connection_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            &io,
            &host,
        )
        .await
        .expect("revoke the first connection");
        assert!(removed);
        let stored = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read after revoke");
        assert!(!stored.mcp_connections.contains_key("claude-desktop"));
        assert!(
            stored.mcp_connections.contains_key("lm-studio"),
            "revoking one connection must not touch the others"
        );

        // Revoking an absent name is a successful no-op, not an error.
        let removed = revoke_mcp_connection_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            &io,
            &host,
        )
        .await
        .expect("revoking an absent name is a no-op");
        assert!(!removed);
    });
}

/// The connection name is a MAP KEY, and the encoder NFC-normalizes keys. A
/// caller passing a decomposed name would therefore store one key and fail to
/// find it on revoke, which is a silent failed revocation; the commands
/// normalize on the way in so both directions address the same entry.
#[test]
fn a_decomposed_connection_name_is_stored_and_revoked_as_one_entry() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x38).await;
        let hooks = noop_hooks();
        let io = crate::vault_io::StdVaultIo;
        let host = crate::host::test_host::TestHost::new(tmp.path());

        // "Cafe" + U+0301 (combining acute) == "Café" (U+00E9) after NFC.
        let decomposed = String::from("Cafe\u{0301}-client");
        assert!(set_mcp_connection_grant_with_dir(
            tmp.path(),
            &state,
            &hooks,
            decomposed.clone(),
            vec![String::from("Work/")],
            Vec::new(),
            &io,
            &host,
        )
        .await
        .expect("approve"));

        let stored = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read");
        assert_eq!(stored.mcp_connections.len(), 1);
        assert!(
            stored.mcp_connections.contains_key("Caf\u{00e9}-client"),
            "the stored key must be the NFC form: {:?}",
            stored.mcp_connections.keys().collect::<Vec<_>>()
        );

        // Revoking with the SAME decomposed spelling finds it.
        assert!(
            revoke_mcp_connection_with_dir(tmp.path(), &state, &hooks, decomposed, &io, &host,)
                .await
                .expect("revoke")
        );
        let stored = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read after revoke");
        assert!(stored.mcp_connections.is_empty());
    });
}

/// An EMPTY name is refused rather than stored: a grant nothing can address
/// is a grant nothing can revoke by name.
#[test]
fn an_empty_connection_name_is_refused_on_both_paths() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x39).await;
        let hooks = noop_hooks();
        let io = crate::vault_io::StdVaultIo;
        let host = crate::host::test_host::TestHost::new(tmp.path());

        assert!(matches!(
            set_mcp_connection_grant_with_dir(
                tmp.path(),
                &state,
                &hooks,
                String::new(),
                Vec::new(),
                Vec::new(),
                &io,
                &host,
            )
            .await,
            Err(PrefsWriteError::InvalidValue)
        ));
        assert!(matches!(
            revoke_mcp_connection_with_dir(tmp.path(), &state, &hooks, String::new(), &io, &host,)
                .await,
            Err(PrefsWriteError::InvalidValue)
        ));
    });
}

/// The write scope is a SUBSET of the read scope, and this is the write half of
/// that rule (the resolver's half is `mcp_write_scope_is_bounded_by_the_read_scope`).
///
/// Refused rather than dropped: a dropped entry would leave the approval screen
/// showing a write grant the stored bytes do not carry, which is the shape
/// `core/AGENTS.md` records as a sink that resolves on a refused write. And the
/// bug it prevents is a note a client can write but never read back.
#[test]
fn a_write_folder_outside_the_read_scope_is_refused_at_approval() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x3b).await;
        let hooks = noop_hooks();
        let io = crate::vault_io::StdVaultIo;
        let host = crate::host::test_host::TestHost::new(tmp.path());
        host.set_now(1_765_432_100);

        // Naming a folder for writing that the same approval leaves out is the
        // contradiction: refused, and nothing is stored.
        assert!(matches!(
            set_mcp_connection_grant_with_dir(
                tmp.path(),
                &state,
                &hooks,
                String::from("claude-desktop"),
                vec![String::from("Projects/")],
                vec![String::from("Projects/")],
                &io,
                &host,
            )
            .await,
            Err(PrefsWriteError::InvalidValue)
        ));
        // A parent exclusion takes its subtree out of the READ scope, so a write
        // grant on a folder underneath it is refused too. Equality alone would
        // let this one through and serve a write the read beside it refuses.
        assert!(matches!(
            set_mcp_connection_grant_with_dir(
                tmp.path(),
                &state,
                &hooks,
                String::from("claude-desktop"),
                vec![String::from("Projects/")],
                vec![String::from("Projects/2026/")],
                &io,
                &host,
            )
            .await,
            Err(PrefsWriteError::InvalidValue)
        ));
        assert!(
            prefs_read_with_dir(tmp.path(), &state, &io)
                .await
                .expect("read")
                .mcp_connections
                .is_empty(),
            "a refused approval must leave no grant behind"
        );

        // The subset is accepted when it IS a subset, and both halves survive a
        // read through the production path.
        assert!(set_mcp_connection_grant_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            vec![String::from("Archive/")],
            vec![String::from("Projects/")],
            &io,
            &host,
        )
        .await
        .expect("approve"));
        let stored = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read after approve");
        let grant = stored
            .mcp_connections
            .get("claude-desktop")
            .expect("the grant is stored");
        assert_eq!(grant.excluded_folders, vec![String::from("archive/")]);
        assert_eq!(grant.write_folders, vec![String::from("projects/")]);
    });
}

// ---- the out-of-scope write queue (task 13) ----------------------------

/// End to end: a write into a readable-but-not-writable folder is QUEUED (not
/// applied, not dropped), the section's view offers it, and accepting it
/// extends the write grant by exactly that folder and nothing else.
///
/// This is task 13's acceptance in one test: the route, the persistence, the
/// row the person reads, and the widening. The verbs that produce such a write
/// are tasks 14 and 15; the mechanism is finished here so that they have
/// something to call rather than something to invent.
/// The write scope may not name a folder the connection may not READ, and
/// "may read" is the effective reach: the grant's own exclusions union the
/// folders the user already left out of Myne's own AI and of the terminal
/// client (`protocol.md` §9.5.2 makes that union normative). This compared
/// against the grant's list alone, so a folder excluded from AI could still be
/// stored as writable; the call-time check refused it, which is why nothing was
/// ever exposed, but the stored grant then carried what the format forbids.
#[test]
fn mcp_a_write_folder_excluded_from_ai_is_refused_at_the_writer() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x3e).await;
        let hooks = noop_hooks();
        let io = crate::vault_io::StdVaultIo;
        let host = crate::host::test_host::TestHost::new(tmp.path());
        host.set_now(1_765_432_200);

        let add_private = || SetMutation {
            add: vec![String::from("Private")],
            remove: Vec::new(),
            add_unless_removed: Vec::new(),
            remove_prefix: Vec::new(),
            rename_prefix: Vec::new(),
        };
        set_ai_excluded_folders_with_dir(tmp.path(), &state, &hooks, add_private(), &io, &host)
            .await
            .expect("exclude a folder from AI");

        // A grant that names NO exclusion of its own: the ONLY thing keeping
        // `private/` out of reach is the AI list, which is exactly the half this
        // check used to miss.
        let refused = set_mcp_connection_grant_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            Vec::new(),
            vec![String::from("Private")],
            &io,
            &host,
        )
        .await;

        assert!(
            matches!(refused, Err(PrefsWriteError::InvalidValue)),
            "a write folder the connection cannot read must be refused, not stored: {refused:?}"
        );
        let stored = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read");
        assert!(
            stored.mcp_connections.is_empty(),
            "the refused approval must write nothing at all"
        );

        // And the same folder is legal once the user stops excluding it from AI,
        // which is what makes this a check on the union rather than on a
        // permanently forbidden folder list.
        let remove_private = || SetMutation {
            add: Vec::new(),
            remove: vec![String::from("Private")],
            add_unless_removed: Vec::new(),
            remove_prefix: Vec::new(),
            rename_prefix: Vec::new(),
        };
        set_ai_excluded_folders_with_dir(tmp.path(), &state, &hooks, remove_private(), &io, &host)
            .await
            .expect("un-exclude");
        set_mcp_connection_grant_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            Vec::new(),
            vec![String::from("Private")],
            &io,
            &host,
        )
        .await
        .expect("a readable folder is writable");
    });
}

/// The D3 finding of the 2026-10-30 review: a deny list fails OPEN on a
/// rename, because the exclusion is a path and the notes moved to a new one.
/// Every path an MCP grant holds is re-rooted by the rename, in one write,
/// without becoming an approval (stamp and model untouched).
#[test]
fn mcp_grant_folder_paths_are_rerooted_when_a_folder_is_renamed() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x3d).await;
        let hooks = noop_hooks();
        let io = crate::vault_io::StdVaultIo;
        let host = crate::host::test_host::TestHost::new(tmp.path());
        host.set_now(1_765_432_100);

        // Read everything except `private/`; write inside `private/2026/` would
        // be refused, so the write list stays on a readable folder.
        set_mcp_connection_grant_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            vec![String::from("Private"), String::from("Privatestuff")],
            Vec::new(),
            &io,
            &host,
        )
        .await
        .expect("approve");

        let before = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read")
            .mcp_connections;
        let grant_before = before.get("claude-desktop").expect("grant").clone();
        assert_eq!(
            grant_before.excluded_folders,
            vec![String::from("private/"), String::from("privatestuff/")],
            "stored canonical, sorted"
        );

        let moved = rewrite_mcp_folder_paths_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("Private"),
            String::from("Journal"),
            &io,
            &host,
        )
        .await
        .expect("reroot");
        assert_eq!(moved, 1, "only the entry inside the renamed subtree moves");

        let after = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read")
            .mcp_connections;
        let grant_after = after.get("claude-desktop").expect("grant").clone();
        assert_eq!(
            grant_after.excluded_folders,
            vec![String::from("journal/"), String::from("privatestuff/")],
            "renamed folder stays excluded, and its near-name is untouched"
        );
        assert_eq!(
            grant_after.approved_at, grant_before.approved_at,
            "a rename is not an approval"
        );
        assert_eq!(grant_after.model, grant_before.model);

        // A rename that touches nothing writes nothing.
        let moved_again = rewrite_mcp_folder_paths_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("Unrelated"),
            String::from("Elsewhere"),
            &io,
            &host,
        )
        .await
        .expect("reroot");
        assert_eq!(moved_again, 0);
    });
}

#[test]
fn mcp_write_queue_queues_then_accepts_and_extends_by_one_folder() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x3c).await;
        let hooks = noop_hooks();
        let io = crate::vault_io::StdVaultIo;
        let host = crate::host::test_host::TestHost::new(tmp.path());
        host.set_now(1_765_432_100);

        // The grant: reads everything, writes nothing.
        set_mcp_connection_grant_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            Vec::new(),
            Vec::new(),
            &io,
            &host,
        )
        .await
        .expect("approve");

        // Make the folder EXIST without inventing an index: `existing_folders`
        // counts the user's own deliberate folders, so a folder the person
        // declared is a folder the scope can resolve against. A folder the
        // vault does not have is not readable in the first place.
        set_deliberate_folders_with_dir(
            tmp.path(),
            &state,
            &hooks,
            SetMutation {
                add: vec![String::from("Inbox")],
                remove: Vec::new(),
                add_unless_removed: Vec::new(),
                remove_prefix: Vec::new(),
                rename_prefix: Vec::new(),
            },
            &io,
            &host,
        )
        .await
        .expect("declare the folder");

        let grew = enqueue_mcp_write_request_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            String::from("Inbox/"),
            String::from("note_create"),
            String::from("Shopping list"),
            &io,
            &host,
        )
        .await
        .expect("queue the request");
        assert!(grew, "a first request grows the queue");

        // The stored grant is UNCHANGED: a proposal is not a permission.
        let stored = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read");
        let grant = stored
            .mcp_connections
            .get("claude-desktop")
            .expect("the grant is stored");
        assert!(
            grant.write_folders.is_empty(),
            "queueing a request must not widen the grant by itself"
        );
        assert_eq!(stored.mcp_write_requests.len(), 1);

        // The view the section renders offers it, with its origin named.
        let view = crate::plugins::mcp::view::external_access_view(
            &stored,
            &std::collections::BTreeMap::new(),
        );
        assert_eq!(view.write_requests.len(), 1);
        let row = &view.write_requests[0];
        assert_eq!(row.connection, "claude-desktop");
        assert_eq!(row.folder, "inbox/");
        assert_eq!(row.verb, "note_create");
        assert_eq!(row.summary, "Shopping list");

        // Accept: the grant gains exactly that folder, the row goes.
        assert!(accept_mcp_write_request_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            String::from("Inbox/"),
            &io,
            &host,
        )
        .await
        .expect("accept"));
        let after = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read after accept");
        assert_eq!(
            after
                .mcp_connections
                .get("claude-desktop")
                .expect("grant")
                .write_folders,
            vec![String::from("inbox/")],
            "accepting widens the write grant by exactly the folder requested"
        );
        assert!(after.mcp_write_requests.is_empty());
    });
}

/// Dismissing removes the row and changes no grant; revoking the connection
/// takes its rows with it, because a row whose grant is gone can never be
/// accepted and a card that kept offering it would be asking about a
/// connection the person just closed.
#[test]
fn mcp_write_queue_dismiss_and_revoke_leave_no_orphans() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x3d).await;
        let hooks = noop_hooks();
        let io = crate::vault_io::StdVaultIo;
        let host = crate::host::test_host::TestHost::new(tmp.path());
        host.set_now(1_765_432_100);
        set_mcp_connection_grant_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            Vec::new(),
            Vec::new(),
            &io,
            &host,
        )
        .await
        .expect("approve");

        enqueue_mcp_write_request_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            String::from("Inbox/"),
            String::from("note_create"),
            String::new(),
            &io,
            &host,
        )
        .await
        .expect("queue");
        assert!(dismiss_mcp_write_request_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            String::from("Inbox/"),
            &io,
            &host,
        )
        .await
        .expect("dismiss"));
        let after_dismiss = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read");
        assert!(after_dismiss.mcp_write_requests.is_empty());
        assert!(
            after_dismiss
                .mcp_connections
                .get("claude-desktop")
                .expect("grant")
                .write_folders
                .is_empty(),
            "dismissing changes no grant"
        );
        // A second dismiss finds nothing, which is a stale click rather than
        // an error.
        assert!(!dismiss_mcp_write_request_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            String::from("Inbox/"),
            &io,
            &host,
        )
        .await
        .expect("dismiss again"));

        enqueue_mcp_write_request_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            String::from("Inbox/"),
            String::from("note_create"),
            String::new(),
            &io,
            &host,
        )
        .await
        .expect("queue again");
        revoke_mcp_connection_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            &io,
            &host,
        )
        .await
        .expect("revoke");
        let after_revoke = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read after revoke");
        assert!(
            after_revoke.mcp_write_requests.is_empty(),
            "revoking takes the connection's queued requests with it"
        );
    });
}

// ---- the last-use stamp (the Settings row's "last used") ---------------

/// The throttle, as arithmetic rather than as a clock: a fresh stamp is not
/// rewritten, a stale one is, and a stamp from the future is.
#[test]
fn the_last_use_stamp_is_throttled_to_the_interval() {
    assert!(
        last_use_needs_stamp(None, 1_000),
        "never used always stamps"
    );
    assert!(
        !last_use_needs_stamp(Some(1_000), 1_299),
        "a call inside the window must not cost a vault write"
    );
    assert!(
        last_use_needs_stamp(Some(1_000), 1_300),
        "the boundary is inclusive, so the row cannot sit a window behind"
    );
    assert!(
        last_use_needs_stamp(Some(1_000), 999),
        "a clock that moved backwards must not leave a row claiming a future use"
    );
}

/// End to end: the first call writes, the second inside the window does not,
/// and the value the Settings row renders is the host clock at the write.
#[test]
fn a_used_connection_is_stamped_once_per_window() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x3a).await;
        let hooks = noop_hooks();
        let io = crate::vault_io::StdVaultIo;
        let host = crate::host::test_host::TestHost::new(tmp.path());
        host.set_now(1_765_432_100);

        set_mcp_connection_grant_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            vec![String::from("Work/")],
            Vec::new(),
            &io,
            &host,
        )
        .await
        .expect("approve");

        host.set_now(1_765_432_160);
        let stamped = touch_mcp_connection_last_used_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            &io,
            &host,
        )
        .await
        .expect("stamp the first call");
        assert!(stamped, "a never-used connection's first call writes");
        let stored = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read");
        assert_eq!(
            stored.mcp_connections["claude-desktop"].last_used_at,
            Some(1_765_432_160),
            "the stamp is the host's clock, in the grant's own seconds unit"
        );

        // Inside the window: no write, and the stamp does not move.
        host.set_now(1_765_432_200);
        let stamped = touch_mcp_connection_last_used_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            &io,
            &host,
        )
        .await
        .expect("second call");
        assert!(!stamped, "a call inside the window costs no vault write");
        let stored = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read after the throttled call");
        assert_eq!(
            stored.mcp_connections["claude-desktop"].last_used_at,
            Some(1_765_432_160)
        );

        // Past the window: it writes again.
        host.set_now(1_765_432_161 + MCP_LAST_USED_WRITE_INTERVAL_SECS);
        let stamped = touch_mcp_connection_last_used_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("claude-desktop"),
            &io,
            &host,
        )
        .await
        .expect("third call");
        assert!(stamped);
        let stored = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read after the window");
        assert_eq!(
            stored.mcp_connections["claude-desktop"].last_used_at,
            Some(1_765_432_161 + MCP_LAST_USED_WRITE_INTERVAL_SECS)
        );
    });
}

/// A name with no grant is stamped nowhere: revocation and this stamp race by
/// design, and the conservative direction is to write nothing rather than to
/// recreate an approval.
#[test]
fn an_unapproved_connection_stamps_nothing() {
    rt().block_on(async {
        let (tmp, state) = make_temp_vault_with_unlocked_state(0x3b).await;
        let hooks = noop_hooks();
        let io = crate::vault_io::StdVaultIo;
        let host = crate::host::test_host::TestHost::new(tmp.path());
        host.set_now(1_765_432_100);

        let stamped = touch_mcp_connection_last_used_with_dir(
            tmp.path(),
            &state,
            &hooks,
            String::from("never-approved"),
            &io,
            &host,
        )
        .await
        .expect("nothing to stamp is not an error");
        assert!(!stamped);
        let stored = prefs_read_with_dir(tmp.path(), &state, &io)
            .await
            .expect("read");
        assert!(
            stored.mcp_connections.is_empty(),
            "a stamp must never mint a grant"
        );
    });
}
