//! Post-decrypt field/set merge of two `vault.prefs` views (MYND-478;
//! `sync-protocol.md` §10.2).
//!
//! Runs entirely in RAM on decrypted views (SYNC-3: plaintext never rests
//! outside the AEAD'd blob). The shared/device-local split lives HERE, not in
//! the on-disk format: [`merge_prefs`] takes remote values only for the fields
//! [`prefs_classification`](super::prefs_classification) marks shared, and the
//! local value always survives for a device-local field.
//!
//! LWW mechanics (§10.2): every shared LWW field races on its own
//! `field_clocks` entry (absent = 0 — every pre-MYND-478 blob); equal clocks
//! tie-break **byte-lexicographically toward the greater canonical value**
//! (the §11.4 catalog-`filename` precedent), so both replicas converge
//! independently. The generic `conflict.rs::merge_scalar_lww` tie-breaks
//! toward its first argument and is therefore NOT used here — its semantics
//! serve other call sites.
//!
//! The result is deterministic and **commutative on the shared subset**:
//! `merge(a, b)` and `merge(b, a)` agree on every shared field and on the
//! merged `field_clocks`; they differ exactly on the device-local fields,
//! where each side keeps its own.

use std::collections::BTreeMap;

use protocol::PrefsView;
use serde::Serialize;

use super::conflict::{merge_set_union, merge_set_union_folded};
use super::prefs_classification::{PrefClass, SharedDiscipline, CLASSIFICATION};

/// Read a field's LWW clock (absent = 0, §10.2).
fn clock_of(view: &PrefsView, field: &str) -> u64 {
    view.field_clocks.get(field).copied().unwrap_or(0)
}

/// Winner of one shared LWW race (scalar, sequence-on-whole, or whole-value):
/// newer clock wins; equal clocks fall back to the byte-lexicographically
/// greater canonical (serde-JSON) encoding of the value, which is
/// deterministic and side-symmetric. Records the winning clock into `clocks`
/// (only when non-zero, so never-stamped fields keep the map empty and a
/// legacy blob re-encodes byte-identically).
fn lww_field<T: Serialize + Clone + PartialEq>(
    field: &str,
    local: &T,
    local_clock: u64,
    remote: &T,
    remote_clock: u64,
    clocks: &mut BTreeMap<String, u64>,
) -> T {
    lww_field_keyed(
        field,
        local,
        local_clock,
        remote,
        remote_clock,
        clocks,
        tiebreak_key,
    )
}

/// [`lww_field`] with a caller-supplied tiebreak-key function, for fields
/// whose serde encoding is NOT their §9.5.2 canonical encoding (`saved_views`:
/// serde emits struct-declaration key order, the canonical codec emits
/// lexicographic). §10.2 makes the tiebreak bytes normative — "the values'
/// canonical encodings" — so a divergence here would let an independent
/// implementation pick the opposite equal-clock winner and never converge.
#[allow(clippy::too_many_arguments)]
fn lww_field_keyed<T: Clone + PartialEq>(
    field: &str,
    local: &T,
    local_clock: u64,
    remote: &T,
    remote_clock: u64,
    clocks: &mut BTreeMap<String, u64>,
    key: impl Fn(&T) -> Vec<u8>,
) -> T {
    let remote_wins = match remote_clock.cmp(&local_clock) {
        core::cmp::Ordering::Greater => true,
        core::cmp::Ordering::Less => false,
        // Equal values need no tiebreak (either side wins identically) — skip
        // the serialization for the common neither-device-touched-it case.
        core::cmp::Ordering::Equal => remote != local && key(remote) > key(local),
    };
    let (winner, winning_clock) = if remote_wins {
        (remote, remote_clock)
    } else {
        (local, local_clock)
    };
    if winning_clock > 0 {
        clocks.insert(field.to_string(), winning_clock);
    }
    winner.clone()
}

/// The equal-clock tiebreak key of a value: its serde-JSON encoding, except
/// that an unset value (`null`) sorts BELOW every present value (empty key).
/// Without the exception, JSON's `null` (`n` = 0x6E) would byte-compare above
/// every string (`"` = 0x22) — and two never-clocked legacy devices merging a
/// set label against an unset one would erase the label. §10.2: an absent/
/// null value sorts lowest.
fn tiebreak_key<T: Serialize>(value: &T) -> Vec<u8> {
    let bytes = serde_json::to_vec(value).expect("prefs field serializes");
    if bytes == b"null" {
        Vec::new()
    } else {
        bytes
    }
}

/// §10.2 per-key map merge: union of keys; a key present on both sides resolves
/// LWW on its own `<field>/<key>` clock (equal clocks → byte-lexicographically
/// greater canonical value). Winning per-key clocks are recorded under their
/// namespaced names. `local_map`/`remote_map` are passed explicitly (rather than
/// re-read off the view) so the one helper serves every per-key field;
/// `local`/`remote` are still needed to read the per-key clocks.
///
/// Generic over the value type so the SAME merge serves the string→string
/// decoration maps (`device_names`, `item_colors`, `folder_icons`) and the
/// string→sequence container map (`item_order`, MYND-596): the per-key value is
/// LWW-on-whole either way — a whole color string, or a whole per-container
/// child sequence. `V: Serialize` supplies the equal-clock tiebreak encoding
/// via [`lww_field`].
fn merge_per_key_map<V: Serialize + Clone + PartialEq>(
    field: &str,
    local: &PrefsView,
    remote: &PrefsView,
    local_map: &BTreeMap<String, V>,
    remote_map: &BTreeMap<String, V>,
    clocks: &mut BTreeMap<String, u64>,
) -> BTreeMap<String, V> {
    let mut out = BTreeMap::new();
    let keys: std::collections::BTreeSet<&String> =
        local_map.keys().chain(remote_map.keys()).collect();
    for key in keys {
        let clock_key = format!("{field}/{key}");
        match (local_map.get(key), remote_map.get(key)) {
            (Some(l), Some(r)) => {
                let merged = lww_field(
                    &clock_key,
                    l,
                    clock_of(local, &clock_key),
                    r,
                    clock_of(remote, &clock_key),
                    clocks,
                );
                out.insert(key.clone(), merged);
            }
            // Single-sided key: carried over verbatim with its clock (if any).
            (Some(v), None) | (None, Some(v)) => {
                let side = if local_map.contains_key(key) {
                    local
                } else {
                    remote
                };
                let c = clock_of(side, &clock_key);
                if c > 0 {
                    clocks.insert(clock_key, c);
                }
                out.insert(key.clone(), v.clone());
            }
            (None, None) => unreachable!("key came from one of the two maps"),
        }
    }
    out
}

/// SHA-256 (lowercase hex) of the **shared subset** of a prefs view — every
/// shared field's serde-JSON value (in the classification table's stable
/// alphabetical order) plus the full `field_clocks` map. This is the push
/// gate's discriminator (`sync-protocol.md` §10.2.1): a purely device-local
/// edit re-encrypts the blob (new nonce) but leaves this hash unchanged, so
/// the sync phase generates no traffic for it.
pub fn shared_subset_hash(view: &PrefsView) -> String {
    use sha2::{Digest, Sha256};
    let v = serde_json::to_value(view).expect("prefs view serializes");
    let mut subset = serde_json::Map::new();
    for (name, class) in CLASSIFICATION {
        if matches!(class, PrefClass::Shared(_)) {
            subset.insert(
                (*name).to_string(),
                v.get(*name).cloned().unwrap_or(serde_json::Value::Null),
            );
        }
    }
    subset.insert(
        "field_clocks".to_string(),
        v.get("field_clocks")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    );
    let bytes =
        serde_json::to_vec(&serde_json::Value::Object(subset)).expect("shared subset serializes");
    super::to_hex(&Sha256::digest(&bytes))
}

/// Stamp `now_ms` into `after.field_clocks` for every **shared** LWW field
/// whose value differs from `before` (MYND-478; `sync-protocol.md` §10.2
/// "stamped by the setter that last changed the field"). Driven by the
/// normative classification table so every current and future setter routed
/// through the central prefs write path stamps correctly with zero per-setter
/// code: set-union fields stay clockless, device-local fields are never
/// stamped, and `device_names` stamps per changed/added key under its
/// namespaced `device_names/<key>` name. Field values are compared via their
/// serde-JSON encodings (deterministic; field names match §9.5.2 keys).
pub fn stamp_changed_shared_fields(before: &PrefsView, after: &mut PrefsView, now_ms: u64) {
    let b = serde_json::to_value(before).expect("prefs view serializes");
    let a = serde_json::to_value(&*after).expect("prefs view serializes");
    let empty = serde_json::Map::new();
    for (name, class) in CLASSIFICATION {
        match class {
            PrefClass::Shared(SharedDiscipline::PerKeyMapMerge) => {
                let bm = b.get(*name).and_then(|v| v.as_object()).unwrap_or(&empty);
                let am = a.get(*name).and_then(|v| v.as_object()).unwrap_or(&empty);
                for (key, value) in am {
                    if bm.get(key) != Some(value) {
                        after.field_clocks.insert(format!("{name}/{key}"), now_ms);
                    }
                }
            }
            PrefClass::Shared(SharedDiscipline::SetUnion) => {}
            PrefClass::Shared(_) if a.get(*name) != b.get(*name) => {
                after.field_clocks.insert((*name).to_string(), now_ms);
            }
            _ => {}
        }
    }
}

/// Merge a remote `vault.prefs` view into the local one per the normative
/// §10.2 classification. See the module docs for semantics.
pub fn merge_prefs(local: &PrefsView, remote: &PrefsView) -> PrefsView {
    let mut clocks: BTreeMap<String, u64> = BTreeMap::new();

    // A tiny local macro keeps every shared-LWW line down to (name, accessor)
    // so the field name string can never drift from the accessed field.
    macro_rules! lww {
        ($name:literal, $field:ident) => {
            lww_field(
                $name,
                &local.$field,
                clock_of(local, $name),
                &remote.$field,
                clock_of(remote, $name),
                &mut clocks,
            )
        };
    }
    // Sibling macro for per-key map fields — one `$field` drives both the clock
    // namespace and the accessed map, so a name/map mismatch can't be typed
    // (the `lww!` footgun-guard, extended to `device_names` + the MYND-562
    // decoration maps).
    macro_rules! per_key {
        ($name:literal, $field:ident) => {
            merge_per_key_map(
                $name,
                local,
                remote,
                &local.$field,
                &remote.$field,
                &mut clocks,
            )
        };
    }

    // Folder decorations are per-key map merges too (MYND-562): concurrent edits
    // to DIFFERENT folder keys both survive (whole-map LWW dropped one). Keys are
    // the folded folder identity (`folderKey`) + note UUIDs; note colors gain the
    // same per-key protection for free.
    let device_names = per_key!("device_names", device_names);
    let folder_icons = per_key!("folder_icons", folder_icons);
    let item_colors = per_key!("item_colors", item_colors);
    // item_order (MYND-596): each container path is a key; its child sequence
    // races on `item_order/<container>`, so a reorder in one folder never
    // clobbers another folder's order (whole-sequence LWW dropped one — the
    // exact loss MYND-562 fixed for the decoration maps above).
    let item_order = per_key!("item_order", item_order);

    // The struct literal lists EVERY PrefsView field with no `..` — the same
    // compile-time drift lock as the classification conformance test: a new
    // prefs field fails compile here until it gets a merge line matching its
    // §10.2 classification row.
    PrefsView {
        // ---- shared: scalar-LWW -----------------------------------------
        archive_disabled: lww!("archive_disabled", archive_disabled),
        // ingest-image-compression: a content-fidelity switch with a
        // vault-wide irreversible effect, unlike the device-local compute-
        // budget siblings below (`attachment_ocr_enabled` et al.) — see
        // prefs_classification.rs's comment on this row.
        attachment_compression_enabled: lww!(
            "attachment_compression_enabled",
            attachment_compression_enabled
        ),
        // MYND-613 — Shared/ScalarLww, unlike its lexicographic neighbour
        // `show_note_timestamps`, which is DeviceLocal.
        // Device-local (MYND-618): whether a machine shows reminders, and how
        // far ahead it registers them, are properties of THAT machine — so the
        // local value wins outright rather than merging.
        reminders_enabled: local.reminders_enabled,
        reminder_horizon_days: local.reminder_horizon_days,
        // Device-local (myne#279): the right display zone is a property of where
        // THIS device is, and an IANA zone is a coarse geolocation datum that
        // `dialect/src/taskFields.ts` deliberately keeps out of note bytes.
        timezone: local.timezone.clone(),
        show_task_marker: lww!("show_task_marker", show_task_marker),
        // MYND-592: shared for the same reason as `show_task_marker` — wanting
        // speech-to-text is taste, not device capability.
        transcription_enabled: lww!("transcription_enabled", transcription_enabled),
        // MYND-651: shared for the same reason again — a bundled task-model, so
        // wanting automatic tag suggestions is taste. Its co-gate `ai_enabled`
        // stays device-local below, which is what keeps a synced `true` from
        // starting inference on a device that never opted into AI.
        auto_tag_enabled: lww!("auto_tag_enabled", auto_tag_enabled),
        // myne#279: how a date and a time are PRINTED is taste, so both merge
        // last-writer-wins alongside `daily_date_format`. `timezone` is the
        // exception and stays device-local below — see its comment there.
        date_format: lww!("date_format", date_format),
        time_format: lww!("time_format", time_format),
        daily_date_format: lww!("daily_date_format", daily_date_format),
        daily_folder: lww!("daily_folder", daily_folder),
        daily_template: lww!("daily_template", daily_template),
        icon: lww!("icon", icon),
        label: lww!("label", label),
        new_note_location: lww!("new_note_location", new_note_location),
        new_note_location_folder: lww!("new_note_location_folder", new_note_location_folder),
        // ---- shared: set-union (clockless; the shared conflict.rs primitive) --
        // Folder-path sets fold case-insensitively so `personal/` ≡ `PERSONAL/`
        // never coexist (MYND-562); `spell_languages` (language codes) stays
        // case-sensitive on the plain union.
        ai_excluded_folders: merge_set_union_folded(
            &local.ai_excluded_folders,
            &remote.ai_excluded_folders,
        ),
        archived_folders: merge_set_union_folded(&local.archived_folders, &remote.archived_folders),
        // myne-cli epic (MYND-490): a folder-path set, same fold discipline as
        // ai_excluded_folders/archived_folders/deliberate_folders — an exclusion
        // added on one device must never be lost in a merge with a device that
        // lacks it.
        cli_excluded_folders: merge_set_union_folded(
            &local.cli_excluded_folders,
            &remote.cli_excluded_folders,
        ),
        deliberate_folders: merge_set_union_folded(
            &local.deliberate_folders,
            &remote.deliberate_folders,
        ),
        spell_languages: merge_set_union(&local.spell_languages, &remote.spell_languages),
        // ---- shared: sequence-LWW-on-whole -------------------------------
        favorites: lww!("favorites", favorites),
        view_order: lww!("view_order", view_order),
        // ---- shared: whole-value LWW -------------------------------------
        // (saved_views / color_groups need their codec's canonical encoder —
        // serde would emit struct-declaration key order.)
        saved_views: lww_field_keyed(
            "saved_views",
            &local.saved_views,
            clock_of(local, "saved_views"),
            &remote.saved_views,
            clock_of(remote, "saved_views"),
            &mut clocks,
            |v| protocol::canonical_encode_saved_views(v),
        ),
        // color_groups (MYND-604): order IS rule precedence, so — unlike
        // saved_views — the tiebreak key must NOT re-sort; the canonical
        // encoder already preserves slice order verbatim, which is exactly
        // what `lww_field_keyed` needs (a deterministic byte key per value).
        color_groups: lww_field_keyed(
            "color_groups",
            &local.color_groups,
            clock_of(local, "color_groups"),
            &remote.color_groups,
            clock_of(remote, "color_groups"),
            &mut clocks,
            |v| protocol::canonical_encode_color_groups(v),
        ),
        // ---- shared: per-key map merge (MYND-478 device_names; MYND-562
        // folder decorations) — computed above so each borrows `clocks` once.
        device_names,
        folder_icons,
        item_colors,
        // item_order (MYND-596): per-container map merge, computed above so it
        // borrows `clocks` once — moved here from the sequence-LWW group.
        item_order,
        // ---- device-local: local wins, always -----------------------------
        active_workspace: local.active_workspace.clone(),
        ai_enabled: local.ai_enabled,
        // MYND-441: device-local like `ai_enabled`, and for the same reason —
        // battery and thermal capacity differ per device, so turning OCR off on
        // a phone must not turn it off on the desktop.
        attachment_ocr_enabled: local.attachment_ocr_enabled,
        auto_lock_seconds: local.auto_lock_seconds,
        bar_items_order: local.bar_items_order.clone(),
        // myne-cli epic (MYND-490): a per-machine door + performance knob — the
        // local value always survives the merge, same discipline as ai_enabled.
        cli_enabled: local.cli_enabled,
        cli_rate_limit_disabled: local.cli_rate_limit_disabled,
        custom_theme: local.custom_theme.clone(),
        // developer-mode (MYND-593): device-local like `ai_enabled` — it gates
        // a device-local model-path override, so a synced flag would read "on"
        // on a device with no override behind it.
        developer_mode: local.developer_mode,
        editor_content_width: local.editor_content_width.clone(),
        editor_default_view_mode: local.editor_default_view_mode.clone(),
        editor_focus_dim_inactive: local.editor_focus_dim_inactive,
        editor_focus_typewriter: local.editor_focus_typewriter,
        editor_font_family: local.editor_font_family.clone(),
        editor_layout: local.editor_layout,
        editor_line_numbers: local.editor_line_numbers,
        editor_line_spacing: local.editor_line_spacing.clone(),
        editor_slash_hidden: local.editor_slash_hidden.clone(),
        editor_slash_order: local.editor_slash_order.clone(),
        editor_text_size: local.editor_text_size.clone(),
        editor_toolbar_hidden: local.editor_toolbar_hidden.clone(),
        editor_toolbar_order: local.editor_toolbar_order.clone(),
        // vim-keyboard-mode (MYND-313): device-local — the local value always
        // survives the merge, like every other editor preference.
        editor_vim_mode: local.editor_vim_mode,
        hidden_bar_items: local.hidden_bar_items.clone(),
        keymap: local.keymap.clone(),
        last_backup_at: local.last_backup_at,
        paired_extensions: local.paired_extensions.clone(),
        right_panel_active_tab: local.right_panel_active_tab.clone(),
        right_panel_hidden_tabs: local.right_panel_hidden_tabs.clone(),
        right_panel_tab_order: local.right_panel_tab_order.clone(),
        screen_capture_protection: local.screen_capture_protection,
        show_note_timestamps: local.show_note_timestamps,
        spell_enabled: local.spell_enabled,
        startup_open: local.startup_open.clone(),
        startup_open_note: local.startup_open_note.clone(),
        theme: local.theme,
        // ---- merge metadata ------------------------------------------------
        field_clocks: clocks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::sync::prefs_classification::classify;

    fn stamped(view: &mut PrefsView, field: &str, clock: u64) {
        view.field_clocks.insert(field.to_string(), clock);
    }

    /// Device-local fields reset to defaults so the commutativity assertion
    /// compares only what §10.2 promises converges (shared fields + merged
    /// clocks). Table-driven via a serde-Value overlay — the same mechanism
    /// the production hash/stamp paths use — so it never drifts from the
    /// classification.
    fn shared_projection(view: &PrefsView) -> PrefsView {
        let mut v = serde_json::to_value(view).expect("prefs view serializes");
        let d = serde_json::to_value(PrefsView::default()).expect("defaults serialize");
        for (name, class) in CLASSIFICATION {
            if *class == PrefClass::DeviceLocal {
                v[*name] = d[*name].clone();
            }
        }
        serde_json::from_value(v).expect("projected view deserializes")
    }

    #[test]
    fn newer_clock_wins_both_directions() {
        let mut a = PrefsView {
            label: Some("Phone".into()),
            ..PrefsView::default()
        };
        stamped(&mut a, "label", 200);
        let mut b = PrefsView {
            label: Some("Desktop".into()),
            ..PrefsView::default()
        };
        stamped(&mut b, "label", 100);

        let ab = merge_prefs(&a, &b);
        let ba = merge_prefs(&b, &a);
        assert_eq!(ab.label.as_deref(), Some("Phone"));
        assert_eq!(ba.label.as_deref(), Some("Phone"));
        assert_eq!(ab.field_clocks.get("label"), Some(&200));
        assert_eq!(ba.field_clocks.get("label"), Some(&200));
    }

    #[test]
    fn attachment_compression_enabled_is_shared_scalar_lww() {
        // ingest-image-compression: unlike attachment_ocr_enabled (device-local),
        // this toggle is shared — a vault-wide, irreversible content-fidelity
        // switch, so the newer clock wins in both directions like `label`.
        let mut a = PrefsView {
            attachment_compression_enabled: false,
            ..PrefsView::default()
        };
        stamped(&mut a, "attachment_compression_enabled", 200);
        let mut b = PrefsView {
            attachment_compression_enabled: true,
            ..PrefsView::default()
        };
        stamped(&mut b, "attachment_compression_enabled", 100);

        let ab = merge_prefs(&a, &b);
        let ba = merge_prefs(&b, &a);
        assert!(!ab.attachment_compression_enabled);
        assert!(!ba.attachment_compression_enabled);
        assert_eq!(
            ab.field_clocks.get("attachment_compression_enabled"),
            Some(&200)
        );
        assert_eq!(
            ba.field_clocks.get("attachment_compression_enabled"),
            Some(&200)
        );
    }

    #[test]
    fn equal_clocks_tie_break_lexicographically_greater() {
        let mut a = PrefsView {
            label: Some("Alpha".into()),
            ..PrefsView::default()
        };
        stamped(&mut a, "label", 500);
        let mut b = PrefsView {
            label: Some("Zulu".into()),
            ..PrefsView::default()
        };
        stamped(&mut b, "label", 500);

        // "Zulu" > "Alpha" byte-lexicographically — wins from either side.
        assert_eq!(merge_prefs(&a, &b).label.as_deref(), Some("Zulu"));
        assert_eq!(merge_prefs(&b, &a).label.as_deref(), Some("Zulu"));
    }

    #[test]
    fn absent_clock_counts_as_zero_migration_case() {
        // Legacy local (pre-MYND-478: real label, no clock) vs a remote that
        // renamed post-upgrade: the clocked write wins — and the reverse
        // direction agrees.
        let legacy = PrefsView {
            label: Some("Old Name".into()),
            ..PrefsView::default()
        };
        let mut upgraded = PrefsView {
            label: Some("New Name".into()),
            ..PrefsView::default()
        };
        stamped(&mut upgraded, "label", 1);

        assert_eq!(
            merge_prefs(&legacy, &upgraded).label.as_deref(),
            Some("New Name")
        );
        assert_eq!(
            merge_prefs(&upgraded, &legacy).label.as_deref(),
            Some("New Name")
        );
    }

    #[test]
    fn concurrent_edits_to_different_fields_both_survive() {
        // The reason per-field clocks exist (§10.2): an offline rename on one
        // device and a favorites edit on the other must both survive.
        let mut a = PrefsView {
            label: Some("Renamed Offline".into()),
            ..PrefsView::default()
        };
        stamped(&mut a, "label", 300);
        let mut b = PrefsView {
            favorites: vec!["note-1".into()],
            ..PrefsView::default()
        };
        stamped(&mut b, "favorites", 400);

        let merged = merge_prefs(&a, &b);
        assert_eq!(merged.label.as_deref(), Some("Renamed Offline"));
        assert_eq!(merged.favorites, vec!["note-1".to_string()]);
    }

    #[test]
    fn set_union_fields_union_clocklessly() {
        let a = PrefsView {
            ai_excluded_folders: vec!["Private/".into(), "Journal/".into()],
            deliberate_folders: vec!["A/".into()],
            ..PrefsView::default()
        };
        let b = PrefsView {
            ai_excluded_folders: vec!["Private/".into(), "Work/".into()],
            deliberate_folders: vec!["B/".into()],
            ..PrefsView::default()
        };

        let merged = merge_prefs(&a, &b);
        assert_eq!(
            merged.ai_excluded_folders,
            vec![
                "Journal/".to_string(),
                "Private/".to_string(),
                "Work/".to_string()
            ]
        );
        assert_eq!(
            merged.deliberate_folders,
            vec!["A/".to_string(), "B/".to_string()]
        );
        assert!(merged.field_clocks.is_empty());
    }

    /// myne-cli epic (MYND-490): an exclusion added on one device must never
    /// be lost in a merge with a device that never touched the list — the
    /// same fail-safe SetUnion discipline as `ai_excluded_folders`.
    #[test]
    fn cli_excluded_folders_union_survives_a_device_that_lacks_it() {
        let a = PrefsView {
            cli_excluded_folders: vec!["Journal/".into()],
            ..PrefsView::default()
        };
        let b = PrefsView::default(); // never touched the CLI exclusion list

        for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
            assert_eq!(merged.cli_excluded_folders, vec!["Journal/".to_string()]);
        }
        assert!(merge_prefs(&a, &b).field_clocks.is_empty());
    }

    #[test]
    fn folder_path_sets_fold_case_variants() {
        // MYND-562: a folder present as "personal/" on one device and
        // "PERSONAL/" on the other collapses to one canonical entry through the
        // merge (lexicographic-min survives).
        let a = PrefsView {
            deliberate_folders: vec!["personal/".into()],
            ..PrefsView::default()
        };
        let b = PrefsView {
            deliberate_folders: vec!["PERSONAL/".into()],
            ..PrefsView::default()
        };
        assert_eq!(
            merge_prefs(&a, &b).deliberate_folders,
            vec!["PERSONAL/".to_string()]
        );

        // `spell_languages` is NOT a folder set — case is significant, both survive.
        let a2 = PrefsView {
            spell_languages: vec!["en".into()],
            ..PrefsView::default()
        };
        let b2 = PrefsView {
            spell_languages: vec!["EN".into()],
            ..PrefsView::default()
        };
        assert_eq!(
            merge_prefs(&a2, &b2).spell_languages,
            vec!["EN".to_string(), "en".to_string()]
        );
    }

    #[test]
    fn item_order_merges_per_container_independently() {
        // MYND-596: item_order is a per-container map, so two devices reordering
        // DIFFERENT containers between syncs BOTH survive (the old whole-sequence
        // LWW dropped one). A container edited on both sides resolves LWW on its
        // own `item_order/<container>` clock; a single-sided container is carried
        // over verbatim. This is the MYND-562 per-key-map guarantee applied to
        // the sidebar order.
        let mut a = PrefsView {
            item_order: BTreeMap::from([
                (String::new(), vec!["n1".into(), "n2".into()]),
                ("Projects/".into(), vec!["Projects/Alpha/".into()]),
                // Only local has an Archive/ ordering.
                ("Archive/".into(), vec!["Archive/2024/".into()]),
            ]),
            ..PrefsView::default()
        };
        stamped(&mut a, "item_order/", 10); // root: newer locally
        stamped(&mut a, "item_order/Projects/", 5); // Projects/: older locally
        stamped(&mut a, "item_order/Archive/", 7);

        let mut b = PrefsView {
            item_order: BTreeMap::from([
                (String::new(), vec!["nX".into(), "nY".into()]),
                (
                    "Projects/".into(),
                    vec!["Projects/Beta/".into(), "Projects/Alpha/".into()],
                ),
            ]),
            ..PrefsView::default()
        };
        stamped(&mut b, "item_order/", 8); // root: older on remote
        stamped(&mut b, "item_order/Projects/", 20); // Projects/: newer on remote

        let merged = merge_prefs(&a, &b);
        // Root container: local clock (10) > remote (8) → local order kept.
        assert_eq!(
            merged.item_order.get(""),
            Some(&vec!["n1".to_string(), "n2".to_string()])
        );
        // Projects/: remote clock (20) > local (5) → remote order kept, WITHOUT
        // clobbering the root reorder above.
        assert_eq!(
            merged.item_order.get("Projects/"),
            Some(&vec![
                "Projects/Beta/".to_string(),
                "Projects/Alpha/".to_string()
            ])
        );
        // Archive/ exists only on local → carried over verbatim.
        assert_eq!(
            merged.item_order.get("Archive/"),
            Some(&vec!["Archive/2024/".to_string()])
        );
    }

    #[test]
    fn stamping_item_order_clocks_each_changed_container() {
        // MYND-596: the central write path stamps item_order per-CONTAINER, so
        // the merge above can resolve each container independently. A changed
        // root and a changed "Archive/" get distinct `item_order/<container>`
        // clocks; an untouched "Projects/" gets none; and the bare field name is
        // NEVER stamped (that was the old whole-sequence LWW key).
        let before = PrefsView {
            item_order: BTreeMap::from([
                (String::new(), vec!["n1".into()]),
                ("Projects/".into(), vec!["Projects/A/".into()]),
                ("Archive/".into(), vec!["Archive/1/".into()]),
            ]),
            ..PrefsView::default()
        };
        let mut after = PrefsView {
            item_order: BTreeMap::from([
                (String::new(), vec!["n2".into(), "n1".into()]), // changed
                ("Projects/".into(), vec!["Projects/A/".into()]), // unchanged
                (
                    "Archive/".into(),
                    vec!["Archive/2/".into(), "Archive/1/".into()],
                ), // changed
            ]),
            ..PrefsView::default()
        };
        stamp_changed_shared_fields(&before, &mut after, 999);
        assert_eq!(after.field_clocks.get("item_order/"), Some(&999));
        assert_eq!(after.field_clocks.get("item_order/Archive/"), Some(&999));
        assert!(!after.field_clocks.contains_key("item_order/Projects/"));
        assert!(!after.field_clocks.contains_key("item_order"));
    }

    #[test]
    fn device_local_fields_survive_a_newer_remote() {
        let mut local = PrefsView {
            auto_lock_seconds: Some(30),
            ..PrefsView::default()
        };
        local.theme = None; // follow OS
        let mut remote = PrefsView {
            auto_lock_seconds: Some(600),
            ..PrefsView::default()
        };
        // Even a (bogus) remote clock on a device-local field changes nothing.
        stamped(&mut remote, "auto_lock_seconds", u64::MAX);

        let merged = merge_prefs(&local, &remote);
        assert_eq!(merged.auto_lock_seconds, Some(30));
        // And the bogus clock entry is NOT propagated into the merged map.
        assert!(!merged.field_clocks.contains_key("auto_lock_seconds"));
    }

    /// MYND-651: `auto_tag_enabled` is Shared/ScalarLww, so the newer clock
    /// wins and the flag DOES cross devices — the deliberate contrast with its
    /// device-local co-gate `ai_enabled`, which does not. The pair is what makes
    /// the classification safe: a synced `true` cannot start inference on a
    /// device that never opted into AI.
    #[test]
    fn auto_tag_enabled_is_shared_lww_unlike_its_ai_enabled_co_gate() {
        assert_eq!(
            classify("auto_tag_enabled"),
            Some(PrefClass::Shared(SharedDiscipline::ScalarLww))
        );

        let local = PrefsView {
            auto_tag_enabled: false,
            ..PrefsView::default()
        };
        let mut remote = PrefsView {
            auto_tag_enabled: true,
            // The co-gate is set on the remote too, and must NOT come with it.
            ai_enabled: true,
            ..PrefsView::default()
        };
        stamped(&mut remote, "auto_tag_enabled", u64::MAX);
        stamped(&mut remote, "ai_enabled", u64::MAX);

        let merged = merge_prefs(&local, &remote);
        assert!(
            merged.auto_tag_enabled,
            "newer remote clock wins the scalar"
        );
        assert!(
            !merged.ai_enabled,
            "ai_enabled is device-local — local's off must survive"
        );
        assert!(!merged.field_clocks.contains_key("ai_enabled"));

        // And a newer LOCAL clock keeps the local value against a set remote.
        let mut local_off = PrefsView {
            auto_tag_enabled: false,
            ..PrefsView::default()
        };
        stamped(&mut local_off, "auto_tag_enabled", u64::MAX);
        let remote_on = PrefsView {
            auto_tag_enabled: true,
            ..PrefsView::default()
        };
        assert!(!merge_prefs(&local_off, &remote_on).auto_tag_enabled);
    }

    /// myne-cli epic (MYND-490): the CLI door is a per-machine decision, so it
    /// must NOT propagate across a merge — after merging local=false with a
    /// remote that has it on, the merged value stays local's (`false`), same
    /// as `ai_enabled`'s device-local discipline.
    #[test]
    fn cli_enabled_does_not_propagate_across_a_merge() {
        let local = PrefsView {
            cli_enabled: false,
            ..PrefsView::default()
        };
        let mut remote = PrefsView {
            cli_enabled: true,
            ..PrefsView::default()
        };
        // Even a (bogus) remote clock on a device-local field changes nothing.
        stamped(&mut remote, "cli_enabled", u64::MAX);

        let merged = merge_prefs(&local, &remote);
        assert!(!merged.cli_enabled);
        assert!(!merged.field_clocks.contains_key("cli_enabled"));

        // And the reverse: local=true survives a remote that has it off.
        let local_on = PrefsView {
            cli_enabled: true,
            ..PrefsView::default()
        };
        let remote_off = PrefsView {
            cli_enabled: false,
            ..PrefsView::default()
        };
        assert!(merge_prefs(&local_on, &remote_off).cli_enabled);
    }

    /// Same device-local discipline for the rate-limit toggle — a machine-local
    /// performance knob, not a shared preference.
    #[test]
    fn cli_rate_limit_disabled_does_not_propagate_across_a_merge() {
        let local = PrefsView {
            cli_rate_limit_disabled: None,
            ..PrefsView::default()
        };
        let remote = PrefsView {
            cli_rate_limit_disabled: Some(true),
            ..PrefsView::default()
        };
        assert_eq!(merge_prefs(&local, &remote).cli_rate_limit_disabled, None);
    }

    #[test]
    fn device_names_merge_per_key() {
        // Disjoint keys union; a shared key resolves on its own namespaced clock.
        let mut a = PrefsView::default();
        a.device_names.insert("aa11".into(), "Laptop".into());
        a.device_names.insert("cc33".into(), "Old Name".into());
        stamped(&mut a, "device_names/aa11", 100);
        stamped(&mut a, "device_names/cc33", 50);
        let mut b = PrefsView::default();
        b.device_names.insert("bb22".into(), "Phone".into());
        b.device_names.insert("cc33".into(), "New Name".into());
        stamped(&mut b, "device_names/bb22", 200);
        stamped(&mut b, "device_names/cc33", 60);

        for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
            assert_eq!(merged.device_names.get("aa11").unwrap(), "Laptop");
            assert_eq!(merged.device_names.get("bb22").unwrap(), "Phone");
            assert_eq!(merged.device_names.get("cc33").unwrap(), "New Name");
            assert_eq!(merged.field_clocks.get("device_names/cc33"), Some(&60));
        }
    }

    #[test]
    fn decoration_maps_merge_per_key() {
        // MYND-562: `item_colors` / `folder_icons` are per-key map merges, not
        // whole-map LWW. Concurrent edits to DIFFERENT folder keys must both
        // survive (the lost-update the whole-map LWW dropped); the SAME key
        // resolves LWW on its own `<field>/<key>` clock; note-UUID color keys
        // ride the same path.
        let mut a = PrefsView::default();
        a.item_colors.insert("work/".into(), "#red".into());
        a.item_colors.insert("uuid-note".into(), "#a1a1a1".into());
        a.folder_icons.insert("work/".into(), "briefcase".into());
        stamped(&mut a, "item_colors/work/", 100);
        stamped(&mut a, "item_colors/uuid-note", 100);
        stamped(&mut a, "folder_icons/work/", 100);

        let mut b = PrefsView::default();
        b.item_colors.insert("personal/".into(), "#blue".into()); // different folder
        b.item_colors.insert("work/".into(), "#green".into()); // same folder, newer clock
        b.folder_icons.insert("personal/".into(), "leaf".into());
        stamped(&mut b, "item_colors/personal/", 200);
        stamped(&mut b, "item_colors/work/", 300);
        stamped(&mut b, "folder_icons/personal/", 200);

        for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
            // Same key: newer clock (300 > 100) wins.
            assert_eq!(merged.item_colors.get("work/").unwrap(), "#green");
            // Different folders: BOTH survive (whole-map LWW would drop one).
            assert_eq!(merged.item_colors.get("personal/").unwrap(), "#blue");
            // Note-UUID color survives on its own key.
            assert_eq!(merged.item_colors.get("uuid-note").unwrap(), "#a1a1a1");
            assert_eq!(merged.folder_icons.get("work/").unwrap(), "briefcase");
            assert_eq!(merged.folder_icons.get("personal/").unwrap(), "leaf");
            assert_eq!(merged.field_clocks.get("item_colors/work/"), Some(&300));
        }
    }

    #[test]
    fn merge_is_commutative_on_the_shared_subset() {
        // A rich pair exercising every discipline at once.
        let mut a = PrefsView {
            label: Some("A-Label".into()),
            ..PrefsView::default()
        };
        stamped(&mut a, "label", 100);
        a.icon = Some("book".into());
        stamped(&mut a, "icon", 300);
        a.favorites = vec!["f1".into()];
        stamped(&mut a, "favorites", 10);
        a.ai_excluded_folders = vec!["P/".into()];
        a.device_names.insert("d1".into(), "One".into());
        stamped(&mut a, "device_names/d1", 5);
        a.theme = None;
        a.auto_lock_seconds = Some(30);

        let mut b = PrefsView {
            label: Some("B-Label".into()),
            ..PrefsView::default()
        };
        stamped(&mut b, "label", 200);
        b.icon = Some("leaf".into());
        stamped(&mut b, "icon", 300); // tie → lexicographic
        b.item_order = BTreeMap::from([(String::new(), vec!["n9".into()])]);
        stamped(&mut b, "item_order/", 40);
        b.ai_excluded_folders = vec!["Q/".into()];
        b.device_names.insert("d2".into(), "Two".into());
        stamped(&mut b, "device_names/d2", 7);
        b.auto_lock_seconds = Some(600);

        let ab = merge_prefs(&a, &b);
        let ba = merge_prefs(&b, &a);
        assert_eq!(shared_projection(&ab), shared_projection(&ba));
        // Each side kept its own device-local values.
        assert_eq!(ab.auto_lock_seconds, Some(30));
        assert_eq!(ba.auto_lock_seconds, Some(600));
    }

    #[test]
    fn merging_two_legacy_views_stays_clockless() {
        // Two pre-MYND-478 devices (no clocks anywhere): the merge must not
        // invent clock entries, so the merged view re-encodes without a
        // field_clocks key (byte-identity discipline).
        let a = PrefsView {
            label: Some("Alpha".into()),
            ..PrefsView::default()
        };
        let b = PrefsView {
            label: Some("Beta".into()),
            ..PrefsView::default()
        };

        let merged = merge_prefs(&a, &b);
        assert_eq!(merged.label.as_deref(), Some("Beta")); // lexicographic
        assert!(merged.field_clocks.is_empty());
    }

    #[test]
    fn merge_respects_the_classification_table() {
        // Sentinel cross-check with prefs_classification: a field the table
        // calls shared takes the remote's newer value; one it calls
        // device-local never does.
        assert!(matches!(classify("label"), Some(PrefClass::Shared(_))));
        assert_eq!(classify("theme"), Some(PrefClass::DeviceLocal));

        let local = PrefsView::default();
        let mut remote = PrefsView {
            label: Some("Synced".into()),
            ..PrefsView::default()
        };
        stamped(&mut remote, "label", 1);
        remote.theme = Some(protocol::ThemeChoice::Dark);

        let merged = merge_prefs(&local, &remote);
        assert_eq!(merged.label.as_deref(), Some("Synced"));
        assert_eq!(merged.theme, None);
    }

    #[test]
    fn developer_mode_is_device_local_local_wins_both_sides() {
        // MYND-593: developer_mode gates a device-local model-path override,
        // so — like ai_enabled / attachment_ocr_enabled — the local value
        // must survive the merge regardless of which side is "on".
        assert_eq!(classify("developer_mode"), Some(PrefClass::DeviceLocal));

        let off = PrefsView::default();
        let on = PrefsView {
            developer_mode: true,
            ..PrefsView::default()
        };

        assert!(
            !merge_prefs(&off, &on).developer_mode,
            "local off must stay off"
        );
        assert!(
            merge_prefs(&on, &off).developer_mode,
            "local on must stay on"
        );
    }

    #[test]
    fn a_set_value_beats_unset_on_equal_clocks() {
        // §10.2: an absent/null value sorts LOWEST in the tiebreak — a legacy
        // device that named the vault must not lose the name to a legacy
        // device that never did (both clockless ⇒ tie).
        let named = PrefsView {
            label: Some("Kept".into()),
            ..PrefsView::default()
        };
        let unnamed = PrefsView::default();
        assert_eq!(merge_prefs(&named, &unnamed).label.as_deref(), Some("Kept"));
        assert_eq!(merge_prefs(&unnamed, &named).label.as_deref(), Some("Kept"));
    }

    #[test]
    fn shared_subset_hash_ignores_device_local_changes() {
        // The push gate's discriminator: a device-local edit (theme) leaves the
        // hash unchanged; a shared edit (label) changes it.
        let base = PrefsView::default();
        let themed = PrefsView {
            theme: Some(protocol::ThemeChoice::Dark),
            ..PrefsView::default()
        };
        let labeled = PrefsView {
            label: Some("New".into()),
            ..PrefsView::default()
        };
        assert_eq!(shared_subset_hash(&base), shared_subset_hash(&themed));
        assert_ne!(shared_subset_hash(&base), shared_subset_hash(&labeled));
    }

    #[test]
    fn saved_views_tie_breaks_on_the_canonical_encoding() {
        // §10.2 makes the equal-clock tiebreak bytes normative: "the values'
        // canonical encodings" (the §9.5.2 codec) — NOT an implementation's
        // native serializer output. saved_views is the one shared field where
        // the two differ (serde emits struct-declaration key order), so pin
        // that the winner is chosen by `canonical_encode_saved_views` bytes,
        // from either side.
        use protocol::{FilterNode, SavedView, ViewType};
        let view = |id: &str, name: &str| SavedView {
            id: id.into(),
            name: name.into(),
            view_type: ViewType::List,
            filters: FilterNode::All,
            sort: None,
            group_by: None,
            columns: Vec::new(),
            card_size: None,
            image: None,
            image_aspect_ratio: None,
        };
        let mut a = PrefsView {
            saved_views: vec![view("0190-a", "Books")],
            ..PrefsView::default()
        };
        stamped(&mut a, "saved_views", 500);
        let mut b = PrefsView {
            saved_views: vec![view("0190-b", "Articles")],
            ..PrefsView::default()
        };
        stamped(&mut b, "saved_views", 500);

        let expected = if protocol::canonical_encode_saved_views(&a.saved_views)
            > protocol::canonical_encode_saved_views(&b.saved_views)
        {
            a.saved_views.clone()
        } else {
            b.saved_views.clone()
        };
        assert_eq!(merge_prefs(&a, &b).saved_views, expected);
        assert_eq!(merge_prefs(&b, &a).saved_views, expected);
    }

    #[test]
    fn color_groups_merge_is_commutative_and_tie_breaks_on_the_canonical_encoding() {
        // MYND-604: color_groups is classified whole-value LWW like
        // saved_views, and for the same reason the tiebreak must use the
        // canonical (order-preserving) encoding, not serde's — pin both
        // merge(a,b) == merge(b,a) AND the winner-by-canonical-bytes rule.
        use protocol::{ColorGroup, FilterNode};
        let rule = |id: &str, name: &str| ColorGroup {
            id: id.into(),
            name: name.into(),
            color: "moss".into(),
            enabled: true,
            filter: FilterNode::All,
        };
        let mut a = PrefsView {
            color_groups: vec![rule("g-a", "Work")],
            ..PrefsView::default()
        };
        stamped(&mut a, "color_groups", 500);
        let mut b = PrefsView {
            color_groups: vec![rule("g-b", "Rest")],
            ..PrefsView::default()
        };
        stamped(&mut b, "color_groups", 500);

        let expected = if protocol::canonical_encode_color_groups(&a.color_groups)
            > protocol::canonical_encode_color_groups(&b.color_groups)
        {
            a.color_groups.clone()
        } else {
            b.color_groups.clone()
        };
        assert_eq!(merge_prefs(&a, &b).color_groups, expected);
        assert_eq!(merge_prefs(&b, &a).color_groups, expected);
    }

    #[test]
    fn color_groups_newer_clock_wins_and_precedence_order_survives() {
        // A non-tie case: the newer side wins outright, and its rule ORDER
        // (precedence) survives verbatim — not re-sorted by id.
        use protocol::{ColorGroup, FilterNode};
        let rule = |id: &str| ColorGroup {
            id: id.into(),
            name: id.into(),
            color: "slate".into(),
            enabled: true,
            filter: FilterNode::All,
        };
        let mut older = PrefsView {
            color_groups: vec![rule("zzz"), rule("aaa")],
            ..PrefsView::default()
        };
        stamped(&mut older, "color_groups", 100);
        let mut newer = PrefsView {
            color_groups: vec![rule("bbb"), rule("ccc")],
            ..PrefsView::default()
        };
        stamped(&mut newer, "color_groups", 200);

        let merged = merge_prefs(&older, &newer);
        assert_eq!(
            merged
                .color_groups
                .iter()
                .map(|g| g.id.clone())
                .collect::<Vec<_>>(),
            vec!["bbb".to_string(), "ccc".to_string()]
        );
    }

    #[test]
    fn stamping_marks_changed_shared_lww_fields_only() {
        let before = PrefsView::default();
        let mut after = PrefsView {
            label: Some("Renamed".into()),            // shared LWW → stamps
            theme: Some(protocol::ThemeChoice::Dark), // device-local → no stamp
            deliberate_folders: vec!["A/".into()],    // set-union → clockless
            ..PrefsView::default()
        };
        stamp_changed_shared_fields(&before, &mut after, 12345);

        assert_eq!(after.field_clocks.get("label"), Some(&12345));
        assert!(!after.field_clocks.contains_key("theme"));
        assert!(!after.field_clocks.contains_key("deliberate_folders"));
        assert_eq!(after.field_clocks.len(), 1);
    }

    #[test]
    fn stamping_skips_unchanged_fields_and_preserves_existing_clocks() {
        let mut before = PrefsView {
            label: Some("Same".into()),
            ..PrefsView::default()
        };
        stamped(&mut before, "label", 100);
        let mut after = before.clone();
        after.icon = Some("book".into()); // only icon changed

        stamp_changed_shared_fields(&before, &mut after, 999);
        assert_eq!(after.field_clocks.get("label"), Some(&100)); // untouched
        assert_eq!(after.field_clocks.get("icon"), Some(&999));
        assert_eq!(after.field_clocks.len(), 2);
    }

    #[test]
    fn stamping_device_names_is_per_key() {
        let mut before = PrefsView::default();
        before.device_names.insert("aa".into(), "Old".into());
        let mut after = before.clone();
        after.device_names.insert("aa".into(), "New".into()); // changed
        after.device_names.insert("bb".into(), "Added".into()); // added

        stamp_changed_shared_fields(&before, &mut after, 777);
        assert_eq!(after.field_clocks.get("device_names/aa"), Some(&777));
        assert_eq!(after.field_clocks.get("device_names/bb"), Some(&777));
        assert!(!after.field_clocks.contains_key("device_names"));
        assert_eq!(after.field_clocks.len(), 2);
    }
}
