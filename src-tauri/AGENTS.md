# src-tauri/ — Tauri 2 host (Rust)

> Subdirectory AGENTS.md. Loaded when OpenCode reads files here. See repo-root `AGENTS.md` for project-wide context, and `core/AGENTS.md` for the shared `myne-core` crate — most of the plugin logic this file governs lives there, not here.

## Stack

- Tauri 2, Rust 1.96.0 (pinned in `rust-toolchain.toml` at workspace root)
- Package name `myne-desktop` (the `-p` argument); `[lib] name = "myne_desktop_lib"` — the **`_lib` suffix is required** to avoid Windows lib-vs-bin collision (rust-lang/cargo#8519). Don't rename, and don't pass the lib name to `-p`.
- `src-tauri/src/main.rs` calls into `myne_desktop_lib`. Most logic should live in the lib, not the bin.

## Where the code actually lives

This crate is no longer where most plugin logic sits. The **`myne-core`** crate (`core/`, shared with the mobile client and with the web client's wasm entry surface) holds the plugin *cores* — `commands.rs` / `state.rs` / `error.rs` — plus the crate-root helpers this file keeps citing (`atomic_write`, `paths`, `io_failure_kind`, `protocol_error_kind`, `search`, `snapshot_store`, …). `src-tauri/src/lib.rs` re-exports every one of them, so `crate::atomic_write::…`, `crate::paths::…` and `crate::plugins::vault_unlock::commands::…` all still resolve from desktop code — but the file you edit is under `core/`. Depth on that crate: `core/AGENTS.md`.

What stays desktop-side: the `tauri::Builder` wiring in `lib.rs`, the per-plugin `init()` + `generate_handler!` shim, the capability/permission ACL, and the plugins with no mobile or browser counterpart, `backup`, `clipper_pairing`, `importer`, `pdf_export`, `vault_repair`, plus `src/spell/` and `src/clipper/`, which sit outside `plugins/` entirely.

`local_inference` was on that list and is now **split** (myne-md/myne#456). What is still here is the LOCAL half: the Candle engine, the Ollama loopback engine, retrieval, the vector store, the model store, whisper, and this plugin's Tauri surface. The portable half (the `Engine` trait, its error enum, the ChatML sanitizer, the cancellable-IO wrapper, the backend registry with its ambient-versus-remote refusal, and the whole remote-provider arm) moved to `myne-core`'s `src/inference/` and is re-exported by `src/plugins/local_inference/mod.rs`, so every `super::engine::…` / `super::state::…` path in this tree still resolves. It is behind `myne-core/remote-ai`, which this crate's `local-inference` feature turns on: that chain is what keeps the `--no-default-features` auditable build free of remote-provider code now that the files are in a crate which compiles unconditionally. `scripts/ai-no-network-check.sh` check 5 asserts both directions of it. Desktop-only side effects reattach to the shared cores through `myne_core::hooks::VaultLifecycleHooks`, implemented here by `src-tauri/src/hooks.rs::DesktopHooks`.

**The secret-handling discipline in this file is normative for `myne-core` too** — the cores moved, the rules did not. `myne-core` source files cite it back as `src-tauri/AGENTS.md`.

## Frontend coupling (don't break)

`tauri.conf.json` declares:
- `beforeDevCommand: "pnpm sidecar && pnpm dev"`
- `beforeBuildCommand: "pnpm sidecar:release && pnpm build"`

The `pnpm sidecar` half is load-bearing, not a convenience: it builds and stages each sidecar binary under the target-triple name `bundle.externalBin` expects (`scripts/build-cli-sidecar.mjs`, `scripts/build-mcp-sidecar.mjs`, `scripts/build-tor-sidecar.mjs`). Drop it and `tauri build` fails to find a sidecar; drop it from the dev hook and `pnpm tauri dev` runs against a stale one.

**pnpm only.** Switching to npm/yarn here breaks Tauri's lifecycle hooks. Node is pinned by `.nvmrc` at repo root (25.9.0); the pnpm version is pinned by the `packageManager` field in the root `package.json` (`pnpm@11.8.0`).

## Capability ACL — security-load-bearing

`capabilities/default.json` declares the permission set for the main window. Tauri 2's permission system is **opt-in per command**:
- Adding a new Tauri plugin → permission entry required
- Adding a new `#[command]` invoke handler → permission entry required
- Adding clipboard / dialog / opener access → scope-restricted permission required

Never add `core:default` plus a wide allowlist; prefer named, narrow permissions. Treat changes here as security-relevant — they widen the attack surface from the WebView side (TB6).

**The `core:*` entries are enumerated, and the list is not arbitrary (myne#384).** `core:default` is a bundle resolving to **92** command grants across nine sub-namespaces; only three are reachable from the platform seam, so the capability names `core:path:default`, `core:event:default` and `core:window:default` and takes **40**. The five dropped sub-namespaces had no consumer on either idiom — neither a typed `@tauri-apps/api/*` import (which `scripts/check-platform-seam.mjs` would catch) nor a raw `"plugin:<x>|<y>"` literal (which it would not; the guard is an *import* guard, and raw literals are this tree's dominant IPC idiom). `core:menu` was the live one: its 22 handlers are registered unconditionally on desktop, and `menu|new` + `menu|set_as_app_menu` carry no platform `cfg` and no vault gate, so a script in page context could install its own application menu — on macOS, into the bar outside the window that users read as the OS. Add a sub-namespace back only with a named production consumer. `no_egress::GRANTED_CORE_NAMESPACES` records the three with their consumers and its gate asserts **both** directions, so a fourth appearing and a recorded one going away are equally loud.

**`core:window:default` is 28 grants and every one of them is a READ**, which is worth knowing before you describe any window-related capability change. `allow-is-*`, `allow-get-all-windows`, the size, position, monitor and scale queries, `allow-title`: no `show`, no `unminimize`, no `set_focus`, no `hide`. So page context holds no window mutator except what a capability grants it by name, and a new host command that raises a window is a widening even when it replaces one. myne-md/myne#483 got this wrong in four files at once, each calling the trade a "net narrowing" because it dropped `core:window:allow-show`, while the command replacing it drives `unminimize` and `set_focus` too. Measure it before claiming it: `src-tauri/gen/schemas/acl-manifests.json`, key `core:window`, `default_permission.permissions`. A claim repeated in several files is the one a reviewer stops checking.

**Before REMOVING a grant, grep `e2e/` for it: one of them is a test's positive control.** `e2e/acl-refusal.e2e.ts` is the only scenario in the repo that observes Tauri actually enforcing this ACL, and it works by invoking a granted command and a withheld one in the same run. The granted half was `plugin:window|show`, so myne-md/myne#483 dropping `core:window:allow-show` (its one product consumer moved host-side) turned that scenario red on its **control** rather than on its subject. A red positive control does not make the test noisy, it makes it useless: the refusal it asserts stops being evidence that the ACL refused, and `check-e2e-floor.mjs` carries `stable_max_failures: 0`, so it reddens a blocking step for a reason that reads like an unrelated regression. Repoint the control at something the capability still grants (a read like `plugin:window|is_visible`) in the same change, and correct that file's header, which enumerates the mutators by name.

**An ACL entry does not wire a command — and nothing checks that it does.** A permission identifier is just a string; Tauri never verifies that a matching handler exists. A command that has its `[[permission]]` block, that identifier in the plugin's `[default]` bundle, and a frontend caller — but is missing from that plugin's `generate_handler!` — **compiles, passes clippy, renders its UI, and is dead at runtime** (the invoke rejects). Registration is its own edit, never an implied consequence of the others (MYND-441 shipped `set_attachment_ocr_enabled` this way; caught in review, not by any tool).

**Adding a command — the edits that are actually load-bearing, and where each one lives:**

1. **`build.rs`** — the *plugin* must be declared once as a `tauri_build::InlinedPlugin`. That declaration is what creates the `<plugin>:` ACL namespace; without it the permissions flatten into `__app-acl__` and never match the `plugin:<plugin>|<cmd>` form Tauri authorizes against (the comment at the top of `build.rs` spells this out). **Naming the command in that arm's `.commands(&[…])` list is optional** — it autogenerates an `allow-<cmd>` / `deny-<cmd>` pair, which a hand-written `[[permission]]` block supplies just as well. 43 of the 51 `prefs` commands appear nowhere in `build.rs` and are fully wired; `vault-unlock`'s `account_number_check` is the mirror case (in `build.rs`, no hand-written block). **A command's absence from `build.rs` is not evidence that it is unwired.**
2. **`permissions/<plugin>/default.toml`** — a `commands.allow` entry for the command (hand-written or autogenerated per above) *and* its `allow-<cmd>` identifier listed in the `[default]` bundle. The ACL is fail-closed: an identifier that is not in the bundle is refused.
3. **`capabilities/default.json`** — the `<plugin>:default` bundle granted to the main window. Once per plugin, not per command; the feature-gated `local-inference` plugin is the exception and adds its own scoped capability at runtime (`src/plugins/local_inference/mod.rs`).
4. **`generate_handler!`** — the fn itself, in the plugin's `init()`. **The registration site is the client shim, `src-tauri/src/plugins/<plugin>/mod.rs`**; the shared core at `core/src/plugins/<plugin>/mod.rs` deliberately has *no* handler list (the split is stated in `core/src/plugins/sync/mod.rs`). The one exception is `vault_creation`, whose entire plugin — `init()`, `generate_handler!`, TTL evictor and all — lives in `core/src/plugins/vault_creation/mod.rs`, with `src-tauri/src/plugins/mod.rs` only re-exporting it; there is no `src-tauri/src/plugins/vault_creation/` directory to look in. Adding a command to a core `commands.rs` alone ships it dead.

Current entries include `vault-creation:default` (the vault-creation flow plugin), scoped clipboard/dialog entries, and an `opener:allow-open-path` carrying **two** path scopes — `$APPDATA/vaults/*` (the current `vaults/<id>/` layout) *and* `$APPDATA/vault` (the legacy pre-migration single-vault directory, `core/src/paths.rs::LEGACY_VAULT_DIR_NAME`). Both are load-bearing; dropping the legacy one narrows the scope for a profile the eager boot migration has not rewritten yet. See the file for the full list. **No `fs:` permission is granted at all**, even though `tauri-plugin-fs` is registered in `lib.rs`: every external-path read/write goes through a narrow in-app plugin command instead (`importer`, `backup`, `export`, `secret-export`, `pdf-export`), which is the least-privilege posture the `importer` and `backup` arms of `build.rs` call out by name (TB6). Do not "just add" an `fs:` scope.

**The browser-clipper native-messaging host is an EXTERNAL ingress NOT governed by this ACL.** It is a separate stdio process (plus a local single-instance Unix-socket relay into the running app), so `capabilities/default.json` does not gate it. It carries its OWN untrusted-input discipline as a security-load-bearing pattern (TB10): length-prefixed framing with size caps (64 MiB ext→host / 16 MiB note body / 1 MiB reply), UTF-8 validation, no path traversal, re-sniffed MIME, a clip-handoff rate limiter, silent-to-unpaired, and the running app re-validating **every** relayed frame as hostile before any `note_create`. See `src/clipper/` + `threat-model.md` TB10 / A14. Only the WebView-side pairing commands (`clipper-pairing:default`) are ACL-governed here (TB6) — the one narrow entry the clipper added.

## Plugin pattern

Multi-step flows live as Tauri plugins, and a plugin is now **two halves**.

The shared core, `core/src/plugins/<flow-name>/`:
- `commands.rs` — the command bodies: a host-taking `*_from_host` core, a thin `#[tauri::command]` IPC wrapper (cfg-gated on `tauri-ipc` + `not(wasm32)`), and a `*_with_dir` / `*_with_path` inner that takes its paths directly so tests need no Tauri runtime
- `state.rs` — session/cache state with TTL eviction
- `error.rs` — `serde::Serialize` error enum (matched on TS side)

The desktop shim, `src-tauri/src/plugins/<flow-name>/mod.rs`:
- the `init()` plugin builder, `generate_handler!` registration, and `app.manage(...)` of the plugin's state
- `pub use myne_core::plugins::<flow>::{commands, state};` so existing `crate::plugins::<flow>::…` paths keep resolving
- anything genuinely desktop-only (e.g. `notes/desktop_commands.rs`, `notes/search_sync.rs`, `sync/qr.rs`, `vault_indices/bench.rs`)

Most shims are `mod.rs`-only (nineteen of the directories under `src-tauri/src/plugins/` contain nothing else. The plugins whose whole body is still desktop-side) `backup`, `clipper_pairing`, `importer`, `pdf_export`, `vault_repair`: keep the old single-half shape, and are the ones to copy from only if the flow has no mobile or browser counterpart. `local_inference` is now neither shape: it is a genuinely split plugin, keeping its local engines and its Tauri surface here while re-exporting the shared seam from `myne-core` (see above).

Reference: `core/src/plugins/vault_creation/` — implements the begin/commit/cancel session pattern (`decisions.md` 2026-04-28 "Vault creation flow: backend session pattern; root_key never crosses IPC"). New flows that need to keep secrets server-side should follow the same shape. Note that this plugin is the one whose `init()` also lives in core (see the ACL checklist above); every other flow's `init()` is desktop-side.

`myne_core::hooks::VaultLifecycleHooks` is the seam between the halves: a shared core that needs a desktop-only side effect (search upsert, spell hydrate, snapshot capture, screen-capture apply) calls a hook method rather than reaching for a desktop type. Adding one means a trait method *plus* a `NoopHooks` no-op *plus* an implementation in every client — see `core/AGENTS.md`.

**Defensive guards on user-meaningful destructive operations.** Plugins that write to user-meaningful state (vault.meta, .myn blobs, future settings stores) defensively guard pre-existing destinations: a recognized-artefact check at the top of the write command + a closed error variant + restore the session under its token so retry stays non-destructive. Pattern is canonical in `core/src/plugins/vault_creation/commands.rs::commit_with_vault_path` (`VaultArtifactsPresent` guard backed by the `vault_artifacts_present` predicate in the same file, broadened from the original `vault.meta`-only check to recognize vault.meta + vault.meta.tmp + notes/*.myn; `decisions.md` 2026-05-02 original + 2026-05-26 broadening) — desktop call sites such as `src-tauri/src/vault_migration.rs` still reach it as `crate::plugins::vault_creation::commands::vault_artifacts_present` through the re-export. The guard is expected to NEVER trigger in normal flow — its role is bug-canary against frontend routing regressions or dev-tools manipulation that would otherwise silently overwrite irrecoverable state, or co-mingle a fresh vault with orphan blobs left by a partial-fail `vault_delete`.

## Secret-handling logging discipline

Canonical for all `src-tauri/` **and `core/`** code that touches secret material (passwords, recovery phrases, wrap keys, root keys, items keys, salts, nonces, account-number-hash bytes, raw vault.meta bytes, OS path strings). Per-module docs **point here** with a single line — `// see: src-tauri/AGENTS.md "Secret-handling logging discipline"` — rather than duplicating the lists below. Write that pointer **repo-relative**, not as a `../../AGENTS.md` hop: the modules that moved into `myne-core` took their relative pointers with them, where they now resolve to a `core/src/AGENTS.md` that does not exist.

### Pattern: Zeroizing wrap + spawn_blocking move

A Tauri command that touches a secret takes the secret as a plain `String` parameter (the IPC layer hands us one), then **on the first non-doc statement** wraps it in `Zeroizing<String>` and moves the wrapper into the heavy-compute closure:

```rust
#[tauri::command]
pub async fn unlock(
    password: String,
    state: State<'_, VaultRuntimeState>,
    // ...
) -> Result<(), VaultUnlockError> {
    // First statement: bound the lifetime of the bytes to a Zeroizing
    // wrapper. Every early-return path (slot guard, permit guard, IO
    // failure, parse failure) drops the wrapper and zeroes the bytes.
    let password = Zeroizing::new(password);

    // ... cheap guards run with the wrapper in scope ...

    let result = tokio::task::spawn_blocking(move || {
        // The wrapper moves into the closure. derive_* helpers borrow
        // `&str` via deref coercion: &Zeroizing<String> → &String → &str.
        // No clone, no format-arg, no log of the password.
        derive_root_key(&password, &meta)
    })
    .await;
    // Closure exit: wrapper drops, bytes wipe.
    // ...
}
```

**Do NOT** enable the `zeroize/serde` feature for "Zeroizing<String> deserializes directly". V8 immutable strings + serde intermediate buffers do not become Zeroizing-aware just because the command signature looks tighter. Cosmetic gain, deps surface bloat — TB9 audit-anchor disciplined. The first-line wrap is the load-bearing pattern.

### Pattern: Plaintext IPC across the WebView boundary

Note plaintext (the user's Markdown body) crosses IPC as `String` in both directions — `note_create(plaintext: String)` and `note_read(...) -> Result<String, _>`. Mechanically, the discipline is identical to the password pattern above (first-line `Zeroizing::new(plaintext)` wrap, move into spawn_blocking, drop on closure exit). Threat-shape-wise, plaintext is a longer-lived secret than a password: a password is consumed by Argon2id within milliseconds; plaintext lives in the WebView's V8 immutable string heap for the **hours** the user has the editor open. The Rust-side discipline still applies (and is verified by `core/src/plugins/notes/commands.rs::note_create_with_dir` + `note_read_with_dir`), but the Rust-side window is **strictly dominated** by the V8-side window — the dominant leak is on the WebView side, not the IPC transit. v0.1 accepts the V8-side leak under `threat-model.md` §5 "NOT Protected Against — A7 active local malware" (an A7-class attacker has process-memory inspection capabilities that cover both V8 and Rust heaps regardless).

The intermediate Tauri serde V8-string-deserialization buffer (the bytes that materialize between V8's immutable-string release and the first Rust binding) is **accepted as outside Rust-side wipe scope** — its lifetime is microseconds and the V8-side retention window strictly dominates it. The `zeroize/serde` feature is **explicitly rejected** for plaintext-bearing types: it wraps `serde::Deserialize` impls with Zeroize-on-drop semantics but does not touch the parsing intermediate buffers; it provides "we tried" cosmetic gain without closing the dominant V8 channel. **Next-major forward-look:** a native render path (Tauri 2 native widget OR custom IPC channel that bypasses WebView serialization entirely) keeps plaintext outside the WebView and collapses the dominant channel — see `decisions.md` 2026-05-07 "v005 native render path forward-look" for the design constraint.

On the read side, `note_read_with_dir` pairs `String::from_utf8(decrypted.plaintext().to_vec())` with an explicit `drop(decrypted)` immediately after. The `to_vec()` allocation is the non-Zeroized intermediate that crosses from `decrypted`'s `Zeroizing<Vec<u8>>` into the eventual `String` (which will leave through IPC); the explicit drop minimizes the window where both wrappers coexist. Same shape applies to any future plugin command that returns plaintext to the WebView.

### DENY list — never emit via tracing, log, format, or panic message

Never reference any of these in a `tracing::*!`, `println!`, `eprintln!`, `format!`, `?fmt`, `%fmt`, or a `panic!` / `.expect(…)` message. **Log scope only** — the IPC boundary is a separate, narrower list ("Never crosses IPC" below), because the two memberships genuinely differ. The heading used to claim both, which made the list unfollowable rather than strict: note plaintext and `note_id` are never-log values that *must* cross IPC in every shipped notes command (`note_read(note_id: String) -> Result<String, _>` violated the old wording by construction, and the pattern section eight lines above mandates exactly that signature). A reviewer-enforced rule survives on its credibility; a scope a reviewer can be correctly rebutted on devalues every entry that is absolute.

**One half of this rule is now machine-checked, and the reason is the diagnostic log** (myne-md/myne#860). While the only sink was a terminal nobody reads, "reviewer-enforced; no automated lint" was affordable. It stopped being affordable when the desktop gained an opt-in log file **the user is invited to send on**, because the DENY list is then the thing standing between a `debug!` call site and a public issue thread. `scripts/check-tracing-discipline.mjs` (pre-commit and CI `pnpm-build`) therefore enforces three shapes over the shipping crates: **no `%` Display formatter at `info`, `warn` or `error`**, which are the levels the file layer records (`src-tauri/src/logging` installs it at a fixed `LevelFilter::INFO` and ignores `RUST_LOG`, so a `debug!` `%` cannot reach disk and is deliberately not flagged); **no value interpolated into a message**, which is the shape no field-name rule can see; and **no field value that builds an unbounded string** (`format!`, `concat!`, `String::from`, `to_string`, `to_owned`), which no field-name rule can bound either. It reads both macro spellings, `tracing::info!` and the bare `info!` in a file that imports from `tracing`, because a qualified-only scan reads nothing at all for the idiomatic form. Its header states what it deliberately does not check: `?` Debug formatting (the closed-enum mapping rule below still governs it), a field-name allowlist (the vocabulary is 111 names), and `println!`/`eprintln!`/`dbg!` (which bypass `tracing` entirely, and which `cli_bridge/logging_discipline.rs` checks for the one directory where a path is actually handled). Everything below stays review-enforced.

- `password`, recovery phrase
- `password.len()` / phrase word count (partial-attempt counter telemetry leak)
- wrap_key, root_key, items_key, item_key, HKDF PRK
- salts, nonces (vault-stable correlation tags, even though not secret-bearing)
- `account_number_hash` bytes
- `vault.meta` raw bytes
- `plaintext`, `body`, `content` — note plaintext bytes/strings (IPC-arrived UTF-8 markdown; same secret class as `password`, longer-lived V8-side window per the Plaintext-IPC pattern above)
- `note_id` — per-note vault-stable correlation tag (same category as the `salts, nonces` line above; `items_key_id` is implicitly covered by that line)
- full filesystem path
- raw `std::io::Error::Display` (kernel-dependent path leakage on some platforms)

### Never crosses IPC — WebView-side absence is the invariant

Distinct from and narrower than the DENY list above: these must not appear in an IPC argument or in an IPC-bound `serde::Serialize` field, in any form or encoding. Anchor: `decisions.md` 2026-04-28 "Vault creation flow: backend session pattern; root_key never crosses IPC" — the session-token pattern exists precisely so none of them has to travel.

- `root_key`, `items_key`, `item_key`, wrap keys, HKDF PRK
- salts, nonces, `items_key_id`
- `account_number_hash` bytes (the display-form account number is a different value, and does cross — see below)
- raw `vault.meta` bytes, raw blob bytes
- **backend-resolved** filesystem paths: `app_data_dir`, `vaults/<VaultId>/`, `.myn` blob paths. `VaultSummary` carries the `VaultId` and no path for exactly this reason
- `password.len()`, phrase word count, and anything else derived from a secret whose only consumer would be telemetry

**What does cross, deliberately, and is therefore not a violation.** The UI cannot function without these; each is a single designed hop into a surface the user is already looking at, and each stays DENY-listed for logging:

- the password, inbound — `unlock(password: String)`, `vault_creation::begin(password: String)`; the Zeroizing-wrap pattern above is what bounds it
- the 24-word recovery phrase — outbound exactly once at creation (`vault_creation::begin -> BeginResult { phrase, … }`, so the user can write it down) and inbound at recovery (`recover_with_phrase(phrase: String)`)
- the display-form account number
- `note_id`, note plaintext, titles, folder names — governed by "Pattern: Plaintext IPC across the WebView boundary" above, not by this list. `note_list` returns nothing *but* note ids, and no narrower shape exists: a UI cannot address a note it cannot name
- a **user-chosen** destination path — `vault_export_markdown(destination: String)`, `vault_export_backup(destination: String)`, `import_read_file(root, path)`. It originates in the frontend's own file dialog, so refusing it at the seam would protect nothing; what stays inside is the backend's own path *resolution*
- one argued carve-out: `cli_bridge::path_shim::shim_dir_for_display`, the CLI PATH-shim directory, which reaches the Settings panel that asked for it and nowhere else. Not vault-derived, not secret — and a redacted path would be an `export PATH="…:$PATH"` line that does not work. Its reach is pinned by a test in `src-tauri/src/cli_bridge/logging_discipline.rs`; a second caller needs the carve-out re-argued, not copied
- one argued carve-out (myne-md/myne#788): `plain_file::commands::plain_file_resolve_path` returns the CANONICAL path of a `myne://open-file?path=…` target to the confirmation layer, which renders it so the user sees the REAL file before confirming. It is the backend's own resolution, which this list otherwise forbids, and it is admitted because the confirmation is meaningless without the true target (a link naming `~/notes.md` that is a symlink elsewhere must show where it really points) and the confirmed open re-validates the gate, extension and size from scratch, minting no handle and reading no content. Not vault-derived, not secret; `plain_file_open_confirmed` re-derives it rather than trusting what the page echoed. A second caller needs the carve-out re-argued

Crossing IPC once, into the window the user opened, is not the same permission as landing in a log file. When adding a command, decide the two questions separately.

### ALLOW list — safe to emit via tracing

- bounded `ProtocolError` / `VaultUnlockError` / `AppError` variant name (use a `&'static str` helper, NOT `?e` Debug formatting)
- `stage` tag: `read_meta`, `parse_meta`, `password_kdf`, `root_unwrap`, `items_key_unwrap`, `slot_check`, `permit_acquire`, `spawn_blocking_join`, etc. — static strings naming the failure stage
- coarse `duration_ms` (Argon2id timing telemetry; sub-ms precision deliberately discarded — no fingerprintable timing channel)
- success/failure event without account identifier (`event = "vault_unlocked"`)
- closed `IoFailureKind` enum (from `core/src/io_failure_kind.rs`, re-exported as `crate::io_failure_kind`) — Debug emits `PermissionDenied`/`NotFound`/`NoSpace`/`Other`, all DENY-list-safe

### Closed-enum mapping rule

`?` and `%` `tracing` formatters are **forbidden** on `std::io::Error`, `String` containing OS path, and any DENY-listed type. Always reduce to a closed enum first. Pattern:

```rust
// ❌ Wrong — io::Error::Display may include kernel path strings.
tracing::error!(stage = "read_meta", error = ?e, "...");

// ✅ Right — bounded enum, Debug emits the variant name only.
let io_kind = crate::io_failure_kind::from_io_error_kind(e.kind());
tracing::error!(stage = "read_meta", io_failure_kind = ?io_kind, "...");
```

For `ProtocolError` (all unit variants), `?e` Debug-formatting would also emit just the variant name — but use the `protocol_error_kind(&ProtocolError) -> &'static str` helper anyway. Discipline-explicit, drift-detecting (a new variant compile-fails the helper's match), and survives an accidental future `Debug` impl change on the protocol crate.

### Reference implementation

All three reference files moved into `myne-core` with their plugin cores; the discipline did not change with them.

`core/src/plugins/vault_unlock/commands.rs` (Task 8 of `vault-unlock-password`) wires this discipline end-to-end. The invariant across its `tracing::*!` call sites is **not** that they all carry a `stage` tag — it is that **every record's leading field is a static-string discriminant**, and the file uses two of them: `stage = "…"` on the failure paths (`slot_check`, `permit_acquire`, `read_meta`, `parse_meta`, `kdf_capability`, `kdf_params_range`, `password_kdf`, `root_unwrap`, `items_key_unwrap`, `spawn_blocking_join`, `status_check`, `vault_list`; `open_32_byte_secret` takes its `stage: &'static str` as a parameter so both unwrap sites label themselves) and `event = "…"` on the outcome/lifecycle paths (`vault_unlocked`, `vault_locked`, `prefs_post_unlock_skipped`, `rename_recovery_skipped`, `rename_recovery_failed`). Every *other* field is a literal, a coarse number, or the output of a closed-enum helper — one `protocol_error_kind`, `prefs_read_error_kind`, `IoFailureKind` — and zero DENY-listed values appear in any argument. `core/src/plugins/vault_creation/commands.rs` retroactively adopted the Zeroizing-wrap idiom in Task 7 of the same feature. `core/src/plugins/notes/commands.rs` (MYND-26) is the canonical reference for the **Plaintext-IPC pattern** — `note_create_with_dir` shows the input direction (first-line `Zeroizing::new(plaintext)` + move into `spawn_blocking`); `note_read_with_dir` shows the output direction (`String::from_utf8(decrypted.plaintext().to_vec())` + explicit `drop(decrypted)` to minimize the non-Zeroized intermediate's lifetime); both ship `note_create_error_kind` / `note_read_error_kind` static-string label helpers that mirror `protocol_error_kind` and structurally catch enum-variant drift.

## Atomic file writes

`core/src/atomic_write.rs` (re-exported as `crate::atomic_write` from `src-tauri/src/lib.rs`) — `atomic_write(path, bytes, replace: bool)` is the single canonical helper for durable persistent writes (`vault.meta`, `.myn` blobs, future settings). Write-to-temp + `sync_all` + atomic rename, with platform-native durability for the rename step: Unix does `rename` + parent-dir `sync_all` (journal commit of the new directory entry); Windows does `MoveFileExW(MOVEFILE_WRITE_THROUGH [| MOVEFILE_REPLACE_EXISTING])` (USN journal commit + rename in one syscall). `replace=false` returns `io::ErrorKind::AlreadyExists` on a pre-existing destination, mapped at call sites to plugin-specific defensive variants (`vault_creation::commit_with_vault_path::VaultArtifactsPresent` — broadened in 2026-05-26 to recognize vault.meta, vault.meta.tmp, and notes/*.myn; `notes::note_create::NoteAlreadyExists`). See `decisions.md` 2026-05-07 "`atomic_write` durability hardening + `replace: bool` parameter" for the full rationale (write-frequency pressure, dual-helper rejection, Windows primitive choice, `RENAME_NOREPLACE` Phase 2 deferral). Two siblings share the module and share its durability + failure-path-cleanup contract: `atomic_write_private` creates the temp `0600` on Unix from the moment it exists, so a device-local credential file (the per-device sync token) is never briefly group/world-readable; `atomic_write_unclobbered` is the export-destination variant described below.

A **returned error** (temp write/`sync_all` failure, or `finalize_atomic` rename failure) drops the partial `<path>.tmp` on the way out (best-effort; the original error is surfaced) — a failed write leaves no stray temp sibling. Vault-internal callers always pass ciphertext (encoded blobs), so a leftover temp inside the vault never exposes plaintext even when cleanup is skipped. **Amended 2026-06-11 (export suite):** the user-initiated export commands (MYND-115/211/255) are plaintext callers — their temp sibling lives at the **user-chosen export destination**, which is plaintext by the user's own intent (threat-model TB3 egress exception), never inside the vault. The "temp = ciphertext" invariant continues to hold for every vault-resident path. Export-destination writes use `atomic_write_unclobbered` (randomized `create_new` temp name) so a write can never truncate a pre-existing user file named `<target>.tmp` or a sibling export whose final name is `*.tmp` — the fixed `<path>.tmp` name of plain `atomic_write` stays load-bearing for vault-internal artifact recognition (`vault.meta.tmp`) and must not be used at user destinations. The interrupted-write recovery contract is exercised by a `#[cfg(test)]` fault-injection seam (the private `Fault` enum + `atomic_write_inner`/`write_temp`); the production `atomic_write` passes `Fault::None`, so in non-test builds the seam compiles out to the straight-line path (zero runtime cost). See `decisions.md` 2026-06-08 "Interrupted-write recovery test gate + `atomic_write` failure-path `.tmp` cleanup (MYND-88)".

**`note_delete` durability is asymmetric** — Unix arm runs `parent_dir.sync_all()` after `std::fs::remove_file`; Windows arm is `#[cfg(unix)]`-explicit no-op (no `FlushFileBuffers` parent-handle, no `windows-sys` direct dep extension). Write durability protects data integrity (a half-written `.myn` = AEAD-tag-fail = permanent loss); delete durability protects redundancy elimination (a power-loss-reverted delete = trivial repeat — the user re-deletes; AEAD-encrypted bytes leak nothing in the meantime). Failure modes are structurally different; the "symmetric durability" intuition mixes data-integrity discipline with idempotency-of-cleanup. Phase 2 sync layer revisit hook: if deterministic delete-event ordering across devices is required, the s2 path (`FlushFileBuffers` parent-handle on Windows) becomes a Phase 2 dep; not in v0.1. See `decisions.md` 2026-05-07 "`note_delete` durability: Unix parent-dir `sync_all` only; Windows s1 best-effort" for the full asymmetry rationale + s2 rejection cost analysis.

## Paths

`core/src/paths.rs` (re-exported as `crate::paths`) resolves each vault to `<app_data_dir>/vaults/<VaultId>/`, where `<VaultId>` is a random UUIDv7 directory name — per `decisions.md` 2026-06-09 "Vault disk layout: vaults/<id>/ + eager boot migration", which supersedes the 2026-04-28 single-`vault/` entry and brought the eager boot migration in `src/vault_migration.rs` with it. Every resolver takes the vault **root** rather than `app_data_dir` directly; the pure `*_under(parent)` helpers do the join, which is what lets tests point them at a temp dir with no Tauri runtime. Don't hardcode user paths.

## Common commands

```bash
# `-p` takes the package name; `-p myne_desktop_lib` is rejected with
# "package ID specification ... did not match any packages" (see Stack).
cargo check -p myne-desktop
cargo clippy -p myne-desktop --all-targets -- -D warnings
pnpm tauri dev          # full app loop (from repo root)
pnpm tauri build        # production bundle (from repo root)

# backup-container test vectors (MYND-254 — the one vector family hosted
# here instead of protocol/; see src/backup_container.rs test mod):
cargo test -p myne-desktop --lib backup_container               # incl. the companion-repo runner
cargo test -p myne-desktop --lib emit_backup_container_vectors_for_paste -- --ignored   # regenerate
```

## Gotchas

- Tauri's `#[command]` async fns must be `Send` — anything in their state must satisfy `Send + Sync` (use `tokio::sync::Mutex`, not `std::sync::Mutex`, when an `.await` happens while locked).
- The Tauri WebView is Chromium on Windows/Linux, WKWebView on macOS — feature parity is not exact (storage quotas, font rendering). Test the macOS WKWebView path before assuming Chromium-only behavior.
- `app.path().app_data_dir()` resolves differently in dev vs production. In dev it lands under the dev identifier; production uses the bundle identifier. Don't write to absolute paths. Call sites go through the project wrapper `myne_core::paths::app_data_dir(&app)` (`crate::paths::app_data_dir`) rather than the Tauri API directly. (There is no `tauri::api::*` on Tauri 2 — that was the v1 surface; the crate exposes `tauri::path` / `AppHandle::path()`.)
- **A compile error naming a field you just added — `no field X on type PrefsView` — usually means a STALE crate in the shared target, not a mistake in your code.** The user-global `~/.cargo/config.toml` sets `build.target-dir` to `~/.cargo/shared-target` for every project and worktree, so another branch's compiled `protocol` (or `myne-core`) can shadow yours and cargo will not rebuild it. Tell them apart by re-running with an isolated `CARGO_TARGET_DIR=/tmp/...`: if it compiles there, the code is fine. Fix the shared one with `cargo clean -p protocol -p myne-core -p myne-desktop` (never a bare `cargo clean` — with no package name it wipes every project's artefacts). The **pre-push hook is no longer exposed to this** — every cargo command in it sets `CARGO_TARGET_DIR: target/pre-push`, precisely so a `cargo` run in another terminal cannot make the gate cry wolf. The same class of staleness still hits the E2E container through its `myne-e2e-target` Docker volume — see `e2e/AGENTS.md`.
