<!--
PR title = conventional-commit subject, e.g.
  fix(editor): reveal colored highlights cleanly
Do NOT mention AI/assistant tooling anywhere — the commit-msg hook rejects attribution trailers.
-->

## Summary

<!-- What does this change, and why? -->

## Linked work

<!-- Cite the issue without a closing keyword: the issue stays open until a human verifies the change on the default branch. -->

- Refs #

## Type of change

- [ ] Bug fix
- [ ] Feature / enhancement
- [ ] Documentation / spec
- [ ] Refactor / chore
- [ ] Breaking change (on-disk format, protocol, or public API)

## How was this tested?

<!-- Commands run, platforms covered. A new user-facing flow ships WITH its data-testid pass, see AGENTS.md; its E2E scenario is written by hand, later. -->

## Checklist

- [ ] Conventional-commit subject; the issue is referenced above with a non-closing keyword (`Refs #n`), so the merge does not close it.
- [ ] Lint + tests pass locally (`cargo clippy --workspace --all-targets -- -D warnings`, `pnpm build`, `pnpm test`).
- [ ] A new user-facing flow ships with its `data-testid` pass (`src/AGENTS.md` "Test observability"); its E2E scenario is written by hand, later.
- [ ] Docs / specs / glossary / decisions updated where behavior changed.
- [ ] No new plaintext, key-handling, network, or third-party-origin surface — or it's justified against `docs/threat-model.md`.
- [ ] If the on-disk format or a load-bearing identifier changed, `myne-test-vectors` is updated in lockstep.

## Developer Certificate of Origin

- [ ] Every commit carries a `Signed-off-by:` trailer (`git commit -s`), and I certify the
      [DCO](https://developercertificate.org/): this contribution is mine to give under the
      repository's license (AGPL-3.0) or, for `docs/`, CC-BY-4.0. The `commit-msg` hook enforces
      the trailer; see [CONTRIBUTING.md](../CONTRIBUTING.md).
