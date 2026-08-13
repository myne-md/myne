import SwiftUI

// WG-04 · Quick-capture surface — the destination the Control Center / Action
// Button / widget AppIntent opens. This belongs to the APP target (not the
// widget extension): it runs inside the trust boundary and can hold plaintext.
// UI-only: no encryption/persistence is wired; the states are presentational.

enum CaptureState {
    case typing
    case voice
    case saving
}

struct CaptureSheet: View {
    var state: CaptureState = .typing

    var body: some View {
        ZStack(alignment: .bottom) {
            // dimmed pass-through backdrop
            (state == .voice ? Color.black.opacity(0.4) : Color.black.opacity(0.18))
                .ignoresSafeArea()
            sheet
                .frame(maxWidth: .infinity)
                .background(state == .voice ? MyneColor.paper /*dark surface via tokens*/ : MyneColor.paper)
                .clipShape(.rect(topLeadingRadius: 20, topTrailingRadius: 20))
        }
    }

    @ViewBuilder private var sheet: some View {
        VStack(spacing: 0) {
            Capsule().fill(MyneColor.line).frame(width: 36, height: 4).padding(.vertical, 14)
            switch state {
            case .typing: typing
            case .voice: voice
            case .saving: saving
            }
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 18)
    }

    // ── typing ──────────────────────────────────────────────────────────────
    private var typing: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                MyneLogo(size: 18)
                Text("New note").font(.system(size: 13, weight: .semibold)).foregroundStyle(MyneColor.inkSecondary)
            }
            (Text("Pick up oat milk and") + Text("|").foregroundColor(MyneColor.accent))
                .font(.system(size: 16))
                .lineSpacing(4)
                .foregroundStyle(MyneColor.ink)
                .frame(maxWidth: .infinity, minHeight: 160, alignment: .topLeading)
                .padding(.top, 14)
            HStack(spacing: 10) {
                capButton("Cancel", filled: false)
                capButton("Save", filled: true)
            }
            Text("Encrypted on save · cleared if you leave")
                .font(.system(size: 11)).foregroundStyle(MyneColor.line2)
                .frame(maxWidth: .infinity).padding(.top, 10)
        }
    }

    // ── voice ───────────────────────────────────────────────────────────────
    private var voice: some View {
        VStack(spacing: 18) {
            Spacer()
            Circle().fill(MyneColor.accent).frame(width: 84, height: 84)
                .overlay(Image(systemName: "mic").font(.system(size: 30)).foregroundStyle(MyneColor.accentOn))
                .overlay(Circle().strokeBorder(MyneColor.accent.opacity(0.18), lineWidth: 10).scaleEffect(1.24))
            HStack(spacing: 3) {
                 forEachBar([10, 22, 14, 28, 18, 24, 12])
            }.frame(height: 30)
            Text("0:08 · listening").font(.system(size: 14, design: .monospaced)).foregroundStyle(MyneColor.inkSecondary)
            Spacer()
            capButton("Stop", filled: false, full: true)
        }
        .frame(minHeight: 320)
    }

    private func forEachBar(_ heights: [CGFloat]) -> some View {
        ForEach(Array(heights.enumerated()), id: \.offset) { _, h in
            Capsule().fill(MyneColor.accent).frame(width: 3, height: h)
        }
    }

    // ── saving ──────────────────────────────────────────────────────────────
    private var saving: some View {
        VStack(spacing: 18) {
            ProgressView().controlSize(.large).tint(MyneColor.accent)
            Text("Encrypting…").font(.system(size: 16, weight: .semibold)).foregroundStyle(MyneColor.ink)
            Text("Saved to your vault on this device.")
                .font(.system(size: 13)).multilineTextAlignment(.center).foregroundStyle(MyneColor.inkSecondary)
                .frame(maxWidth: 200)
        }
        .frame(maxWidth: .infinity, minHeight: 320)
    }

    private func capButton(_ title: String, filled: Bool, full: Bool = false) -> some View {
        Text(title)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(filled ? MyneColor.accentOn : MyneColor.inkSecondary)
            .frame(maxWidth: .infinity)
            .frame(height: 46)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(filled ? MyneColor.accent : MyneColor.paper)
                    .overlay(filled ? nil : RoundedRectangle(cornerRadius: 12).strokeBorder(MyneColor.line, lineWidth: 1))
            )
            .frame(maxWidth: full ? .infinity : nil)
    }
}

#Preview("Typing") { CaptureSheet(state: .typing) }
#Preview("Voice") { CaptureSheet(state: .voice) }
#Preview("Saving") { CaptureSheet(state: .saving) }
