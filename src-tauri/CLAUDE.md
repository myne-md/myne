# src-tauri/ — Tauri 2 host (Rust)

> Subdirectory CLAUDE.md. Loaded when Claude reads files here. See repo-root `CLAUDE.md` for project-wide context.

## Stack

- Tauri 2, Rust 1.90.0 (pinned in `rust-toolchain.toml` at workspace root)
- Crate name `myne_desktop_lib` — **`_lib` suffix is required** to avoid Windows lib-vs-bin collision (rust-lang/cargo#8519). Don't rename.
- `src-tauri/src/main.rs` calls into `myne_desktop_lib`. Most logic should live in the lib, not the bin.

## Frontend coupling (don't break)

`tauri.conf.json` declares:
- `beforeDevCommand: "pnpm dev"`
- `beforeBuildCommand: "pnpm build"`

**pnpm only.** Switching to npm/yarn here breaks Tauri's lifecycle hooks. The pnpm version is pinned by `.nvmrc` at repo root (Node 25.9.0).

## Capability ACL — security-load-bearing

`capabilities/default.json` declares the permission set for the main window. Tauri 2's permission system is **opt-in per command**:
- Adding a new Tauri plugin → permission entry required
- Adding a new `#[command]` invoke handler → permission entry required
- Adding clipboard / dialog / fs access → scope-restricted permission required

Never add `core:default` plus a wide allowlist; prefer named, narrow permissions. Treat changes here as security-relevant — they widen the attack surface from the WebView side (TB6).

Current entries include `vault-creation:default` (the vault-creation flow plugin) and scoped clipboard/dialog/fs entries — see file for the full list.

## Plugin pattern

Multi-step flows live as Tauri plugins under `src/plugins/<flow-name>/`:
- `mod.rs` — plugin builder + handler registration
- `commands.rs` — `#[command]` async functions
- `state.rs` — session/cache state with TTL eviction
- `error.rs` — `serde::Serialize` error enum (matched on TS side)

Reference: `src/plugins/vault_creation/` — implements the begin/commit/cancel session pattern (`decisions.md` 2026-04-28 "Vault creation flow: backend session pattern; root_key never crosses IPC"). New flows that need to keep secrets server-side should follow the same shape.

## Atomic file writes

`src/atomic_write.rs` — write-to-temp + rename-into-place pattern; on Windows the destination is replaced explicitly (see commit 529e532 "Fix: atomic_write replaces existing destination on Windows"). Use this for any persistent state (vault.meta, .myn blobs, settings).

## Paths

`src/paths.rs` — derive `vault_dir` from `app_data_dir()/vault/` per `decisions.md` 2026-04-28 "Vault path: app_data_dir/vault/, single vault per OS user in Phase 1". Don't hardcode user paths.

## Common commands

```bash
cargo check -p myne_desktop_lib
cargo clippy -p myne_desktop_lib --all-targets -- -D warnings
pnpm tauri dev          # full app loop (from repo root)
pnpm tauri build        # production bundle (from repo root)
```

## Gotchas

- Tauri's `#[command]` async fns must be `Send` — anything in their state must satisfy `Send + Sync` (use `tokio::sync::Mutex`, not `std::sync::Mutex`, when an `.await` happens while locked).
- The Tauri WebView is Chromium on Windows/Linux, WKWebView on macOS — feature parity is not exact (storage quotas, font rendering). Test the macOS WKWebView path before assuming Chromium-only behavior.
- `tauri::api::path::app_data_dir()` resolves differently in dev vs production. In dev it lands under the dev identifier; production uses the bundle identifier. Don't write to absolute paths.
