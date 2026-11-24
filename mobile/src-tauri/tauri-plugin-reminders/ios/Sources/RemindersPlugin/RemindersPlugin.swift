// SPDX-License-Identifier: AGPL-3.0
//
// ⚠️ DEVICE-VERIFY-PENDING — this Swift cannot be compiled in the mobile repo
// (no Xcode project is generated here; `src-tauri/gen/` holds only `schemas`).
// It is committed source at the `tauri-plugin-qr-scan` bar and is verified on a
// real device via `dev-notes/device-matrix.md`, NOT in the change that adds it.
//
// iOS half of the task-reminder scheduler (MYND-619, task 2).
//
// This is the SAME `UNUserNotificationCenter` API the macOS desktop adapter
// uses, which is why adding mobile after the desktop is a continuation rather
// than a new undertaking. One registration per reminder, at one instant.
//
// ── What may never appear in this file ──────────────────────────────────────
//
// * **Task text, a note identifier, or anything derived from either.** A
//   registration is written into the platform's own persistence and can surface
//   on a locked screen (`threat-model.md` §7). The body is the fixed
//   `contentFreeBody` and `userInfo` is EMPTY — the tap path (task 7) reads the
//   request's own identifier, so there is nothing to put there.
// * **A push service, a push token, or background refresh.** No
//   `registerForRemoteNotifications`, no `BGTaskScheduler`, no background mode
//   in `Info.ios.plist`. `UNCalendarNotificationTrigger` runs no code of ours:
//   the OS holds an inert payload and later draws a notification.
// * **A repeating trigger.** iOS can register one notification that fires
//   forever, which would remove the horizon problem entirely — and is rejected:
//   it fires whether or not the task was completed, it writes the recurrence
//   RULE into the OS store rather than one instant (a much larger and
//   longer-lived exposure), and the Android equivalent behaves differently,
//   which would split one model into two.
// * **A badge.** `.badge` is deliberately absent from the authorization
//   options: a badge count is the pending-reminder COUNT, published on the home
//   screen — the exact datum removed from the notification body.
//
// ── Boot restore (task 4) is deliberately empty on this side ────────────────
//
// iOS preserves pending `UNNotificationRequest`s across a restart, and across an
// app update, so there is nothing to re-register — and nothing here that could
// be got wrong. The Android half needs a whole boot receiver and a persisted
// record precisely because that platform throws its alarms away.
//
// This asymmetry is also why `listPending` is safe here and needs care there:
// on iOS it asks the operating system what it is actually holding, so if a
// registration ever vanished the next reconciliation pass would see it gone and
// put it back. On Android it is answered from a record Myne keeps, which
// survives a reboot even though the alarms do not — see `ReminderAlarms`.
//
// ── Two behaviours that look like omissions and are not ─────────────────────
//
// * **No `UNUserNotificationCenterDelegate` is set**, so iOS keeps its default of
//   suppressing a notification while the app is in the foreground. That default
//   is the one to keep: the in-app layer (N1) is the intended foreground
//   surface — it is not built yet, `useReminderScheduler` currently only runs
//   the reconciliation pass — and once it is, an OS banner drawn at the same
//   instant would be a second notification for the same reminder. Task 7 adds a
//   delegate for the tap path and must not change this by accident: implementing
//   `willPresent` at all is what opts INTO foreground presentation.
// * **Ownership is tagged, and both `listPending` and `cancelAll` filter by it.**
//   That is load-bearing, not tidiness: the reconciliation pass cancels anything
//   `listPending` reports that its target set does not contain, so an unfiltered
//   listing would make this plugin delete another subsystem's notifications, and
//   an unfiltered cancel-all would do it wholesale.

import Foundation
import Tauri
import UserNotifications

/// `schedule` argument. `at` is a LOCAL wall-clock instant, `YYYY-MM-DDTHH:MM` —
/// no offset, no zone.
class ScheduleArgs: Decodable {
  let id: String
  let at: String
}

/// `cancel` argument — the opaque registration identifier, nothing else.
class CancelArgs: Decodable {
  let id: String
}

/// `setTapHandler` argument — the Rust-side delivery channel for taps.
class SetTapHandlerArgs: Decodable {
  let handler: Channel
}

class RemindersPlugin: Plugin, UNUserNotificationCenterDelegate {
  /// The notification body, fixed and content-free.
  ///
  /// It carries no count, deliberately: every registration is exactly one
  /// reminder, so a count would always read `1` — zero information, sitting in
  /// the OS store for free. There is no code path that concatenates anything
  /// onto this string.
  static let contentFreeBody = "Myne — reminder"

  /// Marks a registration as ours. See the header: the reconciliation pass
  /// cancels whatever `listPending` reports and its target set does not contain,
  /// so listing someone else's notification would delete it.
  static let ownershipTag = "md.myne.reminder"

  private var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }

  /// Delivery channel for reminder taps, handed in by the Rust backend at setup.
  /// Null until then; a tap that lands before it is wired is dropped, which is
  /// the designed behaviour — the alternative to dropping is a queue, and a
  /// queue is a file.
  private var tapChannel: Channel?

  // MARK: - Tap delivery (task 7)
  //
  // Setting a delegate is what makes `didReceive` arrive at all. It is ALSO what
  // would opt this app into foreground presentation — but only by implementing
  // `willPresent`, which is deliberately absent below. iOS keeps suppressing a
  // notification while the app is in the foreground, which is what the design
  // wants: the in-app layer is the foreground surface, and an OS banner at the
  // same instant would be a second notification for one reminder.

  /// Internal-only: NOT in `build.rs`, so it is unreachable from the WebView.
  @objc public func setTapHandler(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetTapHandlerArgs.self)
    tapChannel = args.handler
    center.delegate = self
    invoke.resolve()
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    // The request identifier IS the opaque registration identifier — which is
    // why `userInfo` is empty: there was never anything else to carry.
    let id = response.notification.request.identifier
    if !id.isEmpty {
      // The `JsonObject` overload, not the generic `Encodable` one: that
      // overload throws, and there is nothing useful to do with a failure here
      // — a tap that cannot be delivered is dropped, which is the designed
      // behaviour. Naming the type keeps that a compile-time fact instead of a
      // `try?` that hides a real error later.
      let payload: JsonObject = ["id": id]
      tapChannel?.send(payload)
    }
    completionHandler()
  }

  // MARK: - Scheduling

  @objc public func schedule(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ScheduleArgs.self)

    guard !args.id.isEmpty else {
      invoke.reject("reminder id is empty")
      return
    }
    // Refused rather than coerced. A parse that "recovered" from a malformed
    // instant would register a reminder at an hour nobody asked for, and a
    // reminder that arrives at the wrong time is not trusted again.
    guard let components = RemindersPlugin.localComponents(from: args.at) else {
      invoke.reject("reminder instant is not local YYYY-MM-DDTHH:MM: \(args.at)")
      return
    }

    let content = UNMutableNotificationContent()
    content.body = RemindersPlugin.contentFreeBody
    content.categoryIdentifier = RemindersPlugin.ownershipTag
    // Group under one thread so twenty reminders do not become twenty separate
    // stacks — and so the grouping key is a constant rather than anything
    // derived from the task.
    content.threadIdentifier = RemindersPlugin.ownershipTag
    content.sound = .default
    // Left empty on purpose: the tap path reads `request.identifier`, so there
    // is nothing this needs to carry, and anything put here would be persisted
    // by the OS outside the encrypted envelope.
    content.userInfo = [:]

    // `repeats: false` — see the header. One instant, never a rule.
    let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
    let request = UNNotificationRequest(
      identifier: args.id, content: content, trigger: trigger)

    // `add` REPLACES a pending request with the same identifier, which is what
    // makes a re-run of the same reconciliation pass a no-op rather than a
    // duplicate.
    center.add(request) { error in
      if let error = error {
        invoke.reject("schedule failed: \(error.localizedDescription)")
      } else {
        invoke.resolve()
      }
    }
  }

  @objc public func cancel(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CancelArgs.self)
    // Cancelling something the OS is not holding is a no-op, never an error:
    // the reconciliation pass cancels first and has to survive a set that
    // drifted underneath it.
    center.removePendingNotificationRequests(withIdentifiers: [args.id])
    invoke.resolve()
  }

  @objc public func cancelAll(_ invoke: Invoke) throws {
    // NOT `removeAllPendingNotificationRequests()`: that would also drop
    // notifications a future subsystem registered. Only ours are enumerated and
    // removed.
    center.getPendingNotificationRequests { requests in
      let ids = requests
        .filter { $0.content.categoryIdentifier == RemindersPlugin.ownershipTag }
        .map { $0.identifier }
      if !ids.isEmpty {
        UNUserNotificationCenter.current().removePendingNotificationRequests(
          withIdentifiers: ids)
      }
      invoke.resolve()
    }
  }

  @objc public func listPending(_ invoke: Invoke) throws {
    center.getPendingNotificationRequests { requests in
      var pending: [[String: String]] = []
      for request in requests {
        guard request.content.categoryIdentifier == RemindersPlugin.ownershipTag,
          let trigger = request.trigger as? UNCalendarNotificationTrigger,
          // The instant must round-trip EXACTLY to the string that was
          // scheduled: the reconciliation diff compares these as text, so a
          // formatting difference would read as "the time changed" and produce
          // a cancel-and-reschedule on every single pass, forever.
          let at = RemindersPlugin.instant(from: trigger.dateComponents)
        else { continue }
        pending.append(["id": request.identifier, "at": at])
      }
      invoke.resolve(["pending": pending])
    }
  }

  // MARK: - Permission
  //
  // The *when* is not decided here — `requestReminderPermission` above the seam
  // owns it (first reminder, after an in-app explanation, marked before the ask,
  // never automatically repeated, because the OS grants one prompt).

  @objc public func permissionStatus(_ invoke: Invoke) throws {
    center.getNotificationSettings { settings in
      invoke.resolve(["status": RemindersPlugin.map(settings.authorizationStatus)])
    }
  }

  @objc public func requestPermission(_ invoke: Invoke) throws {
    // `.alert` + `.sound` only. `.badge` is refused (it would publish the
    // pending-reminder count on the home screen); `.provisional` is refused
    // (quiet delivery to Notification Center defeats "the phone behaves like
    // every other reminder on it"); `.criticalAlert` is not ours to ask for.
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
      if error != nil {
        // Reported as a status rather than a rejection: the caller treats an
        // error and an unavailable platform identically, and a false "granted"
        // is the only outcome that would actually mislead.
        invoke.resolve(["status": "unavailable"])
        return
      }
      invoke.resolve(["status": granted ? "granted" : "denied"])
    }
  }

  private static func map(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .authorized, .provisional, .ephemeral:
      return "granted"
    case .denied:
      return "denied"
    case .notDetermined:
      return "not-determined"
    @unknown default:
      // A status this build does not know is NOT assumed to be permissive.
      return "unavailable"
    }
  }

  // MARK: - Local wall-clock conversion
  //
  // Hand-parsed rather than `DateFormatter`-parsed, and the reason is the whole
  // point of the format: a formatter carries a locale and a calendar, and a
  // non-Gregorian device calendar or a locale with its own digits would silently
  // produce a different instant. `DateComponents` with no `timeZone` set is read
  // in the device's current calendar and zone, which is exactly what "09:00
  // means 09:00 wherever the user is" asks for.

  static func localComponents(from instant: String) -> DateComponents? {
    let halves = instant.split(separator: "T", omittingEmptySubsequences: false)
    guard halves.count == 2 else { return nil }
    let date = halves[0].split(separator: "-", omittingEmptySubsequences: false)
    let time = halves[1].split(separator: ":", omittingEmptySubsequences: false)
    guard date.count == 3, time.count == 2,
      // Widths AND digits are both checked: `Int("-1")` is a valid two-character
      // parse that would yield hour -1 and a trigger that never fires.
      let year = digits(date[0], width: 4), let month = digits(date[1], width: 2),
      let day = digits(date[2], width: 2), let hour = digits(time[0], width: 2),
      let minute = digits(time[1], width: 2),
      (1...12).contains(month), (1...31).contains(day),
      (0...23).contains(hour), (0...59).contains(minute)
    else { return nil }

    var components = DateComponents()
    components.year = year
    components.month = month
    components.day = day
    components.hour = hour
    components.minute = minute
    return components
  }

  /// Exactly `width` ASCII digits, as an integer. Nothing else — no sign, no
  /// whitespace, no non-ASCII numeral.
  private static func digits(_ text: Substring, width: Int) -> Int? {
    guard text.count == width, text.allSatisfy({ $0.isASCII && $0.isNumber }) else {
      return nil
    }
    return Int(text)
  }

  static func instant(from components: DateComponents) -> String? {
    guard let year = components.year, let month = components.month,
      let day = components.day, let hour = components.hour,
      let minute = components.minute
    else { return nil }
    return String(format: "%04d-%02d-%02dT%02d:%02d", year, month, day, hour, minute)
  }
}

@_cdecl("init_plugin_reminders")
func initPlugin() -> Plugin {
  return RemindersPlugin()
}
