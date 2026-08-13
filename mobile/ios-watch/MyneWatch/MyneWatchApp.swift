// SPDX-License-Identifier: AGPL-3.0
import SwiftUI

/// The Myne Apple Watch companion — a single-target watchOS app (Xcode 14+/
/// watchOS 10 single-target model, `WKApplication`). Its ONLY job is voice
/// quick-capture: dictate a note, ship it to the paired iPhone over
/// WatchConnectivity. It holds NO vault key and runs NO crypto (the phone seals
/// + files it into the vault on unlock; `spec/protocol.md` §9.18, main-repo
/// `docs/decisions.md` 2026-07-12).
@main
struct MyneWatchApp: App {
    init() {
        // Activate WCSession as early as possible so a queued transfer flushes
        // when either app next runs.
        _ = WatchConnectivityClient.shared
    }

    var body: some Scene {
        WindowGroup {
            CaptureView()
        }
    }
}
