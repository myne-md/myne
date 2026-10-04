// SPDX-License-Identifier: AGPL-3.0
import SwiftUI
import WidgetKit

/// watchOS WidgetKit complication for Myne. Tapping any accessory family
/// launches the watch app (a complication launches its containing app by
/// default), landing the user on the dictation surface — the fastest path to a
/// voice quick-capture from the watch face. Purely a launcher: it carries NO
/// vault content (the watch is outside the plaintext trust boundary, §9.18).
///
/// The rectangular family ALSO carries a `myne-watch://meeting` link so the
/// meeting recorder has its own entry point from the watch face (myne-md/myne#812);
/// the capture launcher is untouched, so the dictation path stays one tap.
struct MyneComplicationEntry: TimelineEntry {
    let date: Date
}

struct MyneComplicationProvider: TimelineProvider {
    func placeholder(in context: Context) -> MyneComplicationEntry {
        MyneComplicationEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (MyneComplicationEntry) -> Void) {
        completion(MyneComplicationEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<MyneComplicationEntry>) -> Void) {
        // Static launcher — never needs a timeline refresh.
        completion(Timeline(entries: [MyneComplicationEntry(date: Date())], policy: .never))
    }
}

struct MyneComplicationView: View {
    @Environment(\.widgetFamily) private var family

    private var mark: some View {
        MyneMark()
            .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
    }

    var body: some View {
        switch family {
        case .accessoryInline:
            Label("New note", systemImage: "mic.fill")
        case .accessoryCircular, .accessoryCorner:
            ZStack {
                AccessoryWidgetBackground()
                mark.padding(7)
            }
        default: // .accessoryRectangular
            HStack(spacing: 6) {
                mark.frame(width: 18, height: 18)
                Text("New note")
                Spacer(minLength: 0)
                // A distinct tap target for the meeting recorder. `.widgetURL` on
                // the whole view would override the default launch, so the meeting
                // link is a `Link` INSIDE the otherwise-default complication: the
                // body still launches the capture surface, this opens the recorder.
                Link(destination: URL(string: "myne-watch://meeting")!) {
                    Image(systemName: "record.circle")
                }
            }
        }
    }
}

@main
struct MyneWatchComplications: Widget {
    private let kind = "md.myne.mobile.watchkitapp.complication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: MyneComplicationProvider()) { _ in
            MyneComplicationView()
        }
        .configurationDisplayName("Myne")
        .description("Quick voice note")
        .supportedFamilies([
            .accessoryCircular,
            .accessoryInline,
            .accessoryRectangular,
            .accessoryCorner,
        ])
    }
}
