import SwiftUI

/// The Myne "M" chevron, from the design's 32×32 viewBox path
/// `M8 22 V10 L16 18 L24 10 V22`. Stroked, round joins.
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

/// Rounded-square brand tile: ink square + paper "M" (inverts in dark).
struct MyneLogo: View {
    var size: CGFloat
    var inkColor: Color = MyneColor.ink
    var markColor: Color = MyneColor.paper

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
            .fill(inkColor)
            .frame(width: size, height: size)
            .overlay(
                MyneMark()
                    .stroke(markColor, style: StrokeStyle(lineWidth: max(1.5, size * 0.0625), lineCap: .round, lineJoin: .round))
                    .frame(width: size, height: size)
            )
    }
}

/// The bare "M" chevron (no tile) — used for lock-screen / StandBy monochrome.
struct MyneGlyph: View {
    var color: Color
    var lineWidth: CGFloat = 2.2
    var body: some View {
        MyneMark()
            .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
    }
}
