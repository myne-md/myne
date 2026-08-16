# core/ — `myne-core`, the shared backend crate (Rust)

> Subdirectory CLAUDE.md. Loaded when Claude reads files here. See repo-root `CLAUDE.md` for project-wide context, `src-tauri/CLAUDE.md` for the desktop host (its **secret-handling logging discipline is normative for this crate too**), and `protocol/CLAUDE.md` for the primitives underneath.

## What this crate is

The plugin **cores** — command bodies, session/cache state, error enums — plus the crate-root helpers they share. Extracted from the desktop crate so vault / notes / prefs logic has one source of truth instead of one copy per client. It is the largest Rust crate in the repo, and it is the crate you are most likely in when you thought you were editing `src-tauri/`.

Three clients consume it, and each supplies its own edges:

| Consumer | How | What it supplies |
|---|---|---|
| `myne-desktop` (`src-tauri/`, this repo) | path dep + `pub use myne_core::…` re-exports at the lib root | `DesktopHooks`, the real `init()` shims, the capability ACL |
| `myne-mobile` (`mobile/src-tauri/`, this repo) | path dep `myne-core = { path = "../../core" }` | `MobileHooks`, its own `init()` shims, its own ACL |
| `myne-web-wasm` (`web/wasm/`, this repo) | path dep with `default-features = false` | `WebHooks`, `WebHost`, `OpfsVaultIo`, a Worker command router instead of `generate_handler!` |

**What does NOT live here:** the `tauri::Builder` app wiring, `generate_handler!` registration, capability/permission ACLs, and any plugin with no cross-client meaning (`backup`, `clipper_pairing`, `importer`, `local_inference`, `pdf_export`, `vault_repair`, `spell`, `clipper` — all desktop-side). The crate-level docs in `src/lib.rs` and `src/plugins/mod.rs` restate this split; keep them true.

## The three seams

Everything host-specific goes through a seam, because the failure mode this crate is exposed to is not a compile error. `SystemTime::now()`, `tokio::task::spawn_blocking` and `std::fs` all **compile for `wasm32-unknown-unknown` and then panic at runtime**: the build goes green, every gate passes, and the first note the user saves kills the Worker. A trait is the only thing that catches that class.

| Seam | Module | Abstracts | Native impl | Browser impl |
|---|---|---|---|---|
| `HostCtx` | `src/host.rs` | `app_data_dir` / `app_config_dir`, event emission, wall + monotonic clocks, the KDF-memory ceiling, `sole_vault_id` | `TauriHost` (cfg-gated on `tauri-ipc`) | `WebHost` (`web/wasm/src/host.rs`) |
| `VaultIo` | `src/vault_io.rs` | the filesystem | `StdVaultIo` | `OpfsVaultIo` / `RawOpfs` |
| `run_blocking` / `sleep` / `yield_now` | `src/task.rs` | blocking execution and timers (free fns, target-split — not a trait) | delegates to tokio verbatim | runs the closure inline in the Worker |

Rules that travel with them:

- **`&dyn`, never a generic parameter.** `<R: Runtime>` already infects the Tauri wrappers; swapping it for `<H: HostCtx>` would leave every signature just as viral. `&dyn` keeps ported fns non-generic, which is what lets the commands that need no host keep zero host parameters.
- **`VaultIo` returns `IoFailureKind`, never `std::io::Error`.** Not ergonomics — `io::Error`'s `Display` carries the path on some kernels, and this crate's errors reach a browser page. The closed enum has no field that could hold one.
- **`VaultIo` is `#[async_trait]`.** Forced, not chosen: OPFS handle acquisition is asynchronous and a Worker cannot block on a promise. The `Send` bound is target-split (native futures cross tokio threads; wasm futures hold `JsValue`).
- Read the module-level doc before adding a method. Each one records *why* it is on the seam, and the reasons are load-bearing (`now_unix_millis` is the primitive and `now_unix_secs` is derived, because deriving the other way silently coarsens the prefs LWW field clocks).

## The hooks seam (desktop-only side effects)

`src/hooks.rs` — `VaultLifecycleHooks` is the fourth seam, one axis over: not "what the host provides" but "what a side effect does". A shared core that needs to touch the search index, the spell dictionary, the snapshot store, the AI vector store or screen-capture protection calls a hook method instead of reaching for a client type. `Hooks = Arc<dyn VaultLifecycleHooks>`, taken by commands as `State<'_, Hooks>`.

Object-safe by construction: no generic methods, and async methods return a hand-rolled `BoxFuture` (the `async-trait` desugaring, written out) so the trait stays `R`-free without a dependency. `BoxFuture` is `Send` on native and `?Send` on `wasm32` — a storage-touching hook awaits a `VaultIo` future, and the browser arm's OPFS handles are pinned to their Worker thread.

**Adding a hook method is four edits, in this order:** the trait method here → the `NoopHooks` no-op here (headless callers inherit it) → `DesktopHooks` in `src-tauri/src/hooks.rs` → `WebHooks` in `web/wasm/src/hooks.rs` → `MobileHooks` in `mobile/src-tauri/src/hooks.rs`. **All four are in this repo and fail the build together.** Until 2026-08-13 the last one was in a separate repository and went red only after the change had landed on `develop`, so a breaking trait or shared-type change owed a companion PR that nothing here enforced; that is no longer true, and the old procedure is gone rather than merely discouraged.

The trait is deliberately scoped to note-CRUD + unlock/lock. Hooks that fire only inside a desktop-only plugin do not belong here.

## Plugin cores

`src/plugins/<flow>/` — the same shape in every directory: `commands.rs`, `state.rs` (when the flow has session or cache state), `error.rs`, `mod.rs`. The full list is `src/plugins/mod.rs`; today it is:

| Plugin | Owns |
|---|---|
| `attachments` | attachment crypto pipeline (`MYA1`/`MYC1`), sniffing, ref-scan, OCR + text-extraction cache |
| `captures` | `MYK1` watch-dictation queue drained on unlock — mobile-only |
| `export` | whole-vault plaintext markdown-tree export — native-only |
| `graph_layout` | `vault.graph` (`MYG1`) layout cache read/write |
| `notes` | per-note CRUD + listing, title extraction, drawing-text projection |
| `prefs` | `vault.prefs` (`MYP1`) read + the per-field setters |
| `quick_unlock` | PIN + biometric wrap-key paths (`MYQ1`); `apple.rs` is macOS/iOS-gated |
| `secret_export` | the single narrow-seam `save_secret_text` write |
| `share_import` | `MYF1` OS-share-sheet staging queue — mobile-only |
| `snapshots` | list / preview / restore / prune over encrypted note history |
| `sync` | the whole Phase 2 client engine: transport, SCRAM enroll, cycle, reconcile, conflict, device roster |
| `themes` | `vault.themes` (`MYT1`) custom-palette store, validated through `theme-validator` |
| `vault_change_password` | `change_password` rotation |
| `vault_creation` | begin / commit / cancel session flow — **and its own `init()`**, see below |
| `vault_delete` | one-shot vault destruction |
| `vault_indices` | in-RAM wikilink graph, backlinks, tags, typed properties (`MYI1`) |
| `vault_recover` | phrase recovery — compiles for BOTH targets since 2026-08-15 (entry 0514) |
| `vault_unlock` | the `UnlockedVault` slot, unlock/lock, status probes, storage health |
| `workspace` | `vault.workspace` (`MYW1`) pane tree + the RAM-only stage |

Alongside them at the crate root: `search/` (the `MYS1` full-text engine + its encrypted persistence — shared, though only desktop feeds it), `atomic_write`, `paths`, `io_failure_kind`, `protocol_error_kind`, `vault_registry`, `vault_sweep`, `vault_id`, `vault_label` (the `MYL1` sealed label store: the per-vault keychain key + the device-local file the LOCKED picker reads a vault's name from), `vault_meta_hash`, `note_txn`, `note_nonce`, `attachment_nonce`, `export_naming`, `snapshot_store` + `snapshot_policy`, `text`, `singleton` + `double_buffer` (the web client's crash-recoverable container).

### Command shape — three layers

A command in this crate is written as three functions, and the split is what makes it testable and portable:

```rust
// 1. The core. Takes its host, state and IO as ordinary parameters.
pub async fn note_create_from_host(
    host: &dyn HostCtx, state: &VaultRuntimeState, hooks: &Hooks,
    plaintext: String, io: &dyn VaultIo,
) -> Result<String, NoteCreateError> { /* … */ }

// 2. The IPC wrapper. Thin, and compiled only for a Tauri host.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn note_create<R: Runtime>(
    app: AppHandle<R>, state: State<'_, VaultRuntimeState>,
    hooks: State<'_, Hooks>, plaintext: String,
) -> Result<String, NoteCreateError> {
    note_create_from_host(&TauriHost::new(app), state.inner(), hooks.inner(),
                          plaintext, &StdVaultIo).await
}

// 3. The inner. Takes resolved paths, so a test drives the whole pipeline
//    (slot guard → AEAD → atomic_write) under a ScopedTempDir with no runtime.
pub async fn note_create_with_dir(notes_dir: PathBuf, /* … */) -> Result<String, NoteCreateError>
```

Layer 2 is what the `tauri-ipc` feature gates: both native hosts keep their `generate_handler!` lines unchanged, and a future consumer that wants core without Tauri turns the feature off rather than refactoring — that release valve only exists because layer 1 does.

### Where commands get registered

**Not here, with one exception.** Each client owns its own `init()` + `generate_handler!` + capability shim: `src-tauri/src/plugins/<flow>/mod.rs` on desktop, the mirror path in `myne-mobile`, and a Worker-side dispatcher (`web/wasm/src/dispatch.rs`) in the browser. The core `mod.rs` files carry no handler list — the closing NOTE in `src/plugins/sync/mod.rs` states the rule.

The exception is **`vault_creation`**, whose entire plugin (its `init()`, `generate_handler!` and TTL evictor) lives in `src/plugins/vault_creation/mod.rs`; `src-tauri/src/plugins/mod.rs` only re-exports it and there is no desktop directory for it at all. Do not generalize from that file when adding a plugin.

Adding a command therefore means edits in this crate **and** in each client that should expose it. The desktop-side checklist (build.rs namespace, `permissions/<plugin>/default.toml`, capability bundle, `generate_handler!`) is in `src-tauri/CLAUDE.md`; nothing verifies that the two halves agree, and a command added here alone ships dead.

## Error modelling

- **One closed `serde::Serialize` enum per command**, hand-mirrored on the TS side. `#[serde(tag = "kind", content = "detail")]`, `thiserror` for `Display`. Separate enums per command rather than one per plugin, so an `Err` from `note_create` cannot type-narrow to `NoteReadError`.
- **No `String` field ever reaches the frontend.** IO collapses to `IoFailureKind` (`PermissionDenied` / `NotFound` / `NoSpace` / `Other`); `ProtocolError` goes through the `protocol_error_kind(&ProtocolError) -> &'static str` helper, which compile-fails on a new variant.
- **Non-distinguishing by design where the spec says so.** `NoteReadError::CannotDecrypt` is a single tag for AEAD failure (`protocol.md` §6.4); the internal cause goes to `tracing::debug!` inside the codec and never crosses IPC.
- Adding a variant is an IPC contract change: update the TS mirror in the same commit.

## Examples (fixture generators)

`examples/` holds four binaries, all of them serving the web E2E lane — two emit deterministic fixture bytes the lane cannot produce for itself, two stand up the live account it signs into:

```bash
# Deterministic fixtures — require the `test-support` feature (declared in
# Cargo.toml as `required-features`, so --all-targets SKIPS them without it).
cargo run -p myne-core --features test-support --example emit-double-buffer-fixtures \
  > e2e-web/fixtures/double-buffer.json
cargo run --release -p myne-core --features test-support --example emit-vault-fixture \
  > e2e-web/fixtures/unlockable-vault.json

# Live-server seeders — no feature needed; they talk to a real sync server.
cargo run --release --example seed-account   -- <server-url> <password> <leaf-cert-sha256-hex>
cargo run --release --example approve-device -- <server-url> <account-number> <recovery-phrase> <leaf-cert-sha256-hex>
```

The emitters drive the **real** writers with the same `Fault` injection the unit tests use. The point is that a fixture hand-assembled in TypeScript would encode a second opinion about the container framing, and the moment it drifted the lane would be testing recovery from a shape production never produces — a failure that looks like a passing test. Their output is checked in (the browser lane cannot run cargo); re-running the emitter is what keeps it honest.

The seeders take the TLS pin as an **argument** rather than fetching it: the native transport verifies only against pins it was given, and a seeder that silently accepted any certificate would be a worse example than none.

## Feature flags

- **`default = ["tauri-ipc"]`** — compiles the `#[tauri::command]` wrappers and the `TauriHost` adapter. A wasm build never enables it (the `tauri` dep is target-gated out of the wasm arm anyway); `web/wasm` takes the crate with `default-features = false`.
- **`test-support`** — gates `test_support` (`ScopedTempDir`, `block_on`, seeded vault fixtures) and `double_buffer_fixtures` so clients can pull them as a dev-dependency while production builds never compile them. Both fixture emitters declare it as `required-features`.

Three modules are gated OUT of the wasm build at the **module** level rather than ported: `captures`, `export` and `share_import` (no watch, no OS path, no share sheet in a tab). Gating the whole module is the honest shape: a ported command that always returns "unsupported" would be dead code pretending to be a feature.

`vault_recover` was a fourth until 2026-08-15. It was gated on `decisions.md` 2026-07-26 "Web capability set" — the 24-word phrase never typed into served code — and entry 0514 reverses that half, so the module now compiles for both targets with its read and its write on the IO seam. Two things that gating had been hiding surfaced in the port and are worth knowing before touching it: `paths::current_vault_root_from_base` is a `read_dir` scan that on wasm32 does not error out loudly but falls through to the legacy path, so a pre-unlock resolution must go through `active_vault_root_from_host`; and `crate::atomic_write` returns `Unsupported` on wasm32 by design, so every write goes through the seam.

## Common commands

```bash
cargo check -p myne-core
cargo clippy -p myne-core --all-targets -- -D warnings
cargo test -p myne-core                       # the crate's own battery
cargo test -p myne-core <name>                # filter by name

# The wasm arm — CI runs both (`wasm-protocol` step, .woodpecker.yml)
cargo clippy -p myne-core -p protocol --target wasm32-unknown-unknown -- -D warnings
bash scripts/wasm-core-graph-check.sh         # the dependency graph must resolve

# Mobile compilability (the iOS one is the mac-local hard gate; CI does Android
# only when the NDK is provisioned)
cargo check -p myne-core --target aarch64-apple-ios
```

CI runs this crate's tests inside the desktop lane's `cargo-test-tauri` step (`nextest … -p myne-desktop -p myne-core`), and the sync simulation (`plugins::sync::sim`) in its own `sync-sim` step off the end of the chain. Locally, `pre-push` runs `cargo clippy --workspace --all-targets` + `cargo test --workspace`, both of which cover this crate.

## Gotchas

- **Every keychain-backed device-local secret in this crate is Apple-only today.** `quick_unlock`
  has an `apple.rs`, `captures/device_key.rs` is `#[cfg(any(target_os = "macos", target_os = "ios"))]`,
  and `vault_label::key::platform_keychain` returns `UnavailableKeychain` on every other target. So a
  feature that seals something under a keychain works on macOS and iOS and reports "cannot work here"
  on Windows, Linux and Android. That is the posture rather than an oversight (adding a keychain crate
  is a dependency decision, which root `CLAUDE.md` classes as a security decision), but it has to
  reach the UI copy and the user guide, or both promise something two of the four platforms do not
  do. myne-md/myne#411 shipped a guide sentence blaming "a Linux desktop with no secret service",
  which implied Linux with one worked, and mentioned neither Windows nor Android.

- **A breaking change here now fails in the same build, and it did not used to.** Mobile consumed this crate as a path dependency into a *sibling checkout*, so a changed trait method, a changed shared type, or a new `VaultLifecycleHooks` method compiled fine here and broke `MobileHooks` in another repository — which only went red once the change was already on `develop`. The mobile client moved in-repo on 2026-08-13 (`decisions.md`): `mobile/src-tauri` is a workspace member, `cargo clippy --workspace` compiles it, and the `mobile-compile` CI step gates it. No companion PR, no land order, no worktree dance. If you are following an older instruction that mentions any of those, it is stale.
- **`../../CLAUDE.md` pointers in this crate do not resolve.** Modules that moved here brought their relative pointers along, where `../../CLAUDE.md` now names a `core/src/CLAUDE.md` that has never existed. Write new pointers **repo-relative** — `src-tauri/CLAUDE.md "Secret-handling logging discipline"` — which is what the crate-root modules already do.
- **The secret-handling DENY list applies here in full.** Passwords, phrases, wrap/root/items keys, salts, nonces, `account_number_hash`, raw `vault.meta`, note plaintext, `note_id`, full filesystem paths, raw `io::Error` Display. On `wasm32` the only sink a `tracing` event has is the browser console — inside the served-code trust boundary — which is why `Cargo.toml` compiles every event below `warn` out of the wasm build entirely. That ceiling is compile-time; do not "temporarily" relax it.
- **A `[target.'cfg(…)'.dependencies]` table must go at the END of `Cargo.toml`.** Placed inside `[dependencies]`, it TERMINATES that section and every crate declared after it silently becomes part of the target table — `sha2` and friends vanish from both builds with `unresolved import` errors naming the wrong file. TOML sections have no closing brace, so nothing about the edit looks wrong.
- **Stale artefacts in the shared cargo target masquerade as your bug.** The user-global `~/.cargo/config.toml` points every project and worktree at one `build.target-dir`, so another branch's compiled `myne-core` can shadow yours — classically as `no field X on type PrefsView` on a field you just added. Re-run with an isolated `CARGO_TARGET_DIR=/tmp/…` to tell them apart; fix with `cargo clean -p protocol -p myne-core -p myne-desktop` (never a bare `cargo clean` — it wipes every project's artefacts). The `pre-push` hook is insulated from this: it sets `CARGO_TARGET_DIR: target/pre-push` on every cargo step.
- **`cargo check -p myne-core` alone does not build the examples.** Any `--all-targets` run does, which is where a fixture emitter's unresolved `myne_core::test_support` import surfaces after passing locally — the reason both emitters declare `required-features = ["test-support"]`, so cargo SKIPS them instead. That is the mechanism for exactly this case, not a workaround.
- **Adding a dependency here is a security decision** and lands in the single shared workspace `Cargo.lock` (TB9 audit anchor). Every current dep carries a comment saying why its feature set is as narrow as it is; match that bar or don't add it.
