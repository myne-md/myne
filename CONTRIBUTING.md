# Contributing to Myne

Thanks for helping. This file is the short version for somebody arriving from outside; the
authoritative rule set is [`AGENTS.md`](AGENTS.md), and where the two disagree, that file wins.

## Before you write code

**Open an issue first.** Every change in this repository binds to a tracked issue under
[`myne-md`](https://github.com/myne-md), and the tracker is the only place work is tracked. A pull
request with no issue behind it has nowhere to record why the change was made, which is the part
that outlives the diff.

**Work in a git worktree, not in your checkout of the default branch.** `AGENTS.md` explains why
(the branch in a shared checkout belongs to whoever is in the directory) and where one goes
(`.worktrees/<name>`, branched from `origin/develop`).

**Large, contested or unclear work gets a design pass first**: an issue, then a stress-test
interview, then a PRD and a task list, then implementation. Work that touches cryptography, the
on-disk format, sync, a capability ACL or the egress allowlist is never small, however short the
diff, because [`docs/threat-model.md`](docs/threat-model.md) has to change in the same commit.

**A change to `protocol/` ships with its vectors** in
[`myne-test-vectors`](https://github.com/myne-md/myne-test-vectors). That obligation is not advice:
it is what makes a protocol change verifiable by someone who does not trust this repository. A change
a user can notice does not owe a user-guide page in the same session; the guide is brought up to date
on its own pass (`decisions/process/0780`).

## Developer Certificate of Origin

Every commit must be signed off. That is the whole of the DCO: a trailer asserting you wrote the
change or otherwise have the right to submit it under this repository's licence.

```bash
git commit -s -m "fix(editor): reveal colored highlights cleanly"
```

which appends

```
Signed-off-by: Your Name <you@example.com>
```

Use your real name and a reachable address, and note that the trailer is in the commit, so it is
public forever. The `commit-msg` hook rejects a commit without it. If you forget, `git commit
--amend -s` fixes the last one; `git rebase --signoff origin/develop` fixes a branch.

The DCO text is at <https://developercertificate.org/>. It is the same instrument the Linux kernel
and most of the projects this one borrows from use, chosen because it is short enough to read.

## Build and test

```bash
pnpm install
pnpm tauri dev     # the full app (spawns Vite + the Rust core)
pnpm test          # Vitest (unit + component specs)
pnpm build         # typecheck + production bundle
cargo nextest run --workspace   # the Rust gate pre-push runs (brew install cargo-nextest)
cargo clippy --workspace --all-targets -- -D warnings
```

`lefthook install` once per clone activates the git hooks. They are not decoration: the
`pre-commit` set is the fast half of the rule set (formatting, the platform seam, the token and
primitive ratchets, the i18n catalogues), and `pre-push` runs the full local battery. CI runs the
same checks plus the lanes that need a container. [`scripts/repo-guards.md`](scripts/repo-guards.md)
says what each one blocks and, more usefully, what it catches that no compiler would.

## Writing the pull request

The PR body is for the next developer. State what changed and why in two or three
sentences, then the commands you ran. The rules in [`AGENTS.md`](AGENTS.md#rules)
cover the voice and the base branch. Use one thought per sentence, active voice and
no em or en dashes. Do not open with a tagline or a commit count. Do not use bolded
commit subjects as headings, and do not stack a PR on another open branch.

## What your contribution is licensed under

Inbound equals outbound. Code is **AGPL-3.0**; the `docs/` subtree is **CC-BY-4.0** so that the
specification stays reusable by independent implementations. The full map, including the bundled
third-party assets and the trademark carve-out, is [`LICENSING.md`](LICENSING.md). By opening a
pull request you agree to license your contribution under the licence of the subtree it lands in.

## Code of conduct

Participation is covered by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
