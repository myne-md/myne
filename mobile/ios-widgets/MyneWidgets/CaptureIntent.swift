import AppIntents

/// The "New note" action behind the Control Center control + Action Button.
/// UI-only: it opens the app to the quick-capture surface (WG-04). On a locked
/// device the system defers the open until the user unlocks — the capture sheet
/// is the AppIntent's destination, wired app-side in a later phase.
struct NewNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "New note"
    static var description = IntentDescription("Open Myne to capture a quick note.")
    static var openAppWhenRun: Bool = true

    func perform() async throws -> some IntentResult {
        // No logic yet — the app handles the `myne://capture` route on launch.
        return .result()
    }
}
