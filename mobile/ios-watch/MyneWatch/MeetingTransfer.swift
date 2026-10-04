// SPDX-License-Identifier: AGPL-3.0
import Foundation
import WatchConnectivity

/// Watch-side transfer queue for meeting audio chunks (myne-md/myne#812). Each
/// chunk file produced by [`MeetingRecorder`] is shipped to the paired iPhone
/// with `WCSession.transferFile(_:metadata:)` — a **durable, FIFO** transfer that
/// survives the watch app closing and is re-sent on the phone's next launch,
/// unlike `sendMessage`.
///
/// # Why this is not part of [`WatchConnectivityClient`]
///
/// `WatchConnectivityClient` owns the *dictated-capture* lane and the single
/// watch-side `WCSessionDelegate` slot. This type is the meeting lane's
/// counterpart: it reuses that client's activation gate and its delegate for the
/// `didFinish fileTransfer:` callback, but keeps its own transfer bookkeeping so
/// the two lanes cannot interfere. There is still exactly ONE
/// `session.delegate = …` assignment in the watch app — here we only *extend*
/// the existing delegate, never claim the slot a second time.
///
/// # Durable lifecycle
///
/// A chunk file is deleted **only after `didFinish fileTransfer:` reports
/// success** (the mapping from `WCSessionFileTransfer` to a local path is kept in
/// `inFlight`). A transfer that fails is left on disk for a retry, and a chunk
/// queued before the session finished activating is buffered — `transferFile` on
/// a non-activated session is a programmer error that can wedge every subsequent
/// transfer until a watch restart (the same hazard
/// [`WatchConnectivityClient`] guards its captures against).
///
/// The watch holds **NO vault key and runs NO crypto**: this type moves file
/// bytes over the OS-encrypted WatchConnectivity transport and nothing else. The
/// phone seals each chunk on arrival.
final class MeetingTransfer: NSObject {
    static let shared = MeetingTransfer()

    /// The `transferFile` metadata keys the phone reads (`WCMeetingReceiver`).
    /// MUST stay byte-identical to `WCMeetingReceiver.sessionIDKey` et al.
    static let sessionIDKey = "session_id"
    static let chunkIndexKey = "chunk_index"
    static let startedAtKey = "started_at"

    private struct Pending {
        let fileURL: URL
        let metadata: [String: Any]
    }

    private let lock = NSLock()
    private var queued: [Pending] = []
    /// `WCSessionFileTransfer` → the local chunk URL it is carrying, so the
    /// completion callback can delete exactly the right file.
    private var inFlight: [ObjectIdentifier: URL] = [:]

    private override init() {
        super.init()
    }

    /// Hand one finished chunk to WatchConnectivity. Called by the recorder on
    /// each chunk boundary, so it must return immediately.
    func enqueue(fileURL: URL, sessionID: String, chunkIndex: UInt32, startedAtMs: UInt64) {
        let metadata: [String: Any] = [
            Self.sessionIDKey: sessionID,
            Self.chunkIndexKey: NSNumber(value: chunkIndex),
            Self.startedAtKey: NSNumber(value: startedAtMs),
        ]
        WatchConnectivityClient.shared.activate()
        let session = WCSession.default
        if session.activationState == .activated {
            transfer(session: session, fileURL: fileURL, metadata: metadata)
        } else {
            lock.lock()
            queued.append(Pending(fileURL: fileURL, metadata: metadata))
            lock.unlock()
        }
    }

    /// Flush anything buffered before activation completed. Called by
    /// `WatchConnectivityClient` from `activationDidCompleteWith(.activated)`.
    func flushIfActivated() {
        let session = WCSession.default
        guard session.activationState == .activated else { return }
        lock.lock()
        let pending = queued
        queued.removeAll()
        lock.unlock()
        for item in pending {
            transfer(session: session, fileURL: item.fileURL, metadata: item.metadata)
        }
    }

    /// Start one durable transfer and remember its local file. `transferFile`
    /// copies the file into the OS-managed transfer area, so the source can be
    /// deleted on completion without racing the transfer itself.
    private func transfer(session: WCSession, fileURL: URL, metadata: [String: Any]) {
        let transfer = session.transferFile(fileURL, metadata: metadata)
        lock.lock()
        inFlight[ObjectIdentifier(transfer)] = fileURL
        lock.unlock()
    }

    /// `WCSessionDelegate.session(_:didFinish fileTransfer:)` — routed here by
    /// [`WatchConnectivityClient`], the watch app's one delegate owner. Deletes
    /// the local chunk ONLY on success; on failure the file stays for a retry.
    func didFinish(fileTransfer: WCSessionFileTransfer, error: Error?) {
        lock.lock()
        let fileURL = inFlight.removeValue(forKey: ObjectIdentifier(fileTransfer))
        lock.unlock()

        guard error == nil, let fileURL else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }
}
