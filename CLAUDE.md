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

Git hooks are managed by **lefthook** (`lefthook.yml`). `pre-commit` runs the fast lint set (rustfmt-check, `tsc --noEmit`, whitespace, EOF newline, secret pattern guard, single-Cargo.lock check); `pre-push` runs the full battery (`cargo clippy --workspace -- -D warnings`, `cargo test --workspace`, `pnpm build`). CI is self-hosted Woodpecker via the Forgejo mirror (`.woodpecker.yml`, Linux runner; `docs/decisions.md` 2026-05-01) — the hooks are the local pre-push net, CI is the remote gate, and the `e2e` step drives the production binary via tauri-driver (`docs/dev/e2e.md`). Bypass with `git commit --no-verify` only when you understand why.

**A new user-facing flow ships WITH its E2E coverage**: the same change carries the `data-testid` pass (`src/CLAUDE.md` "Test observability") and an `e2e/` scenario on the harness (`e2e/CLAUDE.md`, procedure `docs/dev/e2e.md`). A PR that adds a flow without its E2E scenario gets rejected in review.

`pnpm` is the canonical package manager (Tauri's `beforeDevCommand`/`beforeBuildCommand` invoke it). Pinned versions: Node `.nvmrc`, Rust `rust-toolchain.toml`. **Do not bypass the pinning** — CI and reproducible-build rely on it.

JS tests run on **Vitest** (`pnpm test` → `vitest run`; config `vite.config.ts`/`vitest.config.ts`, specs under `tests/**/*.test.ts`). `tsc` via `pnpm build` is the typecheck; for Rust use `cargo test`. (Note: `tests/` is outside `tsc`'s `include: ["src"]`, so Vitest is the only check that exercises test files.)

## What lives where

```
myne/
├── docs/                ← specs, threat model, glossary, decisions log (CC-BY-4.0)
├── src/                 ← React UI (Tauri WebView); src/dialect + src/editor are re-export shims into the shared pkgs below
├── src-tauri/           ← Tauri 2 + Rust desktop core
│   └── capabilities/    ← Tauri capability ACLs (security-load-bearing)
├── dialect/             ← @myne/dialect: shared markdown-parser source pkg (source-consumed, no build), desktop+mobile WebView
├── editor/              ← @myne/editor: shared CodeMirror engine; platform IO injected via the EditorHost seam (decisions.md 2026-07-05)
├── protocol/            ← Rust crypto crate
├── core/                ← myne-core: shared backend plugin cores (vault/notes/prefs), desktop+mobile
├── public/              ← static assets bundled into the WebView
├── workspace/           ← multi-repo helper scripts + manifest
├── pnpm-workspace.yaml  ← pnpm workspace members (dialect, editor)
├── Cargo.toml           ← workspace root (members: src-tauri, protocol, core)
├── Cargo.lock           ← single shared lockfile (TB9 audit anchor)
├── rust-toolchain.toml  ← pinned Rust toolchain
├── package.json         ← pnpm + Vite + React 19 + TS toolchain
└── vite.config.ts       ← Tauri-aware Vite config
```

**Companion repos** (clone via `./workspace/setup.sh` reading `workspace/manifest.txt`): `myne-test-vectors/`, `myne-server/`, `myne-web/`, `myne-mobile/`, `myne-website/`, `myne-ops/`, `myne-agents/`. Each is a separate GitHub repo under [`myne-md`](https://github.com/myne-md) — **never commit changes to them through this repo**. Each carries its own CLAUDE.md (lazy-load when you `cd` into it).

## The spec is the source of truth

Read `docs/` before changing anything that touches cryptography, on-disk format, key handling, or sync. Order:

1. `docs/vision.md` — phased plan, anti-features (commitments, not "maybe later")
2. `docs/threat-model.md` — A1–A14 adversaries, AS1–AS17 assets, TB1–TB10 trust boundaries. **Normative**: marketing copy and code may not exceed its guarantees.
3. `docs/spec/protocol.md` — v0.1 cryptographic protocol
4. `docs/spec/account-number.md` — 20-character Crockford-base32 + Damm-32 identifier
5. `docs/glossary.md` — canonical terminology (~115 entries). Every new term in any doc gets a glossary entry in the same change.
6. `docs/decisions.md` — append-only timeline. Newest entry **last**. Reversals get new entries that say "supersedes <date> — <title>"; never delete or rewrite past entries.

See `docs/CLAUDE.md` for spec-authoring discipline in depth.

## Phase 1 plan & ownership

Active Phase 1 work is tracked in Plane: **plane.myne.md** (self-hosted). Lane IDs (`A`, `B`, `C`, `D`, `S`) are retired — Plane native work-item identifiers (e.g., `MYN-…`) are the new anchor for cross-references in `docs/decisions.md`, feature directories, commit subjects, and PR titles. Historical lane-ID references in `docs/decisions.md` and git history are preserved (append-only spec discipline).

## Cryptographically load-bearing identifiers

Identifiers and constants whose change is a major-version event. Most are bound into AEAD tags or magic-byte checks; some (e.g. the account-number display prefix, the Damm-32 table) are load-bearing through account identity or presentation rather than an AEAD/magic boundary — the mechanism is noted per row:

| Use site | Value |
|---|---|
| AAD prefix (every AEAD tag) | `"myne.v0.1\|"` (10 ASCII bytes; `protocol.md` §5.2) |
| HKDF context-string prefix | `"myne.v0.1 "` (note trailing space; §3.2) |
| Salt domain prefix (password) | `"myne.v0.1 argon2id-password\|"` |
| Salt domain prefix (recovery) | `"myne.v0.1 argon2id-recovery\|"` |
| Salt domain prefix (quick-unlock PIN) | `"myne.v0.1 argon2id-quickunlock-pin\|"` (§9.14.2; PIN-derived quick-unlock wrap key) |
| Per-note blob magic | `MY01` (extension `.myn`) |
| Vault metadata magic | `MYV1` (file `vault.meta`) |
| Vault prefs blob magic | `MYP1` (file `vault.prefs`; §9.5) |
| Search-index blob magic | `MYS1` (file `vault.search`; §9.6) |
| Workspace-state blob magic | `MYW1` (file `vault.workspace`; §9.7) |
| Subkey role string (workspace KEK) | `"session-state-key"` (HKDF context `"myne.v0.1 session-state-key"`; §9.7.3) |
| Vault-indices blob magic | `MYI1` (file `vault.indices`; §9.8) |
| Subkey role string (vault-indices KEK) | `"vault-indices-key"` (HKDF context `"myne.v0.1 vault-indices-key"`; §9.8) |
| AAD role string (vault-indices blob) | `"vault-indices-blob"` (length-prefixed; §9.8.3) |
| Attachment blob magic | `MYA1` (files `attachments/<attachment-id-hex>`; §9.9) |
| Attachments catalog magic | `MYC1` (file `vault.attachments`; §9.10) |
| Vault backup container magic | `MYB1` (files `*.myne-backup`; §9.11) |
| Personal-dictionary blob magic | `MYD1` (file `vault.dictionary`; §9.13) |
| Quick-unlock credential blob magic | `MYQ1` (file `vault.quickunlock`; §9.14; device-local, wraps a third `root_key` copy) |
| Extracted-attachment-text blob magic | `MYE1` (files `attachments-text/<attachment-id-hex>`; §9.15; per-attachment search-extraction cache) |
| AI-embeddings blob magic | `MYR1` (file `vault.embeddings`; §9.17; on-device AI embedding index, written only when the runtime beta opt-in `ai_enabled` is on — AI ships in the default build, `decisions.md` 2026-07-02; a `--no-default-features` build never writes it; rebuildable cache, never synced/backed up) |
| Subkey role string (personal-dictionary KEK) | `"personal-dictionary-key"` (HKDF context `"myne.v0.1 personal-dictionary-key"`; §9.13.3) |
| AAD role string (personal-dictionary blob) | `"personal-dictionary-blob"` (length-prefixed; §9.13.3) |
| Subkey role string (attachment-text KEK) | `"attachment-text-key"` (HKDF context `"myne.v0.1 attachment-text-key"`; §9.15.3) |
| AAD role string (attachment-text blob) | `"attachment-text-blob"` (length-prefixed; §9.15.3; AAD also binds `attachment_id` + `extractor_version`) |
| Subkey role string (AI-embeddings KEK) | `"ai-embeddings-key"` (HKDF context `"myne.v0.1 ai-embeddings-key"`; §9.17; `root_key`-derived, itemsKey-independent) |
| AAD role string (AI-embeddings blob) | `"ai-embeddings-blob"` (length-prefixed; §9.17.3; vault-scoped like search/indices — the `{model_hash ∥ embedding_dim ∥ chunker_version}` model-identity tuple invalidates via the inner payload, NOT the AAD) |
| Protocol identifier string | `myne-protocol-v0.1` |
| Account-number display prefix | `MY-` + five dash-separated 4-char Crockford groups (27-char display form, `account-number.md` §3; the old `MY-XXXX-XXXX-XXXX-XXXX-X` sketch was illustrative shorthand — the last group is 4 chars, ending in the Damm-32 check char) |
| Damm-32 quasigroup table | frozen literal, `account-number.md` §4.2 — determines which 20-char strings are valid and which check char generation emits; changing it rejects already-distributed account numbers and breaks cross-impl validity agreement |
| Firefox Gecko extension ID (browser clipper) | `clipper@myne.md` (`src-tauri/src/clipper/manifest.rs::FIREFOX_EXTENSION_ID`) — **not** an AEAD/magic value; load-bearing through *pairing-token binding*: every clipper pairing token is bound to this exact extension ID and the native-messaging host manifest's `allowed_extensions` is generated from it, so changing it invalidates all distributed pairings (a forced re-pair). |
| Chrome/Edge extension ID (browser clipper) | `ebbbblnjddeockegombcnbiljefmlhbh` (`src-tauri/src/clipper/manifest.rs::CHROMIUM_EXTENSION_ID`) — **not** an AEAD/magic value; load-bearing the same way the Firefox id is: it is written into the Chromium native-messaging manifest's `allowed_origins` (`chrome-extension://<id>/`) and every clipper pairing token binds to it. **Deterministically derived** from the committed manifest `key` in the `myne-clipper` repo (base64-decode → SHA-256 → first 16 bytes → `[a-p]`); changing that `key` re-derives this and forces a re-pair. Installer wiring: `docs/decisions.md` 2026-07-05. |
| Native-messaging host name (browser clipper) | `md.myne.clipper` (`src-tauri/src/clipper/manifest.rs::HOST_NAME`) — the host-manifest family name the browser launches and the desktop bundle id (`md.myne.desktop`) it is distinct from; changing it requires re-installing the host manifest. Not an AEAD/magic value. |

v005 reservations: `NT05`/`NTV5` (per-note / vault-meta) + `MYP5`/`MYS5`/`MYW5`/`MYI5`/`MYA5`/`MYC5`/`MYB5`/`MYD5`/`MYQ5`/`MYE5`/`MYR5` (prefs / search / workspace / vault-indices / attachment / attachments-catalog / backup-container / personal-dictionary / quick-unlock / attachment-text / ai-embeddings) magic, `"myne.v005|"` AAD prefix, `"myne.v005 "` HKDF context prefix — see the normative magic-allocation table in `docs/spec/protocol.md` §10.3 (which is the single source of truth for magic allocation; `MYI1`/§9.8 VaultIndices landed with MYND-271). v0.1 and v005 are **forward-incompatible by design** — no extension points, no algorithm-agility headers; cross-major reads happen only via explicit user-initiated migration.

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

Multi-licensed by subtree — see [`LICENSING.md`](LICENSING.md) for the authoritative map. Application code (`src/`, `src-tauri/`, `protocol/`) is **AGPL-3.0** (not "or-later"); the `docs/` subtree is **CC-BY-4.0** so the spec stays reusable for independent implementations as long as Myne is credited. Every `protocol/` source file carries `// SPDX-License-Identifier: AGPL-3.0`. Decision recorded in `docs/decisions.md`.
