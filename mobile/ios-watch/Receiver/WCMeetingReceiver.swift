// SPDX-License-Identifier: AGPL-3.0
import Foundation
import Tauri
import UIKit
import WatchConnectivity
import WebKit

/// iPhone-side handler for the Apple Watch **meeting** audio chunks
/// (myne-md/myne#812). A sibling of `WCCaptureReceiver`, not a second
/// `WCSessionDelegate`: the dictated-capture receiver owns the single
/// `WCSession.default` delegate slot and dispatches `didReceive file:` here, so
/// exactly one component ever claims the delegate.
///
/// # Why this does NOT stage plaintext, and where plaintext still lives
///
/// `WCCaptureReceiver.stage(text:)` writes a plaintext file into
/// `pending-captures/staging/` because the Rust `seal_staged` runs later, on
/// boot / on the JS `capture` event. This receiver writes no plaintext of its
/// own: it MOVES the file WatchConnectivity delivered into an app-owned inbox
/// (see "The inbox move" below) and hands that path to the sealing command
/// (`plugin:captures|seal_meeting_chunk`), which reads the audio, seals it under
/// the device-local share-import wrap key into
/// `pending-captures/meetings/entries/`, and deletes the source.
///
/// The plaintext window that remains is the OS-written delivery file itself:
/// WatchConnectivity places the chunk in the app's inbox in plaintext, protected
/// only by OS Data Protection, and it exists from delivery until the seal
/// consumes it. That window is enumerated in `agent-tooling/docs/threat-model.md`; it is NOT
/// zero, and this comment exists because an earlier revision of the docs claimed
/// it was.
///
/// # The inbox move (why the delivery is copied, not referenced)
///
/// WatchConnectivity owns the delivered `fileURL` and the system may remove or
/// relocate it once the delegate method returns. Dispatching that path to the
/// WebView and reading it there is therefore a race at best and a silent loss at
/// worst, and the loss is worst exactly in the cold-background-launch case this
/// classification exists to serve. So `handle(file:)` MOVES the file
/// synchronously, inside the delegate callback, into
/// `pending-captures/meetings/inbox/<uuid>`, and everything downstream reads the
/// app-owned copy. `WCSession`'s own re-delivery covers a delivery the process
/// never saw; the move covers a delivery it saw and returned from.
///
/// # The bridge, and why it is the WebView
///
/// A plain Swift class compiled into the Tauri app cannot invoke a Rust
/// `#[tauri::command]` directly (Tauri's mobile plugin bridge only goes
/// Rust → native → a `Channel`, never native → Rust), and re-running the AEAD
/// in Swift would be a second crypto codebase. So the receiver dispatches a
/// `myne-meeting-chunk` CustomEvent into the app's WebView
/// (`Plugin.manager.viewController`) and `mobile/src/lib/captures.ts` listens
/// and calls the device-key-based command. The seal therefore runs while the
/// vault is LOCKED, exactly as it does for the dictated queue.
///
/// # Why this is a `Plugin` subclass
///
/// `PluginManager.shared` is `internal` to the `Tauri` module
/// (`tauri-2.12.1/mobile/ios-api/Sources/Tauri/Tauri.swift`), so a class
/// compiled into the app target cannot reach it. `Plugin.manager` is the public
/// accessor, and it requires the `open class Plugin` base. Classifying a `Plugin`
/// also means this type is subject to `InlinedPlugin`/capability wiring like
/// every other mobile plugin, which is the honest home for it.
///
/// # Cold background launch
///
/// A `didReceive file:` delivery can fire before the WebView is created (a cold
/// background launch, or the moment the app is relaunched by
/// WatchConnectivity). The inbox path is therefore QUEUED and flushed the first
/// time the WebView becomes available (`flushIfPossible`, retried on session
/// activation and on `load(webview:)`). The queued entry holds an app-owned file
/// that survives the wait; `transferFile` re-delivery covers a process that died
/// before the move.
@objc(WCMeetingReceiver)
public final class WCMeetingReceiver: Plugin {
    @objc public static let shared = WCMeetingReceiver()

    /// The `transferFile` metadata keys the watch sends and this receiver reads.
    /// MUST stay in step with `MeetingTransfer` on the watch side.
    static let sessionIDKey = "session_id"
    static let chunkIndexKey = "chunk_index"
    static let startedAtKey = "started_at"

    /// `<app_data_dir>/pending-captures/meetings/inbox/` — app-owned, sibling of
    /// the sealed `entries/` and `manifest/` directories the Rust side owns.
    /// Resolved exactly as `WCCaptureReceiver.stagingDir()` resolves its staging
    /// dir (Tauri v2's iOS `app_data_dir()` = `dirs::data_dir()/<bundle id>`, so
    /// the bundle id is appended explicitly).
    private static func inboxDir() -> URL? {
        guard let appSupport = try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ), let bundleID = Bundle.main.bundleIdentifier else { return nil }
        let dir = appSupport
            .appendingPathComponent(bundleID, isDirectory: true)
            .appendingPathComponent("pending-captures", isDirectory: true)
            .appendingPathComponent("meetings", isDirectory: true)
            .appendingPathComponent("inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// One arrived chunk, already moved into the app-owned inbox.
    private struct Delivery {
        /// App-owned path. Survives the delegate returning.
        let path: String
        let sessionID: String
        let chunkIndex: UInt32
        let startedAt: UInt64
    }

    private let lock = NSLock()
    private var pending: [Delivery] = []
    private var webview: WKWebView?

    public override init() {
        super.init()
    }

    /// Tauri calls this once the WebView exists. Flush whatever arrived first.
    public override func load(webview: WKWebView) {
        lock.lock()
        self.webview = webview
        lock.unlock()
        flushIfPossible()
    }

    /// Handle one `transferFile` delivery from the shared `WCSession` delegate.
    /// MOVES the file into the app-owned inbox before returning (the OS owns the
    /// delivered URL only until this method returns), then queues it for the
    /// seal. Returns immediately; the seal happens in the WebView when it exists.
    public func handle(file: WCSessionFile) {
        guard let parsed = Self.parse(file: file) else {
            // A malformed / foreign delivery is dropped, never sealed: without a
            // session id and index it could not be grouped into a meeting.
            // Dropping it without deleting leaves the OS to reclaim its inbox.
            return
        }
        guard let moved = Self.moveIntoInbox(
            parsed.sourceURL,
            sessionID: parsed.sessionID,
            chunkIndex: parsed.chunkIndex,
            startedAt: parsed.startedAt
        ) else {
            // The move failed (no inbox dir, or the source vanished between the
            // delegate firing and this call). Nothing app-owned exists to seal,
            // so there is nothing to queue; `transferFile` re-delivers.
            return
        }
        let delivery = Delivery(
            path: moved.path,
            sessionID: parsed.sessionID,
            chunkIndex: parsed.chunkIndex,
            startedAt: parsed.startedAt
        )
        lock.lock()
        pending.append(delivery)
        lock.unlock()
        flushIfPossible()
    }

    /// Dispatch every queued delivery to the WebView, if one exists. Safe to call
    /// repeatedly (on `WCSession` activation, on `load(webview:)`). A delivery is
    /// removed from the queue only once its event has been dispatched; the file
    /// it names is owned by us and is deleted by the seal.
    public func flushIfPossible() {
        lock.lock()
        guard let webview = self.webview else {
            lock.unlock()
            return
        }
        let queued = pending
        pending.removeAll()
        lock.unlock()
        for delivery in queued {
            Self.dispatch(delivery, to: webview)
        }
    }

    /// Read + validate the manifest fields. `nil` when any is missing or the
    /// delivered URL is not a local file path.
    ///
    /// The session-id charset is deliberately ASCII-only and matches the Rust
    /// `is_session_id` exactly. It used to accept Unicode `isLetter`/`isNumber`
    /// and count `Characters`, while Rust counts bytes and accepts ASCII only, so
    /// a non-ASCII or 64-character id passed here and was refused there — a
    /// chunk silently lost between two validators that disagreed.
    private static func parse(file: WCSessionFile) -> (sourceURL: URL, sessionID: String, chunkIndex: UInt32, startedAt: UInt64)? {
        let metadata = file.metadata ?? [:]
        guard let sessionID = metadata[sessionIDKey] as? String,
              !sessionID.isEmpty,
              sessionID.count <= 64,
              sessionID.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }),
              let chunkIndex = (metadata[chunkIndexKey] as? NSNumber)?.uint32Value,
              let startedAt = (metadata[startedAtKey] as? NSNumber)?.uint64Value
        else {
            return nil
        }
        let url = file.fileURL
        guard url.isFileURL else { return nil }
        return (url, sessionID, chunkIndex, startedAt)
    }

    /// Move the delivered file into the app-owned inbox, synchronously, naming it
    /// with the delivery's metadata. Returns the durable URL, or `nil` on any
    /// failure. `moveItem` (not `copyItem`): the delivered file is consumed here,
    /// so a copy would leave a second plaintext file for the OS to reclaim on its
    /// own schedule.
    ///
    /// The name is `<session-id>.<chunk-index>.<started-at>.<uuid>`. Embedding the
    /// metadata is what makes the inbox re-scannable: the WatchConnectivity
    /// metadata is consumed the moment this delegate returns, so a seal that
    /// fails or never runs would otherwise leave a chunk with no way to recover
    /// its grouping. A session id is ASCII alphanumerics plus `-`/`_` and can
    /// never contain a `.`, so the fields split unambiguously; the Rust
    /// `seal_meeting_inbox` scan parses this exact shape
    /// (`core/src/plugins/captures/commands.rs::parse_meeting_inbox_name`).
    private static func moveIntoInbox(
        _ source: URL,
        sessionID: String,
        chunkIndex: UInt32,
        startedAt: UInt64
    ) -> URL? {
        guard let dir = inboxDir() else { return nil }
        let name = "\(sessionID).\(chunkIndex).\(startedAt).\(UUID().uuidString)"
        let dest = dir.appendingPathComponent(name)
        do {
            try FileManager.default.moveItem(at: source, to: dest)
            return dest
        } catch {
            return nil
        }
    }

    /// Dispatch one delivery as a `myne-meeting-chunk` CustomEvent. The detail is
    /// JSON-encoded with `JSONSerialization` rather than string interpolation, so
    /// a path containing a quote or backslash cannot break out of the literal.
    private static func dispatch(_ delivery: Delivery, to webview: WKWebView) {
        let detail: [String: Any] = [
            "path": delivery.path,
            sessionIDKey: delivery.sessionID,
            chunkIndexKey: delivery.chunkIndex,
            startedAtKey: delivery.startedAt,
        ]
        guard
            let data = try? JSONSerialization.data(withJSONObject: detail, options: []),
            let json = String(data: data, encoding: .utf8)
        else {
            return
        }
        let script =
            "window.dispatchEvent(new CustomEvent('myne-meeting-chunk', { detail: \(json) }));"
        DispatchQueue.main.async {
            webview.evaluateJavaScript(script, completionHandler: nil)
        }
    }
}
