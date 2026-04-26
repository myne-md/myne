# Myne

> Open-source, end-to-end-encrypted markdown notes — local-first, with optional zero-knowledge sync. Plain markdown files after decryption, backlinks and graph as first-class features, no email at signup.

This is the **main repository** for the Myne project. It holds the desktop client (Tauri + Vite + React + Rust) and will hold the canonical Rust crypto protocol crate when its implementation begins. The complete v0.1 specification, threat model, and decisions log are already here under [`docs/`](docs/).

## Status

**Pre-alpha.** No implementation has shipped yet. The v0.1 specification is complete; the Tauri desktop client (Phase 1) scaffold has just been initialised — Tauri 2 + Vite + React + TypeScript on the UI, Rust core in [`src-tauri/`](src-tauri/). See [`docs/vision.md`](docs/vision.md) for the phased plan.

## What v0.1 commits to

- **End-to-end encrypted** by default. No plaintext mode. Every byte — note content, titles, folder structure, timestamps, attachments — stays encrypted at rest and in transit.
- **Plain markdown after decryption.** No proprietary block format. If Myne disappears, your files are already in the format every editor understands.
- **No email at signup.** A 20-character Crockford-base32 account number with a Damm-32 check digit replaces email. See [`docs/spec/account-number.md`](docs/spec/account-number.md).
- **BIP-39 24-word recovery phrase.** Hard zero-knowledge: lose both password and phrase, the data is unrecoverable. We cannot help. Email recovery will not be added.
- **Argon2id `m=256 MiB, t=3, p=2`** for password stretching, with parameters bound into AAD to defeat downgrade attacks.
- **XChaCha20-Poly1305 + CTX commitment** for every AEAD operation. Defeats partitioning-oracle attacks (Len–Grubbs–Ristenpart, USENIX 2021).
- **Forward-incompatible major versions.** v005 will be a separate closed spec; cross-major migration is explicit and one-way.
- **Same protocol for hosted sync and self-host.** No closed-source server. Self-hosting changes the operator, not the security model.

## Documentation

All specifications live under [`docs/`](docs/):

- [`docs/vision.md`](docs/vision.md) — project vision, target user, success criteria, anti-features
- [`docs/threat-model.md`](docs/threat-model.md) — 13 adversary classes, 17 assets, 9 trust boundaries. **Read this first.**
- [`docs/spec/protocol.md`](docs/spec/protocol.md) — v0.1 cryptographic protocol
- [`docs/spec/account-number.md`](docs/spec/account-number.md) — account-number format and validation
- [`docs/glossary.md`](docs/glossary.md) — ~115 entries covering primitives, constructions, project-specific keys
- [`design-notes.md`](design-notes.md) — running log of every architectural decision

The threat model is normative for what users may rely on; marketing copy must not exceed its guarantees.

## Repository layout

```
myne/
├── docs/                ← specifications, vision, threat-model, glossary, decisions
├── src/                 ← React UI (Phase 1 desktop client front-end)
├── src-tauri/           ← Tauri 2 + Rust desktop core (Phase 1)
├── public/              ← static assets bundled into the WebView
├── protocol/            ← Rust crypto protocol crate (Phase 1; lands when crate implementation begins)
├── workspace/           ← scripts for cloning siblings & cross-repo operations
├── index.html
├── package.json         ← pnpm + Vite + React + TS toolchain
├── vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── .nvmrc               ← pinned Node version (reproducible builds)
├── LICENSE
└── README.md
```

The desktop client lives at the repository root, not in an `apps/` subfolder, because mobile, web, and website clients all live in dedicated companion repos (see below) — a one-child `apps/desktop/` would just be unnecessary nesting. The Rust crypto protocol crate, when its implementation begins, lands as a sibling Cargo workspace member at `protocol/`. Together with `src-tauri/`, they share a single root `Cargo.lock` for a single auditable lockfile per the threat model's hash-pinning commitment.

`docs/`, `workspace/`, the Tauri scaffold, and pinned toolchain files exist today; `protocol/` lands when crate implementation begins.

## Companion repositories

The full Myne project spans multiple repos under the [`myne-md`](https://github.com/myne-md) GitHub organization. The main repo (this one) holds the desktop client + protocol crate + specifications. Deployment-specific code lives in companion repos that, when cloned via `workspace/setup.sh`, live as nested directories inside this one.

| Repo | What it is |
|---|---|
| [`myne-test-vectors`](https://github.com/myne-md/myne-test-vectors) | Language-agnostic JSON test vectors for the protocol |
| [`myne-server`](https://github.com/myne-md/myne-server) | Go sync server (Phase 2) |
| [`myne-web`](https://github.com/myne-md/myne-web) | Next.js web client (Phase 3) |
| [`myne-mobile`](https://github.com/myne-md/myne-mobile) | React Native iOS + Android (Phase 3) |
| [`myne-website`](https://github.com/myne-md/myne-website) | Marketing site (myne.md) |
| [`operations`](https://github.com/example-org/operations) | Internal ops & infrastructure (private) |

## Setting up a local dev workspace

```bash
gh repo clone myne-md/myne
cd myne
./workspace/setup.sh
```

`setup.sh` clones every companion repo (`myne-test-vectors`, `myne-server`, `myne-web`, `myne-mobile`, `myne-website`, `operations`) **into** this `myne/` directory as nested folders. The main repo's `.gitignore` excludes them so they do not show up as untracked.

Daily commands:

- `./workspace/pull-all.sh` — `git pull --ff-only` across the main repo and every nested companion
- `./workspace/status-all.sh` — one-line `git status` summary per repo

See [`workspace/README.md`](workspace/README.md) for the full layout and command reference.

## Contributing

Until Phase 1 implementation begins, the most productive contribution is review of the spec and threat model — open an issue if you find an inconsistency, an unstated assumption, or an attack class the threat model misses. Once code lands, contribution flow will be documented here.

## License

Currently CC0 (this repo holds documentation only). When Phase 1 application code lands, the repo will move to **AGPL-3.0** with the `docs/` subtree retaining CC0 (or a similarly permissive content license) so the specification remains maximally reusable for independent implementations. The licensing transition will be recorded in [`design-notes.md`](design-notes.md) when it happens.
