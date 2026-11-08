// SPDX-License-Identifier: AGPL-3.0
import AVFoundation
import Foundation

/// Watch-side **meeting** audio recorder (myne-md/myne#812). Its sibling
/// [`CaptureView`] dictates a short note through the system text input's mic;
/// this one holds the watch microphone open for the length of a meeting and
/// spools the audio into numbered chunk files on disk.
///
/// # What the watch does and does NOT do
///
/// Like every other watch surface here, it holds **NO vault key and runs NO
/// crypto** — the watch is outside the plaintext trust boundary (spec
/// §9.18, main-repo `agent-tooling/design-notes.md` 2026-07-12). It records, then hands each
/// chunk to [`MeetingTransfer`], which ships it to the paired iPhone over
/// WatchConnectivity. The phone seals each chunk on arrival under the
/// device-local wrap key (`WCMeetingReceiver` → `plugin:captures|seal_meeting_chunk`),
/// so the audio is encrypted at rest before the vault is ever unlocked.
///
/// # Foreground-only, by design
///
/// There is deliberately **NO `HKWorkoutSession` and NO background recording**
/// (`UIBackgroundModes` stays out of the watch `Info.plist` too). Recording runs
/// only while this view is foregrounded, and the watch screen is left ON for the
/// duration: watchOS dims and suspends a non-workout app once the wrist drops,
/// which ends the recording. A meeting recorder that keeps the screen lit is the
/// honest trade here — the alternative is a workout session, which would claim
/// the exercise ring and the always-on-display entitlement for an activity that
/// is not exercise. If the wrist drops, `AVAudioRecorder` is interrupted and the
/// session stops; whatever chunks were already transferred are safe on the phone.
///
/// # Chunking
///
/// The recorder spools a **new file every `chunkSeconds`** rather than producing
/// one long file at the end, for three reasons:
///
/// 1. `WCSession.transferFile` moves one file per transfer, so a chunk is the
///    unit the phone seals and the unit a reconnect re-sends. A single 40-minute
///    file would be one all-or-nothing transfer.
/// 2. WatchConnectivity's queue is durable but not bounded in any way the
///    program can observe; a fresh chunk every 15 s keeps a lost connection from
///    holding one huge file hostage.
/// 3. 15 s of 16 kHz mono linear PCM is roughly 480 KB per chunk, orders of
///    magnitude under the phone's 64 MiB per-chunk cap, so the cap is a
///    sanity bound rather than a limit a meeting can hit.
///
/// # The chunk is WAV, not CAF (myne-md/myne#812 review)
///
/// Each chunk is written as a **RIFF/WAVE** file (16 kHz mono 16-bit linear PCM),
/// deliberately. The phone's attachment sniffer recognizes audio only as
/// `RIFF....WAVE` (`core/src/plugins/attachments/sniff.rs`) and both transcription
/// parsers accept only RIFF/WAVE (`local_inference/audio.rs`), so an earlier
/// revision that recorded Opus/AAC into a `.caf` container landed every chunk as
/// `application/octet-stream`: unplayable and un-transcribable, and the meeting
/// note shipped with no transcript and export-only file cards. Linear PCM is
/// universally encodable on watchOS and produces a real WAV, which is the shape
/// the rest of the pipeline was already built to accept. The cost is size — about
/// 8x Opus — which the 64 MiB per-chunk cap absorbs with room to spare.
///
/// 15 s is also short enough that a *stop* mid-meeting loses at most the tail of
/// one chunk, and long enough that the re-arm cost (closing a file, starting
/// another) is negligible against a meeting's length.
final class MeetingRecorder: NSObject, ObservableObject {
    /// One recorder per process, so a view that re-appears (the watch app's
    /// view tree is torn down on wrist-down) re-attaches to the session already
    /// in flight instead of starting a second one.
    static let shared = MeetingRecorder()

    /// Emitted to [`MeetingView`]: elapsed seconds since [`start`], ticked once a
    /// second while a session is running.
    @Published private(set) var elapsed: TimeInterval = 0
    /// Emitted to [`MeetingView`]: whether a session is running.
    @Published private(set) var isRecording = false
    /// Emitted to [`MeetingView`]: the last start/stop failure, if any. The watch
    /// surfaces it rather than failing silently.
    @Published private(set) var lastError: String?

    /// One chunk file is ~15 s of audio (see the type doc). Cost is ~1 file
    /// server-side `transferFile` + one phone-side seal per 15 s of meeting.
    static let chunkSeconds: TimeInterval = 15

    /// Chunk files live in `tmp` — the OS owns eviction. A file is deleted once
    /// its transfer reports success (`MeetingTransfer.didFinish`); a chunk whose
    /// transfer never reports (the watch app was relaunched and the in-flight
    /// mapping was lost, or the watch was left mid-send) is cleaned up by `tmp`
    /// reclamation rather than accumulating.
    private let workDir: URL

    private var recorder: AVAudioRecorder?
    private var sessionID: String = ""
    private var startedAtMs: UInt64 = 0
    private var nextChunkIndex: UInt32 = 0
    private var ticker: Timer?
    private var chunkTimer: Timer?
    private var startedAtDate: Date?
    /// Set by [`discard`] so the final `closeChunk` deletes its partial file
    /// instead of transferring it.
    private var discarded = false

    override init() {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("myne-meeting-recorder", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        workDir = dir
        super.init()
    }

    // MARK: - Session lifecycle

    /// Begin a session: reset the counters, open the mic, and record the first
    /// chunk. A no-op if a session is already running.
    func start() {
        guard !isRecording else { return }

        // The session id travels in `transferFile` metadata and is validated by
        // the Rust manifest as ASCII `[A-Za-z0-9_-]` with `len <= 64`. A UUID
        // string (36 chars, hex + hyphens) satisfies both by construction, which
        // is why it is chosen over anything human-readable.
        sessionID = UUID().uuidString
        startedAtMs = UInt64(Date().timeIntervalSince1970 * 1000)
        nextChunkIndex = 0
        lastError = nil

        do {
            try activateAudioSession()
        } catch {
            lastError = "Could not start the microphone."
            return
        }

        isRecording = true
        startedAtDate = Date()
        elapsed = 0
        startTicking()

        if !openChunk() {
            // A failed first chunk means the session cannot produce audio; stop
            // cleanly rather than leaving an idle "recording" UI.
            stop()
            lastError = "Could not start recording."
        }
    }

    /// End the session: close the current chunk, hand it off, tear the audio
    /// session down, and stop the UI tick. The already-transferred chunks are the
    /// meeting; nothing here is rolled back.
    func stop() {
        guard isRecording else { return }
        isRecording = false
        stopTicking()
        closeChunk()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        startedAtDate = nil
    }

    /// Discard a mistaken start: stop the session WITHOUT transferring its tail
    /// chunk, then delete every chunk left on disk. A chunk already handed to the
    /// transfer layer cannot be recalled, but a discarded session that produced
    /// only one partial chunk transfers nothing — the `discarded` flag makes
    /// `closeChunk` delete rather than enqueue. The session id is released so a
    /// later start cannot collide with a half-drained session on the phone.
    func discard() {
        if isRecording {
            discarded = true
            isRecording = false
            stopTicking()
            closeChunk()
            recorder = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            startedAtDate = nil
        }
        let files = (try? FileManager.default.contentsOfDirectory(
            at: workDir,
            includingPropertiesForKeys: nil
        )) ?? []
        for file in files {
            try? FileManager.default.removeItem(at: file)
        }
        // Release the session id so nothing can accidentally reuse it.
        sessionID = ""
        startedAtMs = 0
        nextChunkIndex = 0
        elapsed = 0
        lastError = nil
        discarded = false
    }

    // MARK: - Chunk files

    /// Open the next chunk file and start recording into it. Returns `false` when
    /// `AVAudioRecorder` could not be created.
    ///
    /// The chunk is **16 kHz mono 16-bit linear-PCM WAV** (see the type doc): the
    /// `.wav` extension makes `AVAudioRecorder` write a RIFF/WAVE container, which
    /// is the only audio shape the phone's sniffer and transcription parser accept.
    /// Linear PCM is encodable on every watchOS version, so there is no codec
    /// fallback path.
    private func openChunk() -> Bool {
        let index = nextChunkIndex
        let url = workDir.appendingPathComponent("chunk-\(sessionID)-\(index).wav")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        guard let next = try? AVAudioRecorder(url: url, settings: settings) else {
            return false
        }
        return arm(next, index: index, url: url)
    }

    /// Common tail of [`openChunk`]: arm the recorder and schedule the next chunk.
    private func arm(_ newRecorder: AVAudioRecorder, index: UInt32, url: URL) -> Bool {
        newRecorder.isMeteringEnabled = false
        guard newRecorder.record() else { return false }
        recorder = newRecorder
        nextChunkIndex = index + 1

        chunkTimer?.invalidate()
        chunkTimer = Timer.scheduledTimer(
            withTimeInterval: Self.chunkSeconds,
            repeats: false
        ) { [weak self] _ in
            guard let self, self.isRecording else { return }
            self.closeChunk()
            if !self.openChunk() {
                // The next chunk could not be opened (mic grabbed by another app,
                // recorder refused): stop cleanly and say so rather than leaving
                // the UI claiming it is still recording into nothing.
                self.stop()
                self.lastError = "Recording stopped: the microphone became unavailable."
            }
        }
        return true
    }

    /// Finish the in-flight chunk and hand it to [`MeetingTransfer`] for delivery.
    /// A no-op when nothing is recording. A discarded session deletes its partial
    /// chunk instead of transferring it.
    private func closeChunk() {
        guard let finished = recorder else { return }
        finished.stop()
        recorder = nil
        chunkTimer?.invalidate()
        chunkTimer = nil

        guard !discarded, !sessionID.isEmpty else {
            // Discarded (or the id was already released): remove the file rather
            // than transferring a chunk belonging to a session the user rejected.
            try? FileManager.default.removeItem(at: finished.url)
            return
        }
        // The index is the one this recorder was opened with, recovered from its
        // own file name so a stop and the timer cannot disagree about it.
        guard let index = Self.index(of: finished.url) else {
            try? FileManager.default.removeItem(at: finished.url)
            return
        }
        MeetingTransfer.shared.enqueue(
            fileURL: finished.url,
            sessionID: sessionID,
            chunkIndex: index,
            startedAtMs: startedAtMs
        )
    }

    /// Parse `chunk-<session>-<index>.wav` back to its index.
    private static func index(of url: URL) -> UInt32? {
        let name = url.deletingPathExtension().lastPathComponent
        guard let dash = name.lastIndex(of: "-") else { return nil }
        return UInt32(name[name.index(after: dash)...])
    }

    // MARK: - Timers + audio session

    private func startTicking() {
        ticker?.invalidate()
        ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self, let start = self.startedAtDate else { return }
            self.elapsed = Date().timeIntervalSince(start)
        }
    }

    private func stopTicking() {
        ticker?.invalidate()
        ticker = nil
    }

    private func activateAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        // `.record` (not `.playAndRecord`): the watch has no speaker use here, and
        // `.record` is the category that prompts for the microphone on watchOS.
        // `.defaultToSpeaker` is an iOS-only option and is deliberately not used.
        try session.setCategory(.record, mode: .default, options: [])
        try session.setActive(true)
    }
}
