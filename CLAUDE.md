# CLAUDE.md

Guidance to Claude Code (claude.ai/code) when working in this repository.

Subdirectory CLAUDE.md files cover their own domain in depth — they lazy-load when Claude reads files there:
- `src-tauri/CLAUDE.md` — Tauri 2 host, capability ACL, plugin pattern, Windows lib-name quirk
- `core/CLAUDE.md` — `myne-core`, the shared backend crate: the host/IO/task seams, the lifecycle-hooks seam, plugin-core layout, three-layer command shape
- `protocol/CLAUDE.md` — RustCrypto primitives, subkey derivation discipline, vector-verification
- `src/CLAUDE.md` — React UI patterns, design tokens, mock-layer status
- `docs/CLAUDE.md` — spec authoring rules (decisions.md append-only, glossary discipline)
- `e2e/CLAUDE.md` — tauri-driver desktop harness, scenario authoring rules, the green-3×-consecutive gate
- `e2e-web/CLAUDE.md` — browser web-E2E lane: what belongs in it and what does not
- `myne-agents/CLAUDE.md` — agent + skill + feature/session/plan layout

## Design context (pointer)

Three files at the repo root carry the visual + strategic system. Read in this order before designing any UI:

1. `PRODUCT.md` — strategy: register, users, voice, brand personality, anti-references, design principles. Cross-client (desktop + future mobile + web). Read before any new screen.
2. `DESIGN.md` + `DESIGN.json` — visual system in [Google Stitch DESIGN.md format](https://stitch.withgoogle.com/docs/design-md/format/). Frontmatter is the machine-readable token layer; `DESIGN.json` carries the live-panel components, tonal ramps, shadow + motion + focus extensions.
3. `docs/design/` — the **code-side projection** of the design canon: `README.md` (voice + tactical rules), `colors_and_type.css` (CSS variable source), `ui_kits/desktop/` (JSX primitives), `preview/` (token specimen tabs).

**Penpot is the canonical design source**, connected via the `penpot` MCP server (page `4 — Desktop UI Kit`, screens 1280×800). Workflow is **Penpot → revise in Penpot → implement in code**, never the reverse. When code and Penpot disagree, Penpot wins by default and the projection gets updated; a Playwright + Penpot diff harness at `scripts/penpot-diff.sh` (procedure: `docs/dev/penpot-design-diff.md`) names the side that is wrong with RMSE + SSIM + per-region scores. Drift artefacts land in `manual-fixes-needed.md`. The `penpot-sync` skill automates this loop.

`/impeccable` commands (craft, polish, audit, etc.) read `PRODUCT.md` + `DESIGN.md` automatically. Do not duplicate their content into other docs.

## Project status

**Pre-alpha.** Shipped: v0.1 specs (`docs/`), Tauri 2 + Vite + React + TS scaffold (`src/`, `src-tauri/`), Rust crypto crate (`protocol/`, RustCrypto, `#![no_std]` + `alloc`), Cargo workspace (one shared `Cargo.lock`), workspace scripts, pinned toolchain. The desktop scaffold lives at the **repo root** deliberately. It is no longer the only in-repo client: the Phase 3 desktop-**browser** client lives at `web/` and compiles the same `src/` tree (`docs/decisions.md` **2026-07-26** "The web client lives in-repo at `web/`", which supersedes the one-in-repo-client clause of the 2026-04-26 "Desktop scaffold lives at repository root" entry while leaving its placement decision intact). Mobile, server, website, ops, test-vectors, clipper, themes and branding remain companion repos (`workspace/manifest.txt` is the list); `myne-web` is redundant and archived.

## Common commands

```bash
pnpm tauri dev          # full Tauri dev (spawns Vite on :1420 + Rust core)
pnpm dev                # Vite only — port fixed via strictPort, fails if 1420 is taken
pnpm tauri build        # production desktop bundle

pnpm sidecar            # build + stage BOTH externalBin sidecars — `myne` (CLI) and `myne-tor` (arti) — debug
pnpm sidecar:release    # same, release profile — both tauri lifecycle hooks run these

pnpm web:dev            # web client dev server on :1421 (runs alongside the desktop one)
pnpm web:build          # typecheck web/ against the shared src/ tree + production web bundle
pnpm web:preview        # serve the built web bundle

cargo test -p protocol <name>     # one test in protocol crate
cargo clippy --workspace --all-targets -- -D warnings

brew install lefthook && lefthook install   # one-time per clone; activates git hooks
```

Git hooks are managed by **lefthook** (`lefthook.yml`, which is the authoritative list). `pre-commit` runs the fast lint set (rustfmt-check, SPDX headers on `protocol/`, `tsc --noEmit`, the seam/coverage guards + the i18n catalog check under `scripts/` (see "Repo guards" below), whitespace, EOF newline, single-`Cargo.lock` check, secret pattern guard); `pre-push` runs the full battery (Damm-32 table drift, `cargo clippy --workspace --all-targets -- -D warnings`, the same clippy for `wasm32-unknown-unknown` over `myne-core` + `protocol`, `cargo test -p myne-web-wasm`, `cargo test --workspace`, `pnpm build`, `pnpm test`); `commit-msg` rejects AI co-author/attribution trailers. CI is self-hosted Woodpecker via the Forgejo mirror (`.woodpecker.yml`, Linux runner; `docs/decisions.md` 2026-05-01) — the hooks are the local pre-push net, CI is the remote gate, and the `e2e` step drives the production binary via tauri-driver (`docs/dev/e2e.md`). **Two lanes, one pipeline** (MYND-574): the desktop lane is one serial chain (`pnpm-build` → `vitest` → `tauri-compile` → `cargo-test-tauri` → `e2e`) because each of those runs `pnpm install` into the shared workspace `node_modules`; the **web lane** hangs off the end of it (`web-build` — the web bundle plus the artefact greps, the seam contract against the web implementation, the bundle budget and the screen/surface/testid rosters) so it adds nothing to the desktop lane's wall-clock, alongside the early Rust wasm gates (`wasm-protocol`). Every step that can go red is listed in `notify-failure` (the only thing that pushes a failure to the maintainer), and every compile/test step carries the `code-paths` filter, so a docs-only commit skips them. **Two steps deliberately carry no filter and must keep it that way**: `hooks-parity` (its EOF/whitespace/SPDX checks apply to docs too) and `bundle-record` (the append-only hash record *is* a doc, so a docs-only commit is exactly when it must run) — both say so in their own `.woodpecker.yml` comments; adding `when: *code-paths` to either is a regression, not a cleanup. The web deploy chain (`web-docker-build` → `web-docker-deploy` → `web-smoke`) gates on a different anchor again — `&web-deploy`, i.e. push-to-`develop` — because it publishes `app.myne.md`. Bypass with `git commit --no-verify` only when you understand why.

**A new user-facing flow ships WITH its E2E coverage**: the same change carries the `data-testid` pass (`src/CLAUDE.md` "Test observability") and a scenario on the right harness (`e2e/CLAUDE.md`, procedure `docs/dev/e2e.md`). A PR that adds a flow without its E2E scenario gets rejected in review. **Which harness** — there are two lanes and they do not mirror each other: a flow in the **shared** `src/` tree owes ONE scenario to the tauri-driver suite in `e2e/` and nothing to the web lane, because it is literally the same code; a **web-specific** behaviour (capability gating, OPFS persistence, the single-tab lock, sync-required entry, crash recovery of the double-buffered blobs) owes a scenario to `e2e-web/`. Do **not** dual-drive the desktop suite against a browser: the premise that lets one suite cover both clients is "same tree, only the seam differs", and that premise is verified by the **seam contract tests** (`tests/platform/seam-contract.ts`, run against every implementation in both CI lanes), not by re-running every tauri-driver scenario file in `e2e/`. `docs/decisions.md` 2026-07-26 "Web E2E policy".

`pnpm` is the canonical package manager (Tauri's `beforeDevCommand`/`beforeBuildCommand` invoke it). Pinned versions: Node `.nvmrc`, Rust `rust-toolchain.toml`. **Do not bypass the pinning** — CI and reproducible-build rely on it.

JS tests run on **Vitest** (`pnpm test` → `vitest run`; config `vitest.config.ts` — standalone, it does not extend `vite.config.ts` — specs under `tests/**/*.test.{ts,tsx}`). The other lanes have configs of their own: `vitest.e2e.config.ts` (desktop E2E), `vitest.web-e2e.config.ts` (web E2E), `vitest.capture.config.ts` (user-guide screenshots). `tsc` via `pnpm build` is the typecheck; for Rust use `cargo test`. (Note: `tests/` is outside `tsc`'s `include: ["src"]`, so Vitest is the only check that exercises test files.)

## What lives where

```
myne/
├── docs/                ← specs, threat model, glossary, decisions log (CC-BY-4.0)
├── src/                 ← React UI, shared by BOTH clients; src/editor is a re-export shim into @myne/editor, src/dialect shims @myne/dialect PLUS desktop-side dialect code never extracted (clip.ts, clip/, html/, text/)
│   └── platform/        ← the platform seam: the ONLY place under src/ allowed to import @tauri-apps/*
├── web/                 ← Phase 3 desktop-browser client: same src/ tree, seam substituted at build time (pnpm web:dev / web:build)
├── src-tauri/           ← Tauri 2 + Rust desktop core
│   └── capabilities/    ← Tauri capability ACLs (security-load-bearing)
├── dialect/             ← @myne/dialect: shared markdown-parser source pkg (source-consumed, no build), desktop+mobile WebView
├── editor/              ← @myne/editor: shared CodeMirror engine; platform IO injected via the EditorHost seam (decisions.md 2026-07-05)
├── copy/                ← @myne/copy: load-bearing user-facing strings kept byte-identical across clients by construction (SYNC-42); deliberately outside i18n
├── protocol/            ← Rust crypto crate
├── core/                ← myne-core: shared backend plugin cores + the host/IO/task seams; consumed by desktop, mobile AND the web wasm entry crate
├── cli/                 ← myne-cli: the `myne` terminal client (MYND-490). Ships as a Tauri `externalBin` sidecar INSIDE the desktop bundle (staged by scripts/build-cli-sidecar.mjs, PATH shim by src-tauri/src/cli_bridge/path_shim.rs) and drives the running, unlocked desktop over its local command socket — it never opens the vault and depends on neither myne-core nor protocol
├── tor-sidecar/         ← myne-tor-sidecar: arti (Rust Tor) as a standalone loopback SOCKS5 proxy, shipped as a second Tauri `externalBin` sidecar (MYND-650). NOTHING links it — the desktop spawns it as a subprocess when the device-local Tor routing option is on, which is exactly what keeps arti out of `myne-desktop`'s `cargo tree -e normal` closure and leaves the no-egress gate scanning a tree with no networked crate in it
├── theme-validator/     ← shared custom-theme value-shape allowlist — SECURITY-LOAD-BEARING: the WebView CSP carries style-src 'unsafe-inline', so a theme value that reaches the DOM executes. Desktop themes plugin and myne-themes marketplace CI run this exact crate so the grammar cannot drift (threat-model.md "Custom-theme CSS-value surface"; MYND-508)
├── tests/               ← Vitest unit/component specs; tests/platform/ holds the seam contract run against every seam implementation
├── e2e/                 ← tauri-driver desktop E2E suite + fixture-gen crate, fixtures and harness (pnpm test:e2e)
├── e2e-web/             ← browser-driven web E2E lane, deliberately thin: web-specific behaviour only (pnpm test:e2e:web)
├── scripts/             ← repo guards + dev tooling — see "Repo guards" below for what each guard blocks
├── locales/             ← i18n catalogs, one directory per language; locales/en/common.json is the source of truth
├── packaging/           ← distro packaging (Arch PKGBUILD + .desktop entry)
├── public/              ← static assets bundled into the WebView
├── workspace/           ← multi-repo helper scripts + manifest
├── pnpm-workspace.yaml  ← pnpm workspace members (dialect, editor, copy)
├── Cargo.toml           ← workspace root; its `members` list is the source of truth (today: src-tauri, protocol, core, cli, tor-sidecar, theme-validator, e2e/fixture-gen, web/wasm, web/bench/wasm)
├── Cargo.lock           ← single shared lockfile (TB9 audit anchor)
├── rust-toolchain.toml  ← pinned Rust toolchain
├── package.json         ← pnpm + Vite + React 19 + TS toolchain
└── vite.config.ts       ← Tauri-aware Vite config
```

**Companion repos** (clone via `./workspace/setup.sh` reading `workspace/manifest.txt`, which is the list): `myne-test-vectors/`, `myne-server/`, `myne-mobile/`, `myne-website/`, `myne-ops/`, `myne-agents/`, `myne-clipper/`, `myne-themes/`, `myne-branding/`. (`myne-web` is **not** in this list: the web client is the in-repo `web/` target, and the empty companion repo is archived — `decisions.md` 2026-07-26.) Each is a separate GitHub repo under [`myne-md`](https://github.com/myne-md) — **never commit changes to them through this repo**. Each carries its own CLAUDE.md (lazy-load when you `cd` into it).

## Repo guards (what blocks a commit, and what blocks CI)

Most of `scripts/` is not tooling — it is the machine-checked half of the rules this file states in prose. Each guard exists because the failure it catches is invisible to every compiler: a TS string literal that no `match` arm answers, a `std::fs` call that compiles for wasm32 and dies at runtime, a value in the served bundle that should not be there. They are zero-dependency and hand-runnable (`node scripts/<name>.mjs`, `bash scripts/<name>.sh`); every one carries a header comment explaining the failure it prevents, which is the thing to read when it fires.

| Guard | Enforces | Fires in |
|---|---|---|
| `check-platform-seam.mjs` | `src/platform/` is the only place under `src/` importing `@tauri-apps/*`; `editor/`, `dialect/`, `copy/` get **zero** Tauri imports | `pre-commit` + CI `pnpm-build` |
| `check-core-task-seam.mjs` | `crate::task` is the only place in `core/` reaching tokio's *execution* surface (`spawn_blocking` compiles for wasm32 and panics at runtime) | `pre-commit` + CI `pnpm-build` |
| `check-core-io-seam.mjs` | filesystem ratchet: a `core/src` file not on the recorded list may not start using `std::fs`, and one that leaves may not come back | `pre-commit` + CI `pnpm-build` |
| `check-web-command-coverage.mjs` | every `plugin:<x>\|<y>` literal in the shared tree is classified in `web/wasm/src/capability.rs` — dispatched, absent-on-web, or a port still owed | `pre-commit` + CI `pnpm-build`, `web-build` |
| `check-web-capabilities.mjs` | the UI's capability descriptor and the dispatcher's refusal table agree (disagreement is invisible from either side alone) | `pre-commit` + CI `pnpm-build`, `web-build` |
| `check-i18n.mjs` | no empty English source value in `locales/en/common.json`; every static `t("…")` key in `src/` exists in the catalog | `pre-commit` + CI `pnpm-build` |
| `check-cli-sidecar.mjs` | the `myne` CLI's duplicated-by-design contract with the desktop: bundle identifier + command-socket/status basenames agree across `cli/src/paths.rs` and `src-tauri/src/cli_bridge/`, and the sidecar is still listed in `bundle.externalBin` (drift compiles clean on both sides, then reports "app not running" against a running app) | `pre-commit` + CI `pnpm-build` |
| `hooks-parity-check.sh` | CI backstop for the pre-commit checks that are otherwise `--no-verify`-bypassable: SPDX headers, EOF newline, trailing whitespace — its own header lists what it deliberately leaves to `pnpm-build` and why | CI `hooks-parity` (**unfiltered**: runs on docs-only commits too) |
| `check-bundle-record.mjs` | the published-bundle-hash record is append-only (`--append-only`), and a deploy may only ship a hash already recorded (`--has`) | CI `bundle-record` (**unfiltered**) + `web-docker-build` (the `--has` precondition, before the image can be deployed) |
| `wasm-csprng-check.sh` | `protocol` builds for `wasm32-unknown-unknown` **and** its `getrandom` hook stays *undefined* there, so the final Worker-host link must supply entropy explicitly instead of something in the graph quietly supplying it | CI `wasm-protocol` |
| `wasm-core-graph-check.sh` | `myne-core`'s **dependency graph** resolves for wasm32 (the walls are in the graph, before core's own code compiles) | CI `wasm-protocol` |
| `wasm-repro-check.sh` | the wasm artefact rebuilds byte-identically (double build, `wasm-bindgen-cli` version read from the lock, never hardcoded). It runs here rather than only locally because CI is a *different* machine — that difference is most of the value. `threat-model.md` §6's substitute for the missing audit; against A15/TB11 a bundle hash nobody else can reproduce is a number the publisher asserts about itself | CI `wasm-protocol` |
| `check-web-third-party.mjs` | zero third-party origins in the web bundle | CI `web-build` |
| `check-web-no-phrase.mjs` | the recovery phrase is **absent** from the served bundle, not merely hidden | CI `web-build` |
| `check-web-no-test-hooks.mjs` | no production test hooks in the served bundle (a hook a scenario can call is a hook any script on the page can call) | CI `web-build` |
| `check-web-bundle-budget.mjs` | first-load size ratchet, measured from a real build rather than invented | CI `web-build` |
| `check-web-screens.mjs` / `check-web-surfaces.mjs` | every screen, and every `src/components/settings/`, `src/lib/`, `src/hooks/` module, carries a web verdict — and the excluded ones really are absent | CI `web-build` |
| `check-web-testids.mjs` | every web-only rendering module has a testid, named `<screen>.<element>`, and no `data-*` on a pre-unlock web screen is fed a runtime expression (the account number is one keystroke from the DOM, screenshots and CI artefacts) | CI `web-build` |
| `check-web-container-headers.sh` | the container actually *serves* its security headers and operational endpoints (config being right is not the same as its effect being right) | CI `web-docker-build` |
| `web-smoke.sh` | post-deploy, against the public TLS origin: the right commit shipped and the right sync origin is wired | CI `web-smoke` |
| `check-icons.mjs` | icon variants exist at the right dimensions, `bundle.icon` is coherent, no Tauri-default icon hashes survive, master SVG hash pinned | CI `e2e` |
| `src-tauri/scripts/ai-no-network-check.sh` | the on-device AI path has no network surface (a standing anti-feature) | CI `ai-no-network` |

Not gated anywhere and run by hand: `check-web-no-ip-logging.sh` (asserts the web container logs no client IP — the "no persistent server-side IP logging" commitment; a page load on that origin is a vault opening). The rest of `scripts/` is tooling, not gates: `build-wasm.sh`, `emit-web-version.mjs`, the `e2e-*.sh` runners, `bench-web.mjs`, `browser-vectors.sh`, `capture-userguide.sh`, `clipper-dev-install.sh`, `penpot-diff.sh`.

## The spec is the source of truth

Read `docs/` before changing anything that touches cryptography, on-disk format, key handling, or sync. Order:

1. `docs/vision.md` — phased plan, anti-features (commitments, not "maybe later")
2. `docs/threat-model.md` — A1–A15 adversaries, AS1–AS19 assets, TB1–TB11 trust boundaries (A15 + TB11 are the web bundle's delivery channel, added 2026-07-26). **Normative**: marketing copy and code may not exceed its guarantees.
3. `docs/spec/protocol.md` — v0.1 cryptographic protocol
4. `docs/spec/account-number.md` — 20-character Crockford-base32 + Damm-32 identifier
5. `docs/glossary.md` — canonical terminology, one A–Z entry per term. Every new term in any doc gets a glossary entry in the same change.
6. `docs/decisions.md` — append-only timeline. Newest entry **last**. Reversals get new entries that say "supersedes <date> — <title>"; never delete or rewrite past entries.

See `docs/CLAUDE.md` for spec-authoring discipline in depth.

## Phase 1 plan & ownership

Active Phase 1 work is tracked in Plane: **plane.myne.md** (self-hosted). Lane IDs (`A`, `B`, `C`, `D`, `S`) are retired — Plane native work-item identifiers (e.g., `MYND-635`) are the new anchor for cross-references in `docs/decisions.md`, feature directories, commit subjects, and PR titles. Historical lane-ID references in `docs/decisions.md` and git history are preserved (append-only spec discipline).

## Cryptographically load-bearing identifiers

**The Phase 3 web client adds nothing to this table and removes nothing from it** — it runs the same `protocol/` crate compiled to wasm, reads and writes byte-identical blobs, and introduces no magic, AAD prefix, HKDF context or subkey role of its own. Its only on-disk divergence is the *container layout* around those blobs in OPFS (`decisions.md` 2026-07-26), which is not an identifier.

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
| Device-local sync-baseline magic | `MYH1` (file `vault.head-state`; §9.16; MYND-416 — the last vault head this device accepted. **The one §10.3 family that is not AEAD-encrypted**: it wraps the sync-wire head record verbatim behind a 6-byte header, and integrity is that head's own HMAC-SHA-256 under `vault-head-mac`, re-verified on load. The wire head itself has **no magic** — it is sync-wire-only, versioned by its `head_format_version` byte, not a §10.3 family.) |
| AI-embeddings blob magic | `MYR1` (file `vault.embeddings`; §9.17; on-device AI embedding index, written only when the runtime beta opt-in `ai_enabled` is on — AI ships in the default build, `decisions.md` 2026-07-02; a `--no-default-features` build never writes it; rebuildable cache, never synced/backed up) |
| Custom-themes blob magic | `MYT1` (file `vault.themes`; §9.21; the singleton `{theme_name → palette}` map promoted from device-local plaintext to vault content — encrypted, synced, backed up; `decisions.md` 2026-07-16 supersedes the 2026-06-16 storage-split clause) |
| Subkey role string (custom-themes KEK) | `"custom-themes-key"` (HKDF context `"myne.v0.1 custom-themes-key"`; §9.21.3; `root_key`-derived, itemsKey-independent) |
| AAD role string (custom-themes blob) | `"custom-themes-blob"` (length-prefixed; §9.21.3; binds `account_number_hash`, not `items_key_id`) |
| Subkey role string (themes sync-id) | `"themes-sync-id"` (HKDF context `"myne.v0.1 themes-sync-id"`; §3.4; Phase 2 sync — derives the reserved 16-byte sync blob-id of `vault.themes` as `DeriveSubkey(root_key, "themes-sync-id")[0..16]` (`sync-protocol.md` §10.2.2). An **identifier** derivation like `catalog-sync-id`/`prefs-sync-id`, NOT a KEK (the themes KEK stays `custom-themes-key`); changing it silently splits `vault.themes` into a second sync record on every existing account.) |
| Pending-capture blob magic | `MYK1` (files `captures/<capture-id-hex>`; §9.18; device-local encrypted queue holding a watch-dictated note until the phone unlocks and drains it into the vault; sealed under a device-local keychain `wrap_key`, NOT `root_key`-derived; vault-agnostic — binds the per-entry `capture_id`, not `account_number_hash`; never synced/backed up) |
| Graph-layout cache magic | `MYG1` (file `vault.graph`; §9.19; knowledge-graph layout cache — node positions + a schema-version marker; `root_key`-derived KEK, frontend-driven opaque payload like `vault.workspace`; rebuildable cache, never synced/backed up) |
| Share-import staging queue magic | `MYF1` (MYND-507; `F` = file, a free §10.3 letter — implementer-allocated like every family magic; files `pending-shares/sealed/<share-id-hex>`; §9.20; device-local encrypted queue holding a file shared via the OS share sheet until the vault unlocks and drains it into the attachment library; sealed under a device-local keychain/Keystore `wrap_key` (service `md.myne.shareimport`), NOT `root_key`-derived; vault-agnostic — binds the per-entry `share_id`; 64 MiB cap; never synced/backed up) |
| AAD role string (share-import blob) | `"share-import-blob"` (length-prefixed; §9.20.3; binds `share_id`; device-local, no `SubkeyRole`) |
| Subkey role string (personal-dictionary KEK) | `"personal-dictionary-key"` (HKDF context `"myne.v0.1 personal-dictionary-key"`; §9.13.3) |
| AAD role string (personal-dictionary blob) | `"personal-dictionary-blob"` (length-prefixed; §9.13.3) |
| Subkey role string (attachment-text KEK) | `"attachment-text-key"` (HKDF context `"myne.v0.1 attachment-text-key"`; §9.15.3) |
| AAD role string (attachment-text blob) | `"attachment-text-blob"` (length-prefixed; §9.15.3; AAD also binds `attachment_id` + `extractor_version`) |
| Subkey role string (AI-embeddings KEK) | `"ai-embeddings-key"` (HKDF context `"myne.v0.1 ai-embeddings-key"`; §9.17; `root_key`-derived, itemsKey-independent) |
| Subkey role string (graph-layout KEK) | `"graph-layout-key"` (HKDF context `"myne.v0.1 graph-layout-key"`; §9.19; `root_key`-derived, itemsKey-independent; KEK for the `vault.graph` layout cache) |
| AAD role string (graph-layout blob) | `"graph-layout-blob"` (length-prefixed; §9.19.3; binds `account_number_hash`, like `vault.workspace`/`vault.prefs`) |
| Subkey role string (catalog sync-id) | `"catalog-sync-id"` (HKDF context `"myne.v0.1 catalog-sync-id"`; §3.4; Phase 2 sync — derives the reserved 16-byte sync blob-id of `vault.attachments` as `DeriveSubkey(root_key, "catalog-sync-id")[0..16]` (`sync-protocol.md` §8.1). An **identifier** derivation like `attachments-id-hmac`, not a KEK; changing it silently splits the catalog into a second sync record on every existing account.) |
| Subkey role string (prefs sync-id) | `"prefs-sync-id"` (HKDF context `"myne.v0.1 prefs-sync-id"`; §3.4; Phase 2 sync — derives the reserved 16-byte sync blob-id of `vault.prefs` as `DeriveSubkey(root_key, "prefs-sync-id")[0..16]` (`sync-protocol.md` §10.2.1). An **identifier** derivation like `catalog-sync-id`, not a KEK (the prefs KEK stays `prefs-key`); changing it silently splits `vault.prefs` into a second sync record on every existing account.) |
| AAD role string (AI-embeddings blob) | `"ai-embeddings-blob"` (length-prefixed; §9.17.3; vault-scoped like search/indices — the `{model_hash ∥ embedding_dim ∥ chunker_version}` model-identity tuple invalidates via the inner payload, NOT the AAD) |
| Protocol identifier string | `myne-protocol-v0.1` |
| Account-number display prefix | `MY-` + five dash-separated 4-char Crockford groups (27-char display form, `account-number.md` §2; the old `MY-XXXX-XXXX-XXXX-XXXX-X` sketch was illustrative shorthand — the last group is 4 chars, ending in the Damm-32 check char) |
| Damm-32 quasigroup table | frozen literal, `account-number.md` §4.2 — determines which 20-char strings are valid and which check char generation emits; changing it rejects already-distributed account numbers and breaks cross-impl validity agreement |
| Firefox Gecko extension ID (browser clipper) | `clipper@myne.md` (`src-tauri/src/clipper/manifest.rs::FIREFOX_EXTENSION_ID`) — **not** an AEAD/magic value; load-bearing through *pairing-token binding*: every clipper pairing token is bound to this exact extension ID and the native-messaging host manifest's `allowed_extensions` is generated from it, so changing it invalidates all distributed pairings (a forced re-pair). |
| Chrome/Edge extension ID (browser clipper) | `ebbbblnjddeockegombcnbiljefmlhbh` (`src-tauri/src/clipper/manifest.rs::CHROMIUM_EXTENSION_ID`) — **not** an AEAD/magic value; load-bearing the same way the Firefox id is: it is written into the Chromium native-messaging manifest's `allowed_origins` (`chrome-extension://<id>/`) and every clipper pairing token binds to it. **Deterministically derived** from the committed manifest `key` in the `myne-clipper` repo (base64-decode → SHA-256 → first 16 bytes → `[a-p]`); changing that `key` re-derives this and forces a re-pair. Installer wiring: `docs/decisions.md` 2026-07-05. |
| Native-messaging host name (browser clipper) | `md.myne.clipper` (`src-tauri/src/clipper/manifest.rs::HOST_NAME`) — the host-manifest family name the browser launches and the desktop bundle id (`md.myne.desktop`) it is distinct from; changing it requires re-installing the host manifest. Not an AEAD/magic value. |

Next-major (reserved) magic: `NT05`/`NTV5` (per-note / vault-meta) + `MYP5`/`MYS5`/`MYW5`/`MYI5`/`MYA5`/`MYC5`/`MYB5`/`MYD5`/`MYQ5`/`MYE5`/`MYH5`/`MYR5`/`MYK5`/`MYG5`/`MYF5`/`MYT5` (prefs / search / workspace / vault-indices / attachment / attachments-catalog / backup-container / personal-dictionary / quick-unlock / attachment-text / sync-baseline / ai-embeddings / pending-capture / graph-layout / share-import / custom-themes) — reserved placeholder values, finalized by the next major version. The next major's **AAD prefix and HKDF context prefix are not pre-allocated** in v0.1 (it defines its own; the v0.1 values `"myne.v0.1|"` / `"myne.v0.1 "` are untouched) — see the normative magic-allocation table in `docs/spec/protocol.md` §10.3 (which is the single source of truth for magic allocation; `MYI1`/§9.8 VaultIndices landed with MYND-271). v0.1 and a later major version are **forward-incompatible by design** — no extension points, no algorithm-agility headers; cross-major reads happen only via explicit user-initiated migration. (The next major was formerly drafted as "v005"; that codename is retired — see `docs/decisions.md` 2026-08-01 and the glossary "next major version" entry. In prose, deferrals read as "later"; parked items as "icebox".)

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

- **`@tauri-apps/*` may only be imported from `src/platform/`.** The platform seam is what lets one `src/` tree compile for both the desktop and the web client; a direct import anywhere else breaks the web build rather than degrading it. Enforced by `scripts/check-platform-seam.mjs` in `pre-commit` **and** in CI (so `--no-verify` does not slip one through), and extended to `editor/`, `dialect/` and `copy/` by MYND-574 task 76. If an export you need is missing, add it to the seam module — do not reach around it.
- **A new `web/wasm/src/dispatch.rs` arm needs its `capability::DISPATCHED` entry in the same change, and only `cargo test -p myne-web-wasm` tells you.** Without it, `classify` reports a command the router *does* answer as unported — the exact wrong answer the capability system exists to prevent. `cargo clippy --target wasm32-unknown-unknown` is green either way, and so is every `scripts/check-web-*.mjs` guard. The crate is a workspace member (so `cargo test --workspace` in `pre-push` covers it), but CI's Rust steps name `-p protocol` and `-p myne-desktop -p myne-core`; the wasm lane now runs the crate's tests too (MYND-574 task 77).
- **A `[target.'cfg(…)'.dependencies.…]` table must go at the END of a `Cargo.toml`, never beside the crate it overrides.** Inserted next to `tracing = "0.1"` inside `[dependencies]`, it TERMINATES that section, and every crate declared after that line silently becomes part of the target table — `sha2`, `unicode_normalization` and friends disappear from both builds with `unresolved import` errors that name the wrong file. TOML sections have no closing brace, so nothing about the edit looks wrong.
- **`web/wasm/pkg/` is a derived artefact and goes stale.** Adding a `#[wasm_bindgen]` export needs `./scripts/build-wasm.sh` before `pnpm web:build`, or the bundler fails with `MISSING_EXPORT` on the new name.
- **`Cargo.lock` is single-shared at workspace root** (TB9 audit anchor). Do not split into per-crate locks.
- **Vite `strictPort: 1420`** — `pnpm dev` fails fast if port taken; this is intentional (Tauri expects exact port).
- **Vite `clearScreen: false`** — keep it; otherwise Rust errors get hidden during `pnpm tauri dev`.
- **CLAUDE.md HTML comments are stripped** before injection. Block comments (`<!-- ... -->`) outside code blocks vanish silently. Use code blocks if you need a literal comment.
- **Tauri lib must keep `_lib` suffix** (`myne_desktop_lib`) to avoid Windows lib-vs-bin collision (rust-lang/cargo#8519). See `src-tauri/CLAUDE.md`.

## License

Multi-licensed by subtree — see [`LICENSING.md`](LICENSING.md) for the authoritative map. Application code (`src/`, `src-tauri/`, `web/`, `core/`, `protocol/`) is **AGPL-3.0** (not "or-later" — and `web/`'s AGPL is load-bearing: the network clause is what makes a served bundle self-hostable, the only mitigation A15/TB11 has); the `docs/` subtree is **CC-BY-4.0** so the spec stays reusable for independent implementations as long as Myne is credited. Every `protocol/` source file carries `// SPDX-License-Identifier: AGPL-3.0`. Decision recorded in `docs/decisions.md`.
