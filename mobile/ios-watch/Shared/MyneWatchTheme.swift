// SPDX-License-Identifier: AGPL-3.0
import SwiftUI

/// Minimal Myne design tokens for the watch surfaces. watchOS is always dark, so
/// these use the DARK palette from `src/styles/tokens.css` (kept tiny + self
/// contained rather than sharing the widget's dynamic light/dark `MyneColor`,
/// which the always-dark watch does not need). Shared by the watch app target and
/// the complication extension target.
enum MyneWatchTheme {
    static let ink = Color(red: 0.909, green: 0.906, blue: 0.874) // --fg-1 dark ≈ #E8E7DF
    static let inkSecondary = Color(red: 0.553, green: 0.549, blue: 0.522) // --fg-3 dark ≈ #8D8C85
    static let accent = Color(red: 0.541, green: 0.643, blue: 0.816) // --accent dark ≈ #8AA4D0
}

/// The Myne "M" chevron, from the design's 32×32 viewBox path
/// `M8 22 V10 L16 18 L24 10 V22`. Stroked, round joins. (Mirrors
/// `ios-widgets/MyneWidgets/MyneMark.swift`, duplicated so the watch targets do
/// not cross-depend on the iOS widget target.)
struct MyneMark: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 32.0
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * s, y: rect.minY + y * s)
        }
        var p = Path()
        p.move(to: pt(8, 22))
        p.addLine(to: pt(8, 10))
        p.addLine(to: pt(16, 18))
        p.addLine(to: pt(24, 10))
        p.addLine(to: pt(24, 22))
        return p
    }
}
