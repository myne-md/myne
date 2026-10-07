// SPDX-License-Identifier: AGPL-3.0
import SwiftUI

/// The Myne Apple Watch companion — a single-target watchOS app (Xcode 14+/
/// watchOS 10 single-target model, `WKApplication`). It has two jobs, both
/// voice→phone: **quick-capture** (dictate a note, ship it) and **meeting
/// recording** (hold the mic open, chunk the audio, ship it — myne-md/myne#812).
/// Either way it holds NO vault key and runs NO crypto (the phone seals + files it
/// into the vault on unlock; `spec/protocol.md` §9.18, main-repo
/// `docs/decisions.md` 2026-07-12).
@main
struct MyneWatchApp: App {
    /// Which of the two surfaces the TabView is showing. Selected by a
    /// `myne-watch://meeting` deep link (the complication's meeting entry point),
    /// otherwise left on capture.
    enum Surface: Hashable {
        case capture
        case meeting
    }

    @State private var surface: Surface = .capture

    init() {
        // Activate WCSession as early as possible so a queued transfer flushes
        // when either app next runs.
        _ = WatchConnectivityClient.shared
    }

    var body: some Scene {
        WindowGroup {
            // Two sibling surfaces. The TabView keeps `CaptureView` reachable and
            // byte-for-byte unchanged in behaviour — its one-tap dictation flow is
            // still the first page. Vertical paging is the watch idiom.
            TabView(selection: $surface) {
                CaptureView()
                    .tag(Surface.capture)
                MeetingView()
                    .tag(Surface.meeting)
            }
            .tabViewStyle(.verticalPage)
            // The complication can carry a `myne-watch://meeting` URL to open
            // straight onto the recorder; a plain launch stays on capture.
            .onOpenURL { url in
                if url.scheme == "myne-watch", url.host == "meeting" {
                    surface = .meeting
                }
            }
        }
    }
}
