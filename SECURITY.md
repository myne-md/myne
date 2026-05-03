# Security Policy

## Reporting a vulnerability

Report security issues to **`security@myne.md`** privately.

Please do **not** open a public GitHub issue for vulnerabilities. We don't have a public bug-bounty page yet (planned for Phase 1 ship), but we still want to hear about issues before they go public.

If you don't get an acknowledgment within 5 business days, ping again — the address may have failed silently.

## What to include

A useful report includes:
- A description of the vulnerability and the impact
- Steps to reproduce (or proof-of-concept code)
- The Myne component affected (`protocol/`, `src-tauri/`, `src/`, `myne-server`, etc.) and version/commit
- Any suggested mitigation, if you have one
- How you'd like to be credited (handle, real name, anonymous)

## Our response commitment

- **Acknowledge** within 5 business days
- **Initial assessment** (severity, scope, fix plan) within 14 days
- **Coordinated disclosure** — we ask for a 90-day window from acknowledgment to public disclosure; we'll work with you to extend if a fix needs more time

We may also work with you to coordinate disclosure timing with downstream packagers (Linux distros, app stores) when relevant.

## Scope

In scope for security reports:
- The `myne-md/myne` repository (this one) — desktop client, `protocol/` Rust crypto crate, build configuration
- Companion repositories under `myne-md/`: `myne-server`, `myne-web`, `myne-mobile`, `myne-website`, `myne-ops`, `myne-test-vectors`
- The published v0.1 cryptographic protocol (`docs/spec/protocol.md`) and account-number scheme (`docs/spec/account-number.md`) — including formal modeling concerns or attack analyses
- Reproducible-build chain and signing infrastructure (when Phase 1 §C-launch lands)
- Any hosted instance run by the Myne maintainers (when Phase 2 ships)

Out of scope:
- Self-hosted instances run by third parties — report to the operator
- The `myne-agents/` repository (private, internal tooling)
- Third-party dependencies — report upstream first; we'll track via `cargo audit` / `pnpm audit`
- Social-engineering attacks against maintainers
- Theoretical attacks below the published threat model (`docs/threat-model.md` §6 — we acknowledge "no third-party audit" as an explicit compensating-controls regime)

## Pre-1.0 caveat

Myne is **pre-alpha**. The protocol is v0.1 (under active hardening), there is no third-party cryptographer audit yet (planned for Phase 1 ship). The threat model (`docs/threat-model.md`) documents the current guarantee envelope; reports outside that envelope are still welcome but may be classified as "known limitation, will reconsider for v1.0".

## Hall of fame

When the public bug-bounty page goes live (Plan 1 §C7), reporters who agreed to credit will be listed there. Acknowledgment-only at first iteration; monetary bounty reconsidered when project sustainability is established.

## PGP / encrypted reports

We don't currently publish a PGP key. If your report contains material you don't want to send via plain email, contact us first via `security@myne.md` to coordinate a transport (Signal handle, Tutanota address, etc.).

## Why no public-issue tracker for vulnerabilities

Per the project's privacy commitment (`docs/vision.md`, `docs/threat-model.md`), we want vulnerability reports to follow coordinated disclosure — public issues skip that step and put users at risk. The same applies to draft PRs that fix vulnerabilities: open them privately, tag the maintainers, then publish coordinated.

## Reference

- `docs/threat-model.md` — adversaries (A1–A13), assets (AS1–AS17), trust boundaries (TB1–TB9)
- `docs/spec/protocol.md` — v0.1 cryptographic protocol
- `public/.well-known/security.txt` — RFC 9116 machine-readable contact file
- `docs/decisions.md` — design decisions log (append-only)
