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
5. **License compatible?** AGPL-3.0 (this repo) requires:
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

### Attachment text extraction (MYND-328) — `src-tauri/Cargo.toml`

Two pure-Rust deps so search can index the text inside attachments (PDF / Word / text-like). Neither is crypto (extraction consumes already-decrypted attachment plaintext; the result is sealed by the existing `MYE1`/`protocol` codec) nor telemetry; both are leaf-use, command-path only (`plugins/attachments/extract.rs`), permissive-licensed. PDF reuses the `lopdf` already present (`Document::extract_text`, **zero new deps**) and text-like files use std UTF-8 — so DOCX is the only format needing new crates.

| Dep | Version | Used for | Transitive footprint | License | Justified-by |
|---|---|---|---|---|---|
| `zip` | 2 (`default-features = false`, `deflate`) | Unpack `word/document.xml` from a `.docx` (an OOXML zip) | `flate2`/`miniz_oxide`/`crc32fast`/`zopfli` — small, pure-Rust; most already in-tree | MIT | `decisions.md` 2026-06-19 (attachment-content-search); Task 3 |
| `quick-xml` | 0.37 | Stream the `<w:t>` runs out of `word/document.xml` (paragraph-separated) | `memchr` — already in-tree | MIT | `decisions.md` 2026-06-19; Task 3 |

**Why not `pdf-extract` / `docx-rs` (the heavier obvious choices):** the MYND-328 dependency spike measured `pdf-extract` at **+61** transitive crates including a **duplicate `lopdf` 0.36** alongside the repo's 0.41 (a single-lockfile / minimal-surface violation), and `docx-rs` at **+44**. Reusing the in-tree `lopdf` for PDF + `zip`/`quick-xml` + ~50 LOC for DOCX gets the same extraction with a fraction of the surface. Trade-off accepted: `lopdf::extract_text` is weaker than `pdf-extract` on exotic-font PDFs, acceptable for search indexing (re-derivable, `extractor_version`-gated, §9.15) and revisitable without a format change.

### Image OCR in search (MYND-441) — `core/Cargo.toml`

The OCR layer MYND-328 deferred: pixels — image attachments and scanned, text-layer-less PDFs — become searchable. Two new direct deps, both pure-Rust, both leaf-use behind `core/src/plugins/attachments/ocr/`, neither crypto nor telemetry. They live in **`core/`**, not `src-tauri/`, because mobile ships the same extractor (the attachment-import path already takes the extractor as an injected parameter). Scanned PDFs add **zero** deps: the embedded page image is pulled out of the PDF XObject stream with the `lopdf` already in-tree.

| Dep | Version | Used for | Transitive footprint | License | Justified-by |
|---|---|---|---|---|---|
| `rten` | 0.24 (`default-features = false`, feature `rten_format` only) | Run the bundled PP-OCRv5 mobile detection / recognition / angle-classifier weights | `rten-base`, `rten-gemm`, `rten-simd`, `rten-vecmath`, `rten-tensor`, `rten-model-file`, `rten-shape-inference`, `flatbuffers`, `rayon`, `rustc-hash`, `bitflags` — all pure-Rust, no C/C++ toolchain | MIT/Apache-2.0 | `decisions.md` (MYND-441); Task 2 |
| `rten-tensor` | 0.24 | The tensor type the runtime's input/output surface takes | shared with `rten` above | MIT/Apache-2.0 | same |
| `image` | 0.25 (`default-features = false`, features `png`/`jpeg`/`webp`) | Decode the image formats `sniff.rs` already accepts as attachments, before handing pixels to OCR. **Declared in both `core/` and `src-tauri/`** at the same pin and feature set — the desktop crate also decodes the page images pulled out of a scanned PDF (`extract::decode_pdf_image`), which is `lopdf`-bound and therefore desktop-only. Second declaring crate, not a second admission (the `base64` precedent). | `png` / `zune-jpeg` / `image-webp` + `flate2`/`miniz_oxide` (already in-tree via `zip`) | MIT/Apache-2.0 | same |

**Feature surface narrowed below the crate default.** `rten`'s default enables both `rten_format` and `onnx_format`; we enable **only** `rten_format`. The weights ship already converted, so the ONNX parser (`rten-onnx`) would be pure untrusted-input parsing surface for a code path that is never taken at runtime.

**Why `rten` over the obvious alternatives.** `onnxruntime` bindings (`ort`) and `pdfium-render` both mean a **prebuilt C++ binary per platform**, which breaks three commitments at once: the single shared `Cargo.lock` stops being a complete audit anchor, reproducible signed builds gain an opaque blob, and the mobile cross-builds (`aarch64-apple-ios`, `aarch64-linux-android`) gain a per-platform maintenance burden. `rten` is the same pure-Rust posture the `ring`-over-`aws-lc-rs` choice was made for. Measured cost: ~1.4× slower than onnxruntime on the same models (≈383 ms/page vs ≈250 ms on an aarch64 laptop) — accepted.

**Why not the stock `ocrs` package** (which is `rten`'s sibling and would have supplied the pre/post-processing for free): it self-describes as an early preview and is Latin-only with an English-oriented charset. The MYND-441 spike measured both; see the Turkish note below.

**Explicitly NOT behind `local-inference`.** OCR compiles in **every** build including `--no-default-features`. It is search correctness, not an AI feature: gating it would make the AI-free audit build search differently from the shipped product, which is exactly what that build exists to rule out. `ai-no-network-check.sh` check 3 asserts this and fails if someone later gates it. The consequence — that the `--no-default-features` build is no longer "ML-free" — is stated honestly in `src-tauri/Cargo.toml` rather than papered over.

**Bundled weights are part of this admission.** `src-tauri/resources/models/ocr/` ships 21.05 MiB of PP-OCRv5 mobile weights (Apache-2.0, `MODEL-LICENSE` beside them, provenance + SHA-256 in that directory's `README.md`), tracked via Git LFS like the Whisper model. They are converted **once, offline** from the upstream ONNX with `rten-convert`; that Python tool is build-time-only and never enters the shipped graph. There is **no runtime download path** — `rten` has no network surface and the loader reads only the bundled directory.

**Scanned PDFs add zero dependencies, on purpose.** The page image is pulled out of the PDF's XObject stream with the in-tree `lopdf` (`get_page_images`) rather than rendered. `DCTDecode` and `FlateDecode` cover modern scanner/phone output; `CCITTFaxDecode`, `JBIG2` and `JPX` are deliberately not decoded and those pages simply yield nothing. A rasterizer would have been the third prebuilt-C++-binary admission this section exists to avoid.

**Turkish limitation, measured not assumed.** The spike found that `ppocrv5_dict.txt` lacks `Ğ` (U+011E) and `İ` (U+0130), and that in-dict characters (`ş`, `ç`, `ı`) are still emitted unreliably because the model's training distribution is Chinese+English dominant. No Turkish-specific PaddleOCR recognizer exists, and `latin_PP-OCRv3_rec` is worse (185-entry dict, no `ğ`/`Ğ`/`ş`/`Ş`/`İ`). Since every candidate engine shares the weakness, it is mitigated **index-side** — OCR-derived documents are indexed under a diacritic-folded token variant — rather than by swapping deps.

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

### Embedded-HTML sanitizer (MYND-209) — `package.json`

| Dep | Version | Used for | Transitive footprint | License | Justified-by |
|---|---|---|---|---|---|
| `dompurify` | 3.4.8 (exact-pinned) | Sanitize note-authored embedded HTML to an ultra-tight allowlist before render (`src/editor/html/sanitize.ts`); also reused for mermaid SVG (MYND-49) | One small transitive (`@types/trusted-types`), pure-JS | (MPL-2.0 OR Apache-2.0) | epic `markdown-render-conformance` SYNC-4/SYNC-5; grill 2026-06-08 `embedded-html-rendering`; `decisions.md` 2026-06-08 |

- **Non-existence of alternative:** the createElement-per-tag allowlist path (the standing "no sanitizer" preference) was considered but does not cleanly handle `<details>`'s nested content; a correct HTML sanitizer is not safely hand-rollable (parser-differential / mutation-XSS classes). DOMPurify is the industry-standard, single-purpose, widely-audited choice. This is the **deliberate reversal** of the prior "no content sanitization layer" posture, scoped to the desktop editor.
- **Maintained:** very active (cure53), huge install base; bus-factor low for a security-critical lib.
- **Bundle size:** **lazy-loaded via dynamic `import()`** (code-split); a note with no embedded HTML pays zero bytes. ~ tens of KB.
- **The control IS the config:** `ALLOWED_TAGS` = 8 elements, `ALLOWED_ATTR` = `[title]`, KEEP_CONTENT; strips all `on*`/`src`/`href`/`style`/`class`/`id`. Rendered via `innerHTML` of sanitized output ONLY. Tested in `tests/editor/sanitize-html.test.ts` + `embedded-html-security.test.ts`.

### Math render (MYND-48) — `package.json`

| Dep | Version | Used for | Transitive footprint | License | Justified-by |
|---|---|---|---|---|---|
| `katex` | 0.17.0 (exact-pinned) | Render inline `$…$` + block `$$…$$` LaTeX to HTML in the editor (`src/editor/math/render-math.ts`) | Zero runtime deps; ships its own CSS + WOFF2 fonts | MIT | epic `markdown-render-conformance` SYNC-4; grill 2026-06-08 `math-katex`; `decisions.md` 2026-06-08 |

- **Non-existence of alternative:** a LaTeX math typesetter is not hand-rollable; KaTeX is the renderer the dialect spec (§7) already named. The MathML-via-temml alternative was rejected (uneven WebView math support cross-platform).
- **Maintained:** Khan Academy / community, very active; large install base.
- **Bundle size:** **lazy-loaded via dynamic `import()`** (code-split, with its CSS); a math-free note pays zero bytes. Fonts self-hosted (Vite-bundled, no CDN — reproducible-build-safe).
- **CSP / safety:** KaTeX needs no `eval`; runs `trust:false` so output carries no `\html`/`\href` injection — safe to `innerHTML` (vetted-output mode, SYNC-5). `throwOnError` caught → invalid LaTeX falls back to source + a subtle hint.

### Mermaid diagram render (MYND-49) — `package.json` — ⚠️ HEAVIEST DEPENDENCY

| Dep | Version | Used for | Transitive footprint | License | Justified-by |
|---|---|---|---|---|---|
| `mermaid` | 11.15.0 (exact-pinned) | Render ```mermaid fenced blocks to SVG (`src/editor/decorations/mermaid.ts`) | **≈ +100 packages** — the largest in the project. Direct: cytoscape (+cose-bilkent/fcose), d3 + d3-sankey, dagre-d3-es, roughjs, marked, dayjs, khroma, stylis, es-toolkit, @iconify/utils, @braintree/sanitize-url, its own dompurify + katex, @mermaid-js/parser, … | MIT | epic `markdown-render-conformance` SYNC-4; grill 2026-06-08 `mermaid-diagrams`; `decisions.md` 2026-06-08 |

- **"The bar" Q1 (hand-roll?):** a general diagram-grammar + layout engine (flowchart/sequence/gantt/class/state/…) is not hand-rollable; the lighter-subset alternative (a hand-rolled `graph TD`/`sequenceDiagram`-only renderer) was considered and rejected by the user in favour of full Mermaid.
- **"The bar" Q4 (transitive tree):** RED FLAG by the policy's own ≥50-transitive heuristic — this is the project's single biggest TB9 surface expansion. Accepted as a **conscious decision** (`decisions.md` 2026-06-08): the auto-grill *recommended deferring* mermaid; the user overrode to ship it.
- **Bundle size:** **lazy-loaded via dynamic `import()`** (code-split) — a diagram-free note pays **zero** bytes; the heaviest dep never enters the cold bundle. (Owed at PR: a measured lazy-chunk KB figure + a byte-stable-across-builds check.)
- **Security:** `securityLevel:'strict'` + `htmlLabels:false` → mermaid sanitizes its own SVG via its bundled DOMPurify (no click/script/`<foreignObject>`, no raw-HTML labels). No remote fetch. `threat-model.md` §6.
- **Mandatory fallback:** parse-error / load-failure → monospace code card (mermaid is never a hard dependency of the render surface).

### Excalidraw drawing canvas (MYND-498, drawing-notes SF1) — `package.json` — ⚠️ RED-FLAG DEPENDENCY

| Dep | Version | Used for | Transitive footprint | License | Justified-by |
|---|---|---|---|---|---|
| `@excalidraw/excalidraw` | 0.18.1 (exact-pinned) | Native drawing/canvas note type — the hardened, lazy-loaded Excalidraw shell (`src/drawing/`) | **+119 packages** (`pnpm add` report) — roughjs (already in-tree via mermaid → deduped), its own hand-drawn fonts, etc. | MIT | epic `drawing-notes` (MYND-497); grill 2026-07-14 `excalidraw-embed-hardening` (MYND-498); `decisions.md` override (user-owned, pending) |

- **"The bar" Q1 (hand-roll?):** a whiteboard/canvas engine is not hand-rollable — same class as mermaid/pdf.js/katex. User pre-approved the dependency surface (2026-07-14).
- **"The bar" Q4 (transitive tree):** RED FLAG by the policy's own ≥50-transitive heuristic (**+119**). roughjs is deduped (already pulled by mermaid). Accepted as a **conscious decision** (user override, 2026-07-14); the `decisions.md` override entry is user-owned and pending (autopilot flags, does not auto-write).
- **Bundle size:** **lazy-loaded via `React.lazy(() => import(...))`** (`src/drawing/DrawingCanvasLazy.tsx`) — a drawing-free session pays **zero** bytes (verified: `@excalidraw` library code absent from the cold `main` chunk). Now that SF2 wires `<DrawingCanvasLazy>` reachable, the vite build code-splits it into a dedicated **`DrawingCanvas-*.js` ≈ 568 KB** chunk (+ a shared ≈ 520 KB Excalidraw chunk), confirmed out of `main`. (Owed at PR: a byte-stable-across-builds reproducibility check.)
- **CSP / safety:** no `eval` needed; renders to `<canvas>` (not `innerHTML`), so no DOMPurify pass here; embeddables rejected (`validateEmbeddable: () => false`, SYNC-5); collaboration / library-CDN / image-from-URL / font-CDN all foreclosed by CSP + the self-hosted `EXCALIDRAW_ASSET_PATH`. Fonts self-hosted under `public/excalidraw-assets/fonts` (SIL OFL 1.1, no CDN — reproducible-build-safe).
- **License artifact:** the repo's first bundled `public/THIRD-PARTY-LICENSES.txt` (Excalidraw MIT + OFL fonts). The whole-npm-tree license CI gate is spun out to **MYND-504**.

### PDF footer stamping (MYND-255 hotfix) — `src-tauri/Cargo.toml`

| Dep | Version | Used for | Transitive footprint | License | Justified-by |
|---|---|---|---|---|---|
| `lopdf` | 0.41.0 (`default-features = false`) | Post-process the captured per-note export PDF to stamp a per-page footer (note title bottom-left, "X / Y" counter bottom-right) — `src-tauri/src/plugins/pdf_export/footer.rs` | **+16 `Cargo.lock` entries measured**: 12 new names (`lopdf`, `aes`, `block-padding`, `cbc`, `ecb`, `encoding_rs`, `md-5`, `rangemap`, `stringprep`, `ttf-parser`, `unicode-bidi`, `unicode-properties`) + 4 new duplicate versions of already-locked names (`chacha20` 0.10, `cpufeatures` 0.3, `rand` 0.10, `rand_core` 0.10) — all pure-Rust, permissive-licensed | MIT | `decisions.md` 2026-06-11 PDF-pipeline entry (footer amendment); owner request 2026-06-11 |

- **Non-existence of alternative:** a per-page "X / Y" total-aware page counter cannot be drawn by the capture engines themselves — WebKit print engines (macOS WKWebView, Linux WebKitGTK) do not implement CSS `@page` margin boxes (`@bottom-left`/`@bottom-right` + `counter(page)`/`counter(pages)` are effectively Chromium-print-only), and the in-document-flow CSS tricks can't know the total page count before pagination. A hand-rolled stamper was rejected: it would have to correctly parse and rewrite three engine dialects (classic xref tables AND xref/object streams, per platform arm) — exactly the "non-trivial parsing" class "The bar" Q1 excludes from hand-rolling.
- **Maintained:** active (J-F-Liu/lopdf, releases well within 12 months; 0.41.0 current at adoption); multiple maintainers/contributors, large install base — bus-factor low-medium.
- **Features trimmed:** `default-features = false` drops the `chrono`/`jiff`/`rayon`/`time` date-object + parallel-parse conveniences; the stamper needs parse + content append + full-rewrite save only.
- **Crypto note (not a primitive-set change):** several transitives (`aes`/`cbc`/`ecb`/`chacha20`/`md-5`/`rand`) are lopdf's own **encrypted-PDF support**, non-optional upstream. Myne never invokes that code path (capture output is never encrypted), no Myne key material flows through lopdf, and the project's closed RustCrypto primitive set (`decisions.md` 2026-04-28) is unchanged — this is dependency-tree surface (TB9), not protocol crypto.
- **Lazy/cold-path:** invoked only inside the `pdf_export` finalize path (user-initiated export command), never on the boot/unlock/cold path; **fail-open** — a stamp failure publishes the unstamped capture (the footer is cosmetic, the export must not break).
- **Hash-pinning:** exact `0.41.0` in `Cargo.toml`, single workspace `Cargo.lock` updated; added to `src-tauri/` only (never `protocol/`).

### Voice-note microphone capture (MYND-259) — `src-tauri/Cargo.toml`

| Dep | Version | Used for | Transitive footprint | License | Justified-by |
|---|---|---|---|---|---|
| `cpal` | 0.15 | Native cross-platform microphone capture for voice notes — `src-tauri/src/plugins/attachments/voice/capture.rs` (PCM in → mono i16 → WAV → encrypted attachment) | OS audio backends per platform: CoreAudio (macOS), WASAPI / `windows` (Windows), ALSA / `alsa-sys` (Linux). Pure-Rust glue; the Linux arm links the system ALSA dev headers (`libasound2-dev`) at build time. | Apache-2.0 OR MIT | `decisions.md` 2026-06-14 voice-notes entry; owner request 2026-06-14 |

- **Non-existence of alternative:** the WebView's `getUserMedia`/MediaRecorder was rejected on three grounds — (1) it leaves captured PCM as an un-`Zeroize`-able JS `Blob` in V8 (a plaintext-residue regression vs Rust-side capture); (2) the output codec/container differs across the three OS WebViews (WebView2 Opus/WebM vs WKWebView AAC/mp4); (3) WebKitGTK's MediaRecorder is notoriously unreliable (GStreamer-plugin-dependent), so the Linux build could silently have no recording at all. Native capture keeps the plaintext in Rust, yields one uniform codec, and removes the WebKitGTK gamble.
- **Maintained:** active (RustAudio/cpal); the de-facto Rust audio-I/O crate, large install base, multiple maintainers — bus-factor low.
- **Codec choice avoids a second dep:** recording to **WAV/PCM** (a 44-byte header written by hand in `voice/encoder.rs`) needs no encoder crate and no C library; Opus would have added `libopus` (a C dependency + reproducible-build friction) and is deferred behind an `Encoder` seam.
- **Crypto note (not a primitive-set change):** cpal touches no key material — captured PCM is handed to the existing `attachment_import` AEAD path; the project's closed RustCrypto primitive set (`decisions.md` 2026-04-28) is unchanged. This is dependency-tree surface (TB9), not protocol crypto.
- **Lazy/cold-path:** invoked only by the user-initiated `voice_record_start` command (the mic stream opens on an explicit gesture), never on the boot/unlock/cold path; the recording is aborted on lock / auto-lock / vault-delete so the mic never outlives the unlocked session.
- **Hash-pinning:** `0.15` in `Cargo.toml`, single workspace `Cargo.lock` updated; added to `src-tauri/` only (never `protocol/`).

### On-device inference (local-ai, MYND-406) — `src-tauri/Cargo.toml` — ⚠️ HEAVIEST RUST DEPENDENCY

The Candle ML stack + tokenizer for [local inference](../glossary.md) — the single largest Rust-side transitive surface Myne takes (the peer of Mermaid on the npm side).

| Dep | Version | Use | Transitive footprint | License | Provenance |
|---|---|---|---|---|---|
| `candle-core` | 0.8 | CPU tensors + quantized GGUF loader (`gguf_file`) | gemm, half, rayon, memmap2, safetensors, … (large) | MIT/Apache-2.0 | `decisions.md` 2026-07-01; local-inference-runtime task 3 |
| `candle-nn` | 0.8 | `VarBuilder` (safetensors → BERT weights) | shares candle-core's tree | MIT/Apache-2.0 | same |
| `candle-transformers` | 0.8 | `quantized_qwen2::ModelWeights` (infer) + `bert::BertModel` (embed) + `LogitsProcessor` | candle-nn + rand_distr | MIT/Apache-2.0 | same |
| `tokenizers` | 0.20 | BPE/WordPiece tokenizer (`Tokenizer::from_file`) | onig (regex C-binding), esaxx-rs, … | Apache-2.0 | same |

- **"The bar" Q4 (transitive tree):** RED FLAG by the ≥50-transitive heuristic — the largest Rust-side TB9 surface. Accepted as a **conscious, human-approved decision** (`decisions.md` 2026-07-01, amended 2026-07-02) with three mitigations — of which one **weakened** when AI moved into the default build (`decisions.md` 2026-07-02 "Ship local AI in the default build behind a runtime beta opt-in"): (1) **feature-gated auditable variant (weakened, not lost)** — `local-inference` is now in `default`, so the **shipped** bundle carries the ML symbols; the zero-ML-symbol, byte-unchanged-`Cargo.lock` binary survives only as the **`--no-default-features` reproducible variant** (guarded by a CI `cargo check --no-default-features`), no longer as the default; (2) **`default-features = false`** on `candle-transformers` + `tokenizers` keeps `hf-hub` / `http` (networked model-download crates) OUT of the tree — models are side-loaded (SYNC-1/2), now verified network-free by an **absolute denylist scan** over the single shipped tree (`ai-no-network-check.sh`, wired into CI) + `no_egress.rs` — this mitigation is **unchanged**; (3) **not in `protocol/`** — the crypto crate's dependency surface is untouched — **unchanged**. The runtime gate is `ai_enabled` (default off, Settings → Labs → AI Beta).
- **Hash-pinning:** exact minor pins in `Cargo.toml`, single workspace `Cargo.lock` updated; the `rustls` in the tree is pre-existing sync-TLS, not a Candle-specific crate. Added to `src-tauri/` only.
- **The `local-inference-stub` build feature** (E2E-only) keeps `local-inference` but swaps the Candle engine for the deterministic stub at compile time — it pulls the same crates but is never the shipped bundle (production uses the real Candle engine).
- **Whisper (voice-to-text, MYND-270) adds ZERO new crates — it rides this Candle row.** On-device speech-to-text reuses `candle-transformers 0.8`'s built-in `whisper` module (already pinned above); **no new dependency enters the tree**, so the TB9 surface is **unchanged** and this admission needed no fresh "the bar" pass. Audio decode is **hand-rolled** — a `RIFF`/`WAVE` WAV reader + a linear 16 kHz resampler in `src-tauri` — so **no audio crate (`hound` / `symphonia` / `rubato`) is admitted**, the same lean posture as the hand-written WAV *encoder* in the `cpal` voice-note row above. The log-mel filterbank is **computed deterministically at runtime** (a `librosa.filters.mel(sr=16000, n_fft=400, n_mels, htk=False, norm="slaney")` reproduction in `whisper.rs`; **no committed blob, no `include_bytes!`, no data file, no runtime download**) — consistent with the side-load / no-network AI posture (SYNC-1/2): nothing about STT reaches the network, and the no-egress denylist gate covers it as part of the same single tree. Added to `src-tauri/` only, never `protocol/`. (`decisions.md` 2026-07-19.)

### Phase 2 sync transport (MYND-424, extracted to core in MYND-457) — `core/Cargo.toml`

The raw-TLS connection layer the SCRAM auth + sync push/pull share, plus the base64 wire
encoding for the enroll handshake. Landed with the Phase-2 client sync engine (MYND-424) in
`src-tauri/Cargo.toml`; **moved to `myne-core` with the sync engine extraction** (`decisions.md`
2026-07-07) so the mobile client inherits the identical transport. Documented here formally for
the first time (the MYND-424 landing left the entry as a gap — it was only mentioned in passing
in the local-ai note).

| Dep | Version | Used for | Transitive footprint | License | Justified-by |
|---|---|---|---|---|---|
| `rustls` | 0.23 (`default-features = false`, features `ring`/`std`/`tls12`) | The single TLS path for SCRAM auth + sync push/pull with cert-pinning (A4) and keying-material export (tls-exporter, the SCRAM channel binding, SYNC-3) — `core/src/plugins/sync/rustls_transport.rs` | rustls-webpki + the `ring` crypto provider (`rustls::crypto::ring`) + zeroize; the `ring` provider carries per-arch asm compiled by the platform clang | Apache-2.0/ISC/MIT | `decisions.md` 2026-07-01 (MYND-424 landing) + 2026-07-07 (core extraction) |
| `rustls-pki-types` | 1 | Cert/key DER newtypes the rustls verifier surface takes (`CertificateDer`, …) | pure-Rust, tiny | Apache-2.0/MIT | same |
| `base64` | 0.22 | SCRAM/enroll wire encoding (`core/src/plugins/sync/enroll.rs`) — also independently used desktop-side by `local_inference`, so it is declared in **both** `core/` and `src-tauri/` | pure-Rust, zero transitive | Apache-2.0/MIT | same |

- **`ring` is NOT a direct dependency.** The sync code uses `rustls::crypto::ring::default_provider()` — a rustls submodule enabled by rustls's `ring` feature — never the standalone `ring` crate. So there is no `ring = …` line; it is a transitive of `rustls`.
- **`ring` provider over the default `aws-lc-rs`:** chosen for a more reproducible build — `ring` needs no C/CMake toolchain, only the platform clang, so `myne-core` **cross-compiles for `aarch64-apple-ios` and `aarch64-linux-android`** (the whole point of the extraction; iOS proven locally in MYND-457, Android gated on the NDK clang and deferred to MYND-465).
- **Relocation vs. new admission (the two-sided consequence, signed off in the MYND-457 grill, SYNC-33):** in the main `myne` repo this is a **relocation** inside the single shared `Cargo.lock` — no new third-party package enters the shared graph (TB9 audit-anchor intact), only which crate declares them changed (`src-tauri/` → `core/`). In the **`myne-mobile` companion repo's own lockfile** these are **new admissions** that mobile inherits transitively via the `myne-core` path dependency — the first C/asm-adjacent crypto crate (`ring`) the mobile build compiles. That admission was human-approved in the grill.
- **Unconditional (no feature gate):** `myne-core` carries the transport unconditionally — every core consumer that wants sync wants the transport, and gating would break the crate's single-feature (`test-support`-only) uniformity (SYNC-33).
- **R3 review-debt (carried, not closed here):** the cert-pin verifier + tls-exporter wiring is **R3-gated** — a primitive-level security review + a live interop test are still owed before production trust. The banner travels with `rustls_transport.rs`; relocating it into the shared core does **not** promote it to reviewed. Nothing user-facing may present cert-trust as verified until R3 closes.
- **Not in `protocol/`:** the crypto crate's dependency surface is untouched; the closed RustCrypto primitive set (`decisions.md` 2026-04-28) is unchanged — this is transport-layer dependency surface (TB9), not protocol crypto.
- **Hash-pinning:** exact pins in `core/Cargo.toml`, single workspace `Cargo.lock` updated (relocation, no new package); added to `core/` (and `base64` also stays in `src-tauri/` for `local_inference`), never `protocol/`.

## Reference

- `threat-model.md` §6 — compensating controls
- `decisions.md` 2026-04-26 — "Reproducible signed builds, hash-pinned lockfiles, minimal direct-dependency surface"
- `decisions.md` 2026-04-28 — "Rust-side primitives: RustCrypto stack as primary"
- `decisions.md` 2026-05-31 — "Encrypted search index" (the four search deps + the postcard-over-serde_json rationale)
- `deny.toml` (this repo) — machine-readable enforcement
