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

```
web/
├── index.html          entry document (loads ../src through web/src/main.tsx)
├── vite.config.ts      the seam substitution + web-specific build config
├── tsconfig.json       typecheck of web/ against the shared src/ tree
└── src/
    ├── main.tsx        web entry — the desktop main.tsx minus its desktop-only boot steps
    └── platform/       the web implementation of the seam (one file per seam module)
```

## Commands

```bash
pnpm web:dev      # Vite dev server on :1421 (desktop dev keeps :1420)
pnpm web:build    # typecheck + production bundle into web/dist/
pnpm web:preview  # serve the built bundle
```

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
(`docs/CLAUDE.md`, operator-doc placement).

## State

Wiring only, at this stage. Every seam module under `src/platform/` currently
throws the typed `PlatformUnsupportedError`; the real implementations (wasm
Worker, OPFS, browser dialogs) land with the tasks that own them. The page
loads, the shell mounts, and the first backend call fails legibly — which is
the point of a wiring task, and is verified rather than assumed.
