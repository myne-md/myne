import SwiftUI
import WidgetKit

// Rendering-mode support for the Home Screen widgets. Kept in its own
// widget-target-only file on purpose: `MyneColor.swift` and `MyneMark.swift`
// are marked SHARED with the app target (see the README), read from the shared
// tree is what a later hand wants, so they must stay compilable at the app
// target's older deployment target, while `WidgetRenderingMode` and
// `.widgetRenderingMode` are iOS 16+ and belong only to the extension.

extension WidgetRenderingMode {
    /// Whether the system is rendering the brand palette. `accented` (Tinted and
    /// Clear Home Screen appearances) and `vibrant` are template modes.
    var isFullColor: Bool {
        if case .fullColor = self { return true }
        return false
    }
}

/// The design tokens resolved against a widget's rendering mode.
///
/// iOS 18 renders Home Screen widgets in WidgetKit's `accented` mode when the
/// person picks the Tinted or Clear appearance (and `vibrant` on the Lock
/// Screen). There the system discards view colors, removes the container
/// background and templates the hierarchy by its alpha channel, so two fully
/// opaque shapes collapse into one solid color. Off the `fullColor` path an
/// adaptive foreground (`ink`, `inkSecondary`) becomes `.primary`/`.secondary`,
/// while a fill that carries meaning (`paper`, `paper2`, `accent`) becomes
/// clear and relies on the `stroke` twin beside it to stay visible.
struct MyneTokens {
    let fullColor: Bool

    init(renderingMode: WidgetRenderingMode) {
        fullColor = renderingMode.isFullColor
    }

    var paper: Color { fullColor ? MyneColor.paper : .clear }
    var paper2: Color { fullColor ? MyneColor.paper2 : .clear }
    var ink: Color { fullColor ? MyneColor.ink : .primary }
    var inkSecondary: Color { fullColor ? MyneColor.inkSecondary : .secondary }
    var faint: Color { fullColor ? MyneColor.line2 : .secondary }
    var line: Color { fullColor ? MyneColor.line : .primary }
    var line2: Color { fullColor ? MyneColor.line2 : .primary }
    var accent: Color { fullColor ? MyneColor.accent : .clear }
    var accentStroke: Color { fullColor ? .clear : .primary }
    var accentOn: Color { fullColor ? MyneColor.accentOn : .primary }
}

/// The brand mark for a Home Screen widget surface, adapting to the rendering
/// mode. In `fullColor` it is the ink tile with a paper "M". In `accented` and
/// `vibrant` the system discards those colors and templates the view by its
/// alpha, which collapses the fully opaque tile and mark into one blank shape,
/// so the bare stroked glyph is drawn instead: it carries its own alpha
/// structure and stays legible as a monochrome mark.
struct MyneBrandMark: View {
    @Environment(\.widgetRenderingMode) private var renderingMode
    var size: CGFloat

    var body: some View {
        if renderingMode.isFullColor {
            MyneLogo(size: size)
        } else {
            MyneGlyph(color: .primary, lineWidth: max(1.5, size * 0.0625))
                .frame(width: size * 0.62, height: size * 0.62)
                .widgetAccentable()
        }
    }
}
