// SPDX-License-Identifier: AGPL-3.0
import Foundation
import WatchConnectivity

/// iPhone-side WatchConnectivity receiver for watch-dictated captures. Owns the
/// single `WCSession.default` delegate (there is one delegate slot — nothing else
/// in this app claims it). On `didReceiveUserInfo` it writes the plaintext to the
/// app's pending-capture **staging** dir with Data Protection, for the Rust
/// `captures` plugin to seal into the encrypted `MYK1` queue (§9.18). It runs NO
/// crypto and holds NO key — it only stages plaintext; the Rust seal + the JS
/// drainer do the rest.
///
/// `@objc(WCCaptureReceiver)` fixes the ObjC runtime name (no module prefix) so
/// the `+load` bootstrap (`WCCaptureReceiverBootstrap.m`) can start it via
/// `NSClassFromString("WCCaptureReceiver")` — the app has no Swift AppDelegate to
/// hang this off (the entry is `main.mm` → Rust).
///
/// Staging-dir parity is RESOLVED (verified against tauri 2.11.2 source): Tauri
/// v2's iOS `app_data_dir()` = `dirs::data_dir()/<bundle id>` (the iOS path
/// resolver falls through the non-android/desktop backend, which joins
/// `config.identifier`), so `stagingDir()` appends `Bundle.main.bundleIdentifier`
/// to match the Rust queue exactly. ⚠️ DEVICE-VERIFY (see `ios-watch/README.md`):
/// prompt sealing while foregrounded relies on the JS focus/visibility re-seal,
/// and the `+load` receiver must actually activate on this build.
@objc(WCCaptureReceiver)
public final class WCCaptureReceiver: NSObject, WCSessionDelegate {
    @objc public static let shared = WCCaptureReceiver()

    /// MUST match `WatchConnectivityClient.captureKey`.
    static let captureKey = "capture"

    private override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    /// `<app_data_dir>/pending-captures/staging/` — MUST match the Rust queue
    /// (`QUEUE_DIR` = "pending-captures", `STAGING_SUBDIR` = "staging"). Tauri v2's
    /// iOS `app_data_dir()` = `dirs::data_dir()/<bundle id>` = `…/Library/Application
    /// Support/md.myne.mobile` (verified against tauri 2.11.2 `path/desktop.rs`,
    /// which iOS uses). iOS `FileManager.applicationSupportDirectory` is NOT nested
    /// under the bundle id, so we append `Bundle.main.bundleIdentifier` to match.
    private func stagingDir() -> URL? {
        guard let appSupport = try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ), let bundleID = Bundle.main.bundleIdentifier else { return nil }
        let dir = appSupport
            .appendingPathComponent(bundleID, isDirectory: true)
            .appendingPathComponent("pending-captures", isDirectory: true)
            .appendingPathComponent("staging", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func stage(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let dir = stagingDir(), let data = trimmed.data(using: .utf8) else {
            return
        }
        let url = dir.appendingPathComponent(UUID().uuidString)
        // completeUntilFirstUserAuthentication: encrypted at rest while the device
        // is locked, but readable in the background after first post-boot unlock so
        // the Rust seal can run (§9.18.4 transient carve-out).
        try? data.write(to: url, options: [.completeFileProtectionUntilFirstUserAuthentication])
    }

    // MARK: WCSessionDelegate
    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        if let text = userInfo[WCCaptureReceiver.captureKey] as? String {
            stage(text: text)
        }
    }

    public func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {}

    public func sessionDidBecomeInactive(_ session: WCSession) {}

    public func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate so the phone keeps receiving after a watch switch.
        WCSession.default.activate()
    }
}
