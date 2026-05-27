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

## Reference

- `threat-model.md` §6 — compensating controls
- `decisions.md` 2026-04-26 — "Reproducible signed builds, hash-pinned lockfiles, minimal direct-dependency surface"
- `decisions.md` 2026-04-28 — "Rust-side primitives: RustCrypto stack as primary"
- `deny.toml` (this repo) — machine-readable enforcement
