// swift-tools-version:5.3
import PackageDescription

// Tauri iOS plugin package (MYND-466). Mirrors the standard Tauri 2 mobile-plugin
// package layout: a static library that depends on the generated `Tauri` Swift
// API package (materialized at `../.tauri/tauri-api` during the iOS build).
let package = Package(
    name: "tauri-plugin-qr-scan",
    platforms: [
        .iOS(.v13)
    ],
    products: [
        .library(
            name: "tauri-plugin-qr-scan",
            type: .static,
            targets: ["tauri-plugin-qr-scan"]
        )
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-qr-scan",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources"
        )
    ]
)
