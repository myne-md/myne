// SPDX-License-Identifier: AGPL-3.0-only
//
// iOS AVFoundation QR scanner for device-join via QR (MYND-466).
//
// The Swift half of `tauri-plugin-qr-scan`: the `scan` command opens a full-screen
// AVCaptureSession preview, reads the FIRST `.qr` metadata object, and resolves the
// invoke with `{ value: "<decoded string>" }` (or `{ value: nil }` on cancel). It
// returns ONLY the decoded string — all parsing / Damm-32 / freshness / pin-source
// selection happen in shared Rust (`myne_core::…::qr_join`), never here.
//
// Requires an on-device / Simulator build (Xcode) to compile + run — the macOS dev
// host cannot build the iOS Swift target. Camera use is gated by
// NSCameraUsageDescription (Info.plist) + the OS permission prompt.

import AVFoundation
import AudioToolbox
import Tauri
import UIKit
import WebKit

class ScanArgs: Decodable {}

class QrScanPlugin: Plugin {
  private var scannerController: ScannerViewController?

  @objc public func scan(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      AVCaptureDevice.requestAccess(for: .video) { granted in
        DispatchQueue.main.async {
          guard granted else {
            invoke.reject("camera permission denied")
            return
          }
          self.present(invoke)
        }
      }
    }
  }

  private func present(_ invoke: Invoke) {
    guard
      let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
      let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController
    else {
      invoke.reject("no window to present the scanner")
      return
    }

    let controller = ScannerViewController()
    controller.modalPresentationStyle = .fullScreen
    controller.onResult = { [weak self] result in
      controller.dismiss(animated: true) {
        switch result {
        case .code(let value):
          invoke.resolve(["value": value])
        case .cancelled:
          // Empty object → Rust `ScanResponse.value` defaults to None.
          invoke.resolve([:])
        case .failed(let message):
          invoke.reject(message)
        }
        self?.scannerController = nil
      }
    }
    self.scannerController = controller
    root.present(controller, animated: true)
  }
}

/// Full-screen camera preview that reports the first QR it reads.
private class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  enum Result {
    case code(String)
    case cancelled
    case failed(String)
  }

  var onResult: ((Result) -> Void)?

  private let session = AVCaptureSession()
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private var didReport = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    configureSession()
    addCancelButton()
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    if !session.isRunning {
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        self?.session.startRunning()
      }
    }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    if session.isRunning {
      session.stopRunning()
    }
  }

  private func configureSession() {
    guard
      let device = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input)
    else {
      report(.failed("no camera available"))
      return
    }
    session.addInput(input)

    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else {
      report(.failed("cannot read camera metadata"))
      return
    }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
    output.metadataObjectTypes = [.qr]

    let preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill
    preview.frame = view.layer.bounds
    view.layer.addSublayer(preview)
    previewLayer = preview
  }

  private func addCancelButton() {
    let button = UIButton(type: .system)
    button.setTitle("Cancel", for: .normal)
    button.setTitleColor(.white, for: .normal)
    button.titleLabel?.font = .systemFont(ofSize: 17, weight: .medium)
    button.translatesAutoresizingMaskIntoConstraints = false
    button.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    view.addSubview(button)
    NSLayoutConstraint.activate([
      button.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
      button.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
    ])
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer?.frame = view.layer.bounds
  }

  @objc private func cancelTapped() {
    report(.cancelled)
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard
      let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
      object.type == .qr,
      let value = object.stringValue
    else {
      return
    }
    // Haptic confirmation; report exactly once.
    AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
    report(.code(value))
  }

  private func report(_ result: Result) {
    guard !didReport else { return }
    didReport = true
    if session.isRunning {
      session.stopRunning()
    }
    onResult?(result)
  }
}

@_cdecl("init_plugin_qr_scan")
func initPlugin() -> Plugin {
  return QrScanPlugin()
}
