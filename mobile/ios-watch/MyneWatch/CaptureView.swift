// SPDX-License-Identifier: AGPL-3.0
import SwiftUI

/// The single watch surface: dictate a note and send it to the phone. Tapping the
/// field opens the system text input, whose **dictation (mic)** option provides
/// the voice capture — so no `SFSpeechRecognizer` and no microphone / speech
/// entitlement are needed (the OS owns the mic; main-repo `design-notes.md`
/// 2026-07-12). There is deliberately NO reading or editing of existing notes and
/// NO vault key on the watch — this view only produces text.
struct CaptureView: View {
    @State private var text: String = ""
    @State private var justSent = false

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                if justSent {
                    VStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.title2)
                            .foregroundColor(MyneWatchTheme.accent)
                        Text("Sent to Myne")
                            .font(.footnote)
                            .foregroundColor(MyneWatchTheme.inkSecondary)
                    }
                    .padding(.vertical, 12)
                    .transition(.opacity)
                } else {
                    MyneMark()
                        .stroke(
                            MyneWatchTheme.accent,
                            style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
                        )
                        .frame(width: 26, height: 26)
                        .padding(.top, 2)

                    // Tapping this field opens the system input (dictation /
                    // Scribble / keyboard) — the mic option is the voice capture.
                    TextField("Dictate a note", text: $text, axis: .vertical)
                        .textFieldStyle(.plain)
                        .foregroundColor(MyneWatchTheme.ink)

                    Button(action: send) {
                        Label("Send", systemImage: "arrow.up.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(MyneWatchTheme.accent)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(.horizontal, 4)
        }
        .onAppear { WatchConnectivityClient.shared.activate() }
    }

    private func send() {
        WatchConnectivityClient.shared.send(text: text)
        text = ""
        withAnimation { justSent = true }
        // Clear the confirmation so a second capture stays one tap away.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            withAnimation { justSent = false }
        }
    }
}
