# Dependency Policy

> Adding a dependency is a security decision. This policy makes the decision repeatable and reviewable.
>
> Anchored in `threat-model.md` §6 (compensating controls — minimal direct-dependency surface is the credible substitute for a missing third-party audit) and `vision.md` (reproducible signed builds, hash-pinned lockfiles).

## Scope

Applies to **every direct dependency** added to:

- `Cargo.toml` (workspace + `protocol/` + `src-tauri/`)
- `package.json`
- Any companion repo's equivalent (`go.mod`, `Cargo.toml`, `package.json`, `Podfile`, `build.gradle`, etc.)

**Indirect (transitive) dependencies** are reviewed during the direct-dep review (you can't add a direct dep without inspecting what it pulls in).

## The bar — what every new direct dep must satisfy

Before opening the PR that adds the dep, the proposer must have answered:

1. **Is there a way to do this without the dep?** Hand-rolled (if non-crypto, non-parsing), `std`-only, existing transitive that we can promote — these always come first.
2. **Is the dep actively maintained?** Last release within 12 months; no `unmaintained` advisory in `cargo audit` / `npm audit`.
3. **Who maintains it?** Solo-maintainer-with-no-bus-factor is a yellow flag; document the bus-factor risk in the PR if accepted.
4. **What's the transitive tree like?** Run `cargo tree -p <crate>` or `pnpm why <pkg>`. If the dep brings in 50+ transitives for a leaf use case, that's a red flag — look for a leaner alternative.
5. **License compatible?** AGPL-3.0-or-later (this repo) requires:
   - Permissive licenses OK: MIT, Apache-2.0, BSD-2/3-Clause, ISC, MPL-2.0, Unicode-DFS-2016, CC0-1.0
   - Weak copyleft OK: MPL-2.0, LGPL (with caveat for static linking)
   - Strong copyleft consider: GPL-3.0 (compatible with AGPL-3.0)
   - **Disallowed**: proprietary, "free for non-commercial", custom licenses without OSI approval
   - `cargo-deny` enforces the allow-list (`deny.toml`).
6. **Is it crypto?** **No new crypto deps without a `decisions.md` entry.** Per `decisions.md` 2026-04-28 "Rust-side primitives: RustCrypto stack", the primitive set is closed; new crypto = new audit surface.
7. **Is it Tauri / Vite / React core?** Upgrades to these go through their own change windows; don't bundle with feature work.

## PR checklist (paste into PR body when adding a dep)

```markdown
## New dependency: `<name>` <version>

- [ ] Justified non-existence of alternative (hand-roll / std-only / existing transitive)
- [ ] Last release: <YYYY-MM> (within 12 months)
- [ ] Maintainer count: <N>; bus-factor risk: <low / medium / high>
- [ ] Transitive count: <N> (`cargo tree -p <name>` / `pnpm why <name>`)
- [ ] License: <SPDX>; compatible with AGPL-3.0
- [ ] cargo-deny / advisory check passes
- [ ] If crypto: `decisions.md` entry linked: `<URL or "n/a">`
- [ ] Lockfile hash-pinned (no `*` versions, no git revs without commit hash)
- [ ] Reviewer eyes-on transitive tree: `<reviewer name>`
```

## Hash-pinning rules

- **Cargo:** `Cargo.lock` is checked in (workspace-shared single lock per `decisions.md` and threat-model TB9). No wildcard versions in `Cargo.toml`. Git deps require explicit `rev = "<sha>"` (no `branch =` / `tag =`).
- **pnpm:** `pnpm-lock.yaml` checked in. `package.json` uses exact versions (no `^`, no `~`) unless explicitly justified in PR.
- **No new transitives via `cargo update -p <crate>`** without re-running the dep checklist for the upgrade path.

## Emergency CVE patches

If a CVE in an existing dep requires immediate upgrade:

1. Open a PR with the version bump
2. Subject line: `Sec: bump <crate> to <version> (CVE-YYYY-NNNNN)`
3. Skip the new-dep checklist (this is an upgrade, not a new dep) but include CVE link + upstream patch reference
4. Land within 48h; backfill `decisions.md` entry if the upgrade changed semantics

## What gets rejected, fast

- Adding a logger / metrics / telemetry dep: hard no without a `decisions.md` entry overriding the "no telemetry" commitment
- Adding an HTTP client when one already exists in the tree
- Adding a JSON serializer when `serde_json` (Rust) or native `JSON` (TS) already covers
- Adding a CSS framework / UI library to `src/`: per `decisions.md` 2026-04-26 the choice of "Vite + React, no Tailwind/CSS Modules" is intentional
- Adding any "vendored" code from another project without a SPDX header and a `decisions.md` entry

## Periodic review

Quarterly: `cargo outdated`, `cargo audit`, `pnpm audit`. PR per crate that needs attention; do not batch-bump multiple crates in a single PR (audit trail matters).

## Load-bearing API watchlist

Direct dependency methods whose semantic changes would silently affect Myne's privacy guarantees. On each upstream minor/patch upgrade, release notes MUST be reviewed for behavior or contract changes to these specific call sites before the upgrade lands.

| Dep | API | Load-bearing for | Reference |
|---|---|---|---|
| `tauri` (2.x) | `WebviewWindow::set_content_protected` | Screen-capture protection (best-effort A7 defense-in-depth) | `threat-model.md` §6; `decisions.md` 2026-05-27 — "Screen-capture protection: Tauri `set_content_protected` abstraction over direct FFI" |

Pending getters: Tauri 2.10.3 does NOT expose a `WebviewWindow::is_content_protected() -> bool` reader. If a future Tauri release adds this getter, extend the screen-capture-protection feature with a 5-line smoke test (`tests/screen_capture_protection.rs`) asserting `set_content_protected(true)` followed by `is_content_protected()` returns `true`. Tracked here so the smoke test lands the same quarter the getter ships.

## Recorded direct dependencies (ledger)

Running ledger of direct deps accepted under "The bar" above, with the justification that would otherwise live in a per-dep PR body. New entries append; never rewrite (mirrors the `decisions.md` discipline).

### Search index (MYND-29) — `src-tauri/Cargo.toml`

Four pure-Rust deps for the full-text search engine. None is crypto (the RustCrypto/primitive set is unchanged — search consumes already-decrypted plaintext); none is telemetry; all are leaf-use, small-tree, permissive-licensed.

| Dep | Version | Used for | Transitive footprint | License | Justified-by |
|---|---|---|---|---|---|
| `unicode-normalization` | 0.1.25 | NFC-normalize tokens so decomposed/precomposed forms match | **None new** — already in `Cargo.lock` via `protocol`'s `vault.prefs` NFC folder normalization (transitive→direct promotion) | MIT/Apache-2.0 | `decisions.md` 2026-05-31 (search-index); Task 1 |
| `rust-stemmers` | 1 | Snowball stemming (EN/TR/DE among 18 langs); same crate tantivy uses internally | Small, pure-Rust | MIT/BSD | `decisions.md` 2026-05-31; Task 2 |
| `whatlang` | 0.16 | Per-note language detection (trigram model) → index-side single-stem | `ahash`/`hashbrown`/`allocator-api2`, pure-Rust | MIT | `decisions.md` 2026-05-31; Task 3 |
| `postcard` | 1 (`default-features = false`, `alloc`) | Compact varint serialization of the `MYS1` search-index blob plaintext (`index_format_version 0x01`) | `cobs` (COBS framing) + `embedded-io` ×2 (no_std IO traits) — all tiny, pure-Rust, `no_std`+`alloc` | MIT/Apache-2.0 | `decisions.md` 2026-05-31; Task 9 |

**Why postcard over the existing `serde_json` (the "don't add a JSON serializer when serde_json covers" rule):** the MYND-29 Task 9 benchmark showed `serde_json` inflated the at-rest `vault.search` blob to ~5× the indexed text and dominated warm-unlock latency, breaking the §9.6 blob-size + blob-load budgets; postcard (binary, varint, no field names) holds the blob under ~1× text and the decode under budget. `serde_json` remains the serializer for the small, schema-evolving, byte-stable-vector `vault.prefs` blob (canonical JSON, §9.5.2) — the two blobs use different encodings by deliberate design. So this is not "a second JSON serializer"; it is a compact binary serializer for a distinct, size-sensitive payload.

### Graph view (MYND-197) — `package.json`

One JS dep for the Phase-1 minimal graph view's force-directed layout. Not crypto (consumes already-decrypted in-RAM index data); not telemetry; lazy-loaded (out of the initial bundle, off the crypto/IPC path). Chosen over Cytoscape.js because the Envelope-A scale target shrinks the need to "force-simulation only" and the render/interaction is hand-rolled (clears "The bar" Q1).

| Dep | Version | Used for | Transitive footprint | License | Justified-by |
|---|---|---|---|---|---|
| `d3-force` | (exact-pinned) | Force-directed node-position layout only (the n-body / Barnes-Hut math); render + pan/zoom/hit-test/interaction are hand-rolled | `d3-dispatch`, `d3-quadtree`, `d3-timer` — all tiny, pure-JS, same d3 monorepo, ISC | ISC | `decisions.md` 2026-06-08 (graph visualization); Task 1 |

**Why a dep at all (vs fully hand-rolled):** rendering/interaction (pan/zoom/hit-test at ~1-2k nodes) is hand-rolled per "The bar" Q1; the force-simulation itself (Barnes-Hut quadtree, convergence, numerical stability) is exactly the numerical code Q1 does NOT ask you to hand-roll. So the dep is scoped to the genuinely-hard math only. **Bus-factor (yellow-flag):** primary-author concentration (Mike Bostock / Observable); mitigated by the huge install-base + the leaf, single-purpose surface. **Hash-pinning:** exact version in `package.json` (no `^`/`~`), `pnpm-lock.yaml` checked in.

### PDF inline render (MYND-164) — `package.json`

| Dep | Version | Used for | Transitive footprint | License | Justified-by |
|---|---|---|---|---|---|
| `pdfjs-dist` | 6.0.227 (exact-pinned) | Render the first page of a decrypted PDF attachment to a `<canvas>` for inline display in the editor (and, later, library thumbnails) — `src/editor/attachments/pdf-render.ts` | **Zero runtime dependencies** (`npm view pdfjs-dist dependencies` → none); ships its own worker. | Apache-2.0 | epic `attachments` SYNC-5 (pdf.js + mandatory icon-fallback); grill 2026-06-07 `editor-image-embeds` |

- **Non-existence of alternative:** PDF rendering is not hand-rollable (full PDF parser + font/CMap engine); the platform `<embed>`/`<iframe>` path is rejected because it would hand decrypted PDF bytes to an uncontrolled native viewer and can execute embedded PDF JavaScript. pdf.js renders to a canvas with `isEvalSupported: false` (no PDF scripting) entirely in-memory.
- **Maintained:** Mozilla-maintained, frequent releases; bus-factor low.
- **Bundle size:** the runtime is **lazy-loaded via dynamic `import()`** so it lands in its own chunks and never enters the main editor bundle — measured at build: `pdf-*.js` ≈ **427 KB raw / 127 KB gzip**, plus the parsing worker `pdf.worker.min-*.mjs` ≈ **1.25 MB raw** shipped as a separate hashed asset fetched only when a PDF attachment is actually rendered. A note with no PDF attachment pays **zero** bytes for it.
- **Mandatory fallback (SYNC-5):** if pdf.js fails to load or parse for any reason, the render path rejects and the editor draws a generic PDF icon instead — pdf.js is never a hard dependency of the render surface.

## Reference

- `threat-model.md` §6 — compensating controls
- `decisions.md` 2026-04-26 — "Reproducible signed builds, hash-pinned lockfiles, minimal direct-dependency surface"
- `decisions.md` 2026-04-28 — "Rust-side primitives: RustCrypto stack as primary"
- `decisions.md` 2026-05-31 — "Encrypted search index" (the four search deps + the postcard-over-serde_json rationale)
- `deny.toml` (this repo) — machine-readable enforcement
