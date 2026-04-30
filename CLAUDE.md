# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Pre-alpha.** No application logic has shipped. What exists today: the v0.1 specifications under `docs/`, the Tauri 2 + Vite + React + TypeScript scaffold (`src/`, `src-tauri/`, `public/`, `index.html`, `package.json`, `vite.config.ts`), the Rust crypto crate scaffold (`protocol/` — `#![no_std]` + `alloc`, RustCrypto stack, modules currently stubs), the Cargo workspace at the repo root (`Cargo.toml` + shared `Cargo.lock`), the workspace setup scripts (`workspace/`), and pinned toolchain files.

The desktop scaffold deliberately lives at the **repository root**, not under `apps/desktop/` — there is only one in-repo client (Phase 1 desktop) and the protocol crate; everything else (mobile, web, server, website, ops, test vectors) is a companion repo. See `design-notes.md` "Desktop scaffold lives at repository root".

## Common commands

This is a Tauri 2 app driven by **pnpm** (Tauri's `beforeDevCommand` / `beforeBuildCommand` invoke `pnpm dev` / `pnpm build`). The pinned Node version is in `.nvmrc` (25.9.0); the pinned Rust toolchain is in `rust-toolchain.toml` at the repo root (1.90.0, profile `minimal`, with `rustfmt` + `clippy`). CI and reproducible-build instructions read these files — do not bypass them.

```bash
# UI / desktop
pnpm install
pnpm tauri dev          # full Tauri dev (spawns Vite on :1420 + Rust core)
pnpm dev                # Vite only — port is fixed via strictPort, fails if 1420 is taken
pnpm build              # tsc (typecheck) + vite build → ../dist/ (consumed by Tauri)
pnpm tauri build        # production desktop bundle

# Rust workspace (run from repo root)
cargo check                                       # whole workspace
cargo check -p protocol                           # protocol crate only
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt                                          # format whole workspace
cargo test --workspace                            # all tests
cargo test -p protocol <name>                     # one test by name in the protocol crate
cargo test --test <integration-file>              # one integration test file

# Multi-repo workspace
./workspace/setup.sh        # clone every companion in workspace/manifest.txt INTO this repo
./workspace/pull-all.sh     # git pull --ff-only on main + every nested companion
./workspace/status-all.sh   # one-line git status per repo
./workspace/link-skills.sh  # symlink agent-tooling/skills/* into .claude/skills/
```

Vite is configured (in `vite.config.ts`) to ignore `src-tauri/**` from its watcher and to keep `clearScreen: false` so Rust errors are not hidden — keep both when editing the config.

There is no test runner wired up yet (no Vitest, no Jest); the only TypeScript "test" today is `tsc` via `pnpm build`. When adding tests, use the language-appropriate runner for the layer you are touching (Rust → `cargo test`; TS → add Vitest if needed).

## Architecture and code organisation

### What lives where, and why

```
myne/
├── docs/                ← specs, threat model, glossary, decisions log (CC0)
├── src/                 ← React UI (single page, Tauri WebView)
├── src-tauri/           ← Tauri 2 + Rust desktop core
│   └── capabilities/    ← Tauri capability ACLs (security-load-bearing)
├── protocol/            ← Rust crypto crate (#![no_std] + alloc, RustCrypto stack)
├── public/              ← static assets bundled into the WebView
├── workspace/           ← multi-repo helper scripts + manifest
├── Cargo.toml           ← Cargo workspace root (members: src-tauri, protocol)
├── Cargo.lock           ← single shared lockfile (TB9 audit anchor)
├── rust-toolchain.toml  ← pinned Rust toolchain (single canonical location)
├── index.html           ← Vite entry
├── package.json         ← pnpm + Vite + React 19 + TS toolchain
├── vite.config.ts       ← Tauri-aware Vite config (port 1420, ignores src-tauri)
├── tsconfig.json        ← strict mode + noUnusedLocals/Parameters
└── .nvmrc               ← pinned Node (reproducible builds)
```

The repo is a single Cargo workspace at root with **one shared `Cargo.lock`** — required for the hash-pinned-lockfile audit story (see `docs/threat-model.md` §3 TB9). The `protocol/` crate is `#![no_std]` + `extern crate alloc;` so Phase 3 wasm-reuse (if chosen) does not require a refactor.

### Companion repositories (cloned inside this repo)

Running `./workspace/setup.sh` clones every repo in `workspace/manifest.txt` as nested directories: `myne-test-vectors/`, `myne-server/`, `myne-web/`, `myne-mobile/`, `myne-website/`, `operations/`. Each carries its own `.git` and is excluded by the parent `.gitignore` so they do not appear as untracked here. **Each companion is a separate GitHub repo under the [`myne-md`](https://github.com/myne-md) org** — never commit changes to them through this repo.

### The spec is the source of truth

Read `docs/` before changing anything that touches cryptography, on-disk format, key handling, or sync. Order:

1. `docs/vision.md` — phased plan, anti-features (these are commitments, not "maybe later").
2. `docs/threat-model.md` — 13 adversaries (A1–A13), 17 assets (AS1–AS17), 9 trust boundaries (TB1–TB9). **Normative**: marketing copy and code may not exceed its guarantees.
3. `docs/spec/protocol.md` — v0.1 cryptographic protocol.
4. `docs/spec/account-number.md` — 20-character Crockford-base32 + Damm-32 identifier format.
5. `docs/glossary.md` — canonical terminology (~115 entries). Every new term added in any doc must come with a glossary entry in the same change.
6. `design-notes.md` — append-only timeline. Newest entry **last**. Reversals get new entries that say "supersedes <date> — <title>"; never delete or rewrite past entries.

### Cryptographically load-bearing identifiers

These strings/bytes are bound into AEAD tags or magic-byte checks. Changing any of them is a major-version event:

| Use site | Value |
|---|---|
| AAD prefix (every AEAD tag) | `"myne.v0.1\|"` (10 ASCII bytes; `protocol.md` §5.2) |
| HKDF context-string prefix | `"myne.v0.1 "` (note trailing space; §3.2) |
| Salt domain prefix (password) | `"myne.v0.1 argon2id-password\|"` |
| Salt domain prefix (recovery) | `"myne.v0.1 argon2id-recovery\|"` |
| Per-note blob magic | `MY01` (extension `.myn`) |
| Vault metadata magic | `MYV1` (file `vault.meta`) |
| Protocol identifier string | `myne-protocol-v0.1` |
| Account-number display prefix | `MY-XXXX-XXXX-XXXX-XXXX-X` |

v005 reservations: `MY05`/`MYV5` magic, `"myne.v005 "` HKDF prefix. v0.1 and v005 are **forward-incompatible by design** — no extension points, no algorithm-agility headers; cross-major reads happen only via explicit user-initiated migration.

### Subkey derivation discipline

All subkey derivations MUST go through a single canonical helper (`DeriveSubkey(rootKey, role)` or its language equivalent) that constructs `info = "myne.v0.1 " || role` from the registered role table in `protocol.md` §3.4. **Code review must reject any direct call to `hkdf.expand` / `crypto_kdf_hkdf_sha256_expand` outside this helper.** This recovers the structural API guarantee that BLAKE3 `derive_key` would have offered natively, without taking on a second KDF.

### Crypto primitives baseline

- **KDF**: Argon2id `m=256 MiB, t=3, p=2`, version 1.3. Parameters are **stored in `vault.meta`** (canonical 11-byte block) and bound into both `AAD_password_wrap` and `AAD_recovery_wrap` — defeats parameter-downgrade.
- **Subkey derivation**: HKDF-SHA-256 (RFC 5869) via the RustCrypto `hkdf` crate (Rust client); libsodium-equivalent on other clients.
- **AEAD**: XChaCha20-Poly1305 wrapped in CTX commitment (Chan & Rogaway, ESORICS 2022): `T' = SHA-256(K[32] || N[24] || len(AD)[4 BE] || AD || T[16])`. On-disk tag fields are 32 bytes (the CTX commitment), not 16 (the Poly1305 tag is recomputed at decrypt and discarded).
- **Recovery phrase**: BIP-39 24 words → fed **directly** to Argon2id (BIP-39's PBKDF2-HMAC-SHA512-2048 is **not** used; BIP-39 here is encoding-only for 256-bit entropy).
- **Library (Rust desktop)**: **RustCrypto stack** — `hkdf`, `argon2`, `chacha20poly1305`, `sha2`, plus `zeroize` for memory hygiene and `getrandom` for OS CSPRNG. The `protocol/` crate is `#![no_std]` + `extern crate alloc;`. Other clients use libsodium-equivalent APIs at the byte level (Go server `golang.org/x/crypto`; mobile iOS/Android native libsodium; Phase 3 web's primitive provider deferred to Phase 3 start). Cross-implementation byte-level compatibility is validated by `myne-test-vectors/`. Audit anchors: `chacha20poly1305` NCC Group (Feb 2020, no significant findings), `vodozemac` Least Authority (Mar 2022, no significant findings), `age`/`rage` prod use. **No custom primitive implementations on any client.** See `design-notes.md` "2026-04-28 — Rust-side primitives: RustCrypto stack as primary".

### Hard architectural commitments (don't quietly walk these back)

- **No email at signup, no email recovery — ever.** Adding email recovery silently invalidates the zero-knowledge claim.
- **No plaintext mode and no encryption opt-in.** Privacy is the default for every user.
- **No persistent server-side IP logging.** Abuse mitigation must work on per-account counters, not per-IP. Reflected in protocol design from day one, not retrofitted.
- **User-meaningful timestamps live inside the encrypted blob.** The server uses an opaque per-note version counter for conflict detection; conflict resolution happens client-side after decryption. This precludes a server-side last-write-wins design.
- **Self-hosted and hosted servers share the exact same trust boundary (TB5).** Same protocol, same security model.
- **Reproducible signed builds, hash-pinned lockfiles, minimal direct-dependency surface.** This is the credible substitute for the missing third-party audit (`threat-model.md` §6) and informs every dependency decision — including why this app uses Vite + React rather than Next.js. Adding a dependency is a security decision.

### Tauri configuration that matters

- `src-tauri/tauri.conf.json` declares `beforeDevCommand: "pnpm dev"` and `beforeBuildCommand: "pnpm build"` — **pnpm is the package manager**; do not switch to npm/yarn here.
- `src-tauri/capabilities/default.json` declares the capability ACL for the main window. Tauri 2's permission system is opt-in per command — adding a new Tauri plugin or invoke handler typically requires a corresponding permission entry here. Treat this file as security-load-bearing and review changes carefully.
- The Tauri `lib` is named `myne_desktop_lib` (in `src-tauri/Cargo.toml`); `src-tauri/src/main.rs` calls into it. The crate name pattern `_lib` suffix is required so the lib does not collide with the bin name on Windows (rust-lang/cargo#8519).

## License

Currently CC0 (docs only). When Phase 1 application code lands, the repo moves to **AGPL-3.0** with the `docs/` subtree retaining a permissive content license so the spec stays reusable for independent implementations. The transition gets recorded in `design-notes.md` when it happens.