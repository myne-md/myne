import WidgetKit
import SwiftUI
import AppIntents

/// Control Center control + Action Button binding (iOS 18+): a single "New note"
/// button bound to `NewNoteIntent`. No vault content — just the capture action.
@available(iOS 18.0, *)
struct NewNoteControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "md.myne.control.newnote") {
            ControlWidgetButton(action: NewNoteIntent()) {
                Label("New note", systemImage: "plus")
            }
        }
        .displayName("Myne: New note")
        .description("Capture a quick note. It is encrypted the moment you save.")
    }
}
