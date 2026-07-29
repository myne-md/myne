// swift-tools-version:5.3
import PackageDescription

// Tauri iOS plugin package (MYND-619). Mirrors the standard Tauri 2
// mobile-plugin package layout — and `tauri-plugin-qr-scan`'s, which is the
// in-repo precedent: a static library depending on the generated `Tauri` Swift
// API package (materialized at `../.tauri/tauri-api` during the iOS build).
let package = Package(
    name: "tauri-plugin-reminders",
    platforms: [
        .iOS(.v13)
    ],
    products: [
        .library(
            name: "tauri-plugin-reminders",
            type: .static,
            targets: ["tauri-plugin-reminders"]
        )
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-reminders",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources"
        )
    ]
)
