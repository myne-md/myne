// SPDX-License-Identifier: AGPL-3.0
import Foundation
import WatchConnectivity

/// Watch-side WatchConnectivity client: activates the session and relays a
/// dictated capture to the paired iPhone via `transferUserInfo` — a **durable,
/// FIFO** queue delivered when the phone app next becomes active (it survives the
/// watch app closing before delivery, unlike `sendMessage`). The watch holds NO
/// vault key; it only ships plaintext text over the OS-encrypted WatchConnectivity
/// transport, which the phone seals into the encrypted queue (§9.18).
///
/// It ALSO owns the single watch-side `WCSessionDelegate` slot on behalf of the
/// meeting lane (myne-md/myne#812): [`MeetingTransfer`] reuses this delegate for
/// `didFinish fileTransfer:` rather than claiming the slot a second time — one
/// delegate, two lanes, exactly as `WCCaptureReceiver` does on the phone.
final class WatchConnectivityClient: NSObject, WCSessionDelegate {
    static let shared = WatchConnectivityClient()

    /// The `userInfo` payload key the iPhone receiver (`WCCaptureReceiver`) reads.
    /// MUST match `WCCaptureReceiver.captureKey`.
    static let captureKey = "capture"

    // Captures produced before the session finished activating (a cold-launch
    // race): buffered here and flushed in activationDidCompleteWith(.activated).
    // transferUserInfo on a non-activated session is a programmer error that can
    // wedge all subsequent transfers until a watch restart.
    private let pendingLock = NSLock()
    private var pending: [String] = []

    private override init() {
        super.init()
        activate()
    }

    /// Idempotently (re)activate the default session with this delegate.
    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        if session.activationState != .activated {
            session.activate()
        }
    }

    /// Queue a dictated capture for delivery to the phone. Empty / whitespace-only
    /// text is dropped. If the session is not yet `.activated` (cold-launch race),
    /// the capture is buffered and flushed once activation completes — it is never
    /// sent on a non-activated session.
    func send(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        activate()
        let session = WCSession.default
        if session.activationState == .activated {
            session.transferUserInfo([Self.captureKey: trimmed])
        } else {
            pendingLock.lock()
            pending.append(trimmed)
            pendingLock.unlock()
        }
    }

    // MARK: WCSessionDelegate (watchOS requires only activationDidComplete)
    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        guard activationState == .activated else { return }
        pendingLock.lock()
        let queued = pending
        pending.removeAll()
        pendingLock.unlock()
        for text in queued {
            session.transferUserInfo([Self.captureKey: text])
        }
        // Flush any meeting chunks buffered before activation finished (same
        // cold-launch race, separate queue — see `MeetingTransfer`).
        MeetingTransfer.shared.flushIfActivated()
    }

    /// `transferFile` completion for the meeting lane (myne-md/myne#812). This
    /// delegate is the app's ONE `WCSession` delegate owner, so the meeting
    /// transfer routes here and deletes its local chunk from this callback. The
    /// dictated-capture lane never calls `transferFile` and is unaffected.
    func session(
        _ session: WCSession,
        didFinish fileTransfer: WCSessionFileTransfer,
        error: Error?
    ) {
        MeetingTransfer.shared.didFinish(fileTransfer: fileTransfer, error: error)
    }
}
