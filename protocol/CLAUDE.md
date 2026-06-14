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
| Tracing facade | `tracing` (0.1, no default features) | non-distinguishing decode failures emit cause via `tracing::debug!(stage = ?cause)` so ops/forensics can disambiguate without crossing the IPC boundary (§6.4 boundary-policy discipline; cf. `decisions.md` 2026-05-02 vault-unlock-error-discipline). Zero default features — pure macro-call surface; no subscriber wired into the crate. |

**Audit anchors:** `chacha20poly1305` reviewed by NCC Group (Feb 2020, no significant findings); `vodozemac` (uses RustCrypto stack heavily) reviewed by Least Authority (Mar 2022, no significant findings); `age`/`rage` production use validates the same primitives at the byte level. See `decisions.md` 2026-04-28 "Rust-side primitives: RustCrypto stack as primary".

## Subkey derivation discipline (LOAD-BEARING)

All subkey derivations MUST go through the canonical helper:

```rust
fn derive_subkey(root_key: &[u8; 32], role: SubkeyRole) -> [u8; 32]
```

The helper constructs `info = "myne.v0.1 " || role` from the registered `SubkeyRole` enum (matches `protocol.md` §3.4). The underlying `hkdf::Hkdf::expand` call is **module-private**.

**Code review must reject any direct call to `hkdf.expand` outside this helper.** This recovers the structural API guarantee that BLAKE3's `derive_key` would have offered natively. There is a clippy lint configured to forbid `pub use hkdf::Hkdf::expand` re-exports.

**Why it matters:** an ad-hoc `info` string that drifts from the registered role table silently produces a different subkey, but the AEAD tag check might still pass with another caller's wrong-key blob. The only defense is making it impossible to construct an `info` outside the registry.

## `_raw` suffix convention (caller-supplied randomness)

Public functions in this crate that accept caller-supplied nonces, item keys, or other randomness — rather than pulling from `getrandom` internally — carry a `_raw` suffix. Three properties travel with that suffix at every call site:

1. **Caller sources all randomness from a CSPRNG-grade source.** Passing low-entropy or attacker-influenced bytes to a `_raw` function is a security-fatal contract violation owned by the caller, not by the crate.
2. **Nonce reuse is catastrophic and is the caller's contract.** The crate cannot detect cross-call nonce collisions; the suffix is the visible reminder that the caller is on the hook.
3. **Legitimate consumers are well-defined.** `_raw` functions exist for the `myne-test-vectors/` companion (byte-level cross-implementation vector generation) and for crate-internal deterministic tampering / golden tests. Production callers SHOULD use the non-`_raw` convenience wrapper that pulls randomness internally.

A code reviewer seeing a production import of a `_raw` function from outside this crate has a clear reason to question the change. The convention is greenfield-applied — first instance is `blob.rs` (MYND-25). Backporting to existing functions that match the property (e.g., `aead.rs::aead_seal_ctx`) is a separate decision, not implicit. See `decisions.md` 2026-05-06 entry for the full rationale.

## AAD helper naming discipline (`vault_` / `note_` prefix)

AAD-builder functions in `aead.rs` are prefixed with `vault_` (vault-singleton context) or `note_` (per-note context) to retire a one-letter near-collision footgun: spec §5.2 distinguishes `AAD_wrap_items_key` (singleton itemsKey wrap, no per-note UUID) from `AAD_wrap_item_key` (per-note item_key wrap, with note_uuid). The `items_key` / `item_key` token pair differs by a single trailing `s` — visually indistinguishable at a glance, type-confusable in import statements, and historically a documented hazard class for crypto code (the kind of footgun the subkey discipline rule above exists to prevent at the subkey level).

The discipline:

- `aad_vault_*_wrap` → AAD for an AEAD operation in the vault-singleton scope (e.g., `aad_vault_items_key_wrap` wraps the singleton `itemsKey` under `itemsKey_wrap_key`).
- `aad_note_*_*` → AAD for an AEAD operation in the per-note scope (e.g., `aad_note_item_key_wrap` wraps a per-note `item_key` under `itemsKey`; `aad_note_content_encrypt` encrypts note content under `item_key`).

The three-letter `vault_` / `note_` prefix is visible at a glance in any import or call-site — same defense shape as the subkey-derivation single-helper rule, applied at the AAD-builder layer. This discipline replaces the earlier `aad_items_key_wrap` (singleton-only) name at MYND-25; the rename is recorded in `decisions.md` 2026-05-06 entries that pin the per-note codec design.

**Code review must reject** any new AAD-builder function whose name relies on a one-character distinction (e.g., `aad_item_key_wrap` next to `aad_items_key_wrap`); collapse to the prefix-disambiguated form.

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
| `blob.rs` | `MY01` per-note encoder/decoder per `protocol.md` §9.2; per-note `item_key` wrap + content encrypt; deterministic `_raw` surface (D6 verification) + `getrandom` convenience surface; `DecryptedNote` handle (Zeroizing on `item_key` + plaintext); single-variant `DecryptError` + `pub(crate) DecryptCause` for tampering-test verification (MYND-25) |
| `template.rs` | MYND-188 deterministic note-template `{{token}}` substitution: `render(template, ctx)` pure function (single left-to-right pass, never re-scans substituted values), `RenderContext` host-injected time/locale strings (no clock/locale in the crate), `supported_tokens()` registry accessor — one closed 5-token registry feeds both (anti-plugin / no-scripting commitment in code) |

## Vector verification (Lane D, retroactive debt)

A2/A3/A4/A5/A6 merged without test vectors. The `myne-test-vectors/` companion repo will hold:
- `vectors/argon2id/` (D4 → A4)
- `vectors/xchacha20-poly1305-ctx/` (D3 → A3)
- `vectors/hkdf-sha256/` (D2 → A2)
- `vectors/account-number/` (D7 → A5)
- `vault.meta` byte-string vectors (D5 → A6)
- `.myn` blob vectors (D6 → MYND-25, blob.rs landed). The `myn-blob` category now also pins the **§6.3 update path** (`encode_update_blob_raw`) via `encrypt_update` cases — the spliced-`header_prefix` (verbatim `enc_item_key`) invariant is the cross-impl contract. Generator: `emit_myn_blob_vectors_for_paste`.
- `vectors/vault-search/` (D8 → MYND-29, `search_blob.rs` `MYS1` codec; landed). Also extended `hkdf-sha256` with the `SearchIndexKey` role and `ctx-aead` with the `aad_search_index_blob` builder in lockstep — the search path's KEK derivation + AAD assembly + blob framing are all now pinned.
- `vectors/password-policy/` (`validate_min_length` floor; boolean accept/reject, counts USVs not bytes). Generator: `emit_password_policy_vectors_for_paste` (`password_policy.rs`).
- `vectors/bip39-recovery/` (end-to-end `normalize_user_phrase` → `derive_recovery_wrap_key_from_normalized`; pins NFKD-before-Argon2id). Generator: `emit_bip39_recovery_vectors_for_paste` (`kdf.rs`); **~9 s** default-on.
- `vectors/aad-construction/` (per-call-site AAD framing decomposition for all 7 pub `aad_*` builders — full bytes + labeled segment offsets, a layer atop `ctx-aead`'s builder-byte pins). Generator: `emit_aad_construction_vectors_for_paste` (`aead.rs`).
- `vectors/attachment-blob/` + `vectors/attachments-catalog/` (MYND-164: `MYA1` per-attachment codec incl. `compute_attachment_id` determinism + `MYC1` catalog codec). Generators: `emit_attachment_blob_vectors_for_paste` (`attachment_blob.rs`), `emit_attachments_catalog_vectors_for_paste` (`attachments_catalog.rs`). The catalog set includes a §9.10.2 unknown-field tolerance `decrypt_ok` case; `hkdf-sha256` covers both attachment subkey roles directly (all 5 registered roles pinned, runner-enforced).
- The MYND-205 `label` field + §9.5.2 forward-compat tolerance ride the `vault-prefs` family as appended cases. Generator: `emit_label_and_tolerance_prefs_vectors` (`prefs.rs`) — separate per-feature generator; the original `emit_prefs_vectors_for_paste` stays stable. The `vault_meta_rewrite` family carries a unicode-password case + a production-canonical-KDF-params case (the latter costs **~3 s + 256 MiB** per `--test vectors` run, generator `emit_vector_hex_for_paste` in `vault_meta.rs`).
- `vectors/note-template/` (MYND-227: `template::render` + `supported_tokens` — deterministic, cross-impl-relevant client behavior in the `password-policy` class, not a codec). 12 cases: 11 `render` (incl. the load-bearing single-pass `render-title-not-rescanned` pin and an NFD byte-transparency case; all strings pinned `*_utf8_hex`) + 1 `token_registry` order/set pin. Generator: `emit_note_template_vectors_for_paste` (`template.rs`), self-asserting at mint.
- MYND-227 also closed the **structural `parse_fail` asymmetry**: every blob family now pins its decode-reject surface at `vault-search` parity. `vault-prefs` + `attachments-catalog` get one distinguishable case per error variant (incl. the post-AEAD `plaintext_parse_failed`); `myn-blob` + `attachment-blob` get 8 non-distinguishing structural rejects each (incl. §10.1 strict-trailing) + an items-key-id-mismatch aead-fail case; `vault-meta` gains wrong-length / protocol-version / kdf-id / argon2-version tampers. **Non-distinguishing parse_fail fixtures carry the real keys** — header bytes are not AAD-bound, so a port that skips a structural check decodes `Ok` and the runner catches it; dummy keys would mask the bug as a coincidental AEAD failure. Append generators (originals stay byte-stable): `emit_vault_meta_parse_fail_vectors`, `emit_prefs_parse_fail_vectors`, `emit_catalog_parse_fail_vectors`, `emit_myn_blob_parse_fail_vectors`, `emit_attachment_blob_parse_fail_vectors`. Encode-side caps (`AttachmentTooLarge`, oversized-plaintext `CiphertextLenOverflow`) are deliberately unvectored — multi-MB fixtures; the caps are pinned from the read direction by the `ciphertext-len-overflow` cases instead.
- `vectors/vault-workspace/` (MYND-254: `MYW1` `workspace_blob.rs` codec, landed code-side with MYND-166). Mirrors `vault-search` (opaque inner plaintext, 12-case shape incl. the load-bearing `format_unsupported` forward hook). Extended `hkdf-sha256` with the `SessionStateKey` role (`session-state-key`) and `ctx-aead` + `aad-construction` with the `aad_workspace_blob` builder (role `workspace-blob`) in lockstep — KEK derivation + AAD assembly + blob framing all pinned, same pattern as the MYND-29 search landing. Generator: `emit_vault_workspace_vectors_for_paste` (`workspace_blob.rs`).
- `vectors/vault-indices/` (MYND-271: `MYI1` `vault_indices_blob.rs` codec, §9.8; design MYND-31). Mirrors `vault-search`/`vault-workspace` (opaque inner plaintext, 12-case shape incl. the load-bearing `format_unsupported` forward hook). Extended `hkdf-sha256` with the `VaultIndicesKey` role (`vault-indices-key`) and `ctx-aead` + `aad-construction` with the `aad_vault_indices_blob` builder (role `vault-indices-blob`) in lockstep — KEK derivation + AAD assembly + blob framing all pinned, same pattern as the MYND-29 search landing. **Distinct blob family from `vault.search`** (`MYI1` != `MYS1`; `vault-indices-key` != `search-index-key`). Generator: `emit_vault_indices_vectors_for_paste` (`vault_indices_blob.rs`). The structured index's value-typing (what feeds the blob) is pinned separately by the `property-coercion` TS-runner category (§3.6.4).
- `vectors/backup-container/` (MYND-254: `MYB1` `.myne-backup` container, §9.11, codec landed with MYND-217). **Generator and runner live in `src-tauri/src/backup_container.rs`, not this crate** — the codec is std/fs/streaming-bound and cannot enter the no_std protocol crate (first family generated outside `protocol/`; see `docs/decisions.md` 2026-06-11). Generator: `emit_backup_container_vectors_for_paste`, runner: `backup_container_vectors`, both `cargo test -p myne-desktop --lib`; the runner follows this crate's skip-if-missing discipline.

**All cross-impl-relevant deterministic surfaces are now vectored.** The remaining unvectored public functions are randomized (`generate_account_number`, `generate_recovery_phrase`), `getrandom`-pulling convenience wrappers (`encode_new_note`, `encode_update`, `encode_prefs_blob`, `encode_search_index_blob`, `encode_workspace_blob`, `encode_attachment_blob`, `encode_attachments_catalog`) whose deterministic `_raw` siblings carry the contract, or host-policy conveniences (`read_or_empty` — call-site fallback over the vectored catalog codec).

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
