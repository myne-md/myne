# src-tauri/ — Tauri 2 host (Rust)

> Subdirectory CLAUDE.md. Loaded when Claude reads files here. See repo-root `CLAUDE.md` for project-wide context.

## Stack

- Tauri 2, Rust 1.96.0 (pinned in `rust-toolchain.toml` at workspace root)
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

**An ACL entry does not wire a command — and nothing checks that it does.** A permission identifier is just a string; Tauri never verifies that a matching handler exists. A command that has its `build.rs` entry, its `permissions/<plugin>/default.toml` listing, its `[[permission]]` block, and a frontend caller — but is missing from that plugin's `generate_handler!` — **compiles, passes clippy, renders its UI, and is dead at runtime** (the invoke rejects). Registration is the fourth edit, not an implied consequence of the first three. Note the decoy: `core/src/plugins/<plugin>/mod.rs` holds the shared implementation and has **no** handler list; the only registration site is `src-tauri/src/plugins/<plugin>/mod.rs`. Adding a command to the core file alone ships it dead (MYND-441 shipped `set_attachment_ocr_enabled` this way; caught in review, not by any tool).

Current entries include `vault-creation:default` (the vault-creation flow plugin) and scoped clipboard/dialog/fs entries — see file for the full list.

**The browser-clipper native-messaging host is an EXTERNAL ingress NOT governed by this ACL.** It is a separate stdio process (plus a local single-instance Unix-socket relay into the running app), so `capabilities/default.json` does not gate it. It carries its OWN untrusted-input discipline as a security-load-bearing pattern (TB10): length-prefixed framing with size caps (64 MiB ext→host / 16 MiB note body / 1 MiB reply), UTF-8 validation, no path traversal, re-sniffed MIME, a clip-handoff rate limiter, silent-to-unpaired, and the running app re-validating **every** relayed frame as hostile before any `note_create`. See `src/clipper/` + `threat-model.md` TB10 / A14. Only the WebView-side pairing commands (`clipper-pairing:default`) are ACL-governed here (TB6) — the one narrow entry the clipper added.

## Plugin pattern

Multi-step flows live as Tauri plugins under `src/plugins/<flow-name>/`:
- `mod.rs` — plugin builder + handler registration
- `commands.rs` — `#[command]` async functions
- `state.rs` — session/cache state with TTL eviction
- `error.rs` — `serde::Serialize` error enum (matched on TS side)

Reference: `src/plugins/vault_creation/` — implements the begin/commit/cancel session pattern (`decisions.md` 2026-04-28 "Vault creation flow: backend session pattern; root_key never crosses IPC"). New flows that need to keep secrets server-side should follow the same shape.

**Defensive guards on user-meaningful destructive operations.** Plugins that write to user-meaningful state (vault.meta, .myn blobs, future settings stores) defensively guard pre-existing destinations: a recognized-artefact check at the top of the write command + a closed error variant + restore the session under its token so retry stays non-destructive. Pattern is canonical in `src/plugins/vault_creation/commands.rs::commit_with_vault_path` (`VaultArtifactsPresent` guard backed by `vault_artifacts_present` predicate, broadened from the original `vault.meta`-only check to recognize vault.meta + vault.meta.tmp + notes/*.myn; `decisions.md` 2026-05-02 original + 2026-05-26 broadening). The guard is expected to NEVER trigger in normal flow — its role is bug-canary against frontend routing regressions or dev-tools manipulation that would otherwise silently overwrite irrecoverable state, or co-mingle a fresh vault with orphan blobs left by a partial-fail `vault_delete`.

## Secret-handling logging discipline

Canonical for all `src-tauri/` plugins that touch secret material (passwords, recovery phrases, wrap keys, root keys, items keys, salts, nonces, account-number-hash bytes, raw vault.meta bytes, OS path strings). Per-plugin module docs **point here** with a single line — `// see: ../../CLAUDE.md "Secret-handling logging discipline"` — rather than duplicating the lists below.

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

Note plaintext (the user's Markdown body) crosses IPC as `String` in both directions — `note_create(plaintext: String)` and `note_read(...) -> Result<String, _>`. Mechanically, the discipline is identical to the password pattern above (first-line `Zeroizing::new(plaintext)` wrap, move into spawn_blocking, drop on closure exit). Threat-shape-wise, plaintext is a longer-lived secret than a password: a password is consumed by Argon2id within milliseconds; plaintext lives in the WebView's V8 immutable string heap for the **hours** the user has the editor open. The Rust-side discipline still applies (and is verified by `src-tauri/src/plugins/notes/commands.rs::note_create_with_dir` + `note_read_with_dir`), but the Rust-side window is **strictly dominated** by the V8-side window — the dominant leak is on the WebView side, not the IPC transit. v0.1 accepts the V8-side leak under `threat-model.md` §5 "NOT Protected Against — A7 active local malware" (an A7-class attacker has process-memory inspection capabilities that cover both V8 and Rust heaps regardless).

The intermediate Tauri serde V8-string-deserialization buffer (the bytes that materialize between V8's immutable-string release and the first Rust binding) is **accepted as outside Rust-side wipe scope** — its lifetime is microseconds and the V8-side retention window strictly dominates it. The `zeroize/serde` feature is **explicitly rejected** for plaintext-bearing types: it wraps `serde::Deserialize` impls with Zeroize-on-drop semantics but does not touch the parsing intermediate buffers; it provides "we tried" cosmetic gain without closing the dominant V8 channel. **v005 forward-look:** a native render path (Tauri 2 native widget OR custom IPC channel that bypasses WebView serialization entirely) keeps plaintext outside the WebView and collapses the dominant channel — see `decisions.md` 2026-05-07 "v005 native render path forward-look" for the design constraint.

On the read side, `note_read_with_dir` pairs `String::from_utf8(decrypted.plaintext().to_vec())` with an explicit `drop(decrypted)` immediately after. The `to_vec()` allocation is the non-Zeroized intermediate that crosses from `decrypted`'s `Zeroizing<Vec<u8>>` into the eventual `String` (which will leave through IPC); the explicit drop minimizes the window where both wrappers coexist. Same shape applies to any future plugin command that returns plaintext to the WebView.

### DENY list — never emit via tracing, log, format, or any IPC payload

Never reference any of these in a `tracing::*!`, `println!`, `eprintln!`, `format!`, `?fmt`, `%fmt`, or any IPC-bound `serde::Serialize` field. Reviewer-enforced; no automated lint.

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

### ALLOW list — safe to emit via tracing

- bounded `ProtocolError` / `VaultUnlockError` / `AppError` variant name (use a `&'static str` helper, NOT `?e` Debug formatting)
- `stage` tag: `read_meta`, `parse_meta`, `password_kdf`, `root_unwrap`, `items_key_unwrap`, `slot_check`, `permit_acquire`, `spawn_blocking_join`, etc. — static strings naming the failure stage
- coarse `duration_ms` (Argon2id timing telemetry; sub-ms precision deliberately discarded — no fingerprintable timing channel)
- success/failure event without account identifier (`event = "vault_unlocked"`)
- closed `IoFailureKind` enum (from `src-tauri/src/io_failure_kind.rs`) — Debug emits `PermissionDenied`/`NotFound`/`NoSpace`/`Other`, all DENY-list-safe

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

`src-tauri/src/plugins/vault_unlock/commands.rs` (Task 8 of `vault-unlock-password`) wires this discipline end-to-end — 12 instrumented call sites, one `protocol_error_kind` helper, zero DENY-listed values in any `tracing::*!` argument. `src-tauri/src/plugins/vault_creation/commands.rs` retroactively adopted the Zeroizing-wrap idiom in Task 7 of the same feature. `src-tauri/src/plugins/notes/commands.rs` (MYND-26) is the canonical reference for the **Plaintext-IPC pattern** — `note_create_with_dir` shows the input direction (first-line `Zeroizing::new(plaintext)` + move into `spawn_blocking`); `note_read_with_dir` shows the output direction (`String::from_utf8(decrypted.plaintext().to_vec())` + explicit `drop(decrypted)` to minimize the non-Zeroized intermediate's lifetime); both ship `note_create_error_kind` / `note_read_error_kind` static-string label helpers that mirror `protocol_error_kind` and structurally catch enum-variant drift.

## Atomic file writes

`src/atomic_write.rs` — `atomic_write(path, bytes, replace: bool)` is the single canonical helper for durable persistent writes (`vault.meta`, `.myn` blobs, future settings). Write-to-temp + `sync_all` + atomic rename, with platform-native durability for the rename step: Unix does `rename` + parent-dir `sync_all` (journal commit of the new directory entry); Windows does `MoveFileExW(MOVEFILE_WRITE_THROUGH [| MOVEFILE_REPLACE_EXISTING])` (USN journal commit + rename in one syscall). `replace=false` returns `io::ErrorKind::AlreadyExists` on a pre-existing destination, mapped at call sites to plugin-specific defensive variants (`vault_creation::commit_with_vault_path::VaultArtifactsPresent` — broadened in 2026-05-26 to recognize vault.meta, vault.meta.tmp, and notes/*.myn; `notes::note_create::NoteAlreadyExists`). See `decisions.md` 2026-05-07 "`atomic_write` durability hardening + `replace: bool` parameter" for the full rationale (write-frequency pressure, dual-helper rejection, Windows primitive choice, `RENAME_NOREPLACE` Phase 2 deferral).

A **returned error** (temp write/`sync_all` failure, or `finalize_atomic` rename failure) drops the partial `<path>.tmp` on the way out (best-effort; the original error is surfaced) — a failed write leaves no stray temp sibling. Vault-internal callers always pass ciphertext (encoded blobs), so a leftover temp inside the vault never exposes plaintext even when cleanup is skipped. **Amended 2026-06-11 (export suite):** the user-initiated export commands (MYND-115/211/255) are plaintext callers — their temp sibling lives at the **user-chosen export destination**, which is plaintext by the user's own intent (threat-model TB3 egress exception), never inside the vault. The "temp = ciphertext" invariant continues to hold for every vault-resident path. Export-destination writes use `atomic_write_unclobbered` (randomized `create_new` temp name) so a write can never truncate a pre-existing user file named `<target>.tmp` or a sibling export whose final name is `*.tmp` — the fixed `<path>.tmp` name of plain `atomic_write` stays load-bearing for vault-internal artifact recognition (`vault.meta.tmp`) and must not be used at user destinations. The interrupted-write recovery contract is exercised by a `#[cfg(test)]` fault-injection seam (the private `Fault` enum + `atomic_write_inner`/`write_temp`); the production `atomic_write` passes `Fault::None`, so in non-test builds the seam compiles out to the straight-line path (zero runtime cost). See `decisions.md` 2026-06-08 "Interrupted-write recovery test gate + `atomic_write` failure-path `.tmp` cleanup (MYND-88)".

**`note_delete` durability is asymmetric** — Unix arm runs `parent_dir.sync_all()` after `std::fs::remove_file`; Windows arm is `#[cfg(unix)]`-explicit no-op (no `FlushFileBuffers` parent-handle, no `windows-sys` direct dep extension). Write durability protects data integrity (a half-written `.myn` = AEAD-tag-fail = permanent loss); delete durability protects redundancy elimination (a power-loss-reverted delete = trivial repeat — the user re-deletes; AEAD-encrypted bytes leak nothing in the meantime). Failure modes are structurally different; the "symmetric durability" intuition mixes data-integrity discipline with idempotency-of-cleanup. Phase 2 sync layer revisit hook: if deterministic delete-event ordering across devices is required, the s2 path (`FlushFileBuffers` parent-handle on Windows) becomes a Phase 2 dep; not in v0.1. See `decisions.md` 2026-05-07 "`note_delete` durability: Unix parent-dir `sync_all` only; Windows s1 best-effort" for the full asymmetry rationale + s2 rejection cost analysis.

## Paths

`src/paths.rs` — derive `vault_dir` from `app_data_dir()/vault/` per `decisions.md` 2026-04-28 "Vault path: app_data_dir/vault/, single vault per OS user in Phase 1". Don't hardcode user paths.

## Common commands

```bash
cargo check -p myne_desktop_lib
cargo clippy -p myne_desktop_lib --all-targets -- -D warnings
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
- `tauri::api::path::app_data_dir()` resolves differently in dev vs production. In dev it lands under the dev identifier; production uses the bundle identifier. Don't write to absolute paths.
