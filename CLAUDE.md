# CLAUDE.md

Guidance to Claude Code (claude.ai/code) when working in this repository.

Subdirectory CLAUDE.md files cover their own domain in depth — they lazy-load when Claude reads files there:
- `src-tauri/CLAUDE.md` — Tauri 2 host, capability ACL, plugin pattern, Windows lib-name quirk
- `protocol/CLAUDE.md` — RustCrypto primitives, subkey derivation discipline, vector-verification
- `src/CLAUDE.md` — React UI patterns, design tokens, mock-layer status
- `docs/CLAUDE.md` — spec authoring rules (decisions.md append-only, glossary discipline)
- `myne-agents/CLAUDE.md` — agent + skill + feature/session/plan layout

## Design context (pointer)

Three files at the repo root carry the visual + strategic system. Read in this order before designing any UI:

1. `PRODUCT.md` — strategy: register, users, voice, brand personality, anti-references, design principles. Cross-client (desktop + future mobile + web). Read before any new screen.
2. `DESIGN.md` + `DESIGN.json` — visual system in [Google Stitch DESIGN.md format](https://stitch.withgoogle.com/docs/design-md/format/). Frontmatter is the machine-readable token layer; `DESIGN.json` carries the live-panel components, tonal ramps, shadow + motion + focus extensions.
3. `docs/design/` — the **code-side projection** of the design canon: `README.md` (voice + tactical rules), `colors_and_type.css` (CSS variable source), `ui_kits/desktop/` (JSX primitives), `preview/` (token specimen tabs).

**Penpot is the canonical design source**, connected via the `penpot` MCP server (page `4 — Desktop UI Kit`, screens 1280×800). Workflow is **Penpot → revise in Penpot → implement in code**, never the reverse. When code and Penpot disagree, Penpot wins by default and the projection gets updated; a Playwright + Penpot diff harness at `scripts/penpot-diff.sh` (procedure: `docs/dev/penpot-design-diff.md`) names the side that is wrong with RMSE + SSIM + per-region scores. Drift artefacts land in `manual-fixes-needed.md`. The `penpot-sync` skill automates this loop.

`/impeccable` commands (craft, polish, audit, etc.) read `PRODUCT.md` + `DESIGN.md` automatically. Do not duplicate their content into other docs.

## Project status

**Pre-alpha.** Shipped: v0.1 specs (`docs/`), Tauri 2 + Vite + React + TS scaffold (`src/`, `src-tauri/`), Rust crypto crate (`protocol/`, RustCrypto, `#![no_std]` + `alloc`), Cargo workspace (one shared `Cargo.lock`), workspace scripts, pinned toolchain. The desktop scaffold lives at the **repo root** deliberately — there is one in-repo client; mobile/web/server/website/ops/test-vectors are companion repos. See `docs/decisions.md` "Desktop scaffold lives at repository root".

## Common commands

```bash
pnpm tauri dev          # full Tauri dev (spawns Vite on :1420 + Rust core)
pnpm dev                # Vite only — port fixed via strictPort, fails if 1420 is taken
pnpm tauri build        # production desktop bundle

cargo test -p protocol <name>     # one test in protocol crate
cargo clippy --workspace --all-targets -- -D warnings

brew install lefthook && lefthook install   # one-time per clone; activates git hooks
```

Git hooks are managed by **lefthook** (`lefthook.yml`). `pre-commit` runs the fast lint set (rustfmt-check, `tsc --noEmit`, whitespace, EOF newline, secret pattern guard, single-Cargo.lock check); `pre-push` runs the full battery (`cargo clippy --workspace -- -D warnings`, `cargo test --workspace`, `pnpm build`). No CI yet — these hooks are the safety net. Bypass with `git commit --no-verify` only when you understand why.

`pnpm` is the canonical package manager (Tauri's `beforeDevCommand`/`beforeBuildCommand` invoke it). Pinned versions: Node `.nvmrc`, Rust `rust-toolchain.toml`. **Do not bypass the pinning** — CI and reproducible-build rely on it.

No JS test runner wired up yet (no Vitest/Jest); `tsc` via `pnpm build` is the only TypeScript "test". Add Vitest if needed; for Rust use `cargo test`.

## What lives where

```
myne/
├── docs/                ← specs, threat model, glossary, decisions log (CC0)
├── src/                 ← React UI (Tauri WebView)
├── src-tauri/           ← Tauri 2 + Rust desktop core
│   └── capabilities/    ← Tauri capability ACLs (security-load-bearing)
├── protocol/            ← Rust crypto crate
├── public/              ← static assets bundled into the WebView
├── workspace/           ← multi-repo helper scripts + manifest
├── Cargo.toml           ← workspace root (members: src-tauri, protocol)
├── Cargo.lock           ← single shared lockfile (TB9 audit anchor)
├── rust-toolchain.toml  ← pinned Rust toolchain
├── package.json         ← pnpm + Vite + React 19 + TS toolchain
└── vite.config.ts       ← Tauri-aware Vite config
```

**Companion repos** (clone via `./workspace/setup.sh` reading `workspace/manifest.txt`): `myne-test-vectors/`, `myne-server/`, `myne-web/`, `myne-mobile/`, `myne-website/`, `myne-ops/`, `myne-agents/`. Each is a separate GitHub repo under [`myne-md`](https://github.com/myne-md) — **never commit changes to them through this repo**. Each carries its own CLAUDE.md (lazy-load when you `cd` into it).

## The spec is the source of truth

Read `docs/` before changing anything that touches cryptography, on-disk format, key handling, or sync. Order:

1. `docs/vision.md` — phased plan, anti-features (commitments, not "maybe later")
2. `docs/threat-model.md` — A1–A13 adversaries, AS1–AS17 assets, TB1–TB9 trust boundaries. **Normative**: marketing copy and code may not exceed its guarantees.
3. `docs/spec/protocol.md` — v0.1 cryptographic protocol
4. `docs/spec/account-number.md` — 20-character Crockford-base32 + Damm-32 identifier
5. `docs/glossary.md` — canonical terminology (~115 entries). Every new term in any doc gets a glossary entry in the same change.
6. `docs/decisions.md` — append-only timeline. Newest entry **last**. Reversals get new entries that say "supersedes <date> — <title>"; never delete or rewrite past entries.

See `docs/CLAUDE.md` for spec-authoring discipline in depth.

## Phase 1 plan & ownership

Active Phase 1 work is tracked in Plane: **plane.myne.md** (self-hosted). Lane IDs (`A`, `B`, `C`, `D`, `S`) are retired — Plane native work-item identifiers (e.g., `MYN-…`) are the new anchor for cross-references in `docs/decisions.md`, feature directories, commit subjects, and PR titles. Historical lane-ID references in `docs/decisions.md` and git history are preserved (append-only spec discipline).

## Cryptographically load-bearing identifiers

Bound into AEAD tags or magic-byte checks. Changing any is a major-version event:

| Use site | Value |
|---|---|
| AAD prefix (every AEAD tag) | `"myne.v0.1\|"` (10 ASCII bytes; `protocol.md` §5.2) |
| HKDF context-string prefix | `"myne.v0.1 "` (note trailing space; §3.2) |
| Salt domain prefix (password) | `"myne.v0.1 argon2id-password\|"` |
| Salt domain prefix (recovery) | `"myne.v0.1 argon2id-recovery\|"` |
| Per-note blob magic | `MY01` (extension `.myn`) |
| Vault metadata magic | `MYV1` (file `vault.meta`) |
| Vault prefs blob magic | `MYP1` (file `vault.prefs`; §9.5) |
| Search-index blob magic | `MYS1` (file `vault.search`; §9.6) |
| Protocol identifier string | `myne-protocol-v0.1` |
| Account-number display prefix | `MY-XXXX-XXXX-XXXX-XXXX-X` |

v005 reservations: `NT05`/`NTV5` (per-note / vault-meta) + `MYP5`/`MYS5` (prefs / search) magic, `"myne.v005|"` AAD prefix, `"myne.v005 "` HKDF context prefix — see the normative registry in `docs/spec/protocol.md` §10.3. v0.1 and v005 are **forward-incompatible by design** — no extension points, no algorithm-agility headers; cross-major reads happen only via explicit user-initiated migration.

## Crypto primitives baseline (summary)

**KDF** Argon2id `m=256 MiB, t=3, p=2` v1.3 · **AEAD** XChaCha20-Poly1305 + CTX commitment SHA-256 outer (32-byte tag on disk) · **Subkey derivation** HKDF-SHA-256 via single canonical `DeriveSubkey` helper · **Recovery** BIP-39 24 words → fed **directly** to Argon2id (no PBKDF2 step) · **Library** RustCrypto stack, no custom primitives on any client.

Full primitive details, audit anchors, and subkey derivation discipline rule (which forbids direct `hkdf.expand` calls outside the canonical helper): see `protocol/CLAUDE.md`. Cross-implementation byte-level compatibility validated by `myne-test-vectors/` companion.

## Hard architectural commitments (don't quietly walk these back)

- **No email at signup, no email recovery — ever.** Adding email recovery silently invalidates the zero-knowledge claim.
- **No plaintext mode, no encryption opt-in.** Privacy is the default for every user.
- **No persistent server-side IP logging.** Abuse via per-account counters, not per-IP.
- **User-meaningful timestamps live inside the encrypted blob.** Server uses opaque per-note version counter for conflict detection; resolution is client-side after decryption.
- **Self-hosted and hosted servers share the exact same trust boundary (TB5).** Same protocol, same security model.
- **Reproducible signed builds, hash-pinned lockfiles, minimal direct-dependency surface.** Credible substitute for the missing third-party audit (`threat-model.md` §6). **Adding a dependency is a security decision** — including the choice of Vite + React over Next.js.

## Gotchas

- **`Cargo.lock` is single-shared at workspace root** (TB9 audit anchor). Do not split into per-crate locks.
- **Vite `strictPort: 1420`** — `pnpm dev` fails fast if port taken; this is intentional (Tauri expects exact port).
- **Vite `clearScreen: false`** — keep it; otherwise Rust errors get hidden during `pnpm tauri dev`.
- **CLAUDE.md HTML comments are stripped** before injection. Block comments (`<!-- ... -->`) outside code blocks vanish silently. Use code blocks if you need a literal comment.
- **Tauri lib must keep `_lib` suffix** (`myne_desktop_lib`) to avoid Windows lib-vs-bin collision (rust-lang/cargo#8519). See `src-tauri/CLAUDE.md`.

## License

Currently CC0 (docs only). When Phase 1 application code lands, the repo moves to **AGPL-3.0** with the `docs/` subtree keeping a permissive content license so the spec stays reusable for independent implementations. Transition recorded in `docs/decisions.md` when it happens.
