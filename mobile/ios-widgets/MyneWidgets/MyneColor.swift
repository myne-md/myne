import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

/// Myne design tokens for the widget surfaces, mirroring `src/styles/tokens.css`.
/// Each token is a dynamic colour: the first hex is the light value, the second
/// the dark value, so the widgets follow the wallpaper/system appearance the
/// same way the WebView UI follows `data-theme`.
enum MyneColor {
    static let paper        = dyn(0xFBFBFA, 0x1A1A17) // --paper / --bg-1
    static let paper2       = dyn(0xF4F4F2, 0x232220) // --paper-2 / --bg-2
    static let ink          = dyn(0x1A1A17, 0xE8E7DF) // --ink-1 / --fg-1
    static let inkDisplay   = dyn(0x0B0B09, 0xF7F6EE) // --ink-0 / --fg-display
    static let inkSecondary = dyn(0x6B6A64, 0x8D8C85) // --ink-3 / --fg-3
    static let line         = dyn(0xE3E2DD, 0x2C2B28) // --line-1
    static let line2        = dyn(0xC8C7C1, 0x3A3935) // --line-2
    static let accent       = dyn(0x2C4A7A, 0x8AA4D0) // --accent
    static let accentOn     = dyn(0xFFFFFF, 0x0B0B09) // --accent-on

    static func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
        #if canImport(UIKit)
        return Color(UIColor { tc in
            tc.userInterfaceStyle == .dark ? UIColor(rgb: dark) : UIColor(rgb: light)
        })
        #else
        return Color(rgb: light)
        #endif
    }
}

extension Color {
    init(rgb: UInt32) {
        self.init(
            .sRGB,
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255,
            opacity: 1
        )
    }
}

#if canImport(UIKit)
extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}
#endif
