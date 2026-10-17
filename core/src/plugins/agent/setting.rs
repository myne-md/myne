// SPDX-License-Identifier: AGPL-3.0
//! The agent's setting intents (myne-md/myne#850).
//!
//! The agent may change a **closed set of named settings**, not preferences in
//! general. `docs/decisions/ai/0515` states the principle for note writes and it
//! carries over unchanged: the verb set is the permission. This module is where
//! that set lives, where a value is validated, and where a field the agent may not
//! write is refused.
//!
//! # Three layers, and only the middle one is a list
//!
//! 1. **The intent table.** One row per setting the agent may change: the
//!    settings-index id it resolves from, which pref it writes, and the shape of
//!    its value. This is the permission, so it is deliberately short and every
//!    addition is reviewable.
//! 2. **The derivation.** [`refusal_for_field`] asks the sync layer's own
//!    classification what kind of field this is. `ai_excluded_folders` and
//!    `cli_excluded_folders` are classified there as EGRESS CONTROLS rather than
//!    preferences, and a device-local field describes one machine rather than the
//!    vault, so both are refused whatever the table says. A field that joins
//!    either family later is refused with no edit here.
//! 3. **Validation.** [`validate`] refuses a value the setting cannot hold before
//!    any dialog is shown, so a user never approves a change that then fails.
//!
//! # What the derivation covers, and the residue worth knowing
//!
//! `CLASSIFICATION` marks an egress-control set union and a device-local field,
//! and between them those two arms catch every control in the set the feature
//! refuses: the two folder sets are egress controls, and `screen_capture_protection`,
//! `auto_lock_seconds`, `ai_enabled`, `ai_provider_consent`, `cli_enabled`,
//! `cli_rate_limit_disabled` and `developer_mode` are **all** device-local. So the
//! boundary really is derived rather than listed, and
//! `every_control_is_refused_and_the_arm_that_catches_it_is_named` pins which arm
//! catches which. That test is the one that matters for a reclassification: make
//! `screen_capture_protection` a shared scalar so it syncs, and the refusal
//! disappears silently unless the test says so.
//!
//! The residue: a **shared** field that is nonetheless a control would not be
//! caught, and the table has no third marker to express one. That is not
//! hypothetical for this feature, because it is what the display family runs into:
//! `theme`, `editor_text_size` and `show_note_timestamps` are device-local, so the
//! agent may not write them and the v1 families shrink to note placement and the
//! two format fields. The refusal is the right answer rather than a limitation to
//! route around: a device-local value the agent changed on the phone would not
//! travel, and the user would see it change on one machine and not the other with
//! nothing saying why.

use crate::plugins::sync::prefs_classification::{classify, PrefClass, SharedDiscipline};

/// What one intent writes.
///
/// **One variant per write OPERATION, not per field name** (myne-md/myne#850
/// task 4). The host adapter matches this exhaustively, so an intent whose
/// target nobody implemented does not compile, rather than falling through a
/// string comparison to a runtime refusal. The alternative, `Scalar(&str)` and
/// an adapter that switched on the field name, is the shape that ships a
/// setting which silently fails to write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrefTarget {
    /// One entry of `periodic_notes`, keyed `<period>.<setting>` (myne#177).
    /// The whole map is one classified field, so the derivation checks
    /// `periodic_notes` rather than the entry.
    PeriodicNote {
        period: &'static str,
        setting: &'static str,
    },
    /// `daily_folder`. The daily period keeps its three flat fields rather than a
    /// `periodic_notes` entry, which is why this is not a `PeriodicNote` with
    /// `period: "daily"` (that spelling is refused by the setter).
    DailyFolder,
    /// `daily_template`.
    DailyTemplate,
    /// `daily_date_format`.
    DailyDateFormat,
    /// `date_format`, the display format for dates in the interface.
    DateFormat,
    /// `time_format`, the same for times.
    TimeFormat,
    /// `new_note_location` + `new_note_location_folder`: **one setting over two
    /// fields**, written together so the mode and its folder never desync
    /// (MYND-462, "the existing sub-step shape").
    NewNoteLocation,
}

impl PrefTarget {
    /// The classified pref field this target writes, for the derivation.
    pub fn field(&self) -> &'static str {
        match self {
            Self::PeriodicNote { .. } => "periodic_notes",
            Self::DailyFolder => "daily_folder",
            Self::DailyTemplate => "daily_template",
            Self::DailyDateFormat => "daily_date_format",
            Self::DateFormat => "date_format",
            Self::TimeFormat => "time_format",
            Self::NewNoteLocation => "new_note_location",
        }
    }

    /// Whether this setting can be CLEARED through the prefs layer
    /// (myne-md/myne#850 task 4).
    ///
    /// **Two of them are refused, and after the 2026-10-13 review the reason is a
    /// POLICY rather than a signature.** `set_daily_folder` and
    /// `set_daily_date_format` take a required value, so the model-facing clear has
    /// no setter to reach; rather than write an empty string and call it a clear,
    /// which is a VALUE and the whole reason clear is its own verb, a clear of
    /// these two is refused with that stated reason. The other five route through
    /// setters that already take an `Option`.
    ///
    /// **What changed is that the UNDO gained a way to express the empty state for
    /// them anyway** (`plugins::prefs::commands::clear_daily_folder_from_host` and
    /// its sibling, added with the undo's folder fix): a run that set one of these
    /// for the first time can now be undone, which it could not be before. The
    /// clear VERB still refuses them, deliberately, because a model clearing the
    /// user's daily folder on a sentence is a different act from an undo putting
    /// back what was there a moment ago. Widening the two setters to `Option`
    /// remains the change that would make the two agree, and it is still a change
    /// to a shared command's IPC shape rather than something to slip in here.
    pub fn clearable(&self) -> bool {
        !matches!(self, Self::DailyFolder | Self::DailyDateFormat)
    }
}

/// The shape of the value an intent accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueKind {
    /// A folder path. Non-empty, no control characters, bounded in length. The
    /// folder itself is ensured by the caller, not by this module.
    FolderPath,
    /// A short free string: a template reference, or a note-title date pattern
    /// (a strftime-like mini-language, so free text is the honest shape).
    /// Non-empty, no control characters, and bounded far below the prefs budget.
    Pattern,
    /// **A value from a CLOSED vocabulary** (myne-md/myne#850, from the
    /// 2026-10-14 review). `editor.date-format` and `editor.time-format` write a
    /// field the read side coerces against `DATE_FORMATS`/`TIME_FORMATS`
    /// (`editor/src/host/lib/datetimeFormat.ts`), where an unknown value silently
    /// becomes `system`. A free `Pattern` therefore accepted `"yyyy-MM-dd"`, the
    /// write succeeded, the row was approved, and the setting had no effect at
    /// all, which is the one outcome `validate` exists to prevent.
    ///
    /// The two lists below mirror that module, and
    /// `tests/notes/agentSettingVocabulary.test.ts` parses them out of this file
    /// and compares them to the editor's, so the mirror cannot drift silently.
    OneOf { values: &'static [&'static str] },
    /// **A mode plus the folder it needs, which is ONE setting over two fields**
    /// (myne-md/myne#850 task 4, MYND-462). `folder_mode` names the one value
    /// that requires a folder; every other value must arrive WITHOUT one, which
    /// is the same rule the settings panel applies by passing `folder = None`
    /// whenever the mode is not `specific`.
    ModeWithFolder {
        modes: &'static [&'static str],
        folder_mode: &'static str,
    },
}

/// One setting the agent may change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettingIntent {
    /// The settings-index id this intent resolves from. The index is where the
    /// words a user types come from, so an intent with no entry has no vocabulary
    /// and is a bug rather than a terse row.
    pub id: &'static str,
    /// What it writes.
    pub target: PrefTarget,
    /// What values it accepts.
    pub kind: ValueKind,
}

/// The closed display-format vocabularies (myne-md/myne#850, from the
/// 2026-10-14 review).
///
/// **Mirrors `DATE_FORMATS`/`TIME_FORMATS` in
/// `editor/src/host/lib/datetimeFormat.ts`**, which owns the vocabulary and the
/// coercion that turns an unknown value into `system`. The mirror is held by
/// `tests/notes/agentSettingVocabulary.test.ts`, which parses these two lists out
/// of this file and compares them to the editor module's, the way
/// `settingRejectionMirror.test.ts` holds the rejection enum against its Rust
/// original.
pub const DATE_FORMAT_VALUES: &[&str] = &["system", "iso", "dmy", "mdy", "dmmmy"];
pub const TIME_FORMAT_VALUES: &[&str] = &["system", "24h", "12h"];

/// The intents (myne-md/myne#850).
///
/// **The v1 families, minus the three the classification refuses.** The plan
/// named `appearance.theme`, `editor.text-size` and `appearance.show-edit-times`
/// as display intents; all three classify as `DeviceLocal`, so the derivation
/// refuses them and they are NOT here. That is the decision rather than an
/// omission: a device-local value syncs nothing, so an agent write would land on
/// the machine that ran the agent and nowhere else, and the user would watch a
/// setting change in one place and not the other with nothing saying why. The
/// settings index carries their verdict, with that reason, so the refusal is
/// visible from the surface a user would look at.
///
/// Every row resolves from a settings-index id, and each is kept beside its
/// family so the index's verdicts and this table can be compared in both
/// directions by the test that does exactly that.
pub const INTENTS: &[SettingIntent] = &[
    // ── Note placement ──────────────────────────────────────────────────────
    SettingIntent {
        id: "editor.daily-notes-folder",
        target: PrefTarget::DailyFolder,
        kind: ValueKind::FolderPath,
    },
    SettingIntent {
        id: "editor.weekly-notes-folder",
        target: PrefTarget::PeriodicNote {
            period: "weekly",
            setting: "folder",
        },
        kind: ValueKind::FolderPath,
    },
    SettingIntent {
        id: "editor.monthly-notes-folder",
        target: PrefTarget::PeriodicNote {
            period: "monthly",
            setting: "folder",
        },
        kind: ValueKind::FolderPath,
    },
    SettingIntent {
        id: "editor.daily-notes-template",
        target: PrefTarget::DailyTemplate,
        kind: ValueKind::Pattern,
    },
    SettingIntent {
        id: "editor.weekly-notes-template",
        target: PrefTarget::PeriodicNote {
            period: "weekly",
            setting: "template",
        },
        kind: ValueKind::Pattern,
    },
    SettingIntent {
        id: "editor.monthly-notes-template",
        target: PrefTarget::PeriodicNote {
            period: "monthly",
            setting: "template",
        },
        kind: ValueKind::Pattern,
    },
    SettingIntent {
        id: "editor.daily-notes-date-format",
        target: PrefTarget::DailyDateFormat,
        kind: ValueKind::Pattern,
    },
    SettingIntent {
        id: "editor.weekly-notes-date-format",
        target: PrefTarget::PeriodicNote {
            period: "weekly",
            setting: "format",
        },
        kind: ValueKind::Pattern,
    },
    SettingIntent {
        id: "editor.monthly-notes-date-format",
        target: PrefTarget::PeriodicNote {
            period: "monthly",
            setting: "format",
        },
        kind: ValueKind::Pattern,
    },
    SettingIntent {
        id: "files.new-note-location",
        target: PrefTarget::NewNoteLocation,
        kind: ValueKind::ModeWithFolder {
            modes: &["root", "current", "specific"],
            folder_mode: "specific",
        },
        // Only the `specific` mode names a folder, and the ensure step runs on
        // the value that carries one.
    },
    // ── Display and format ──────────────────────────────────────────────────
    SettingIntent {
        id: "editor.date-format",
        target: PrefTarget::DateFormat,
        kind: ValueKind::OneOf {
            values: DATE_FORMAT_VALUES,
        },
    },
    SettingIntent {
        id: "editor.time-format",
        target: PrefTarget::TimeFormat,
        kind: ValueKind::OneOf {
            values: TIME_FORMAT_VALUES,
        },
    },
];

/// The folder a change NAMES, if it names one (myne-md/myne#850 task 4).
///
/// **One function rather than a rule per call site.** The two shapes that name a
/// folder put it in different places: a `FolderPath` intent names it as the
/// VALUE, and a `ModeWithFolder` names it as the sub-step and only for the mode
/// that takes one. Agreeing on that at every call site is how one of them ends up
/// registering a folder called `root`, which is the bug this exists to make
/// unexpressible.
///
/// It also replaces the `ensures_folder` boolean the table used to carry: whether
/// a setting names a folder is a property of its KIND, and a second field saying
/// so is a second place for the two to disagree.
pub fn folder_named<'a>(
    intent: &SettingIntent,
    value: Option<&'a str>,
    folder: Option<&'a str>,
) -> Option<&'a str> {
    match intent.kind {
        ValueKind::FolderPath => value,
        ValueKind::ModeWithFolder { folder_mode, .. } if value == Some(folder_mode) => folder,
        _ => None,
    }
}

/// The intent for a settings-index id, if the agent may change it.
pub fn intent(id: &str) -> Option<&'static SettingIntent> {
    INTENTS.iter().find(|i| i.id == id)
}

/// Why a field may not be written, whichever way the request arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingRefusal {
    /// No intent carries this id. The request named a setting the agent is not
    /// given, whether because it is not in the v1 families or because it does not
    /// exist.
    UnknownIntent,
    /// The field is one of the two egress-control sets, so writing it would let
    /// the agent move the bound it runs under. `docs/threat-model.md` A17 rests
    /// its remote-provider mitigation on `ai_excluded_folders`.
    EgressControl,
    /// The field describes this device rather than the vault.
    DeviceLocal,
}

/// What the classification says about a field, for the refusal derivation.
///
/// One function rather than two call sites, so a future marker is added once.
pub fn refusal_for_field(field: &str) -> Option<SettingRefusal> {
    match classify(field) {
        // The egress controls are the set unions whose removals do not propagate,
        // which is the table's own way of saying "a control, not a preference".
        Some(PrefClass::Shared(SharedDiscipline::SetUnion {
            removals_propagate: false,
            ..
        })) => Some(SettingRefusal::EgressControl),
        Some(PrefClass::DeviceLocal) => Some(SettingRefusal::DeviceLocal),
        // Shared in any other discipline, merge metadata, and a field the table
        // does not carry all fall through, and this arm is PERMISSIVE: `None`
        // means "no refusal derived here", which `writable` reads as writable.
        // That is safe today because the classification is exhaustive over
        // `PrefsView` (its own destructure makes a new field a compile error), so
        // every field an intent can name has a row. The residue, and it is worth
        // closing rather than glossing: an intent naming a field the table does
        // not carry would be WRITABLE rather than refused, because `classify`
        // answers `None` for an unknown name and absence is not a
        // classification.
        _ => None,
    }
}

/// Resolve an id to a writable intent, or say why not.
///
/// **The order is load-bearing.** The intents resolve first, so a request for a
/// setting nobody has classified is `UnknownIntent` rather than a wrong reason;
/// then the derivation runs on the field the resolved intent writes, so a row that
/// named an egress control would still be refused. A caller that has already
/// resolved the intent, such as the apply path holding a proposal, uses
/// [`refusal_for_field`] directly.
pub fn writable(id: &str) -> Result<&'static SettingIntent, SettingRefusal> {
    let resolved = intent(id).ok_or(SettingRefusal::UnknownIntent)?;
    match refusal_for_field(resolved.target.field()) {
        Some(refusal) => Err(refusal),
        None => Ok(resolved),
    }
}

/// Why a value was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingValueError {
    /// A folder path that is empty, or only whitespace.
    EmptyValue,
    /// A folder path longer than [`MAX_FOLDER_PATH_BYTES`].
    ValueTooLong,
    /// A folder path carrying a control character, which no folder name has and
    /// which would reach the sidebar renderer.
    ValueHasControlChar,
    /// A token outside the intent's closed set.
    NotAllowedValue,
    /// A value that carries a FOLDER where the setting takes none
    /// (myne-md/myne#850 task 4). Its own reason because the fix differs: the
    /// model sent a second field the setting has no room for, and telling it
    /// "invalid value" would send it looking at the value instead.
    UnexpectedFolder,
    /// A mode that REQUIRES a folder arrived without one. The mode cannot be
    /// stored alone: the settings panel passes `folder = None` for every other
    /// mode, so `specific` with no folder is a state the setter would write and
    /// the panel would then render as a desync.
    FolderRequired,
}

/// The offered intent ids, resolved to this crate's own table entries.
///
/// **The client's list is a request; the table is the answer.** Every requested
/// id is mapped through [`writable`], and what comes back is the table's own
/// `&'static str` rather than the client's `String`. That type is the security
/// property, not a style choice: the list is rendered into the system message,
/// so a client-supplied string has to have no route into it, and the only way to
/// guarantee that is for the renderer to be handed values the compiler took from
/// the table.
///
/// An id the table refuses is dropped, which is how a catalogue claiming more
/// than the table allows becomes an offer of less.
pub fn offered_ids(requested: &[String]) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for id in requested {
        if let Ok(intent) = writable(id) {
            if !out.contains(&intent.id) {
                out.push(intent.id);
            }
        }
    }
    out
}

/// What the model is told when it names a setting it may not write.
///
/// A message it can act on rather than a silent failure: each arm names the
/// class of refusal and what to do instead, because a model that is told only
/// "refused" retries the same setting on the next iteration. The two control arms
/// route the user, who is the only one who can make that change.
pub fn refusal_message(refusal: SettingRefusal) -> &'static str {
    match refusal {
        SettingRefusal::UnknownIntent => {
            "set_setting refused: that is not a setting you can change. Use one \
             of the settings you were given, or finish."
        }
        SettingRefusal::EgressControl => {
            "set_setting refused: that setting controls what leaves the device, \
             so you cannot change it. Tell the user to change it themselves."
        }
        SettingRefusal::DeviceLocal => {
            "set_setting refused: that setting is specific to this device, so you \
             cannot change it. Tell the user to change it themselves."
        }
    }
}

/// What the model is told when the value itself is refused.
pub fn value_error_message(err: SettingValueError) -> &'static str {
    match err {
        // **Named and worded for the VALUE, not the folder.** These three are
        // reached by `validate_pattern` as well, so a model that sent an empty
        // date format used to be told a folder name was empty, which is the
        // wrong-reason reporting `UnexpectedFolder`'s own doc says it exists to
        // avoid (corrected in the 2026-10-13 review).
        SettingValueError::EmptyValue => {
            "set_setting refused: the value is empty. Give the value you want, \
             or use clear_setting to remove the setting."
        }
        SettingValueError::ValueTooLong => {
            "set_setting refused: the value is too long. Give a shorter one."
        }
        SettingValueError::ValueHasControlChar => {
            "set_setting refused: the value contains a control character. Give a \
             plain value."
        }
        SettingValueError::NotAllowedValue => {
            "set_setting refused: that is not one of the values this setting \
             accepts. Use one of the values listed for it."
        }
        SettingValueError::UnexpectedFolder => {
            "set_setting refused: that setting does not take a folder. Send the \
             value on its own."
        }
        SettingValueError::FolderRequired => {
            "set_setting refused: that value needs a folder alongside it. Send \
             the folder as well, or choose a value that does not need one."
        }
    }
}

/// The longest folder path an intent accepts.
///
/// A bound rather than a guess: the prefs blob has one fixed 64 KiB budget shared
/// by every setting (myne-md/myne#615), and a folder entry costs about 68 to 90
/// bytes including its clock. 1024 is generous for a path a person typed and far
/// below the point at which a single entry could matter.
pub const MAX_FOLDER_PATH_BYTES: usize = 1024;

/// The longest free string a `Pattern` intent accepts.
///
/// A date format is a dozen characters and a template reference is a note path.
/// 256 is generous for both and far below the point where one entry could
/// matter against the 64 KiB prefs blob.
pub const MAX_PATTERN_BYTES: usize = 256;

/// A folder path's own rules, extracted so the two kinds that accept one (a
/// plain `FolderPath` and a `ModeWithFolder`'s folder) cannot drift apart.
fn validate_folder(value: &str) -> Result<(), SettingValueError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(SettingValueError::EmptyValue);
    }
    if trimmed.len() > MAX_FOLDER_PATH_BYTES {
        return Err(SettingValueError::ValueTooLong);
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(SettingValueError::ValueHasControlChar);
    }
    Ok(())
}

/// A free string's rules: non-empty, no control characters, bounded.
fn validate_pattern(value: &str) -> Result<(), SettingValueError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(SettingValueError::EmptyValue);
    }
    if trimmed.len() > MAX_PATTERN_BYTES {
        return Err(SettingValueError::ValueTooLong);
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(SettingValueError::ValueHasControlChar);
    }
    Ok(())
}

/// Validate a value against the intent's own kind.
///
/// **`folder` is the sub-step field** (myne-md/myne#850 task 4): it is the second
/// half of a `ModeWithFolder` setting, and every other kind refuses it rather
/// than ignoring it, because a value the setting has no room for is a request the
/// model made and nobody honoured.
pub fn validate(
    intent: &SettingIntent,
    value: &str,
    folder: Option<&str>,
) -> Result<(), SettingValueError> {
    match intent.kind {
        ValueKind::FolderPath => {
            if folder.is_some() {
                return Err(SettingValueError::UnexpectedFolder);
            }
            validate_folder(value)
        }
        ValueKind::Pattern => {
            if folder.is_some() {
                return Err(SettingValueError::UnexpectedFolder);
            }
            validate_pattern(value)
        }
        ValueKind::OneOf { values } => {
            if folder.is_some() {
                return Err(SettingValueError::UnexpectedFolder);
            }
            if values.contains(&value) {
                Ok(())
            } else {
                Err(SettingValueError::NotAllowedValue)
            }
        }
        ValueKind::ModeWithFolder { modes, folder_mode } => {
            if !modes.contains(&value) {
                return Err(SettingValueError::NotAllowedValue);
            }
            if value == folder_mode {
                match folder {
                    Some(f) => validate_folder(f),
                    None => Err(SettingValueError::FolderRequired),
                }
            } else if folder.is_some() {
                // The panel's own rule, stated once: a folder is passed only
                // when the mode is the one that takes one.
                Err(SettingValueError::UnexpectedFolder)
            } else {
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every intent in the table resolves, and its own field survives the
    /// derivation. This is the both-ways half: the table may not name something the
    /// classification refuses.
    #[test]
    fn every_intent_in_the_table_is_writable_through_the_derivation() {
        for i in INTENTS {
            assert_eq!(
                writable(i.id).map(|r| r.id),
                Ok(i.id),
                "{} is in the table but the derivation refuses its field {}",
                i.id,
                i.target.field()
            );
        }
    }

    /// The egress controls are refused by the table the sync layer already keeps,
    /// with no row here naming them. Injecting a row that named one would have to
    /// fail, which is what the previous test checks from the other side.
    #[test]
    fn the_egress_controls_are_refused_by_derivation() {
        for field in ["ai_excluded_folders", "cli_excluded_folders"] {
            assert_eq!(
                refusal_for_field(field),
                Some(SettingRefusal::EgressControl),
                "{field} is an egress control and must be refused whatever the intent table says"
            );
        }
    }

    /// Every control is refused, and this names the arm that catches it.
    ///
    /// **This is the reclassification alarm.** Each of these fields is currently
    /// device-local, which is what makes the derivation catch it. If one is ever
    /// reclassified as shared, so that it syncs like a preference, the refusal
    /// disappears silently and only this test says so. The arm is asserted rather
    /// than just `is_some`, so the failure names the field and the change.
    #[test]
    fn every_control_is_refused_and_the_arm_that_catches_it_is_named() {
        for field in [
            "screen_capture_protection",
            "auto_lock_seconds",
            "ai_enabled",
            "ai_provider_consent",
            "cli_enabled",
            "cli_rate_limit_disabled",
            "developer_mode",
        ] {
            assert_eq!(
                refusal_for_field(field),
                Some(SettingRefusal::DeviceLocal),
                "{field} is a per-device control: it must be refused, and this test is what notices if its classification changes"
            );
            assert!(
                !INTENTS.iter().any(|i| i.target.field() == field),
                "{field} is a control and must not be in the intent table"
            );
        }
    }

    /// The display family the plan wanted is refused by the same arm, which is a
    /// product consequence rather than a bug, and it is pinned so the v1 list and
    /// this fact cannot drift apart.
    #[test]
    fn the_device_local_display_settings_are_refused_too() {
        for field in ["theme", "editor_text_size", "show_note_timestamps"] {
            assert_eq!(
                refusal_for_field(field),
                Some(SettingRefusal::DeviceLocal),
                "{field} is a per-device presentation choice, so an agent write would not travel; if that changed, the v1 families change with it"
            );
        }
        // And the two format fields the family keeps really are shared, or the
        // family would be empty.
        for field in ["date_format", "time_format"] {
            assert_eq!(refusal_for_field(field), None, "{field} is a shared scalar");
        }
    }

    /// Resolution happens before the derivation, so a setting nobody carries an
    /// intent for is `UnknownIntent` even when the classification would also have
    /// refused its field. That order is deliberate: it keeps the reason true about
    /// the request rather than about the field.
    #[test]
    fn an_unknown_id_is_refused_as_unknown_rather_than_as_a_control() {
        assert_eq!(
            writable("appearance.theme"),
            Err(SettingRefusal::UnknownIntent)
        );
        assert_eq!(
            writable("not.a.setting"),
            Err(SettingRefusal::UnknownIntent)
        );
    }

    #[test]
    fn an_empty_or_whitespace_folder_is_refused() {
        let i = intent("editor.weekly-notes-folder").expect("the tracer bullet intent");
        assert_eq!(validate(i, "", None), Err(SettingValueError::EmptyValue));
        assert_eq!(validate(i, "   ", None), Err(SettingValueError::EmptyValue));
    }

    #[test]
    fn a_folder_carrying_a_control_character_is_refused() {
        let i = intent("editor.weekly-notes-folder").expect("the tracer bullet intent");
        assert_eq!(
            validate(i, "Journals/\u{7}Weekly", None),
            Err(SettingValueError::ValueHasControlChar)
        );
        // A newline is the case a pasted value actually carries.
        assert_eq!(
            validate(i, "Journals/\nWeekly", None),
            Err(SettingValueError::ValueHasControlChar)
        );
    }

    #[test]
    fn an_over_long_folder_is_refused() {
        let i = intent("editor.weekly-notes-folder").expect("the tracer bullet intent");
        let long = "a".repeat(MAX_FOLDER_PATH_BYTES + 1);
        assert_eq!(
            validate(i, &long, None),
            Err(SettingValueError::ValueTooLong)
        );
        let at_the_bound = "a".repeat(MAX_FOLDER_PATH_BYTES);
        assert_eq!(validate(i, &at_the_bound, None), Ok(()));
    }

    /// **The mode that takes a folder must be given one, and the modes that do
    /// not must not** (myne-md/myne#850 task 4). The second half is the panel's
    /// own rule, it passes `folder = None` for every other mode, so a folder
    /// arriving beside `root` is a request nobody would honour.
    #[test]
    fn a_mode_and_folder_setting_takes_exactly_the_folder_its_mode_needs() {
        let i = intent("files.new-note-location").expect("the new-note-location intent");

        for ok in ["root", "current"] {
            assert_eq!(validate(i, ok, None), Ok(()), "{ok} needs no folder");
            assert_eq!(
                validate(i, ok, Some("J/")),
                Err(SettingValueError::UnexpectedFolder),
                "{ok} must not be handed a folder"
            );
        }

        assert_eq!(
            validate(i, "specific", None),
            Err(SettingValueError::FolderRequired),
            "`specific` with no folder is the desync the paired write prevents"
        );
        assert_eq!(validate(i, "specific", Some("J/Weekly")), Ok(()));
        // The folder is held to the folder rules, not to a weaker one.
        assert_eq!(
            validate(i, "specific", Some("   ")),
            Err(SettingValueError::EmptyValue)
        );
        assert_eq!(
            validate(i, "specific", Some("J/\nWeekly")),
            Err(SettingValueError::ValueHasControlChar)
        );

        // Case matters: the setter's vocabulary is lowercase, so a capitalised
        // value is a refusal rather than a normalisation the model can rely on.
        assert_eq!(
            validate(i, "Root", None),
            Err(SettingValueError::NotAllowedValue)
        );
        assert_eq!(
            validate(i, "anywhere", None),
            Err(SettingValueError::NotAllowedValue)
        );
        assert_eq!(
            validate(i, "", None),
            Err(SettingValueError::NotAllowedValue)
        );
    }

    /// A folder sent to a setting that takes one as its VALUE is refused too, so
    /// the sub-step cannot be smuggled into a plain folder setting.
    #[test]
    fn a_plain_folder_setting_refuses_the_sub_step() {
        let i = intent("editor.weekly-notes-folder").expect("the weekly folder intent");
        assert_eq!(
            validate(i, "J/Weekly", Some("Other/")),
            Err(SettingValueError::UnexpectedFolder)
        );
    }

    /// **The folder a change names, and only where it names one**
    /// (myne-md/myne#850 task 4). A folder-path setting names it as the value; a
    /// mode-and-folder setting names it as the sub-step and only for the mode
    /// that takes one. The third assertion is the one that matters: a mode of
    /// `root` must NOT be read as a folder called `root`.
    #[test]
    fn a_folder_is_named_only_where_the_change_names_one() {
        let folder_intent = intent("editor.weekly-notes-folder").unwrap();
        assert_eq!(
            folder_named(folder_intent, Some("J/Weekly"), None),
            Some("J/Weekly")
        );

        let mode_intent = intent("files.new-note-location").unwrap();
        assert_eq!(
            folder_named(mode_intent, Some("specific"), Some("J/Weekly")),
            Some("J/Weekly")
        );
        assert_eq!(folder_named(mode_intent, Some("root"), None), None);
        assert_eq!(
            folder_named(mode_intent, Some("root"), Some("J/Weekly")),
            None,
            "a folder sent for a mode that takes none names nothing"
        );

        // And a setting that names no folder never does, whatever it is handed.
        let pattern_intent = intent("editor.date-format").unwrap();
        assert_eq!(folder_named(pattern_intent, Some("YYYY-MM-DD"), None), None);
    }

    /// **The v1 intent list, compared BOTH WAYS against the one roster both
    /// languages read** (myne-md/myne#850 task 4).
    ///
    /// The comparison has to be cross-language, which is why it is not simply
    /// `INTENTS == INTENTS`: the index that DECIDES a setting's
    /// agent-writability is TypeScript and the table that ENFORCES it is here, so
    /// a Rust test can only compare this table with itself. The roster is the
    /// third thing both read, and a family added on one side alone fails on that
    /// side rather than shipping as a setting the agent is offered and cannot
    /// spell, or one it can spell and is never offered.
    #[test]
    fn the_intent_list_is_the_shared_roster_in_both_directions() {
        let raw = include_str!("../../../../scripts/agent-setting-intents.json");
        let roster: Vec<String> = serde_json::from_str::<serde_json::Value>(raw)
            .expect("the roster parses")
            .get("intents")
            .and_then(|v| v.as_array())
            .expect("the roster carries an `intents` array")
            .iter()
            .map(|v| v.as_str().expect("each entry is a string").to_string())
            .collect();

        let table: std::collections::BTreeSet<&str> = INTENTS.iter().map(|i| i.id).collect();
        let listed: std::collections::BTreeSet<&str> = roster.iter().map(String::as_str).collect();
        let only_table: Vec<&&str> = table.difference(&listed).collect();
        let only_roster: Vec<&&str> = listed.difference(&table).collect();
        assert!(
            only_table.is_empty(),
            "in the intent table but not in the roster: {only_table:?}"
        );
        assert!(
            only_roster.is_empty(),
            "in the roster but not in the intent table: {only_roster:?}"
        );

        // And every listed id is one the derivation actually allows, so a roster
        // entry naming a control is caught here rather than by a settings screen
        // that offers nothing.
        for id in &roster {
            assert!(
                writable(id).is_ok(),
                "{id} is on the roster but the derivation refuses it"
            );
        }
    }

    /// **Both directions of the table's spread**, so a family cannot be added
    /// half-way: every folder-naming intent is a kind that names one, and no
    /// other kind does.
    #[test]
    fn only_the_folder_naming_kinds_name_a_folder() {
        for i in INTENTS {
            let names = matches!(
                i.kind,
                ValueKind::FolderPath | ValueKind::ModeWithFolder { .. }
            );
            assert_eq!(
                names,
                folder_named(i, Some("specific"), Some("F/")).is_some(),
                "{} disagrees between its kind and what it names",
                i.id
            );
        }
    }

    /// **The display formats are a CLOSED vocabulary, and the read side is the
    /// reason** (myne-md/myne#850, from the 2026-10-14 review). `asDateFormat` /
    /// `asTimeFormat` coerce an unknown value to `system`, so under a free
    /// `Pattern` a model could send `"yyyy-MM-dd"`, have it validated and
    /// approved, and change nothing at all.
    #[test]
    fn a_display_format_outside_the_vocabulary_is_refused() {
        let date = intent("editor.date-format").expect("the date intent exists");
        assert!(validate(date, "iso", None).is_ok());
        assert_eq!(
            validate(date, "yyyy-MM-dd", None),
            Err(SettingValueError::NotAllowedValue)
        );
        let time = intent("editor.time-format").expect("the time intent exists");
        assert!(validate(time, "24h", None).is_ok());
        assert_eq!(
            validate(time, "HH:mm", None),
            Err(SettingValueError::NotAllowedValue)
        );
    }

    /// **And the note-title date patterns stay FREE text**, which is why the two
    /// kinds exist rather than one: `daily_date_format` defaults to
    /// `"YYYY-MM-DD"`, a strftime-like pattern the display vocabulary would
    /// refuse. Collapsing the two would break daily notes on the first write.
    #[test]
    fn a_note_title_date_pattern_is_not_the_display_vocabulary() {
        let daily = intent("editor.daily-notes-date-format").expect("the intent exists");
        assert!(validate(daily, "YYYY-MM-DD", None).is_ok());
    }
}
