# AGENTS.md

Guidance for coding agents working in this repository. It is public: do not add
private hostnames, credentials, internal runbook names or links to repositories
that are not published.

## What this repository is

Myne is an end-to-end encrypted, local-first markdown notes application. This
repository holds all three clients (Tauri desktop, browser web, iOS/Android),
the Rust protocol crate, the shared backend, the CLI and MCP sidecars, the
theme tooling, and the public documentation subset under `docs/`.

## Toolchain

- Node: see `.nvmrc`; pnpm is the only package manager (`pnpm-lock.yaml`).
- Rust: the pinned toolchain in `rust-toolchain.toml`; one workspace lockfile
  (`Cargo.lock`).
- Go and the server live in the `myne-server` companion repository.

## Build and test

```bash
pnpm install --frozen-lockfile
pnpm build                 # tsc + vite
pnpm test                  # vitest
cargo test -p protocol
cargo check --workspace    # needs every sidecar first, see below
```

Sidecars: `pnpm sidecar` builds the debug CLI, MCP and Tor sidecars.
`pnpm sidecar:release` builds those plus the clipper native host. The Tauri
`beforeBuildCommand` runs the release set, so `pnpm tauri build` is
self-contained; a bare `cargo check --workspace` is not, and fails until
`node scripts/build-clipper-host.mjs --profile debug` (or the release script)
has produced the fourth binary.

Model weights are not stored in git. Fetch them with `scripts/fetch-models.sh`
before a build that bundles OCR or speech-to-text, and run
`scripts/check-desktop-payload-budget.mjs` afterwards. A checkout without the
weights still builds, but the features that need them are unavailable.

## Layout

- `src/`, `src-tauri/` — desktop client (React UI + Tauri host).
- `web/`, `mobile/` — browser and mobile targets; they compile the same `src/`
  tree through the platform seam in `src/platform/`.
- `protocol/` — the cryptographic protocol crate (`#![no_std]` + `alloc`).
- `core/`, `format/`, `decrypt/`, `cli/`, `mcp/`, `tor-sidecar/` — Rust crates
  and sidecars.
- `docs/` — public specification, threat model, glossary and bundle-hash
  record, licensed CC-BY-4.0.
- `scripts/`, `tests/`, `e2e/`, `e2e-web/` — repo guards and test lanes.

The decision log, the design canon and the internal development notes are
private. A path such as `decisions/protocol/0763` is an identifier, not a file
in this repository.

## Rules

- Every tracked Rust source file starts with
  `// SPDX-License-Identifier: AGPL-3.0-only`; crate manifests declare the same
  SPDX expression. Do not add a bare `AGPL-3.0`.
- Documentation under `docs/` is CC-BY-4.0. Code, tests and scripts are
  AGPL-3.0-only. Do not copy code into `docs/` or documentation into a code
  subtree without checking `LICENSING.md`.
- Never commit credentials, tokens, private keys or internal hostnames. Use
  the environment or the developer's own credential store.
- Security reports go through `SECURITY.md`; do not open a public issue for a
  vulnerability.
- Commits carry a `Signed-off-by:` trailer (DCO). The project does not use a
  CLA.
- GitHub text is for the next developer. A PR body states what changed and why
  in two or three sentences, then the commands you ran. Use one thought per
  sentence, active voice and no em or en dashes. Open with what the PR does,
  not with a commit count or a tagline. Use plain bullets instead of bolded
  commit subjects as headings.
- Do not open a stacked PR. Start every branch at the default branch and target
  every PR at the default branch. If a change depends on unmerged work, wait for
  it to land or keep both changes in the same PR.
- Run the narrowest relevant check before committing: `pnpm test <path>` for a
  TypeScript change, `cargo test -p <crate>` for Rust, and the repo guards in
  `scripts/` when a path or licence changes.

## Load-bearing identifiers

| Identifier | Value | Why it must not change |
|---|---|---|
| Firefox Gecko extension ID (browser clipper) | `clipper@myne.md` | Every clipper pairing token binds to it and the native host manifest's `allowed_extensions` is generated from it. |
| Chrome/Edge extension ID (browser clipper) | `ebbbblnjddeockegombcnbiljefmlhbh` | Written into the Chromium native-messaging manifest's `allowed_origins`; every pairing token binds to it. Derived from the clipper manifest `key`. |
| Native-messaging host name (browser clipper) | `md.myne.clipper` | The host-manifest family name the browser launches. |
