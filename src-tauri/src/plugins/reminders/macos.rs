// SPDX-License-Identifier: AGPL-3.0
//! The macOS arm of the reminder seam: `UNUserNotificationCenter` through
//! `objc2-user-notifications`, already in `Cargo.lock` as a transitive dependency
//! of tauri/wry, so promoting it to a direct dependency adds no crate.
//!
//! ## Why the platform API rather than a timer
//!
//! A timer in this process dies with the process, and the whole point of the
//! pre-registered tier is a reminder that arrives while Myne is closed. So the
//! registration is handed to the notification centre, which owns delivery from
//! then on.
//!
//! ## The trigger is a CALENDAR trigger, not a time interval
//!
//! `at` is a wall-clock instant with no zone, so it maps onto
//! `UNCalendarNotificationTrigger` components (year, month, day, hour, minute) with
//! `repeats: false`. An interval trigger would need an absolute deadline, which
//! would mean inventing a zone this value deliberately does not carry. The
//! consequence is worth stating: a reminder set for 09:00 fires at 09:00 local
//! wherever the machine is, which is what a wall-clock reminder means and what the
//! mobile plugin's own doc says about the same value.
//!
//! ## Blocking on an async API
//!
//! Every call here is a completion-handler API. Each one is turned into a channel
//! receive with a timeout. `UNUserNotificationCenter` is documented as safe to use
//! from any thread, so no main-thread hop is made: a hop would add a queue this
//! module cannot test and a deadlock when the caller is already on the main thread.
//!
//! A timeout is reported as `TimedOut` rather than as success or failure, because
//! the registration may well exist: the caller re-reads the pending set instead of
//! guessing.

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2_foundation::{NSArray, NSDateComponents, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNCalendarNotificationTrigger,
    UNMutableNotificationContent, UNNotificationRequest, UNUserNotificationCenter,
};

use super::{PendingReminder, ReminderError, WallClock, NOTIFICATION_BODY, NOTIFICATION_TITLE};

/// How long one platform round-trip may take before it is reported as a timeout.
///
/// Short on purpose: this runs from an unlock hook and a periodic tick, and a
/// blocked pass is a pass that cannot reconcile. Five seconds is long enough for
/// the notification centre to answer on a busy machine and short enough that a
/// wedged daemon does not hold the caller.
const CALL_TIMEOUT: Duration = Duration::from_secs(5);

/// Wait for the completion handler's answer, or report the timeout.
fn await_answer<T>(receiver: mpsc::Receiver<T>) -> Result<T, ReminderError> {
    receiver
        .recv_timeout(CALL_TIMEOUT)
        .map_err(|_| ReminderError::TimedOut)
}

/// Register one reminder at one wall-clock instant.
pub fn schedule(id: &str, clock: WallClock) -> Result<(), ReminderError> {
    let identifier = NSString::from_str(id);
    let title = NSString::from_str(NOTIFICATION_TITLE);
    let body = NSString::from_str(NOTIFICATION_BODY);

    let content = UNMutableNotificationContent::new();
    content.setTitle(&title);
    content.setBody(&body);

    let components = NSDateComponents::new();
    components.setYear(clock.year as isize);
    components.setMonth(clock.month as isize);
    components.setDay(clock.day as isize);
    components.setHour(clock.hour as isize);
    components.setMinute(clock.minute as isize);

    let trigger = UNCalendarNotificationTrigger::triggerWithDateMatchingComponents_repeats(
        &components,
        false,
    );
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &identifier,
        &content,
        Some(&trigger),
    );

    let (sender, receiver) = mpsc::channel();
    let handler = RcBlock::new(move |error: *mut NSError| {
        let answer = if error.is_null() {
            Ok(())
        } else {
            Err(ReminderError::Refused {
                reason: "add_failed".to_string(),
            })
        };
        let _ = sender.send(answer);
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&handler));
    await_answer(receiver)?
}

/// Withdraw one registration.
pub fn cancel(id: &str) -> Result<(), ReminderError> {
    let identifier = NSString::from_str(id);
    let identifiers = NSArray::from_retained_slice(&[identifier]);
    UNUserNotificationCenter::currentNotificationCenter()
        .removePendingNotificationRequestsWithIdentifiers(&identifiers);
    // Removal has no completion handler: the platform answers by making the next
    // pending read disagree, which is what the reconciliation diff reads. So this
    // is a claim about the CALL and not about the store, and the store's answer
    // arrives on the caller's next pass by construction.
    Ok(())
}

/// What the platform reports as still registered.
pub fn list_pending() -> Result<Vec<PendingReminder>, ReminderError> {
    let (sender, receiver) = mpsc::channel();
    let handler = RcBlock::new(
        move |requests: std::ptr::NonNull<NSArray<UNNotificationRequest>>| {
            // The platform hands a non-null pointer with the array's lifetime; the
            // dereference is the one genuinely unsafe step in this file.
            let array = unsafe { requests.as_ref() };
            let mut out = Vec::with_capacity(array.len());
            for request in array.iter() {
                out.push(PendingReminder {
                    id: request.identifier().to_string(),
                    // The instant is deliberately not read back: the platform holds
                    // it as calendar components in the user's own calendar, and the
                    // diff compares ids. Echoing a value this side did not verify
                    // would be a claim about when the reminder fires.
                    at: String::new(),
                });
            }
            let _ = sender.send(Ok(out));
        },
    );
    UNUserNotificationCenter::currentNotificationCenter()
        .getPendingNotificationRequestsWithCompletionHandler(&handler);
    await_answer(receiver)?
}

/// What the platform currently allows.
///
/// Read through the settings object's `authorizationStatus`, which is what the
/// WebView's four-state string is derived from on mobile too, so the two clients
/// answer the same question the same way.
pub fn permission_status() -> Result<String, ReminderError> {
    let (sender, receiver) = mpsc::channel();
    let handler = RcBlock::new(
        move |settings: std::ptr::NonNull<objc2_user_notifications::UNNotificationSettings>| {
            let status = unsafe { settings.as_ref().authorizationStatus() };
            // The crate exposes the status as a newtype over NSInteger with the five
            // constants named, so the match is against those rather than integers: a
            // literal 2 would be a second copy of a value Apple owns.
            let label = match status {
                UNAuthorizationStatus::NotDetermined => "not_determined",
                UNAuthorizationStatus::Denied => "denied",
                UNAuthorizationStatus::Authorized => "authorized",
                UNAuthorizationStatus::Provisional => "provisional",
                UNAuthorizationStatus::Ephemeral => "ephemeral",
                _ => "unknown",
            };
            let _ = sender.send(Ok(label.to_string()));
        },
    );
    UNUserNotificationCenter::currentNotificationCenter()
        .getNotificationSettingsWithCompletionHandler(&handler);
    await_answer(receiver)?
}

/// Ask the platform for permission, once.
pub fn request_permission() -> Result<String, ReminderError> {
    let (sender, receiver) = mpsc::channel();
    // `Bool` rather than Rust `bool`: the generated signature takes the C type,
    // and the two are distinct in this binding.
    let handler = RcBlock::new(move |granted: objc2::runtime::Bool, _error: *mut NSError| {
        let _ = sender.send(Ok(if granted.as_bool() {
            "authorized"
        } else {
            "denied"
        }
        .to_string()));
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &handler,
        );
    await_answer(receiver)?
}
