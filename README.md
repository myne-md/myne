# Myne

> Open-source, end-to-end-encrypted markdown notes — local-first, with optional zero-knowledge sync. Plain markdown files after decryption, backlinks and graph as first-class features, no email at signup.

## Status

**Pre-alpha.** This repository contains the v0.1 specification, vision, threat model, and decisions log. No client implementation has shipped yet. The first ship target is a Tauri desktop client (Phase 1); see [vision.md](vision.md) for the phased plan.

## What v0.1 commits to

- **End-to-end encrypted** by default. No plaintext mode. Every byte — note content, titles, folder structure, timestamps, attachments — stays encrypted at rest and in transit.
- **Plain markdown after decryption.** No proprietary block format. If Myne disappears, your files are already in the format every editor understands.
- **No email at signup.** A 20-character Crockford-base32 account number with a Damm-32 check digit replaces email. See [spec/account-number.md](spec/account-number.md).
- **BIP-39 24-word recovery phrase.** Hard zero-knowledge: lose both password and phrase, the data is unrecoverable. We cannot help. Email recovery will not be added.
- **Argon2id `m=256 MiB, t=3, p=2`** for password stretching, with parameters bound into AAD to defeat downgrade attacks.
- **XChaCha20-Poly1305 + CTX commitment** for every AEAD operation. Defeats partitioning-oracle attacks (Len–Grubbs–Ristenpart, USENIX 2021).
- **Forward-incompatible major versions.** v005 will be a separate closed spec; cross-major migration is explicit and one-way.
- **Same protocol for hosted sync and self-host.** No closed-source server. Self-hosting changes the operator, not the security model.

## Documentation

- [vision.md](vision.md) — project vision, target user, success criteria, anti-features
- [threat-model.md](threat-model.md) — 13 adversary classes, 17 assets, 9 trust boundaries. **Read this first.**
- [spec/protocol.md](spec/protocol.md) — v0.1 cryptographic protocol
- [spec/account-number.md](spec/account-number.md) — account-number format and validation
- [glossary.md](glossary.md) — ~115 entries covering primitives, constructions, project-specific keys
- [decisions.md](decisions.md) — running log of every architectural decision

The threat model is normative for what users may rely on; marketing copy must not exceed its guarantees.

## Project layout

Myne is a multi-repo project under the [`myne-md`](https://github.com/myne-md) organization. This repo is the docs + spec home; implementations live in sibling repos.

| Repo | What it is |
|---|---|
| [`myne-protocol`](https://github.com/myne-md/myne-protocol) | Canonical Rust implementation of the protocol |
| [`myne-test-vectors`](https://github.com/myne-md/myne-test-vectors) | Language-agnostic JSON test vectors |
| [`myne-desktop`](https://github.com/myne-md/myne-desktop) | Tauri + Next.js desktop client (Phase 1) |
| [`myne-server`](https://github.com/myne-md/myne-server) | Go sync server (Phase 2) |
| [`myne-web`](https://github.com/myne-md/myne-web) | Next.js web client (Phase 3) |
| [`myne-mobile`](https://github.com/myne-md/myne-mobile) | React Native iOS + Android (Phase 3) |
| [`myne-website`](https://github.com/myne-md/myne-website) | Marketing site (myne.md) |
| [`myne-workspace`](https://github.com/myne-md/myne-workspace) | Local dev workspace setup |

## Setting up a local dev workspace

If you want every Myne repo cloned side-by-side, use the workspace tool:

```bash
mkdir -p ~/Documents/myne && cd ~/Documents/myne
gh repo clone myne-md/myne-workspace
cd myne-workspace
./setup.sh
```

See [`myne-workspace`](https://github.com/myne-md/myne-workspace) for the full setup, layout, and command reference.

## Contributing

The specification is the load-bearing artifact. Until Phase 1 implementation begins, the most productive contribution is review — open an issue if you find an inconsistency in the spec, an unstated assumption in the threat model, or an attack class the threat model misses. Once implementation lands, each implementation repo will document its own contribution flow.

## License

Specifications and documentation: **CC0** (`LICENSE`). Implementation repos carry their own licenses (most AGPL-3.0; protocol library is MPL-2.0; test vectors are CC0; website is MIT). License matrix is recorded in [decisions.md](decisions.md).
