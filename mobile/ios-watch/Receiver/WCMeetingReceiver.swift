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
/// # Why this does NOT stage plaintext (the one real difference)
///
/// `WCCaptureReceiver.stage(text:)` writes a plaintext file into
/// `pending-captures/staging/` because the Rust `seal_staged` runs later, on
/// boot / on the JS `capture` event. This receiver must not: it hands the
/// file WatchConnectivity already placed in the app's inbox **straight to the
/// sealing command** (`plugin:captures|seal_meeting_chunk`), which reads the
/// audio, seals it under the device-local share-import wrap key into
/// `pending-captures/meetings/entries/`, and deletes the source. We never write
/// our own plaintext copy, so the only plaintext on disk is the OS-delivered
/// inbox file, and it is deleted the moment the seal resolves (task 2's
/// `seal_meeting_chunk_from_file`).
///
/// # The bridge, and why it is the WebView
///
/// A plain Swift class compiled into the Tauri app cannot invoke a Rust
/// `#[tauri::command]` directly (Tauri's mobile plugin bridge only goes
/// Rust → native → a `Channel`, never native → Rust), and re-running the AEAD
/// in Swift would be a second crypto codebase. So the receiver dispatches a
/// `myne-meeting-chunk` CustomEvent into the app's WebView
/// (`PluginManager.shared.viewController`), and `mobile/src/lib/captures.ts`
/// listens and calls the device-key-based command. The seal therefore runs while
/// the vault is LOCKED, exactly as it does for the dictated queue.
///
/// # Cold background launch
///
/// A `didReceive file:` delivery can fire before the WebView is created (a cold
/// background launch, or the moment the app is relaunched by
/// WatchConnectivity). The delivery is therefore QUEUED in memory and flushed
/// the first time the WebView becomes available (`flushIfPossible`, retried on
/// session activation). WatchConnectivity's `transferFile` is durable: an
/// undelivered transfer the app never consumes is re-delivered on the next
/// launch, so a crashed process costs one retry rather than a lost chunk.
@objc(WCMeetingReceiver)
public final class WCMeetingReceiver: NSObject {
    @objc public static let shared = WCMeetingReceiver()

    /// The `transferFile` metadata keys the watch sends (task 7) and this
    /// receiver reads. MUST stay in step with the watch's chunker.
    static let sessionIDKey = "session_id"
    static let chunkIndexKey = "chunk_index"
    static let startedAtKey = "started_at"

    /// A delivery that could not be dispatched yet (no WebView), kept verbatim
    /// until one exists. The file itself is NOT retained — it stays where the OS
    /// put it (the app inbox) until the seal consumes it.
    private struct Delivery {
        let path: String
        let sessionID: String
        let chunkIndex: UInt32
        let startedAt: UInt64
    }

    private let lock = NSLock()
    private var pending: [Delivery] = []

    private override init() {
        super.init()
    }

    /// Handle one `transferFile` delivery. Returns immediately; the seal happens
    /// in the WebView as soon as it is available.
    public func handle(file: WCSessionFile) {
        guard let delivery = Self.parse(file: file) else {
            // A malformed / foreign delivery is dropped, never sealed: without a
            // session id and index it could not be grouped into a meeting.
            return
        }
        lock.lock()
        pending.append(delivery)
        lock.unlock()
        flushIfPossible()
    }

    /// Dispatch every queued delivery to the WebView, if one exists. Safe to call
    /// repeatedly (on `WCSession` activation, on the next delivery). A delivery is
    /// removed from the queue only once its event has been dispatched.
    public func flushIfPossible() {
        guard let webview = Self.webview() else { return }
        lock.lock()
        let queued = pending
        pending.removeAll()
        lock.unlock()
        for delivery in queued {
            Self.dispatch(delivery, to: webview)
        }
    }

    /// Read + validate the manifest fields. `nil` when any is missing or the
    /// file URL is not a local file path.
    private static func parse(file: WCSessionFile) -> Delivery? {
        let metadata = file.metadata ?? [:]
        guard let sessionID = metadata[sessionIDKey] as? String,
              !sessionID.isEmpty,
              // The Rust manifest rejects anything that could name a parent
              // directory; refuse the same shape here so a hostile payload never
              // reaches the command.
              sessionID.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }),
              sessionID.count <= 64,
              let chunkIndex = (metadata[chunkIndexKey] as? NSNumber)?.uint32Value,
              let startedAt = (metadata[startedAtKey] as? NSNumber)?.uint64Value
        else {
            return nil
        }
        let path = file.fileURL.path
        guard !path.isEmpty else { return nil }
        return Delivery(path: path, sessionID: sessionID, chunkIndex: chunkIndex, startedAt: startedAt)
    }

    /// The app's WebView, if it has been created. `PluginManager` is Tauri's
    /// public iOS bridge; its `viewController` is the WKWebView host.
    private static func webview() -> WKWebView? {
        guard let controller = PluginManager.shared.viewController else { return nil }
        return controller.view as? WKWebView
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
