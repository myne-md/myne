// swift-tools-version:5.3
import PackageDescription

// Tauri iOS plugin package (myne-md/myne#390). Mirrors the standard Tauri 2
// mobile-plugin package layout: a static library depending on the generated
// `Tauri` Swift API package (materialized at `../.tauri/tauri-api` during the
// iOS build).
//
// iOS 13 floor matches the sibling plugins. The two pasteboard options this
// plugin's whole design rests on need more: `.expirationDate` and `.localOnly`
// are iOS 10+, so the floor is not the constraint there — the constraint is that
// the RECOVERY-PHRASE Copy is gated to iOS 16+ on the client side, for the
// separate reason that the system paste prompt behaviour the design assumes is
// what shipped then.
let package = Package(
    name: "tauri-plugin-sensitive-clipboard",
    platforms: [
        .iOS(.v13)
    ],
    products: [
        .library(
            name: "tauri-plugin-sensitive-clipboard",
            type: .static,
            targets: ["tauri-plugin-sensitive-clipboard"]
        )
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-sensitive-clipboard",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources"
        )
    ]
)
