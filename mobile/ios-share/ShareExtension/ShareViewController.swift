// SPDX-License-Identifier: AGPL-3.0-only
//
// SF2 (MYND-510) — "Save to Myne" Share Extension, PLAINTEXT-STAGING design.
//
// This extension is intentionally PURE SWIFT with NO Rust and NO crypto. An
// earlier design sealed each file into the MYF1 queue in-process, but linking
// the Rust crypto dragged the whole tauri/wry runtime into a ~105 MB extension
// binary that the iOS app-extension sandbox kills on launch (flash-and-vanish).
// Instead — exactly like the Apple-Watch capture receiver (§9.18.4) — the
// extension writes each shared file's bytes (+ a `.meta` sidecar) as PLAINTEXT
// into the shared App-Group container's `pending-shares/staging/` dir, and the
// APP seals it into MYF1 + imports it on next open (`drain_pending_shares` →
// `seal_staged_in_dir`). The staged plaintext is protected at rest by iOS Data
// Protection, is device-local, and is never synced. Decision: user-approved
// reversal of ledger SYNC-2 (2026-07-16), matching the §9.18.4 carve-out.

import UIKit
import UniformTypeIdentifiers

/// Diagnostic log via NSLog so it lands in the DEVICE SYSLOG (visible in the
/// `tauri ios dev` terminal / `idevicesyslog`, and Console.app) — grep `MYNE-SHARE`.
///
/// DEBUG-only: some call sites pass a shared file's name / MIME / size, which are
/// confidential (they live inside the encrypted `MYF1` plaintext, `protocol.md`
/// §9.20.3). NSLog is unredacted and persists in the OS unified log, so in a
/// RELEASE build this must never fire — the whole body compiles out. Full
/// diagnostics remain for the on-device verification, which runs debug builds.
private func shareLogInfo(_ msg: String) {
    #if DEBUG
    NSLog("MYNE-SHARE %@", msg)
    #endif
}

/// Headless principal class for the Myne "Save to Myne" Share Extension
/// (`NSExtensionPrincipalClass`). Presents no UI (SYNC-13): it stages each shared
/// file into the App-Group container and completes immediately.
final class ShareViewController: UIViewController {

    /// The App-Group identifier — MUST match `share_import_ffi::APP_GROUP_ID`
    /// and the `com.apple.security.application-groups` entry in BOTH targets'
    /// `.entitlements`. The OS resolves the shared container from it.
    private static let appGroupID = "group.md.myne.mobile"

    /// Queue subtree under the App-Group container — MUST match the shared-core
    /// `queue.rs` (`QUEUE_DIR` = "pending-shares", `STAGING_SUBDIR` = "staging").
    private static let queueSubdir = "pending-shares"
    private static let stagingSubdir = "staging"

    /// Acceptance cap (SYNC-15). The extension now only COPIES bytes (no seal),
    /// so its memory pressure is one file's bytes — but keep a cap below the
    /// 64 MiB MYF1 codec cap so the app's later seal never rejects an oversize
    /// staged file. 48 MiB covers the overwhelming majority of shared photos/PDFs.
    private static let maxShareBytes = 48 * 1024 * 1024

    /// Type identifiers we accept, in priority order (most specific first). Kept
    /// in lockstep with the `NSExtensionActivationRule` in `Info.plist`
    /// (public.image + com.adobe.pdf + public.data, multi-item — SYNC-14).
    private static let acceptedTypes = [UTType.pdf, UTType.image, UTType.data]

    private var sawOversize = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        processAndComplete()
    }

    /// Stage every shared attachment as plaintext, then complete the request.
    private func processAndComplete() {
        guard
            let containerURL = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: Self.appGroupID)
        else {
            shareLogInfo("NO App-Group container for \(Self.appGroupID) — entitlement/provisioning missing")
            complete()
            return
        }
        let stagingURL = containerURL
            .appendingPathComponent(Self.queueSubdir, isDirectory: true)
            .appendingPathComponent(Self.stagingSubdir, isDirectory: true)
        shareLogInfo("staging dir: \(stagingURL.path)")

        do {
            try FileManager.default.createDirectory(at: stagingURL, withIntermediateDirectories: true)
        } catch {
            shareLogInfo("could not create staging dir: \(error.localizedDescription)")
            complete()
            return
        }

        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
        shareLogInfo("providers: \(providers.count)")

        guard !providers.isEmpty else {
            complete()
            return
        }

        let group = DispatchGroup()
        for provider in providers {
            guard let type = Self.acceptedTypes.first(where: {
                provider.hasItemConformingToTypeIdentifier($0.identifier)
            }) else {
                continue
            }
            group.enter()
            provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { [weak self] data, err in
                defer { group.leave() }
                guard let self else { return }
                if let err {
                    shareLogInfo("loadDataRepresentation FAILED for \(type.identifier): \(err.localizedDescription)")
                    return
                }
                guard let data, !data.isEmpty else {
                    shareLogInfo("loadDataRepresentation EMPTY data for \(type.identifier)")
                    return
                }
                self.stage(data: data, type: type, provider: provider, stagingURL: stagingURL)
            }
        }

        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            if self.sawOversize {
                self.showTooLargeAndComplete()
            } else {
                self.foregroundApp()
                self.complete()
            }
        }
    }

    /// Write one file's bytes + a `.meta` sidecar into `staging/` as plaintext.
    /// The app's `seal_staged_in_dir` reads the pair, seals into MYF1, and deletes
    /// the plaintext. Sidecar format: `"<mime>\n<filename>"` (filename is the
    /// remainder after the first newline). Bytes written FIRST, then the sidecar,
    /// so a crash between them leaves a byte file with no meta (the app defaults
    /// filename/octet-stream) rather than a meta pointing at nothing.
    private func stage(data: Data, type: UTType, provider: NSItemProvider, stagingURL: URL) {
        if data.count > Self.maxShareBytes {
            sawOversize = true
            return
        }
        let ext = type.preferredFilenameExtension
        let base = provider.suggestedName ?? "shared"
        let filename = (ext.map { "\(base).\($0)" }) ?? base
        let mime = type.preferredMIMEType ?? "application/octet-stream"
        let id = UUID().uuidString
        let byteURL = stagingURL.appendingPathComponent(id)
        let metaURL = stagingURL.appendingPathComponent("\(id).meta")

        do {
            // `.completeFileProtection` → encrypted at rest by iOS while the
            // device is locked (the plaintext-at-rest protection for the staging
            // window, §9.18.4-class).
            try data.write(to: byteURL, options: [.atomic, .completeFileProtection])
            let meta = Data("\(mime)\n\(filename)".utf8)
            try meta.write(to: metaURL, options: [.atomic, .completeFileProtection])
            shareLogInfo("STAGED \(filename) (\(mime), \(data.count) B) → \(id)")
        } catch {
            shareLogInfo("STAGE FAILED \(filename): \(error.localizedDescription)")
            try? FileManager.default.removeItem(at: byteURL)
        }
    }

    /// SYNC-15: tell the user we could not accept an oversized file, then finish.
    private func showTooLargeAndComplete() {
        let alert = UIAlertController(
            title: "File too large to share",
            message: "This file is too large to save to Myne. Try a smaller file.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
            self?.complete()
        })
        present(alert, animated: true)
    }

    /// SYNC-12: best-effort foreground of the Myne app so the user can unlock and
    /// the app drains the staged file promptly. `extensionContext.open` is
    /// historically FRAGILE for share extensions; if it no-ops, the staged file is
    /// simply picked up on the next ordinary app open — the queue is durable, so
    /// the feature degrades gracefully with zero data loss.
    private func foregroundApp() {
        guard let url = URL(string: "myne://open") else { return }
        extensionContext?.open(url, completionHandler: nil)
    }

    private func complete() {
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
}
