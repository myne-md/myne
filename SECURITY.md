# Security Policy

## Reporting a vulnerability

Report security issues to **`security@myne.md`** privately.

Please do **not** open a public GitHub issue for vulnerabilities. We don't have a public bug-bounty page yet (planned for Phase 1 ship), but we still want to hear about issues before they go public.

If you don't get an acknowledgment within 5 business days, ping again. The address may have failed silently.

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
- **Coordinated disclosure**: we ask for a 90-day window from acknowledgment to public disclosure; we'll work with you to extend if a fix needs more time

We may also work with you to coordinate disclosure timing with downstream packagers (Linux distros, app stores) when relevant.

## Scope

In scope for security reports:
- The `myne-md/myne` repository (this one): desktop client, the in-repo **web client** (`web/`), `protocol/` Rust crypto crate, build configuration
- Companion repositories under `myne-md/`: `myne-server`, `myne-clipper`, `myne-website`, `myne-themes`, `operations`, `myne-test-vectors`
  - `myne-clipper` also reaches across into this one: the extension is keyless, and its scoped pairing token binds it to the native-messaging host that lives in `src-tauri/src/clipper/` here (`docs/threat-model.md` TB10 / A14). Report either half wherever you found it. We will route it.
- **The served web bundle and its integrity chain**: the reproducible build of `web/`, the published per-release bundle hashes and their append-only record, and any way to make a served bundle differ from the source it claims to be built from without that being detectable
- **The documented service-worker update policy and the decision logic that implements it** (`web/src/sw/update-policy.ts`): its signing key, its rotation and revocation story, and any way to get code past the pin that policy defines. The worker that would enforce it **is not implemented yet** (`docs/threat-model.md` A15 / TB11), so a report here is against the design and the policy function, not against a pin running in anyone's browser
- **The security-header and CSP configuration shipped in the self-host container**: a way to weaken or bypass the strict CSP, the zero-third-party-origin rule, or cross-origin isolation counts, whether via the container's own configuration surface or the runtime sync-origin knob
- **The hosted `app.example.com` origin**, as a maintainer-run instance
- The published v0.1 cryptographic protocol (`docs/spec/protocol.md`) and account-number scheme (`docs/spec/account-number.md`), including formal modeling concerns or attack analyses
- Reproducible-build chain and signing infrastructure (when Phase 1 §C-launch lands)
- Any hosted instance run by the Myne maintainers (when Phase 2 ships)

Out of scope:
- Self-hosted instances run by third parties: report to the operator
- **Bundles served by third parties.** An operator serving a modified web bundle to their own users is a policy matter between them and those users, not a vulnerability in this project. That is the same boundary the self-hosted-instance carve-out draws. What *is* in scope: any way for someone who is **not** the operator to alter what a bundle origin serves, and any weakness in the mechanisms that make a substituted bundle detectable (the reproducible build and the published hashes; the service-worker pin is policy that has not shipped yet, so reports against it belong under the update-policy bullet above).
- The `agent-tooling/` repository (private, internal tooling)
- The `myne-branding/` repository (brand assets only: logo, wordmark, icon and type exports; it ships no code and runs no service)
- The `myne-web/` repository: retired and superseded by the in-repo `web/` target (`design-notes.md` 2026-07-26); nothing is built or served from it, so web-client reports belong against this repository
- Third-party dependencies: report upstream first; we'll track via `cargo audit` / `pnpm audit`
- Social-engineering attacks against maintainers
- Theoretical attacks below the published threat model (`docs/threat-model.md` §6; we acknowledge "no third-party audit" as an explicit compensating-controls regime)

## Pre-1.0 caveat

Myne is **pre-alpha**. The protocol is v0.1 (under active hardening), there is no third-party cryptographer audit yet (planned for Phase 1 ship). The threat model (`docs/threat-model.md`) documents the current guarantee envelope; reports outside that envelope are still welcome but may be classified as "known limitation, will reconsider for v1.0".

## Hall of fame

When the public bug-bounty page goes live (Plan 1 §C7), reporters who agreed to credit will be listed there. Acknowledgment-only at first iteration; monetary bounty reconsidered when project sustainability is established.

## PGP / encrypted reports

We don't currently publish a PGP key. If your report contains material you don't want to send via plain email, contact us first via `security@myne.md` to coordinate a transport (Signal handle, Tutanota address, etc.).

## Why no public-issue tracker for vulnerabilities

Per the project's privacy commitment (`docs/vision.md`, `docs/threat-model.md`), we want vulnerability reports to follow coordinated disclosure. Public issues skip that step and put users at risk. The same applies to draft PRs that fix vulnerabilities: open them privately, tag the maintainers, then publish coordinated.

## Reference

- `docs/threat-model.md`: adversaries (A1–A15), assets (AS1–AS19), trust boundaries (TB1–TB11)
- `docs/spec/protocol.md`: v0.1 cryptographic protocol
- `public/.well-known/security.txt`: RFC 9116 machine-readable contact file. It is served from **every** origin this project runs, including the hosted web-app origin (`app.example.com`): a researcher who finds a problem in the served bundle is, by definition, looking at that origin and not at this repository, so the contact has to be reachable from there.
- `design-notes.md`: design decisions log (append-only)
