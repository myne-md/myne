import WidgetKit
import SwiftUI

/// Entry point for the Myne widget extension. The full set is deliberately
/// minimal — three home-screen launchers (open / capture / encrypted), the
/// lock-screen accessories, a StandBy locked glance, and the "New note" Control
/// Center control. By design there is NO note content, count, name, or
/// timestamp anywhere: the widget process runs outside the trust boundary that
/// holds plaintext, so richness here would be a leak.
@main
struct MyneWidgetBundle: WidgetBundle {
    var body: some Widget {
        OpenMyneWidget()
        QuickCaptureWidget()
        EncryptedWidget()
        LockScreenWidget()
        StandByLockedWidget()
        if #available(iOS 18.0, *) {
            NewNoteControl()
        }
    }
}
