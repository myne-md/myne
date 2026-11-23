// SPDX-License-Identifier: AGPL-3.0
//! The desktop reminder delivery seam: three commands, one per method of the
//! `ReminderNotifier` interface the scheduling core already speaks
//! (myne-md/myne#1076, task 23 of the 0.19 block).
//!
//! ## What this is, and what it deliberately is not
//!
//! It is a TRANSPORT. The decision about which reminders should be registered is
//! the pure TypeScript core (`runReminderPass` / `targetReminders` /
//! `diffReminders`), exactly as it is on mobile; this module hands the operating
//! system what that core computed and reports back what the OS says it holds.
//! Keeping the policy above the seam is what lets one model cover four platforms,
//! and it is why nothing here sorts, diffs or decides.
//!
//! ## What crosses the boundary
//!
//! `{ id, at }` and nothing else. Everything placed here is written into the
//! platform's own persistence, which is plaintext storage outside the AEAD
//! envelope (`threat-model.md` §7), so **no note identifier, no task text and no
//! title crosses this seam**. The notification's title and body are constants
//! owned by the native side (`NOTIFICATION_TITLE` / `NOTIFICATION_BODY`), which is
//! the strongest available reading of that posture: task text cannot reach the OS
//! store through this plugin at all, and an opt-in that changes that has to be an
//! explicit, reviewable change in this file.
//!
//! `at` is a LOCAL WALL-CLOCK instant, `YYYY-MM-DDTHH:MM`, passed through
//! verbatim into the platform's calendar components: no UTC offset and no IANA
//! zone identifier is stored, so the reminder a user set for 09:00 fires at 09:00
//! after a flight, which is what a wall-clock reminder means.
//!
//! ## The tiers, and why this one starts switched off
//!
//! `src/lib/reminderPlatform.ts` names the two tiers this seam can serve, and the
//! pre-registered one stays FALSE until the delivery measurement
//! (`features/019-work-block`, task 24) establishes that the platform delivers
//! while Myne is closed. An adapter that reports capability it has not measured is
//! the failure that measurement exists to prevent, so this module can register a
//! notification and the app still does not claim it will arrive.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline" — nothing here
//! logs a reminder id, an instant or a payload.

use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
mod macos;

/// One registration, exactly as the WebView sends it.
///
/// Field-for-field the same shape as the mobile plugin's `ReminderPayload` and the
/// TypeScript `ReminderPayload`, because the reconciliation diff compares the two
/// sides of it: a field added on one side and not the other is a diff that never
/// converges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReminderPayload {
    /// Opaque identity: `myne.reminder.<note id>.<line index>`. Never a title.
    pub id: String,
    /// Local wall-clock instant, `YYYY-MM-DDTHH:MM`.
    pub at: String,
}

/// What the OS reports as still registered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingReminder {
    pub id: String,
    /// Echoed back when the platform gives it, otherwise the instant this side
    /// registered. The diff only reads `id`, so an absent echo costs nothing.
    pub at: String,
}

/// Why a registration did not happen.
///
/// Closed and small on purpose: the WebView turns each variant into a count of
/// failed operations, and the scheduler's contract is that a failure is VISIBLE
/// rather than swallowed. A generic string would be a message nobody can branch
/// on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReminderError {
    /// This platform has no implementation. The desktop client ships on macOS,
    /// Windows and Linux, and only the first has an arm today.
    ///
    /// Constructed only on the platforms without an arm, and it stays in the enum
    /// there: the variant is part of the CLOSED wire set the WebView switches on, so
    /// a build that cannot produce it must still be able to receive it.
    #[allow(dead_code)]
    Unsupported { platform: String },
    /// The instant is not `YYYY-MM-DDTHH:MM`. Refused rather than coerced: a
    /// silently corrected instant fires at a moment the user did not choose.
    InvalidInstant { at: String },
    /// The platform refused the request, with its own words stripped to a code.
    ///
    /// Constructed by the macOS arm alone today, and it stays in the enum on the
    /// other targets for the same reason `Unsupported` does: the variant is part of
    /// the CLOSED wire set the WebView switches on.
    #[allow(dead_code)]
    Refused { reason: String },
    /// The platform did not answer in time. Distinct from `Refused` because the
    /// registration may exist: the caller re-reads the pending set rather than
    /// assuming either outcome.
    ///
    /// macOS-only constructor today, kept here on every target for the reason above.
    #[allow(dead_code)]
    TimedOut,
}

/// The notification's title, owned here rather than sent from the WebView.
///
/// Read by the macOS arm, which is the only arm that draws a notification today.
#[allow(dead_code)]
pub const NOTIFICATION_TITLE: &str = "Myne";
/// The notification's body. Content-free by construction: it names no task.
#[allow(dead_code)]
pub const NOTIFICATION_BODY: &str = "A reminder is due.";

/// A `YYYY-MM-DDTHH:MM` instant, split into the components a calendar trigger
/// takes.
///
/// Hand-parsed rather than pulled through a date library, and that is the
/// dependency-policy answer as well as the privacy one: the string's shape is
/// fixed by the writer (`src/lib/reminderSchedule.ts`), the platform wants exactly
/// these five integers, and a timezone-aware parser would be a second opinion
/// about a value that is deliberately zone-less.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WallClock {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
}

impl WallClock {
    /// Parse `YYYY-MM-DDTHH:MM`, or `None` when the shape is wrong.
    ///
    /// Range checks are deliberately shallow (month 1..=12, day 1..=31, hour
    /// 0..=23, minute 0..=59): a day the month does not have is the platform's to
    /// refuse, and guessing here would be this side inventing a calendar.
    pub fn parse(at: &str) -> Option<Self> {
        let bytes = at.as_bytes();
        if bytes.len() != 16 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
            return None;
        }
        if bytes[13] != b':' {
            return None;
        }
        let number = |from: usize, to: usize| -> Option<i64> {
            let slice = at.get(from..to)?;
            if !slice.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            slice.parse().ok()
        };
        let parsed = Self {
            year: number(0, 4)?,
            month: number(5, 7)?,
            day: number(8, 10)?,
            hour: number(11, 13)?,
            minute: number(14, 16)?,
        };
        if !(1..=12).contains(&parsed.month)
            || !(1..=31).contains(&parsed.day)
            || parsed.hour > 23
            || parsed.minute > 59
        {
            return None;
        }
        Some(parsed)
    }
}

/// Register one reminder with the platform.
pub fn schedule(payload: ReminderPayload) -> Result<(), ReminderError> {
    let clock = WallClock::parse(&payload.at).ok_or_else(|| ReminderError::InvalidInstant {
        at: payload.at.clone(),
    })?;
    platform_schedule(&payload.id, clock)
}

/// Withdraw one registration.
pub fn cancel(id: String) -> Result<(), ReminderError> {
    platform_cancel(&id)
}

/// What the platform reports as still registered.
pub fn list_pending() -> Result<Vec<PendingReminder>, ReminderError> {
    platform_list_pending()
}

#[cfg(target_os = "macos")]
fn platform_schedule(id: &str, clock: WallClock) -> Result<(), ReminderError> {
    macos::schedule(id, clock)
}

#[cfg(target_os = "macos")]
fn platform_cancel(id: &str) -> Result<(), ReminderError> {
    macos::cancel(id)
}

#[cfg(target_os = "macos")]
fn platform_list_pending() -> Result<Vec<PendingReminder>, ReminderError> {
    macos::list_pending()
}

#[cfg(not(target_os = "macos"))]
fn platform_schedule(_id: &str, _clock: WallClock) -> Result<(), ReminderError> {
    Err(unsupported())
}

#[cfg(not(target_os = "macos"))]
fn platform_cancel(_id: &str) -> Result<(), ReminderError> {
    Err(unsupported())
}

#[cfg(not(target_os = "macos"))]
fn platform_list_pending() -> Result<Vec<PendingReminder>, ReminderError> {
    Err(unsupported())
}

#[cfg(not(target_os = "macos"))]
fn unsupported() -> ReminderError {
    ReminderError::Unsupported {
        platform: std::env::consts::OS.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_instant_parses_into_the_five_components_the_platform_takes() {
        let clock = WallClock::parse("2026-11-22T09:05").expect("a canonical instant");
        assert_eq!(
            clock,
            WallClock {
                year: 2026,
                month: 11,
                day: 22,
                hour: 9,
                minute: 5
            }
        );
    }

    #[test]
    fn a_malformed_instant_is_refused_rather_than_coerced() {
        // Each of these would parse under a lenient reader and fire at a moment
        // nobody chose: a missing zero, a wrong separator, a UTC marker that would
        // turn a wall-clock reminder into an absolute one.
        for at in [
            "2026-11-22 09:05",
            "2026-11-22T9:05",
            "2026-11-22T09:05Z",
            "2026-11-22T09:05:00",
            "2026-11-22",
            "",
        ] {
            assert!(
                WallClock::parse(at).is_none(),
                "{at} parsed and should not have"
            );
        }
        assert_eq!(
            schedule(ReminderPayload {
                id: "r".into(),
                at: "tomorrow".into()
            }),
            Err(ReminderError::InvalidInstant {
                at: "tomorrow".into()
            })
        );
    }

    #[test]
    fn an_out_of_range_component_is_refused() {
        assert!(WallClock::parse("2026-13-22T09:05").is_none());
        assert!(WallClock::parse("2026-11-32T09:05").is_none());
        assert!(WallClock::parse("2026-11-22T24:05").is_none());
        assert!(WallClock::parse("2026-11-22T09:60").is_none());
    }

    #[test]
    fn a_registration_carries_nothing_but_an_id_and_an_instant() {
        // The threat-model posture made a shape: the payload has two fields, and a
        // third would be a third thing written into the platform's plaintext store.
        let payload = ReminderPayload {
            id: "myne.reminder.abc.0".into(),
            at: "2026-11-22T09:00".into(),
        };
        let value = serde_json::to_value(&payload).expect("serializes");
        let object = value.as_object().expect("an object");
        // A map's key order is the serializer's, so the assertion is a SET: two
        // fields, these two, and nothing else.
        let mut keys: Vec<&String> = object.keys().collect();
        keys.sort();
        assert_eq!(keys, vec!["at", "id"], "a registration grew a field");
        // And the words on screen are ours, not the caller's: both constants are
        // fixed literals with no interpolation, which is what makes "task text
        // cannot reach the OS store through this seam" true by construction.
        assert_eq!(NOTIFICATION_TITLE, "Myne");
        assert_eq!(NOTIFICATION_BODY, "A reminder is due.");
        assert!(
            !NOTIFICATION_BODY.contains('{'),
            "the body interpolates something"
        );
    }

    #[test]
    fn every_refusal_crosses_the_wire_with_a_closed_kind() {
        // The label the WebView switches on is the serde tag, so this asserts the
        // WIRE shape rather than a helper that could drift from it.
        let cases = [
            (
                ReminderError::Unsupported {
                    platform: "linux".into(),
                },
                "unsupported",
            ),
            (
                ReminderError::InvalidInstant {
                    at: "tomorrow".into(),
                },
                "invalid_instant",
            ),
            (
                ReminderError::Refused {
                    reason: "add_failed".into(),
                },
                "refused",
            ),
            (ReminderError::TimedOut, "timed_out"),
        ];
        for (error, kind) in cases {
            let value = serde_json::to_value(&error).expect("serializes");
            assert_eq!(value["kind"], kind);
        }
    }
}

// ── the Tauri surface ───────────────────────────────────────────────────────

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// The three `ReminderNotifier` methods plus the two permission calls mobile has,
/// because a desktop client that cannot say "I am not allowed to notify" would
/// report every registration as a failure with no cause.
///
/// Every command is a thin wrapper: the platform arm is where the work is, and a
/// command that decided anything would be a second place the policy lives.
mod commands {
    use super::{
        cancel, list_pending, permission_status, request_permission, schedule, ReminderError,
        ReminderPayload,
    };

    #[tauri::command]
    pub async fn reminders_schedule(reminder: ReminderPayload) -> Result<(), ReminderError> {
        schedule(reminder)
    }

    #[tauri::command]
    pub async fn reminders_cancel(id: String) -> Result<(), ReminderError> {
        cancel(id)
    }

    #[tauri::command]
    pub async fn reminders_list_pending() -> Result<Vec<super::PendingReminder>, ReminderError> {
        list_pending()
    }

    #[tauri::command]
    pub async fn reminders_permission_status() -> Result<String, ReminderError> {
        permission_status()
    }

    #[tauri::command]
    pub async fn reminders_request_permission() -> Result<String, ReminderError> {
        request_permission()
    }
}

/// Construct the `reminders` plugin. Holds no state: the platform store IS the
/// state, and a cache here would be a second answer to "what is registered".
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("reminders")
        .invoke_handler(tauri::generate_handler![
            commands::reminders_schedule,
            commands::reminders_cancel,
            commands::reminders_list_pending,
            commands::reminders_permission_status,
            commands::reminders_request_permission,
        ])
        .build()
}

/// What the platform currently allows, as the WebView's four-state string.
pub fn permission_status() -> Result<String, ReminderError> {
    #[cfg(target_os = "macos")]
    {
        macos::permission_status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(unsupported())
    }
}

/// Ask the platform for permission, once.
pub fn request_permission() -> Result<String, ReminderError> {
    #[cfg(target_os = "macos")]
    {
        macos::request_permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(unsupported())
    }
}
