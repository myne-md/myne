// SPDX-License-Identifier: AGPL-3.0
import SwiftUI

/// The watch **meeting** surface (myne-md/myne#812): start a recording, see an
/// unmistakable live state, stop it, or discard a mistaken start. It reads and
/// writes no vault content and holds no key — like [`CaptureView`], it only
/// produces data for the phone to seal.
///
/// The two surfaces are deliberately siblings in a `TabView` (see
/// `MyneWatchApp`): this view does not touch [`CaptureView`] or
/// [`WatchConnectivityClient`]'s `transferUserInfo` path, so the one-tap
/// dictation flow is unchanged.
struct MeetingView: View {
    @ObservedObject private var recorder = MeetingRecorder.shared
    @State private var confirmDiscard = false

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                if recorder.isRecording {
                    recordingState
                } else {
                    idleState
                }

                if let error = recorder.lastError {
                    Text(error)
                        .font(.footnote)
                        .foregroundColor(MyneWatchTheme.inkSecondary)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.horizontal, 4)
        }
        .onAppear { WatchConnectivityClient.shared.activate() }
    }

    // MARK: - States

    private var idleState: some View {
        VStack(spacing: 10) {
            MyneMark()
                .stroke(
                    MyneWatchTheme.accent,
                    style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
                )
                .frame(width: 26, height: 26)
                .padding(.top, 2)

            Text("Record a meeting")
                .font(.footnote)
                .foregroundColor(MyneWatchTheme.inkSecondary)

            Button(action: recorder.start) {
                Label("Start", systemImage: "record.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(MyneWatchTheme.accent)

            // Honest about the trade the recorder makes: no workout session, so
            // the screen must stay lit for the meeting to keep recording.
            Text("Keep the screen on")
                .font(.system(size: 12))
                .foregroundColor(MyneWatchTheme.inkSecondary)
        }
    }

    private var recordingState: some View {
        VStack(spacing: 10) {
            HStack(spacing: 6) {
                Circle()
                    .fill(MyneWatchTheme.accent)
                    .frame(width: 10, height: 10)
                Text("Recording")
                    .font(.footnote)
                    .foregroundColor(MyneWatchTheme.accent)
            }
            .padding(.top, 2)

            Text(Self.format(recorder.elapsed))
                .font(.system(.title2, design: .rounded))
                .monospacedDigit()
                .foregroundColor(MyneWatchTheme.ink)

            Button(action: recorder.stop) {
                Label("Stop", systemImage: "stop.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(MyneWatchTheme.accent)

            Button(role: .destructive) {
                confirmDiscard = true
            } label: {
                Label("Discard", systemImage: "trash")
                    .frame(maxWidth: .infinity)
            }
            .confirmationDialog(
                "Discard this recording?",
                isPresented: $confirmDiscard,
                titleVisibility: .visible
            ) {
                Button("Discard", role: .destructive) { recorder.discard() }
                Button("Keep recording", role: .cancel) {}
            }
        }
    }

    /// `m:ss`, matching the elapsed counter's one-second tick.
    private static func format(_ interval: TimeInterval) -> String {
        let total = Int(interval)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
