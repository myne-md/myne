# protocol/ — Myne v0.1 cryptographic primitives (Rust)

> Subdirectory CLAUDE.md. Loaded when Claude reads files here. See repo-root `CLAUDE.md` for cryptographically load-bearing identifiers and project-wide context.

## Crate constraints (non-negotiable)

- **`#![no_std]` + `extern crate alloc;`** — Phase 3 wasm-reuse must not require a refactor.
- **License: AGPL-3.0-or-later** — every new file gets the SPDX header `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- **No custom primitive implementations.** Pure-Rust RustCrypto only (audited stack); no hand-rolled AES, no hand-rolled SHA, no clever constant-time tricks.

## Stack (RustCrypto, hash-pinned)

| Use | Crate | Notes |
|---|---|---|
| Subkey derivation | `hkdf` (0.12, no_std) | RFC 5869 HKDF-SHA-256 |
| KDF | `argon2` (0.5, alloc-only) | Argon2id v1.3, `m=256 MiB, t=3, p=2` |
| AEAD | `chacha20poly1305` (0.10, alloc-only) | XChaCha20-Poly1305 + manual CTX outer SHA-256 |
| Hash | `sha2` (0.10, no_std) | SHA-256 for CTX commitment + salts |
| Memory hygiene | `zeroize` (1.8, alloc + derive) | `#[derive(Zeroize, ZeroizeOnDrop)]` for all key material |
| OS CSPRNG | `getrandom` (0.2) | salts, nonces, root_key generation |
| Recovery phrase | `bip39` (2, alloc-only) | 24-word encoding/decoding only — **NOT** PBKDF2 step |
| Constant-time | `subtle` (2, no_std) | tag verification |

**Audit anchors:** `chacha20poly1305` reviewed by NCC Group (Feb 2020, no significant findings); `vodozemac` (uses RustCrypto stack heavily) reviewed by Least Authority (Mar 2022, no significant findings); `age`/`rage` production use validates the same primitives at the byte level. See `decisions.md` 2026-04-28 "Rust-side primitives: RustCrypto stack as primary".

## Subkey derivation discipline (LOAD-BEARING)

All subkey derivations MUST go through the canonical helper:

```rust
fn derive_subkey(root_key: &[u8; 32], role: SubkeyRole) -> [u8; 32]
```

The helper constructs `info = "myne.v0.1 " || role` from the registered `SubkeyRole` enum (matches `protocol.md` §3.4). The underlying `hkdf::Hkdf::expand` call is **module-private**.

**Code review must reject any direct call to `hkdf.expand` outside this helper.** This recovers the structural API guarantee that BLAKE3's `derive_key` would have offered natively. There is a clippy lint configured to forbid `pub use hkdf::Hkdf::expand` re-exports.

**Why it matters:** an ad-hoc `info` string that drifts from the registered role table silently produces a different subkey, but the AEAD tag check might still pass with another caller's wrong-key blob. The only defense is making it impossible to construct an `info` outside the registry.

## Module map

| Module | Purpose |
|---|---|
| `kdf.rs` | Argon2id wrap helpers (`password_wrap_key`, `recovery_wrap_key`); canonical 11-byte param block; AAD construction binds params + role |
| `subkey.rs` | `derive_subkey` canonical helper + `SubkeyRole` enum |
| `aead.rs` | `ctx_encrypt` / `ctx_decrypt` (XChaCha20-Poly1305 + SHA-256 outer); 32-byte tag on disk |
| `vault_meta.rs` | `MYV1` magic encoder/decoder per `protocol.md` §9.3 |
| `account_number.rs` | Crockford base32 + Damm-32; `MY-XXXX-XXXX-XXXX-XXXX-X` display formatter; NFKD-aware parse/normalize |
| `phrase.rs` | BIP-39 24-word generation + NFKD-normalized validation |
| `error.rs` | `ProtocolError` enum (serde-serialize for TS interop) |
| `types.rs` | `KdfParams`, `VaultMeta`, `AccountNumber`, `RecoveryPhrase` newtypes |
| `blob.rs` | **planned (Lane A #8)** — `MY01` blob encoder per `protocol.md` §9.2 |

## Vector verification (Lane D, retroactive borç)

A2/A3/A4/A5/A6 merged without test vectors. The `myne-test-vectors/` companion repo will hold:
- `vectors/argon2id/` (D4 → A4)
- `vectors/xchacha20-poly1305-ctx/` (D3 → A3)
- `vectors/hkdf-sha256/` (D2 → A2)
- `vectors/account-number/` (D7 → A5)
- `vectors/aad-construction/` (per-AEAD AAD assembly)
- `vault.meta` byte-string vectors (D5 → A6)
- `.myn` blob vectors (D6 → A7, after blob.rs lands)

When you change a primitive: regenerate the relevant vector file in the companion repo and bump it in the same PR. CI (Plan 1 §C2) will pull `myne-test-vectors` and re-run vectors against the current Rust impl.

## Common commands

```bash
cargo check -p protocol
cargo clippy -p protocol --all-targets -- -D warnings
cargo test -p protocol
cargo test -p protocol <test-name>          # filter by name
cargo doc -p protocol --no-deps --open      # local docs
```

## Gotchas

- **`getrandom` requires explicit feature on wasm32** (not in scope for Phase 1 desktop, but if someone tries to compile for wasm later they need `getrandom = { features = ["js"] }`). Don't promise wasm support without testing it.
- **Argon2id memory cost is 256 MiB.** Tests that exercise it need extra heap; CI runners must have ≥1 GiB free or tests panic. For unit tests that don't care about real KDF strength, use a test-only fixture with `m=8 KiB, t=1, p=1` — never check that fixture into a production code path.
- **Nonce reuse is catastrophic** — `getrandom` is the only acceptable source for nonces in v0.1. There is no counter-mode fallback.
- **CTX commitment ≠ Poly1305 tag.** On disk we store the 32-byte SHA-256 outer; the Poly1305 tag is recomputed at decrypt and discarded. Don't expose the bare Poly1305 tag in any public type.
