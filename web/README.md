# `web/` — the Phase 3 desktop-browser client

This is a **build target**, not a second UI. It compiles the same `../src/`
React tree the desktop client compiles; the only substitution is the platform
seam (`../src/platform/` → `./src/platform/`), applied by a Vite plugin in
`vite.config.ts` rather than by forking any screen.

`decisions.md` 2026-07-26 ("The web client lives in-repo at `web/`") records why
this lives in the main repository: shared code that crosses a repo boundary has
to be published and versioned, which introduces exactly the drift the shared
tree exists to prevent. A `web/` directory that started growing its own screens
would be the signal that decision had failed.

**Desktop-browser is the whole scope, and it is enforced rather than assumed.**
Phones and tablets are refused before anything mounts — see
`src/environment-gate.ts` and `decisions.md` 2026-07-29. The signals are the
platform's own mobile boolean and the primary-pointer media features, never a
user-agent string and **never a viewport width**: a desktop window snapped to a
quarter of the screen is ~400 px wide and is supported.

```
web/
├── index.html          entry document (loads ../src through web/src/main.tsx)
├── vite.config.ts      the seam substitution + web-specific build config
├── tsconfig.json       typecheck of web/ against the shared src/ tree
├── csp.ts              the Content-Security-Policy the container generates at start
├── bundle-baseline.json  the initial-bundle budget CI measures every build against
├── wasm/               the wasm entry crate — JS↔Rust boundary, OPFS arm, CSPRNG
├── bench/              wasm benchmarks (bench/wasm is a second workspace crate)
├── container/          the self-host image (see below)
└── src/
    ├── main.tsx        web entry — the desktop main.tsx minus its desktop-only boot steps
    ├── platform/       the web implementation of the seam (one file per seam module)
    ├── worker/         the Worker the wasm module runs in — OPFS, sync loop, transport
    ├── sw/             service-worker update policy (may this client replace its bundle?)
    ├── screens/        build-time substitutes for the screens web deliberately omits
    ├── components/     web-only surfaces (sync, backup, settings, device pairing)
    ├── hooks/          web-only hooks
    └── *.ts(x)         environment gate, quota precheck, single-tab vault lock
```

## Commands

```bash
./scripts/build-wasm.sh   # wasm-bindgen glue into web/wasm/pkg/ — needed FIRST
pnpm web:dev      # Vite dev server on :1421 (desktop dev keeps :1420)
pnpm web:build    # typecheck + production bundle into web/dist/
pnpm web:preview  # serve the built bundle
pnpm test:e2e:web # the browser E2E lane (needs a WebDriver on :4544)
```

`web/wasm/pkg/` is a derived artefact and gitignored, but `src/worker/worker.ts`
imports it by path — so a clone that has never run `build-wasm.sh`, or one where
a new `#[wasm_bindgen]` export has been added since, fails the bundle with a
missing-export error rather than at runtime. The script reads the required
`wasm-bindgen-cli` version out of `Cargo.lock` rather than hardcoding it, so a
`cargo update` cannot leave the pin stale.

The desktop commands (`pnpm dev`, `pnpm build`, `pnpm tauri dev`) are unaffected
— they read the root `vite.config.ts`, which this target does not touch.

## Self-hosting

`container/` builds an image that serves the bundle **with its security headers
baked in** and generates the CSP from a runtime `MYNE_SYNC_ORIGIN`. It is not a
convenience: a static server with default headers silently loses cross-origin
isolation and the zero-third-party guarantee, and nothing in the app can detect
that. **No client-IP access logging.** The image's server config deletes every
IP-bearing field from the log stream (the same filter `operations/bundle/Caddyfile`
uses at the sync edge, verbatim) and skips the health route entirely. This
matters more here than almost anywhere: **a page load on this origin is a vault
opening**, so a default access log would be a record of when each user opens
their notes. If you front this origin with your own proxy or CDN, **the
obligation moves to you** — the container cannot scrub a log it does not write.

Normative obligations, the rebuild-and-verify procedure and the AGPL §13
source offer are in [`docs/self-host-web.md`](../docs/self-host-web.md) —
this file stays a contributor's map of the target, not an operator runbook
(`docs/AGENTS.md`, operator-doc placement).

## State

Implemented and deployed. Every module under `src/platform/` is a real web
implementation — the wasm Worker, OPFS persistence, browser dialogs, downloads
— and the target has its own CI lane. `web-build` typechecks and bundles, then
runs the seam contract against this implementation plus the artefact greps, the
bundle budget and the screen/surface/testid rosters; `e2e-web` drives the built
bundle in a real browser. On `develop`, `web-docker-build` →
`web-docker-deploy` → `web-smoke` build the `container/` image, refuse to deploy
a bundle whose hash is not already published in
[`docs/web-bundle-hashes.md`](../docs/web-bundle-hashes.md), and smoke the
result over the public origin — the maintainer-run instance at `app.example.com`.

**Durability is not the desktop's, and cannot be.** OPFS offers no crash-atomic
rename — Safari does not implement `FileSystemFileHandle.move()` at all — so a
port of `core/src/atomic_write.rs` has no correct implementation here. Instead
each singleton lives as **two files written alternately**, each carrying an
8-byte generation prefix *outside* the blob; on open the newest copy that passes
AEAD verification wins (`core/src/double_buffer.rs`). Strip those 8 bytes and
what remains is byte-identical to what the desktop writes — no new magic, no
format change, no version bump. Two tabs on one OPFS container would race that
scheme, so a vault is held under a Web Locks lease and a second tab **reports**
rather than takes over (`src/vault-lock.ts`).

**Narrower than the native clients, by decision and in the artefact.** Account
and vault creation are absent, and nothing that generates or accepts the 24-word
recovery phrase is in the bundle: those modules are substituted away at build
time by the same resolver that substitutes the seam (`src/screens/`), and
`scripts/check-web-no-phrase.mjs` greps the built output to keep it that way.
Sync is required — there is no offline-first first run. `decisions.md`
2026-07-26 is the normative record of that capability set, and
[`docs/threat-model.md`](../docs/threat-model.md) A15 / TB11 states what the
served-code delivery channel costs relative to a signed desktop build.
