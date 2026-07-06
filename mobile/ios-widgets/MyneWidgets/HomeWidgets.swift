import WidgetKit
import SwiftUI

// A single static entry — the widgets are launchers + one capture action; by
// design they carry NO vault content (titles, counts, timestamps would leak),
// so there is nothing to refresh on a timeline.
struct MyneEntry: TimelineEntry {
    let date: Date
}

struct MyneProvider: TimelineProvider {
    func placeholder(in context: Context) -> MyneEntry { MyneEntry(date: Date()) }
    func getSnapshot(in context: Context, completion: @escaping (MyneEntry) -> Void) {
        completion(MyneEntry(date: Date()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<MyneEntry>) -> Void) {
        completion(Timeline(entries: [MyneEntry(date: Date())], policy: .never))
    }
}

// MARK: - WG-01 · Open Myne (systemSmall launcher, locked default)

struct OpenMyneView: View {
    var body: some View {
        VStack(spacing: 14) {
            MyneLogo(size: 52)
            Text("Myne")
                .font(.system(size: 17, weight: .semibold))
                .tracking(-0.34)
                .foregroundStyle(MyneColor.ink)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(MyneColor.paper, for: .widget)
    }
}

struct OpenMyneWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "md.myne.widget.open", provider: MyneProvider()) { _ in
            OpenMyneView().widgetURL(URL(string: "myne://open"))
        }
        .configurationDisplayName("Open Myne")
        .description("A door into your vault. Nothing is shown until you unlock.")
        .supportedFamilies([.systemSmall])
    }
}

// MARK: - WG-02 · Quick capture (systemSmall + systemMedium)

struct QuickCaptureHeader: View {
    var trailing: String? = nil
    var body: some View {
        HStack(spacing: 8) {
            MyneLogo(size: 20)
            Text("Myne")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(MyneColor.inkSecondary)
            if let trailing {
                Spacer()
                Text(trailing)
                    .font(.system(size: 12))
                    .foregroundStyle(MyneColor.line2)
            }
        }
    }
}

struct QuickCaptureSmallView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            QuickCaptureHeader()
            Spacer()
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(MyneColor.accent)
                .frame(width: 44, height: 44)
                .overlay(Image(systemName: "plus").font(.system(size: 22, weight: .semibold)).foregroundStyle(MyneColor.accentOn))
            Text("New note")
                .font(.system(size: 17, weight: .semibold))
                .tracking(-0.34)
                .foregroundStyle(MyneColor.ink)
                .padding(.top, 12)
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(MyneColor.paper, for: .widget)
    }
}

struct QuickCaptureMediumView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            QuickCaptureHeader(trailing: "Encrypted and private")
            Spacer()
            HStack(spacing: 12) {
                Link(destination: URL(string: "myne://capture")!) {
                    HStack(spacing: 10) {
                        Image(systemName: "plus").font(.system(size: 22, weight: .semibold))
                        Text("New note").font(.system(size: 16, weight: .semibold))
                    }
                    .foregroundStyle(MyneColor.accentOn)
                    .frame(maxWidth: .infinity)
                    .frame(height: 56)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(MyneColor.accent))
                }
                Link(destination: URL(string: "myne://capture?mode=voice")!) {
                    Image(systemName: "mic")
                        .font(.system(size: 22))
                        .foregroundStyle(MyneColor.ink)
                        .frame(width: 56, height: 56)
                        .background(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(MyneColor.paper2)
                                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(MyneColor.line, lineWidth: 1))
                        )
                }
            }
        }
        .padding(EdgeInsets(top: 18, leading: 20, bottom: 18, trailing: 20))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(MyneColor.paper, for: .widget)
    }
}

struct QuickCaptureWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "md.myne.widget.capture", provider: MyneProvider()) { _ in
            QuickCaptureEntryView()
        }
        .configurationDisplayName("Quick capture")
        .description("Start a new note. It is encrypted the moment you save.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct QuickCaptureEntryView: View {
    @Environment(\.widgetFamily) private var family
    var body: some View {
        switch family {
        case .systemMedium: QuickCaptureMediumView()
        default: QuickCaptureSmallView()
        }
    }
}

// MARK: - WG-03 · Encrypted (systemSmall, locked)

struct EncryptedView: View {
    var body: some View {
        VStack(spacing: 12) {
            Circle()
                .strokeBorder(MyneColor.line2, lineWidth: 1.5)
                .frame(width: 46, height: 46)
                .overlay(Image(systemName: "lock").font(.system(size: 20)).foregroundStyle(MyneColor.ink))
            Text("Encrypted\nand private")
                .multilineTextAlignment(.center)
                .font(.system(size: 14, weight: .medium))
                .lineSpacing(2)
                .foregroundStyle(MyneColor.inkSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(MyneColor.paper, for: .widget)
    }
}

struct EncryptedWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "md.myne.widget.encrypted", provider: MyneProvider()) { _ in
            EncryptedView()
        }
        .configurationDisplayName("Encrypted")
        .description("A reminder that your notes are sealed on this device.")
        .supportedFamilies([.systemSmall])
    }
}
