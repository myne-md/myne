<!--
PR title = conventional-commit subject, e.g.
  fix(editor): reveal colored highlights cleanly
Do NOT mention AI/assistant tooling anywhere — the commit-msg hook rejects attribution trailers.
-->

## Summary

<!-- What does this change, and why? -->

## Linked work

- Closes #

## Type of change

- [ ] Bug fix
- [ ] Feature / enhancement
- [ ] Documentation / spec
- [ ] Refactor / chore
- [ ] Breaking change (on-disk format, protocol, or public API)

## How was this tested?

<!-- Commands run, platforms covered. A new user-facing flow ships WITH its E2E coverage — see CLAUDE.md. -->

## Checklist

- [ ] Conventional-commit subject; the issue is linked with `Closes #n` above.
- [ ] Lint + tests pass locally (`cargo clippy --workspace --all-targets -- -D warnings`, `pnpm build`, `pnpm test`).
- [ ] A new user-facing flow ships with its `data-testid` pass + an E2E scenario on the right harness (`e2e/` desktop, `e2e-web/` web).
- [ ] Docs / specs / glossary / decisions updated where behavior changed.
- [ ] No new plaintext, key-handling, network, or third-party-origin surface — or it's justified against `docs/threat-model.md`.
- [ ] If the on-disk format or a load-bearing identifier changed, `myne-test-vectors` is updated in lockstep.

## Developer Certificate of Origin

- [ ] I certify the [DCO](https://developercertificate.org/): this contribution is mine to give under the repository's license (AGPL-3.0).
