import AppIntents
import Foundation

/// The "New note" action behind the Control Center control + Action Button.
/// Opens the app on the `myne://capture` deep link, which the app resolves into
/// a new note after unlock (src/lib/deep-link.ts). On a locked device the system
/// defers the open until the user unlocks — nothing is exposed before then.
///
/// iOS 18+: `OpenURLIntent` (the deep-link open) and the Control Center control
/// that invokes this intent are both iOS 18 APIs, so the whole intent is gated
/// there — its only caller is `NewNoteControl`, itself `@available(iOS 18, *)`.
@available(iOS 18.0, *)
struct NewNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "New note"
    static var description = IntentDescription("Open Myne to capture a quick note.")
    // The system opens the app to service the URL; no separate `openAppWhenRun`.

    func perform() async throws -> some IntentResult & OpensIntent {
        return .result(opensIntent: OpenURLIntent(URL(string: "myne://capture")!))
    }
}
