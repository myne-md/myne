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
    @Environment(\.widgetRenderingMode) private var renderingMode
    private var t: MyneTokens { MyneTokens(renderingMode: renderingMode) }

    var body: some View {
        VStack(spacing: 14) {
            MyneBrandMark(size: 52)
            Text("Myne")
                .font(.system(size: 17, weight: .semibold))
                .tracking(-0.34)
                .foregroundStyle(t.ink)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(t.paper, for: .widget)
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
    @Environment(\.widgetRenderingMode) private var renderingMode
    private var t: MyneTokens { MyneTokens(renderingMode: renderingMode) }
    var trailing: String? = nil

    var body: some View {
        HStack(spacing: 8) {
            MyneBrandMark(size: 20)
            Text("Myne")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(t.inkSecondary)
            if let trailing {
                Spacer()
                Text(trailing)
                    .font(.system(size: 12))
                    .foregroundStyle(t.faint)
            }
        }
    }
}

struct QuickCaptureSmallView: View {
    @Environment(\.widgetRenderingMode) private var renderingMode
    private var t: MyneTokens { MyneTokens(renderingMode: renderingMode) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            QuickCaptureHeader()
            Spacer()
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(t.accent)
                .frame(width: 44, height: 44)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(t.accentStroke, lineWidth: 1.5)
                )
                .overlay(
                    Image(systemName: "plus")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(t.accentOn)
                        .widgetAccentable()
                )
            Text("New note")
                .font(.system(size: 17, weight: .semibold))
                .tracking(-0.34)
                .foregroundStyle(t.ink)
                .padding(.top, 12)
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(t.paper, for: .widget)
    }
}

struct QuickCaptureMediumView: View {
    @Environment(\.widgetRenderingMode) private var renderingMode
    private var t: MyneTokens { MyneTokens(renderingMode: renderingMode) }

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
                    .foregroundStyle(t.accentOn)
                    .widgetAccentable()
                    .frame(maxWidth: .infinity)
                    .frame(height: 56)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(t.accent))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(t.accentStroke, lineWidth: 1.5)
                    )
                }
                Link(destination: URL(string: "myne://capture?mode=voice")!) {
                    Image(systemName: "mic")
                        .font(.system(size: 22))
                        .foregroundStyle(t.ink)
                        .frame(width: 56, height: 56)
                        .background(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(t.paper2)
                                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(t.line, lineWidth: 1))
                        )
                        .widgetAccentable()
                }
            }
        }
        .padding(EdgeInsets(top: 18, leading: 20, bottom: 18, trailing: 20))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(t.paper, for: .widget)
    }
}

struct QuickCaptureWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "md.myne.widget.capture", provider: MyneProvider()) { _ in
            // `.widgetURL` makes the WHOLE widget tap open capture — required for
            // systemSmall, which does not support `Link` (only the medium view's
            // buttons use `Link`; the small view has no other tap target).
            QuickCaptureEntryView().widgetURL(URL(string: "myne://capture"))
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
    @Environment(\.widgetRenderingMode) private var renderingMode
    private var t: MyneTokens { MyneTokens(renderingMode: renderingMode) }

    var body: some View {
        VStack(spacing: 12) {
            Circle()
                .strokeBorder(t.line2, lineWidth: 1.5)
                .frame(width: 46, height: 46)
                .overlay(Image(systemName: "lock").font(.system(size: 20)).foregroundStyle(t.ink))
            Text("Encrypted\nand private")
                .multilineTextAlignment(.center)
                .font(.system(size: 14, weight: .medium))
                .lineSpacing(2)
                .foregroundStyle(t.inkSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(t.paper, for: .widget)
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
