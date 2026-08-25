import WidgetKit
import SwiftUI

/// Lock-screen accessories — system-tinted (monochrome) and always the LOCKED
/// state by design: the widget process can't reach the vault key, so the only
/// honest thing to render is a locked door + "tap to unlock". No content.
struct LockScreenView: View {
    @Environment(\.widgetFamily) private var family

    // iOS 17+ requires every widget — accessories included — to declare a
    // container background, or WidgetKit renders the "Please adopt
    // containerBackground API" placeholder instead of the view. Lock-screen
    // accessories are system-tinted, so the background is `.clear`.
    var body: some View {
        content.containerBackground(.clear, for: .widget)
    }

    @ViewBuilder private var content: some View {
        switch family {
        case .accessoryInline:
            // Above the clock: a lock glyph + short label.
            Label {
                Text("Myne · locked")
            } icon: {
                Image(systemName: "lock")
            }

        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                MyneGlyph(color: .primary, lineWidth: 2.4)
                    .frame(width: 26, height: 26)
            }
            .widgetLabel("Myne")

        case .accessoryRectangular:
            HStack(spacing: 11) {
                Image(systemName: "lock")
                    .font(.system(size: 20))
                VStack(alignment: .leading, spacing: 1) {
                    Text("Myne").font(.system(size: 14, weight: .semibold))
                    Text("Tap to unlock").font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }

        default:
            MyneGlyph(color: .primary, lineWidth: 2.2)
        }
    }
}

struct LockScreenWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "md.myne.widget.lock", provider: MyneProvider()) { _ in
            LockScreenView().widgetURL(URL(string: "myne://open"))
        }
        .configurationDisplayName("Myne: locked")
        .description("A door on the Lock Screen. Tap to open and unlock.")
        .supportedFamilies([.accessoryInline, .accessoryCircular, .accessoryRectangular])
    }
}

// MARK: - WG-05 · StandBy / locked glance (systemSmall promoted)
// StandBy renders systemSmall widgets on black; this is the dedicated locked
// glance — bare glyph + "Tap to unlock".

struct StandByLockedView: View {
    var body: some View {
        VStack(spacing: 14) {
            MyneGlyph(color: Color.white.opacity(0.92), lineWidth: 2.2)
                .frame(width: 60, height: 60)
            Text("Tap to unlock")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Color.white.opacity(0.85))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(.black, for: .widget)
    }
}

struct StandByLockedWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "md.myne.widget.standby", provider: MyneProvider()) { _ in
            StandByLockedView().widgetURL(URL(string: "myne://open"))
        }
        .configurationDisplayName("Myne: StandBy")
        .description("A locked glance for StandBy and the bedside table.")
        .supportedFamilies([.systemSmall])
    }
}
