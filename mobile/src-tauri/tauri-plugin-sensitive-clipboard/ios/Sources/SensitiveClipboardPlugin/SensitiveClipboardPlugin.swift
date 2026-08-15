// SPDX-License-Identifier: AGPL-3.0
//
// iOS clipboard writes, with OS-enforced sensitivity for secrets
// (myne-md/myne#390 + myne-md/myne#455).
//
// The Swift half of `tauri-plugin-sensitive-clipboard`. Three commands:
// `writeText` at a caller-declared tier, and `readText`.
//
// # The two options are a PAIR, and that is the whole design
//
// A secret write sets BOTH `.localOnly` and `.expirationDate`, always, and there
// is deliberately no code path here that sets one without the other.
//
// `.localOnly` keeps the item off Universal Clipboard. Without it, twenty-four
// recovery words copied on a phone appear on the user's nearby Mac and iPad.
//
// `.expirationDate` has the OS drop the item. That beats a JavaScript timer twice
// over: it survives the app being killed, which mobile does aggressively, and it
// expires THAT item, so it can never destroy something the user copied
// afterwards — which a read-compare-clear can only approximate, and only by
// holding a clipboard READ grant nobody should have.
//
// They are not independent. With `.localOnly` false, the expiry applies to the
// local pasteboard but not reliably to Universal Clipboard: the data stays
// pasteable on nearby devices well after it expires. Setting the expiry alone is
// therefore not a weaker version of this, it is a hole.
//
// # A plain write sets neither
//
// A user copying a note may legitimately want it on their Mac, and expiring their
// note out from under them thirty seconds later would be a bug wearing a
// security feature's clothes.
//
// # Requires a device or Simulator build
//
// The macOS dev host cannot build this target, and macOS has never supported
// expiring pasteboard items at all, which is the other reason this mechanism is
// mobile-only and the desktop client keeps its host-side compare-and-clear.

import Foundation
import Tauri
import UIKit
import WebKit

/// Matches the Rust `WriteArgs`. `sensitivity` arrives as the serde-lowercased
/// `"plain"` / `"secret"`; the Rust crate has a unit test pinning those exact
/// strings, because a rename there would compile clean on both sides and silently
/// downgrade every secret write to a plain one.
class WriteArgs: Decodable {
  let value: String
  let sensitivity: String
  let expireAfterSecs: UInt32
}

class ReadArgs: Decodable {}

class SensitiveClipboardPlugin: Plugin {
  /// The tier string the Rust side sends for a credential.
  private static let secretTier = "secret"

  @objc public func writeText(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(WriteArgs.self)

    // The pasteboard is main-thread work.
    DispatchQueue.main.async {
      let type = Self.plainTextTypeIdentifier()
      let item: [String: Any] = [type: args.value]

      if args.sensitivity == Self.secretTier {
        // BOTH options, together. See the file header for why setting only the
        // expiry is a hole rather than a weaker version of this.
        let expiry = Date().addingTimeInterval(TimeInterval(args.expireAfterSecs))
        UIPasteboard.general.setItems(
          [item],
          options: [
            .localOnly: true,
            .expirationDate: expiry,
          ]
        )
      } else {
        // Ordinary content: no confinement, no expiry. Copying a note to paste on
        // another device is a thing people do on purpose.
        UIPasteboard.general.setItems([item], options: [:])
      }

      invoke.resolve()
    }
  }

  @objc public func readText(_ invoke: Invoke) throws {
    _ = try invoke.parseArgs(ReadArgs.self)

    DispatchQueue.main.async {
      // `nil` when the pasteboard holds no text at all (an image, a file, or
      // nothing). Resolved as an absent value rather than an empty string,
      // because a paste button acting on `""` would clear the field the user was
      // trying to fill — on the recovery screen, that means deleting words they
      // had already typed.
      //
      // On iOS 16 and later this read is what triggers the system "Allow Paste?"
      // prompt, which is a feature here rather than an obstacle: the user
      // confirms the app may see the clipboard, per read, and the app holds no
      // ambient access.
      let text = UIPasteboard.general.string
      if let text {
        invoke.resolve(["value": text])
      } else {
        invoke.resolve([:])
      }
    }
  }

  /// The plain-text pasteboard type.
  ///
  /// Written as the literal UTI rather than reached through `UTType`
  /// (`UniformTypeIdentifiers`, iOS 14+) or `kUTTypeUTF8PlainText`
  /// (`MobileCoreServices`, deprecated). The string is the stable public
  /// identifier, identical on every iOS version this package targets, so the
  /// availability branch those two spellings would need buys nothing and the
  /// second of them is deprecated on the very versions it exists to serve.
  private static func plainTextTypeIdentifier() -> String {
    "public.utf8-plain-text"
  }
}

@_cdecl("init_plugin_sensitive_clipboard")
func initPlugin() -> Plugin {
  return SensitiveClipboardPlugin()
}
