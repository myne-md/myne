# AGENTS.md

Guidance to OpenCode when working in this repository.

Subdirectory `AGENTS.md` files cover their own domain in depth. OpenCode loads the nearest file when work enters that directory:
- `src-tauri/AGENTS.md` — Tauri 2 host, capability ACL, plugin pattern, Windows lib-name quirk
- `core/AGENTS.md` — `myne-core`, the shared backend crate: the host/IO/task seams, lifecycle hooks and plugin-core layout
- `protocol/AGENTS.md` — RustCrypto primitives, subkey derivation discipline and vectors
- `src/AGENTS.md` — React UI patterns, design tokens and mock-layer status
- `agent-tooling/docs/AGENTS.md` — spec authoring rules
- `e2e/AGENTS.md` — tauri-driver desktop harness and scenario authoring rules
- `e2e-web/AGENTS.md` — browser web-E2E lane
- `mobile/AGENTS.md` — mobile client patterns
- `agent-tooling/AGENTS.md` — agent, skill, feature and session layout

## Design context (pointer)

Three files at the repo root carry the visual + strategic system. Read in this order before designing any UI:

1. `PRODUCT.md` — strategy: register, users, voice, brand personality, anti-references, design principles. Cross-client (desktop + future mobile + web). Read before any new screen.
2. `DESIGN.md` + `DESIGN.json` — visual system in [Google Stitch DESIGN.md format](https://stitch.withgoogle.com/docs/design-md/format/). Frontmatter is the machine-readable token layer; `DESIGN.json` carries the live-panel components, tonal ramps, shadow + motion + focus extensions.
3. `agent-tooling/docs/design/` — **the design canon itself**: `README.md` (voice + tactical rules), `colors_and_type.css` (the CSS-variable source — the binding values), `ui_kits/desktop/` (JSX primitives), `preview/` (token specimen tabs).

**The design canon lives in this repository.** There is no external design file that outranks it — `agent-tooling/docs/design/` is canonical, `DESIGN.md`/`DESIGN.json` are its machine-readable projection (where the two disagree, the CSS is the value and `DESIGN.md` gets corrected), and `src/` is the implementation, binding to CSS variables rather than literals (`check-token-adoption.mjs` is the ratchet). When a shipped screen and the canon disagree, decide which side is wrong **on the merits** — fix the drifted screen, or update `agent-tooling/docs/design/` in the same change when the screen genuinely improved on the system. Leaving the two silently disagreeing is the one option that is never right.

`/impeccable` commands (craft, polish, audit, etc.) read `PRODUCT.md` + `DESIGN.md` automatically. Do not duplicate their content into other docs.

**And what a change OWES the design system lives in `agent-tooling/reference/design-system.md`**,
because this section is read and that file is where a skill's standing obligations point. The split is
deliberate and worth stating: `agent-tooling/docs/design/` above stays the CANON for values and voice, and the
companion file holds the PROCESS and RATCHET rules a change has to satisfy, which is the half that
used to live only in `stories/README.md` and so was read by nobody with a skill loaded. It carries
the token sheet as the values layer and a literal as permanent, the specimen and description
ratchets, the nine-item story definition of done, the casing split (Title Case for a name in a list,
sentence case for product copy), the accessibility levels (`error` by default, `todo` to record,
`off` with a reason), the `--z-*` ladder, and the rule that an audit follows a symptom rather than a
calendar. `stories/README.md` is the human-facing copy of the same material.

## Session conventions (pointer)

**This repository has one harness: pi.** OpenCode was removed on 2026-11-03 and `opencode.json` with
it, so there is nothing to keep in step between two front-ends.

`myne-conventions.ts` in `myne-pi-plugin` appends the body of `agent-tooling/skills/diverge/SKILL.md` to the
system prompt on `before_agent_start`. It shapes how an answer is arrived at, not how it is worded:
widen before you narrow, then commit, inline and spawning nothing. `myne-compaction.ts` carries mutable
session state through compaction.

**How an answer is written is one rule**: ASD-STE100, through
[`agent-tooling/reference/writing-rules.md`](agent-tooling/reference/writing-rules.md), which names the
standard, the surfaces it covers, and the one exception for text a user reads. It constrains how a
sentence is built and never what it may claim: a security, crypto, spec or data-loss finding is
stated in full. Each artefact-producing skill keeps its own output format.

`WORK DISCIPLINE` is preserved as compaction state: after a repository change, the next action is `/pr-review`, then `/done`.

The convention applies to interactive pi sessions. CI classifiers run their dedicated skills headless
and do not load this project configuration.

## How work runs here (pointer)

**Every change to a repository runs on the same lane, whatever the request looked like.** A session
that started from `/grill-me` and a session that started from a one-line "fix this" owe the identical
five things. This section exists because the rules behind them live in `agent-tooling/reference/`, and
those files are read only through a skill's standing-obligations block: a session that invokes no
skill reads none of them, which is exactly the session that then skips them. This file is loaded for
every session in this tree, so the lane is stated here and the mechanics stay there.

**Four craft rules sit above the lane, and they are not style preferences.** They are why a change
here is smaller than the same change elsewhere, and each one has already been paid for:

1. **The least code that does the work, which is a search before it is a principle.** Before writing
   anything, walk this order and stop at the first rung that answers:

   1. Does something in this tree already do it? Search for the CONCEPT, not the name: the same
      question is often spelled with a different word, and `rg` for the name you were about to use is
      how the fourth copy gets written.
   2. Can the thing you found be extended or parameterised instead of copied?
   3. Does a dependency already in `package.json` or `Cargo.toml` do it?
   4. Only then write it.

   A change ends with **one line in its pull request or task record** naming what it reused, what it
   deleted, and why anything new was needed. An empty line reads as a search that did not happen, and
   review treats it that way. Deleting code is a legitimate outcome of a task and does not need a
   second task to justify it. Size is not effort, it is surface: every line is something the next
   reader has to rule out.

   The failure this wording exists for is on the record, not hypothetical: one question ("may this
   device sign a head right now") was implemented three times, in `cycle::signed_head_ctx`,
   `roster_trust::own_device_signing_pair` and `device_binding::store::claim_self_in_dir`, while a
   fourth site answered a different question the same-looking way (`carrier_applies` against
   `meta_kind::carries_b2b_tail`). The third and the fourth disagreed about the vault generation the
   product had started creating, so sync stopped on every new vault and nothing failed. myne-md/myne#983
   is the removal, and `/pr-review`'s `least-code` reviewer is the gate that asks the question.
2. **A UI component is written once.** Before a new button, dialog, list, field, toggle or card,
   find the one that already does it: `src/components/` in the shared tree, the primitives in
   `agent-tooling/docs/design/ui_kits/desktop/`, `client-core`'s policy modules. Reuse it, extend it, or
   parameterise it; write a near-copy only when the existing one is genuinely the wrong shape,
   and say in the commit why. A second copy of a control is a second place a design decision has
   to be made, and the two drift the first time only one of them is touched.
3. **A comment earns its lines or it goes.** Write the one that says WHY, or what the code cannot
   say (a load-bearing identifier, an ordering constraint, a measured behaviour of somebody else's
   system). Do not narrate what the next line plainly does, do not restate the signature, and do
   not leave a paragraph where a sentence works. The same rule for the reply to the owner.
4. **Nothing is written under `~`, ever.** Scratch goes to `$TMPDIR` or a path the session created
   for it, and anything worth keeping becomes a file in the repository (`scripts/`, a runbook, a
   fixture) in the same change that produced it. The owner said "bi daha benim /Users/omer klasorumu
   hic kirletme" after finding wrapper scripts and probe output scattered through his home
   directory, and the same walk produced a runbook step pointing at `~/operations`, a directory that
   has never existed on this machine. A path that only works on the machine that wrote it is a
   broken instruction wearing a green tick.

**The lane spans sessions; starting is not a promise to finish today.** These five obligations are
on the work, not a single-session checklist. Never refuse, defer, or hand off a job because it looks
larger than one session: begin the first concrete task. Partial state is legitimate and already has a
home: leave the tree dirty and record what is done and what remains in `progress.md` (the `do-work`
Partial Completion shape); the compaction plugin carries the session state. The `/pr-review` then
`/done` tail closes the branch when it is ready, not before the work starts. An analysis-only answer
to an implementation request is a failed turn. The user-owned decision gate in item 5 still stops the
work; that is authority, not size.

1. **No issue, no work, and the setup is asked for.** Work that changes a repository binds to a
   tracked issue (`issue: myne-md/<repo>#<n>`), and when none exists the issue is filed with
   `gh issue create` from the main session. But before either the issue or the worktree is created, the skill asks a
   single yes/no question and takes no action until it has the answer: `"No tracker issue exists for
   this and I would work in a fresh worktree. File an issue and create the worktree? (y/n)"`. When
   the issue already exists it asks only about the worktree. The only exception to the gate is the
   user answering `n` to that question: silence is not it, "this is tiny" is not it, and neither is
   "we are in a hurry". Reading, explaining, reviewing, researching and answering a question are
   outside the gate, since none of them change anything. Move the issue to `status: in progress`
   with `gh` when you start: on this lane nothing else will, because that transition
   belongs to `/do-work` and this lane skips it, so the issue would jump from `triage` straight to
   `ready to merge` and no second session would ever see it as taken.
   `agent-tooling/reference/github-issues.md`.

   **That question is the only one the lane asks, and it is asked once.** After the answer there is
   no second gate: not per task, not per risk tier, not "shall I continue", not "which one first".
   Approvals are collected at the top (the issue/worktree answer, and for a release the channel
   question `0769` asks), and the rest of the run executes. A turn that ends by offering the owner a
   choice is a stalled turn, and the measurement behind this paragraph is 335 of 4 846 assistant
   turns that ended in exactly that offer, against 99 one-word "devam" replies it cost him. If
   something genuinely blocks, say what blocks and do everything the block does not cover. Only a
   red gate, a destructive or outward-facing act, and a decision the owner owns (item 5) stop the
   run, and each says so in one sentence naming the decision rather than offering a menu.
2. **A session that changes a repository works in a worktree of it, never in the shared checkout.**
   The section below is that rule in full, including where a worktree lives and what it branches from.
3. **The planning front-half is sized, the tail is not.** Work that is large, contested or unclear
   goes `/grill-me` then `/write-a-prd` then `/prd-to-tasks` then `/do-work`, which produces the
   artefacts under `agent-tooling/features/<feat>/`. Work that is small and already understood skips
   those four and is implemented directly. **Size is measured in consequence, not in lines**: a
   change touching cryptography, the on-disk format, sync, a capability ACL, an egress allowlist, or
   any guarantee `agent-tooling/docs/threat-model.md` states is never small, however short the diff, because the
   threat model changes in the same PR and a design step is the only place that ordering can be
   enforced. And skipping the front half discharges none of the standing obligations: a protocol
   change still ships with its `myne-test-vectors` change
   (`agent-tooling/reference/github-issues.md`). Nothing else rides along: the user guide, the E2E
   scenario and the translation are the owner's own later pass (decision `0780`).
4. **The tail is `/pr-review`, then `/done`.** `/done` is the only committer and
   the only PR-opener, in every repo the work touched. A branch with commits on it and no PR is
   unfinished work, not finished work, and so is a clean checklist. `/pr-review` and `/done` both run
   against a plain branch with no feature directory, so ad-hoc work owes the same tail.
5. **Something coupled to the work in hand is fixed in the branch you are already in**, not filed as
   a new issue, and coupling decides that rather than size. Work that turns out to be genuinely
   distinct is the user's call: ask once, and never file without their answer. Two things always
   leave the branch instead, a legal or policy requirement (a `operations` issue, and change nothing)
   and a decision the user owns, such as the threat model, the on-disk format, an anti-feature or a
   spec reversal (stop and ask). The full table, including what an unattended run does with a
   distinct discovery, is in `agent-tooling/reference/github-issues.md`, "A discovery is implemented,
   not filed".

## Releases (pointer)

`agent-tooling/skills/release/SKILL.md` owns the order and `operations/runbooks/release-checklist.md` owns
the ticks. The rules below are the owner's and bind any session that touches a release, including one
that skips the skill.

- **The tracker is cleaned BEFORE the freeze, not after the publish.** Exactly one milestone is open
  at a time, and a new one takes the next number: no `v0.13` while the release before it is still
  open. A milestone whose version has shipped carries no open issue, so what is left is moved to the
  next milestone (or closed) as part of starting the release. The state this rule exists to prevent
  was measured on 2026-11-03: `v0.10` open with 24 issues five releases after it shipped, `v0.11`
  open with one, and `v0.13` open with eight while `v0.12` had been opened and closed for a single
  issue.
- **Closing the release's issues and clearing their labels is part of the release.** An issue the
  release verified closes, and `status: ready to test` comes off it in the same act; a closed issue
  never keeps that label, because a label that survives its issue tells the next reader nothing.
  Again measured: 220 closed issues carried it on 2026-11-03.
- **A release opens no issue, no PR and no worktree.** Its record is
  `agent-tooling/releases/v<X.Y.Z>.md`, written as the run goes. The worktree rule in item 2 of the
  lane does not apply here: a release runs on `develop` in the main checkout, because every build,
  tag and pin it produces is about that tree.
- **Publishing is the last act.** Builds, artefact verification, the downloads origin and its
  signature, the four downstream pins, the website, the server and web images all finish first.
  Then, in one pass at the end: the TestFlight upload and the GitHub release publish. A release that
  published before its own verification is a release nobody can withdraw.
- **Tracker writes are inline.** `gh issue`/`gh api` from the session, never a subagent: the
  `issue-pm` agent was removed on 2026-11-03 after hanging on every invocation.

## Worktrees (pointer)

**Every session that changes this repository works in a worktree of it, unless the user says
otherwise.** Not the shared checkout, not "just this one file". That checkout's branch belongs to
every session sitting in the directory, so switching it puts their next commit on your branch, and
committing from it lands your work on whatever branch the last session left it on. The shared
checkout stays on the default branch and is for reading.

**And creating one is asked for, not assumed.** It is one half of the single yes/no question in lane
item 1 above: the skill asks `"No tracker issue exists for this and I would work in a fresh
worktree. File an issue and create the worktree? (y/n)"` before it creates either, and does nothing
until it has the answer. On `n` the work proceeds in the current checkout, and the session says once
that it is untracked and not isolated.

A worktree for this repo is created only with `git worktree add`, into
`.worktrees/<name>`, and never anywhere else. It branches from **`origin/develop`**:
`git worktree add .worktrees/<name> -b <branch> origin/develop`.
Branching from the current local HEAD instead carries whatever the working checkout happens to be
sitting on into the new branch, which is how a feature branch picks up an unrelated half-finished
change and a PR arrives with a diff nobody can explain. The session scratchpad under `/private/tmp` is
specifically wrong for one: it is per session and gets cleaned, so the worktree outlives the
directory `git worktree list` still points at, and `.worktrees/` stops being the roster of
what is in flight. Name it after the issue (`410-note-covers`) so the worktree, the branch and the
session read the same.

**The point is that finished work leaves nothing behind**: branch pushed, PR open, machine back to
where it started. So the worktree is removed once its PR is open, together with its local branch,
since the PR tracks the remote one. Never before the PR exists, and never on a dirty tree without
saying what is uncommitted.

One trap, because it has cost two sessions already: inside a worktree, a nested companion repo
(`agent-tooling` and friends) is a **symlink** to the shared checkout, and that is correct. The Write
tool refuses to resolve through it; the answer is one Bash write to the absolute path, not cloning
the companion in. A copy lands the file in a tree nobody commits, so it looks written and is
invisible everywhere else. **And editing is the only thing that works through it**: git in a
companion repo is refused outright from a worktree session, `!` included, because a worktree
session's git may only target its own worktree. The companion's own worktree is created from the
companion itself (`worktrees.md` §2), and its PR is opened from there. `/done` commits and PRs the
main repo, Gate 5 removes the main worktree, and the companion PR follows. That is the merge order;
it is not a session-size judgment and it is not a reason to refuse the work. Full rule:
`agent-tooling/reference/worktrees.md`.

**A second trap, and it is not about the worktree's own session: a sibling checkout sits inside the
tree every guard walks.** `.worktrees/<name>/` is a full copy of this repository, so a guard
that enumerates files from the repo root sees a second `core/src`, a second `src/`, and that
session's half-finished work. The failure is asymmetric and reads as a product defect: a Rust change
here fails `check-hex-helpers.mjs` naming a file in somebody else's worktree, and the red says
nothing about the tree it ran in. A guard whose walk root is the repo root must skip `.worktrees` in
its skip list, and one that instead narrows by path (`check-core-task-seam.mjs` walks `core/src`, not
`.`) needs nothing. Audited 2026-10-19 after the second occurrence: `check-hex-helpers.mjs` carries
the fix and its `SKIP_DIRS` comment is the worked example, and the injection proof is two-directional
(a violation planted in the sibling worktree does not fire, the same violation planted here does).
Deleting the worktree removes the exposure but not the trap, since the next session creates one.

## The harness

`AGENTS.md` is the single rulebook, read by pi. Nothing else reads these files: OpenCode was removed
from this repository on 2026-11-03, together with `opencode.json`, `.opencode/plugins/`,
`.opencode/skills/`, `.opencode/agents/` and `.opencode/package.json`.

- **`AGENTS.md` is the single source of repository rules.** Subdirectory `AGENTS.md` files add their domain guidance when work enters that directory.
- **The agent tooling lives in the private companion, not here.** Skills are `agent-tooling/skills/`; `myne-resources.ts` returns that directory on pi's `resources_discover` event, so a clone with the companion gets `/skill:<name>` commands and the derived subagents without running a link or sync script, and a clone without access gets neither rather than a broken link. Nothing from the companion enters this repository's history: `.pi/.gitignore` excludes the derived agent files. **One agent file is authored here and stays tracked**: `.pi/agents/subworker.md`, which has no source in `agent-tooling` and no second copy anywhere, so gitignoring it would delete the agent rather than de-publish somebody else's file. `diverge`, previously the one authored skill, moved to the companion with the rest.
- **`.opencode/` survives as a PATH, not as a product, and it no longer holds the worktrees.** What is left under it is the `pnpm start` dev instance set and its sync store, plus the stale directories a clone from before the cut still regenerates. Worktrees moved to `.worktrees/<n>-<slug>` when the pi plugin's guard was tightened to refuse any other path: a worktree is machine state that a guard has to be able to name, and `.opencode/` was a directory with two unrelated reasons to exist. `scripts/dev-menu.mjs`, the e2e scripts and the runbooks that name `.opencode/` are all talking about the dev store, not about worktrees.
- **No MCP servers are configured by this repository.** pi registers Woodpecker's through its own package (`myne-mcp.ts`) when a token is present.

## pi harness

pi is a second front-end over the same rules, not a second rulebook. Everything pi-specific lives in `.pi/` and in one private package, and every behaviour below is a property of this repository rather than of the developer's machine - the pi build included, pinned in `package.json`; only the provider never leaves the machine.

- **Three pins, all committed.** The pi build is an exact devDependency in `package.json` (`@earendil-works/pi-coding-agent`, 1.6.0) and a session starts with `pnpm pi`, which refuses a different build; a machine-installed pi cannot change the extension API under the harness. `.pi/settings.json` declares our own `git:github.com/myne-md/myne-pi-plugin@<40-character sha>` (private, AGPL-3.0-only) and `npm:pi-btw@0.8.0` (MIT, a readable TypeScript `/btw` side-conversation extension with no outbound calls of its own). The single-package rule was about not accumulating a pile of third-party behaviour, and it still holds: vendoring 3k lines of someone else's overlay into our package would mean tracking their releases by hand, which is the cost vendoring exists to avoid. Update ours with `pnpm pi install git:github.com/...@<full sha> -l --approve` and theirs by bumping the npm version, both committed. pi's git source resolves only the **full** SHA: a short one fails with `couldn't find remote ref`.

- **Conventions arrive by injection, because pi has no `instructions` key.** `myne-conventions.ts` appends the body of `agent-tooling/skills/diverge/SKILL.md` to the system prompt on `before_agent_start`, read straight from the companion. A skill would not do: pi only applies a skill the model chooses to load, and a convention that applies to every answer cannot be optional. Edit the file in place; there is no second copy to keep in sync.
- **The model and its provider are both named here, on purpose.** `enabledModels` pins `ollama-cloud/deepseek-v4.1-flash:high` with `defaultThinkingLevel: "high"`, and `.pi/settings.json` still carries no key: the credential stays in `~/.pi/agent`. The provider used to be a glob (`*/deepseek-v4.1-flash:high`) so each developer could reach the same model through their own account. That broke the moment a second provider started serving the same model id: pi takes the first match, OpenCode Go sorts before Ollama Cloud, and every session silently moved onto a paid Go model that then answered `GoUsageLimitError`. A default that changes because an unrelated credential was added is not a default. Pin the provider; a developer who runs a different one edits this one line.

- **Requests are routed, not answered in place.** The injected conventions carry a dispatch ladder: a research request goes to a `general-purpose` subagent told to load the `deep-research` skill and to return a cited report; CI state is read from the Woodpecker MCP tools; tracker writes are done inline with `gh`, not delegated, because the `issue-pm` agent was removed on 2026-11-03 after hanging on every invocation. Each lane needs a context or a tool the main session would otherwise guess at, and the three failures the ladder prevents are the ones that cost most: a research answer with no sources, an issue filed by hand and triaged twice, and a build diagnosis invented instead of read from the failing step's log.
- **CI access ships with the package, not with a machine.** Woodpecker's MCP server (`@ni-c/woodpecker-ci-mcp`, MIT) is a dependency of `myne-pi-plugin`, and `myne-mcp.ts` registers it with `pi.registerMcpServer` when a token can be found: `WOODPECKER_TOKEN` from the environment, else the line of that name in `~/.hermes/.env`. No token means no registration, which costs the CI tools and nothing else. `WOODPECKER_URL` overrides the instance for anyone whose CI lives elsewhere. The old shape - a clone under `~/.local/share/mcp-servers` and an absolute path in `~/.pi/agent/mcp.json` - was unreproducible for a teammate and could be moved out from under the config by a reinstall, so it is gone.

- **`agent-tooling/pi/MEMORY.md` is the learning loop, and it lives in the companion.** A correction stated in a session is appended by the `remember` tool - or by hand - as one rule with its reason; `myne-memory.ts` injects the whole file into every session's system prompt under `## Repository memory`. The file itself is `agent-tooling/pi/MEMORY.md`; `myne-memory.ts` reads and writes it directly, so nothing is linked into this repository and a clone without the companion has no memory rather than half of one. It infers nothing on its own: if no one calls `remember`, nothing is learned, and a wrong lesson is deleted by editing the file.
- **Agents are derived, not hand-mirrored.** The plugin's resources extension runs `scripts/sync-agents.mjs` at session start; it writes `.pi/agents/*.md` from `agent-tooling/agents/*.md` plus the twelve `review-*` definitions, and `--check` exits non-zero on drift. pi needs `name` in the frontmatter, which is why these are derived copies rather than links. The derived files are gitignored except `subworker.md` and `general-purpose.md`, mirroring the `.pi/agents` policy.
- **Delegation needs `agentScope: "both"`.** pi's default of `"user"` hides project agents entirely, so the injected conventions carry that sentence - without it the whole subagent layer exists and is unreachable.
- **Compaction is asked for at 45% and forced at 75%, and it resumes the run.** `myne-compaction.ts` calls `ctx.compact({ customInstructions })`, and the instructions tell the summariser to keep a numbered state block - bound issue, worktree and branch, feature tasks, changed files with their purpose, decisions with reasons, the next lane step - rather than folding it into prose. When the compaction completes, the extension posts a resume message with `triggerTurn: true`, so the session carries on from the preserved state instead of waiting for a prompt. `/compact-now` does the same on demand. **The two thresholds are the point**: at 45% (`MYNE_COMPACT_AT`) the extension steers ONE message into the running turn and the agent calls the `compact_context` tool when it reaches a clean boundary, because a forced compaction lands wherever the percentage happens to cross and a summary written mid-step describes half a step; at 75% (`MYNE_COMPACT_FORCE_AT`, clamped so it never sits below the ask) the context is compacted whatever the agent decided. An absolute token ceiling is available as `MYNE_COMPACT_MAX_TOKENS` and is OFF by default: a 200k default compacted a 1M-token window at 20%, four times per window, which is the constant-compaction the owner reported. Note the API shape that makes this work: `session_before_compact` cannot do it (its event carries `customInstructions`, but the caller keeps its own variable, and the hook's only results are `cancel` and a full replacement summary), whereas `ctx.compact()` passes the instructions to the request.
- **pi asks for attention through a desktop notification.** `myne-notify.ts` fires on `ui_prompt_start` (a blocking question) and on `agent_settled` (a run finished with nothing queued), with the title `myne`, the subtitle `pi · <repo>` and one line saying what is waiting. It runs `osascript` directly rather than depending on terminal-notifier, only in interactive sessions (`print`/`json`/`rpc` are driven by other programs), and honours `MYNE_PI_NOTIFY=0`. Long runs here are the normal case, so without this the session sits finished in an unfocused window and nobody notices.
- **The sidebar is a per-process file plus two renderers.** pi's TUI cannot place a pane on the right, so `myne-sidebar.ts` writes `.pi/.state/sidebar/<pid>.json` (gitignored) - phase, current tool and its elapsed time, context percentage, the stage line, the task count, the children a delegation is running and the last five tools with their outcomes - and renders it as a widget above the editor. Every creation and rename names the tab that holds pi's OWN pane (`ZELLIJ_PANE_ID`), never the focused one, because `zellij run` and `rename-tab` act on the client's focus: an owner who switched tabs while pi started used to get the sidebar in the tab they switched to. The tab title is `<task> - <working|waiting|idle>`, task first from the published stage, then the current task-list item, the branch or the repository, capped at 24 cells, so a tab strip too narrow for prose still says which task and what it is doing. A delegated child carries `MYNE_SUBAGENT=1`, opens no sidebar, renames no tab and never notifies, and the parent writes the roster the pane lists. A real right-hand pane comes from `zellij --layout node_modules/myne-pi-plugin/layouts/myne-pi.kdl`, where `scripts/sidebar.mjs` reads the same file twice a second. The renderer never talks to pi, so it keeps showing the last state while the TUI is blocked inside a tool call, and a failure there cannot break a run. The stage line is published by the `set_stage` tool (or `/stage <label> [step]`), which is how a long procedure says where it is: a release or a grill calls it at each boundary instead of leaving the owner to infer the stage from the transcript. Task counters come from the rpiv-todo store when that extension is loaded, and that line simply disappears if the vendored internals ever change.
- **Delegation runs on OpenCode Go's free models.** Every derived agent carries `model: opencode-go/beam-free`, written by `scripts/sync-agents.mjs`, so a research request, a review dimension or a small task does not spend the Ollama Cloud budget: the subagent is spawned with an explicit `--model` instead of inheriting the session's. The two authored agents (`general-purpose`, `subworker`) carry the same line by hand. **On Go only the ids that say `free` are free** - `kimi-k3`, `deepseek-v4.1-flash` and the rest bill the Go subscription and answer `GoUsageLimitError` once its window is spent. The free set churns (on the day this was written `minimax-m3.1-flash-free` was deprecated and `longcat-2.5-preview-free` returned 429, leaving `beam-free`), so re-check with `pi --list-models | grep free`. `MYNE_SUBAGENT_MODEL` overrides the pin when regenerating, and `MYNE_SUBAGENT_MODEL=inherit` leaves the field out so children take the parent's model again.

- **The footer carries what the owner would otherwise open another window for.** Alongside the model and the branch it already showed, `myne-hud.ts` now prints the pull request for the current branch (`gh pr view --head`, cached, refreshed with the usage tick because the footer renders synchronously) and the context percentage, so the stage of the lane and the fill of the window are both visible without a command.
- **The sidebar shows the diff without the IDE.** `myne-sidebar.ts` records the working tree - `git status --porcelain`, per-file status, and `git diff --unified=2 HEAD` capped at 400 lines and 32 KB with the truncation stated - and `scripts/sidebar.mjs` prints it below the box with `+`/`-` coloured, refreshing only when the state file changes so the pane keeps its scrollback and the diff stays readable by scrolling.
- **Delegation has a budget, because two failures are invisible while they happen.** `myne-budget.ts` names at session start any agent file pinned to a model that is not a `*-free` id (on OpenCode Go everything else bills the subscription), and it caps subagent calls per session: `MYNE_MAX_DELEGATIONS`, default 30, one warning at 80%, then a refusal that states the count, the cap and the override. It is a count rather than a cost estimate on purpose, because a dispatch loop and a busy session look identical from the outside; `/budget` reports the count, the cap and any billed pin. `MYNE_ALLOW_PAID_SUBAGENTS=1` silences the model warning for a deliberate expensive run.
- **The hooks mirror is a hook, not the enforcement.** `myne-guards.ts` refuses a `git push` to a protected branch and a worktree outside `.worktrees/`, so the model gets the refusal in a second instead of at push time; lefthook remains the thing that actually blocks. `MYNE_ALLOW_PROTECTED_PUSH=0` keeps the guard on, `1` turns it off, and the local `myne.allowProtectedPush` git config is honoured the same way by both.
- **`.pi/` is cwd-based.** pi reads project settings from the working directory only, so a nested companion repo (`myne-server`, `myne-web`, ...) does not inherit this harness - measured, not assumed: run inside `myne-server`, no conventions and no project skills load. Start pi at this repository's root.
- **The plugin is tested without a model.** `cd myne-pi-plugin && npm test` runs `node:test` against a stub host: the protected-push guard with both hatches, the worktree path, the memory append and injection, the convention injection and its idempotence, and the compaction threshold and repost delta. Thirteen cases in about a second, no network, no key. That suite is also what caught the conventions extension resolving its resource root two levels up from its own file, which as an installed package points at an unrelated checkout.

## Project status

**Pre-alpha.** Shipped: v0.1 specs (`agent-tooling/docs/`), Tauri 2 + Vite + React + TS scaffold (`src/`, `src-tauri/`), Rust crypto crate (`protocol/`, RustCrypto, `#![no_std]` + `alloc`), Cargo workspace (one shared `Cargo.lock`), workspace scripts, pinned toolchain. The desktop scaffold lives at the **repo root** deliberately. It is no longer the only in-repo client — **all three clients live here now**: the Phase 3 desktop-**browser** client at `web/` (`agent-tooling/design-notes.md` **2026-07-26** "The web client lives in-repo at `web/`", which supersedes the one-in-repo-client clause of the 2026-04-26 "Desktop scaffold lives at repository root" entry while leaving its placement decision intact) and the Phase 3 **mobile** client at `mobile/` (`decisions.md` **2026-08-13** "The mobile client lives in-repo at `mobile/`", superseding the companion-repo clause of 2026-05-11 while leaving its Tauri-2-Mobile stack decision intact). All three compile the same `src/` tree. Server, website, ops, test-vectors, clipper, themes, branding and the pi harness remain companion repos (`workspace/manifest.txt` is the list); `myne-web` is archived; `myne-mobile` was deleted outright on 2026-08-13 (see the decisions entry of that date and its correction).

## Common commands

```bash
pnpm pi                 # the pi build this repository pins (1.6.0); starts the agent at the repo root
pnpm start              # ONE command, interactive: Android, iOS, desktop (x2) and web against one local sync server (scripts/dev-menu.mjs)
pnpm dev:reset          # wipe the dev instances + the sync store (macOS only; never the real md.myne.desktop vault)

pnpm tauri dev          # full Tauri dev (spawns Vite on :1420 + Rust core)
pnpm dev                # Vite only — port fixed via strictPort, fails if 1420 is taken
pnpm tauri build        # production desktop bundle

pnpm sidecar            # build + stage ALL THREE externalBin sidecars — `myne` (CLI), `myne-mcp` (MCP front-end) and `myne-tor` (arti) — debug
pnpm sidecar:release    # same, release profile — both tauri lifecycle hooks run these

pnpm web:dev            # web client dev server on :1421 (runs alongside the desktop one)
pnpm web:build          # typecheck web/ against the shared src/ tree + production web bundle
pnpm web:preview        # serve the built web bundle

pnpm mobile:dev         # mobile client dev server on :1422 (all three can run at once)
pnpm mobile:build       # typecheck mobile/ + production mobile bundle
pnpm mobile:test        # mobile Vitest suite (mobile/tests, its own vitest.config.ts)
pnpm mobile:test:flow   # Playwright flow-logic tier — NOT end-to-end (mock Tauri IPC, no device)
pnpm mobile:ios         # tauri ios dev    (needs Xcode; not runnable on the Linux CI runner)
pnpm mobile:android     # tauri android dev (needs the Android SDK+NDK; same)

cargo nextest run --workspace     # the Rust gate pre-push runs (brew install cargo-nextest)
cargo test -p protocol <name>     # one test in protocol crate
cargo clippy --workspace --all-targets -- -D warnings

brew install lefthook && lefthook install   # one-time per clone; activates git hooks
```

Git hooks are managed by **lefthook** (`lefthook.yml`, which is the authoritative list). `pre-commit` runs the fast lint set (rustfmt-check, the SPDX header over every tracked Rust file (`scripts/check-spdx-headers.mjs`), `tsc --noEmit`, the seam/coverage guards + the i18n catalog check under `scripts/` (see "Repo guards" below, and [`scripts/repo-guards.md`](scripts/repo-guards.md) for the row-by-row table), whitespace, EOF newline, single-`Cargo.lock` check, secret pattern guard); `pre-push` runs the local battery, **glob-gated** so a push touching neither Rust nor TypeScript skips it (Damm-32 table drift, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo nextest run --workspace`, `pnpm build`). **`pnpm test` is deliberately NOT in pre-push any more**: it is 1 024 files and four to five minutes of the developer's machine to re-run what `.woodpecker/main.yml` runs anyway, and under pre-push load `tests/scripts/hexHelpers.test.ts` (which shells out over every Rust file in the checkout) blew past vitest's default timeout twice while the same suite passed standalone minutes earlier — twice that cost a push to `LEFTHOOK_EXCLUDE=vitest git push`, which is the failure the hook existed to prevent. CI on `develop` is the gate now and a broken JS test surfaces after the push rather than before it; `pnpm test` by hand is still the same command when a push is worth being sure about. The `lefthook.yml` comment carries the full reasoning so nobody re-adds it as a tidy-up. The wasm-target clippy, the `myne-web-wasm` test run and the `--no-default-features` AI-free check are **CI-only** now: `.woodpecker/main.yml` already runs each at that strength (`wasm-protocol` carries both wasm clippys and `cargo test -p myne-web-wasm`; `tauri-compile` carries `cargo clippy -p myne-desktop --all-targets --no-default-features`, strictly stronger than the local `check`), and they were the slowest-throughput half of the battery; `commit-msg` rejects AI co-author/attribution trailers and requires a `Signed-off-by:` trailer (the DCO, `CONTRIBUTING.md`; a `Merge …` subject is exempt, since git writes it and there is no authorship decision in it). **`pre-push` also carries `protected-branch`**, which refuses a push whose REMOTE ref is `refs/heads/develop`, `refs/heads/main` or `refs/heads/release`, in this repo and in every companion (myne-md/myne#592). `release` is on that list because it is the branch that DEPLOYS: `myne-website`'s `.woodpecker.yml` maps `release` to production and `develop` to staging, so a `develop`-only guard protected the branch with no blast radius and skipped the one that publishes. It is hygiene rather than enforcement and says so in its own comment: the org's plan offers no server-side branch protection for private repos, so there is nothing on GitHub to lean on, and `--no-verify`, `LEFTHOOK=0` and `LEFTHOOK_EXCLUDE=protected-branch` each bypass it. Two hatches are sanctioned instead. `MYNE_ALLOW_PROTECTED_PUSH=1 git push ...` is the one-off; `git config myne.allowProtectedPush true` is for a repo whose normal workflow IS pushing to its default branch (`internal-service` documents exactly that in its own AGENTS.md, and `homebrew-tap` and `myne-branding` work the same way). Both hatches parse a VALUE (`1`, `true`, `yes`, `on`, case-insensitively) and refuse anything else, so `MYNE_ALLOW_PROTECTED_PUSH=0` keeps the guard ON rather than switching it off, which is what testing the variable for non-emptiness used to do. The flag is read with `git config --local`, deliberately: a plain `--get` reads the merged cascade, so one `--global` setting would switch the guard off in every clone at once, which is the failure the flag exists to prevent. Each `lefthook.yml` also carries a `min_version`, because `lefthook run` and the real git hook path IGNORE an unknown key without a word (only `lefthook validate` rejects one, and hooks never call it), so an older binary would drop `use_stdin` and leave a guard printing a green tick while checking nothing. CI is self-hosted Woodpecker via the Forgejo mirror (`.woodpecker/`, Linux runner; `agent-tooling/design-notes.md` 2026-05-01) — the hooks are the local pre-push net, CI is the remote gate. **The config is a DIRECTORY of two workflow files and the split is load-bearing**: `.woodpecker/main.yml` is the per-push pipeline, and `.woodpecker/e2e.yml` holds **both** end-to-end suites (the desktop tauri-driver suite and the browser web lane) and runs on a **manual trigger only**, carrying the variable `RUN_E2E=true`, before a release (myne-md/myne#579, `agent-tooling/design-notes.md` 2026-08-23 entry 0529; procedure `agent-tooling/docs/dev/e2e.md` "When CI runs these suites"). Two consequences worth stating rather than inferring. A green push pipeline is **not** evidence about a single E2E scenario, and the release runbook (`operations/runbooks/release-checklist.md` phase 0) is what owes that claim. And the manual event now carries one intent at a time: `main.yml`'s manual entry is gated `RUN_E2E != "true"` so an E2E trigger does not also run the whole pipeline and, on `develop`, deploy `app.example.com` through the `&web-deploy` anchor below. **Three lanes, one pipeline** (MYND-574; the third landed 2026-08-13): the desktop lane is one serial chain (`pnpm-build` → `vitest` → `tauri-compile` → `cargo-test-tauri`) because each of those runs `pnpm install` into the shared workspace `node_modules` (`e2e` was its tail until myne-md/myne#579 moved it out). `wasm-repro` and `sync-sim` hung off `cargo-test-tauri` until the stage timings said what that cost: the edge queued `web-build`, `web-container-check` and the whole mobile tail behind `tauri-compile`, a step that holds ONE worker slot for 11.6 minutes while the second sits idle for about ten of them, so the tail ran 19.5→32.7 min behind a step it does not depend on. Both now hang off `stories-build`, which ends exactly where `tauri-compile` begins, and the web and mobile lanes run inside the idle window instead; the **web lane** hangs off the end of it (`web-build` — the web bundle plus the artefact greps, the seam contract against the web implementation, the bundle budget and the screen/surface/testid rosters) so it adds nothing to the desktop lane's wall-clock, alongside the early Rust wasm gates (`wasm-protocol`); the **mobile lane** (`mobile-build` → `npm-licenses` → `mobile-vitest` → `mobile-flow-logic`, plus `mobile-compile` for its Rust) hangs off `web-build` for the same reason and by the same rule. That mobile chain is **serial, and every edge into it and inside it is `optional: true`** (the three internal ones since myne-md/myne#515; the `web-build` edge already was): serial because all four ran `pnpm install` into the shared workspace `node_modules` and raced as siblings, optional because a non-optional edge made one red step remove every step behind it, which is how a license-gate failure deleted the mobile Vitest suite and the whole Playwright flow-logic tier from the run. The installs in it are **conditional** now (`test -d node_modules/.pnpm || pnpm install …`), because the tree is put there by `pnpm-build` and two installs into one `node_modules` is the hazard the chains exist to avoid; the chain itself stays so a failure is attributed to its own step rather than interleaved with a neighbour's. An optional edge still orders; it only stops requiring that the parent passed. The mobile lane replaced a *separate pipeline in a separate repo* that began by cloning this one and `git reset --hard`-ing it to `develop` tip — so a mobile commit was not reproducible, and a change here that broke mobile was invisible until somebody pushed there. Three of that pipeline's six steps simply vanished, absorbed by workspace-wide steps that already existed (`cargo fmt --all`, `cargo deny check`, the shared `pnpm install`). Every step that can go red is listed in `notify-failure` (the only thing that pushes a failure to the maintainer), and every compile/test step carries the `code-paths` filter, so a docs-only commit skips them. **Three steps deliberately carry no filter and must keep it that way**: `hooks-parity` (its EOF/whitespace/SPDX checks apply to docs too), `bundle-record` (the append-only hash record *is* a doc, so a docs-only commit is exactly when it must run) and `twin-inventory` (its `--check` half holds a generated `agent-tooling/docs/**` file to its roster, and a hand edit to that file is a docs-only commit) — all three say so in their own `.woodpecker/main.yml` comments; adding `when: *code-paths` to any of them is a regression, not a cleanup. **The web deploy chain is no longer in this pipeline at all** (myne-md/myne#584): `web-docker-build`, `web-docker-deploy` and `web-smoke` are gone, because CI verifies and does not publish. What survives is `web-container-check`, which builds the image to ASK it questions rather than to ship it, runs `check-web-container-headers.sh` against the running container, and is path-filtered to `web/**` since that build is expensive and duplicative. Publishing `app.example.com`, the `--has` bundle-hash precondition and the post-deploy smoke are one by-hand procedure in `operations/runbooks/web-client-deploy.md`. The **whole mobile lane**, plus `web-build` and `sync-sim`, carries `status: [success, failure]` and aliases `*code-path-globs` rather than `*code-paths`: a `when` entry's implicit `status: success` is a *pipeline-wide* condition, not a `depends_on`-scoped one, so without it any red step anywhere skips gates that have no dependency path to it — which is how `mobile-vitest` and `npm-licenses` went unrun for the whole time the mobile client had been in-repo (myne-md/myne#458). Every step in `.woodpecker/e2e.yml` but its notifier carries the same key for the same reason, and one further one: that workflow exists to produce a pre-release inventory, and a skipped gate in an inventory is worse than a red one. It is written there ONCE, as a YAML anchor, because a hand-copy is a second place to drift and losing the key is silent. Bypass with `git commit --no-verify` only when you understand why.

**Branch protection on GitHub is prepared, not installed, and the difference is a plan limit rather
than a decision.** The org is on GitHub `free`, and a PRIVATE repo on that plan carries no ruleset at
all: `POST /repos/myne-md/myne/rulesets` answers `403 Upgrade to GitHub Pro or make this repository
public` for `"enforcement": "active"` and for `"enforcement": "disabled"` alike, so staging them
switched off is not an available shape. What exists instead is the whole migration written down ahead
of the 403: `workspace/rulesets/*.json` holds the definitions, and `workspace/apply-branch-protection.mjs`
installs them on every repo in one idempotent command, skipping a private repo with its reason rather
than failing. Re-run that command the day a repo goes public. The definitions require **no** status
check and **no** approving review, both deliberately: GitHub receives no commit statuses from this
org's CI (it runs on the Forgejo mirror), and an author cannot approve their own PR, so either rule
would make every PR permanently unmergeable with nothing pointing at the cause.
`tests/scripts/branchProtection.test.ts` holds both, and `scripts/lib/branch-rulesets.mjs` carries the
reasoning. The one live proof today is `.github`, the only public repo: its ruleset is active there
and a direct push to `main` is refused, verified by removing the admin bypass and watching GitHub
reject the push.

**A flow no longer owes its E2E scenario in the same change** (decision `0780`). The owner writes
that coverage by hand, later, so a PR that adds a flow with no scenario is not rejected, and review
does not report it. The `data-testid` pass still belongs in the change (`src/AGENTS.md` "Test
observability"), because it is what makes a scenario possible at all.

**Which harness, when a scenario IS written.** There are two lanes and they do not mirror each
other: a flow in the **shared** `src/` tree gets ONE scenario from the tauri-driver suite at `e2e/`
and nothing from the web lane, because it is literally the same code; a **web-specific** behaviour
(capability gating, OPFS persistence, the single-tab lock, sync-required entry, crash recovery of the
double-buffered blobs) gets one in `e2e-web/`. Do **not** dual-drive the desktop suite against a
browser: the premise that lets one suite cover both clients is "same tree, only the seam differs",
and the seam contract tests (`tests/platform/seam-contract.ts`, run against every implementation in
both CI lanes) are what verify that premise, not a second run of every tauri-driver scenario file.
`agent-tooling/design-notes.md` 2026-07-26 "Web E2E policy".

**The manual half is the half no lane reaches**, and it no longer gates a commit. Most of the eight
client surfaces have no automated UI coverage: every desktop scenario runs in a Linux container
against WebKitGTK, and `e2e-web/` reaches the web client in Chromium. `scripts/manual-test-roster.mjs`
still records what a human must verify on the rest, and `/release` still generates the manual half
from it, but `scripts/check-manual-test-roster.mjs` no longer runs in `pre-commit` or CI, so a new
file under one of its six surfaces owes no verdict (decision `0780`). The roster is frozen at what it
recorded the day the gate came off, so an entry can name a file that moved and nothing reports it.

`pnpm` is the canonical package manager (Tauri's `beforeDevCommand`/`beforeBuildCommand` invoke it). Pinned versions: Node `.nvmrc`, Rust `rust-toolchain.toml`. **Do not bypass the pinning** — CI and reproducible-build rely on it.

JS tests run on **Vitest** (`pnpm test` → `vitest run`; config `vitest.config.ts` — standalone, it does not extend `vite.config.ts` — specs under `tests/**/*.test.{ts,tsx}`). The other lanes have configs of their own, and they live under `.config/vitest/` rather than at the root so the root reads as manifests + docs: `e2e.config.ts` (desktop E2E), `web-e2e.config.ts` (web E2E), `stories.config.ts` (story catalogue), `capture.config.ts` (user-guide screenshots), `ui-pass.config.ts` (per-PR UI screenshots, and `ux-fixes-capture.config.ts` the same shape for the 0.17.0 owner pass, with `mobile/ux-fixes-capture.config.ts` as its phone sibling). The **unit** config keeps the root filename on purpose: Vitest discovers `vitest.config.ts` by name, so every bare `vitest run` in this tree — `pnpm test`, `pnpm test:coverage`, the two `test:seam:*` scripts and CI's `pnpm exec vitest run tests/web tests/platform` — depends on it being exactly there. `scripts/check-update-channel.mjs` also reads it at that path. `tsc` via `pnpm build` is the typecheck; for Rust use `cargo test`. (Note: `tests/` is outside `tsc`'s `include: ["src"]`, so Vitest is the only check that exercises test files.)

Two jsdom facts worth knowing before designing a test around them, both measured rather than assumed (myne-md/myne#732, 2026-10-15). jsdom keeps `color-mix(...)` and `var(...)` VERBATIM in `style.background`, so a token-derived colour can be asserted as the string the code set rather than as a resolved rgb. And jsdom provides `PointerEvent`, so a press or hover test can render a real element and dispatch real pointer events instead of calling handlers by hand. Both were probed with a five-line script before the spec was written, which is the cheap version of finding out that the whole approach was vacuous.

## What lives where

```
myne/
├── agent-tooling/docs/                ← the contract itself (private companion): specs, threat model,
│                                       glossary, design canon, decision log. Not published from this repo
├── src/                 ← React UI, shared by the desktop and web clients; src/editor is a re-export shim into @myne/editor, src/dialect shims @myne/dialect PLUS desktop-side dialect code never extracted (clip.ts, clip/, html/, text/)
│   └── platform/        ← the platform seam: the ONLY place under src/ allowed to import @tauri-apps/*
├── web/                 ← Phase 3 desktop-browser client: same src/ tree, seam substituted at build time (pnpm web:dev / web:build)
├── mobile/              ← Phase 3 iOS + Android client (decisions.md 2026-08-13), moved in-repo from the myne-mobile companion, which was then deleted. Its OWN React tree under mobile/src, source-consuming ~25 @myne/* aliases into src/, editor/, dialect/, ornaments/ and locales/ — which is exactly why a repo boundary here was never real. pnpm workspace MEMBER (it keeps its package.json: it is a second Tauri app with its own tauri.conf.json and CLI invocations, unlike web/). Dev server :1422 — desktop holds :1420, web :1421
│   ├── src/platform/    ← mobile's own platform seam (myne#492): the ONLY place under mobile/src allowed to import @tauri-apps/*
│   ├── src/formfactor/  ← the iOS-vs-Android and phone-vs-tablet PRESENTATION split, renamed out of src/platform/ so <tree>/platform/ means the host seam in all three clients
│   └── src-tauri/       ← the mobile Tauri crate + its in-repo plugins (screen-guard, share-intent, save-file, qr-scan, reminders, sensitive-clipboard, device-key); the crate and every plugin are root-workspace members under the ONE Cargo.lock
├── src-tauri/           ← Tauri 2 + Rust desktop core
│   └── capabilities/    ← Tauri capability ACLs (security-load-bearing)
├── dialect/             ← @myne/dialect: shared markdown-parser source pkg (source-consumed, no build), desktop+mobile WebView
├── editor/              ← @myne/editor: shared CodeMirror engine; platform IO injected via the EditorHost seam (decisions.md 2026-07-05)
├── client-core/         ← @myne/client-core: the cross-client DECISION layer (myne#242). What desktop, web and mobile all answer identically, and which imports no host at all: a module may reach the host only through members a client INJECTS, and that amended criterion (`decisions/clients/0716`, which extends `0580`'s `seam: null`) is what lets one policy serve every client. Holds the Rust-error TS mirrors and the ONE design-token sheet all three clients import; both clients keep one-line re-export shims at the old paths. What it deliberately excludes: `src/lib/vault-*.ts`, seven of whose nine call `invoke` at module scope, and whose shared answer lives in `myne-core` behind a command instead
├── copy/                ← @myne/copy: load-bearing user-facing strings kept byte-identical across clients by construction (SYNC-42); deliberately outside i18n
├── ornaments/           ← @myne/ornaments: the shared ornament layer (myne#394) — the stylesheet a custom theme's ornament selections resolve against, plus the role helper a component declares through. Source-consumed by desktop, web AND mobile, so all three draw a theme's ornament identically by construction
├── preview/             ← @myne/preview: the theme-preview snapshot — the real editor's DOM + stylesheet, CAPTURED from the running app (e2e/capture/theme-preview.capture.ts), plus the one implementation of applying a palette to it. Consumed by the website's theme builder and the myne-themes gallery renderer, so a preview is Myne rather than an imitation of it. `src/preview.{html,css}` are artefacts — never hand-edit, re-run the capture
├── protocol/            ← Rust crypto crate
├── core/                ← myne-core: shared backend plugin cores + the host/IO/task seams; consumed by desktop, mobile AND the web wasm entry crate
│   └── src/inference/   ← the AI seam (myne#456): the Engine trait, the backend registry holding the ambient-vs-remote refusal, and the remote-provider arm. Behind the DEFAULT-OFF `remote-ai` feature, which desktop's `local-inference` implies and mobile enables directly: that chain is what keeps `cargo build -p myne-desktop --no-default-features` free of remote-provider code now that the files live in a crate compiling unconditionally
├── format/              ← myne-format: the on-disk-format crate (NC05 read path, MYB1 read half, the VaultIo trait, export-naming, the export walk). Native-only; consumed by desktop and the `myne-decrypt` CLI
├── decrypt/             ← myne-decrypt: the app-independent decrypter CLI (myne-md/myne#166). Exports a vault to plain markdown without the app installed
├── cli/                 ← myne-cli: the `myne` terminal client (MYND-490). Ships as a Tauri `externalBin` sidecar INSIDE the desktop bundle (staged by scripts/build-cli-sidecar.mjs, PATH shim by src-tauri/src/cli_bridge/path_shim.rs) and drives the running, unlocked desktop over its local command socket — it never opens the vault and depends on neither myne-core nor protocol
├── mcp/                 ← myne-mcp: the MCP front-end (external-mcp-connection, myne-md/myne#923). A Tauri `externalBin` sidecar (staged by scripts/build-mcp-sidecar.mjs, same PATH shim) that speaks MCP over stdio and answers `tools/list` from a compiled-in nine-verb schema — holds no key, opens no listener, and this slice reaches no vault
├── tor-sidecar/         ← myne-tor-sidecar: arti (Rust Tor) as a standalone loopback SOCKS5 proxy, shipped as a Tauri `externalBin` sidecar (MYND-650). NOTHING links it — the desktop spawns it as a subprocess when the device-local Tor routing option is on, which is exactly what keeps arti out of `myne-desktop`'s `cargo tree -e normal` closure and leaves the no-egress gate scanning a tree with no networked crate in it
├── theme-validator/     ← shared custom-theme value-shape allowlist — SECURITY-LOAD-BEARING: the WebView CSP carries style-src 'unsafe-inline', so a theme value that reaches the DOM executes. Desktop themes plugin and myne-themes marketplace CI run this exact crate so the grammar cannot drift (threat-model.md "Custom-theme CSS-value surface"; MYND-508)
├── tests/               ← Vitest unit/component specs; tests/platform/ holds the seam contract run against every seam implementation
├── e2e/                 ← tauri-driver desktop E2E suite + fixture-gen crate, fixtures and harness (pnpm test:e2e)
├── e2e-web/             ← browser-driven web E2E lane, deliberately thin: web-specific behaviour only (pnpm test:e2e:web)
├── scripts/             ← repo guards + dev tooling — see [`scripts/repo-guards.md`](scripts/repo-guards.md) for what each guard blocks
├── locales/             ← i18n catalogs, one directory per language; locales/en/common.json is the source of truth
├── packaging/           ← distro packaging (Arch PKGBUILD + .desktop entry)
├── public/              ← static assets bundled into the WebView
├── workspace/           ← multi-repo helper scripts + manifest
├── pnpm-workspace.yaml  ← pnpm workspace members (mobile, dialect, editor, copy, client-core, ornaments, preview)
├── Cargo.toml           ← workspace root; its `members` list is the source of truth (today: src-tauri, protocol, core, format, decrypt, cli, mcp, tor-sidecar, theme-validator, e2e/fixture-gen, web/wasm, web/bench/wasm, mobile/src-tauri + its in-repo tauri-plugin-* crates)
├── Cargo.lock           ← single shared lockfile (TB9 audit anchor). It became the mobile client's anchor too on 2026-08-13: mobile shipped from a SECOND lock in which 62 of 572 shared crates had drifted, `bitcoin_hashes` under `bip39` among them
├── rust-toolchain.toml  ← pinned Rust toolchain
├── package.json         ← pnpm + Vite + React 19 + TS toolchain
└── vite.config.ts       ← Tauri-aware Vite config
```

**Companion repos** (clone via `./workspace/setup.sh` reading `workspace/manifest.txt`, which is the list): `myne-test-vectors/`, `myne-server/`, `myne-website/`, `operations/`, `agent-tooling/`, `myne-pi-plugin/`, `myne-clipper/`, `myne-themes/`, `myne-branding/`. Two more are on disk and deliberately **not** cloned by that script, because each documents a direct push to its default branch as its normal workflow: `internal-service/` (the adversarial range) and `homebrew-tap/`. (`myne-web` and `myne-mobile` are **not** in this list: both clients are in-repo targets — `web/` and `mobile/`. `myne-web` is archived; `myne-mobile` was **deleted**, so its 18 closed issues and its v0.1–v0.4 release binaries are gone and every `myne-mobile#NN` reference left in code comments is a dead link kept only as provenance. `decisions.md` 2026-07-26 and 2026-08-13.) Each is a separate GitHub repo under [`myne-md`](https://github.com/myne-md) — **never commit changes to them through this repo**. Each carries its own AGENTS.md (lazy-load when you enter it).

## Repo guards (what blocks a commit, and what blocks CI)

Most of `scripts/` is not tooling — it is the machine-checked half of the rules this file states in prose. Each guard exists because the failure it catches is invisible to every compiler: a TS string literal that no `match` arm answers, a `std::fs` call that compiles for wasm32 and dies at runtime, a value in the served bundle that should not be there. They are zero-dependency and hand-runnable (`node scripts/<name>.mjs`, `bash scripts/<name>.sh`); every one carries a header comment explaining the failure it prevents, which is the thing to read when it fires.

**This file carries no hand-typed counts.** A number written here has no maintainer: it describes the tree on the day somebody measured it, nothing re-measures it, and it fails silently because the prose keeps reading as authoritative. `check-i18n-coverage.mjs`'s own row records the worked example: two sentences in this repository said the locale set was complete, hundreds of keys were missing from every catalog, and nothing contradicted either sentence for three weeks because nothing measured it. So name the roster, the guard, the command or the path instead, and let a number appear only where the guard itself prints it and a reader is expected to compare against it. **When one here has drifted, delete it rather than correct it**: a corrected number is a fresh promise with the same missing maintainer, and this file's counts have been wrong three separate times (`e2e` files, the scenario floor, the plugin directories) inside the same round that found the drift.

The full table, one row per guard with the failure it prevents and where it fires, is [`scripts/repo-guards.md`](scripts/repo-guards.md). The compact index below is the roster; the guard's own header is the authority when it fires.

| Guard | Blocks, in one line | Fires in |
|---|---|---|
| `check-platform-seam.mjs` | nine guarded roots, each importing `@tauri-apps/*` only from its own seam directory or… | `pre-commit` + CI `pnpm-build` |
| `check-plain-surface-imports.mjs` | denylist: no `.ts`/`.tsx` file under `src/plain/` imports a vault-coupled module… | `pre-commit` + CI `pnpm-build` |
| `check-core-task-seam.mjs` | `crate::task` is the only place in `core/` reaching tokio's *execution* surface… | `pre-commit` + CI `pnpm-build` |
| `check-core-io-seam.mjs` | filesystem ratchet: a `core/src` file not on the recorded list may not start using… | `pre-commit` + CI `pnpm-build` |
| `check-version-routing.mjs` | ratchet: a reader may not reach for a v0.1-only helper (`parse_vault_meta`… | `pre-commit` + CI `pnpm-build` |
| `check-crypto-registries.mjs` | the four registry chokepoints the crate does correctly by hand and no compiler can hold… | `pre-commit` + CI `pnpm-build` |
| `check-web-command-coverage.mjs` | every `plugin:<x>\|<y>` literal in the shared tree is classified in… | `pre-commit` + CI `pnpm-build` |
| `check-web-capabilities.mjs` | the UI's capability descriptor and the dispatcher's refusal table agree (disagreement is… | `pre-commit` + CI `pnpm-build` |
| `check-prefs-nonce.mjs` | every `vault.prefs` write goes through `writePref` (the one path that bumps the prefs… | `pre-commit` + CI `pnpm-build` |
| `check-device-actor.mjs` | ONE reader of "which device is this": the two records that answer it (`sync-state.json`, `person-auth.json`) are read only in `core/src/plugins/sync/device_actor.rs`, and every other `.device_id_hex` site is recorded with a reason, so a second reader fails the commit | `pre-commit` + CI `pnpm-build` |
| `check-unwired.mjs` | ratchet: every module under `web/src`, `src/lib`, `src/hooks`, `src/notes`… | `pre-commit` + CI `pnpm-build` |
| `check-lock-teardown.mjs` | a client that HOLDS a plaintext-derived RAM state for the process lifetime may not leave… | `pre-commit` + CI `pnpm-build` |
| `check-ipc-binding-callers.mjs` | ratchet: every exported TypeScript binding that wraps a `plugin:<x>\|<y>` invoke has a… | `pre-commit` + CI `pnpm-build` |
| `check-frontend-lock-teardown.mjs` | the WebView half of `check-lock-teardown.mjs`, which held only the Rust side | `pre-commit` + CI `pnpm-build` |
| `check-datetime-display-publisher.mjs` | a client tree that READS the shared date/time display store… | `pre-commit` + CI `pnpm-build` |
| `check-mobile-export-backup.mjs` | the mobile plaintext-export directory stays out of the platform's automatic cloud backup… | `pre-commit` + CI `pnpm-build` |
| `check-mobile-plugin-acl.mjs` | every `<plugin>:default` grant in `mobile/src-tauri/capabilities/default.json` resolves… | `pre-commit` + CI `pnpm-build` |
| `check-embed-layout-drift.mjs` | the form-C embed-layout grammar's one shared numeric bound (`MAX_EMBED_DIMENSION_PX`)… | `pre-commit` + CI `pnpm-build` |
| `check-update-channel.mjs` | the update channel has ONE endpoint, ONE variable name and ONE manifest file name per… | `pre-commit` + CI `pnpm-build` |
| `check-published-manifests.mjs` | the PUBLISHED half of the same rule, and the one that answers about the origin rather… | by hand (network) |
| `check-clipboard-feedback.mjs` | two rules over every shared tree: no raw WebView clipboard API outside… | `pre-commit` + CI `pnpm-build` |
| `check-tracing-discipline.mjs` | the diagnostic log's content claim, made a mechanism (myne-md/myne#860) | `pre-commit` + CI `pnpm-build` |
| `check-e2e-menu-testids.mjs` | E2E may not reach for a testid that renders only inside the sidebar's open `+` menu, it… | `pre-commit` + CI `pnpm-build` |
| `check-e2e-toolchain.mjs` | `e2e/Dockerfile`'s Rust version matches `rust-toolchain.toml`'s `channel`, and the image… | `pre-commit` + CI `pnpm-build` |
| `check-playwright-image.mjs` | the CI Playwright image tag names the version `pnpm-lock.yaml` resolves for… | `pre-commit` + CI `pnpm-build` |
| `check-pinned-ci-tools.mjs` | every `/cache/tools/bin/<tool>` a workflow or `scripts/ci-e2e-lane.sh` executes is provisioned at a pinned, hash-verified version by `scripts/ci-pinned-tools.sh` first: a new unpinned tool, a step that executes without provisioning, a pin whose version/URL/digests drifted apart, and a pin nothing references each fail, and a reach back to the read-only `/cache/bin` mount is refused by name | `pre-commit` + CI `pnpm-build` |
| `check-arch-pkgbuild.mjs` | the two Arch recipes and `flake.nix` state one release version, and the from-source recipe pins a `#commit=` rather than a movable tag; `sha256sums=('SKIP')` is refused on anything that is not a commit-pinned git source | `pre-commit` + CI `pnpm-build` |
| `check-ci-image.mjs` | the prebuilt CI base image (`ghcr.io/myne-md/myne-ci`, myne-md/myne#585) against the… | `pre-commit` + CI `pnpm-build` |
| `check-e2e-floor.mjs` | two ratchets over one report, and they hold each other up | CI `e2e-floor` |
| `check-twin-inventory.mjs` | every desktop/mobile twin module carries a verdict (`decision` / `screen` / `absent` /… | `pre-commit` + CI `twin-inventory` |
| `check-fdroid-metadata.mjs` | the F-Droid store metadata against the Android build it describes, which is three… | `pre-commit` + CI `fdroid-metadata` |
| `check-store-publishable.mjs` | a publishable store root may hold only frames whose surface a mobile user can reach (Apple 2.3.1, Play's equivalent), and every PNG in one is a frame the plan writes… | `pre-commit` + CI `pnpm-build` |
| `check-store-frame-identifiers.mjs` | no store frame may carry an identifier that is not pinned; it scans the screens the story renders and `captions.en.json`, whose text is drawn onto the frame… | `pre-commit` + CI `pnpm-build` |
| `check-store-set-freshness.mjs` | a committed store set that no longer matches its append-only record fails; a re-render comparison warns… | `pre-commit` + CI `pnpm-build` |
| `check-duplication.mjs` | ratchet, over the TREE rather than the diff: renamed copies matched by a normalised skeleton, plus the cheapest signal — one unexported local name defined in three files (`FieldLabel` was 11) — with `scripts/duplication-groups.json` carrying a verdict per group (`consolidate`/`justified`+reason) and a baseline that `--emit` may only re-baseline DOWNWARD… | `pre-commit` + CI `duplication` |
| `check-prefs-parity.mjs` | every Rust prefs command in `core/src/plugins/prefs/commands.rs` carries a per-client… | `pre-commit` + CI `prefs-parity` |
| `check-twin-drift-ratchet.mjs` | ratchet: the recorded SET of twin pairs that differ SEMANTICALLY may shrink, never grow | `pre-commit` + CI `pnpm-build` |
| `check-twin-drift.mjs` | warns (never fails) when a change touches one side of a twin module pair and not the… | `pre-commit` + CI `pnpm-build` |
| `check-i18n.mjs` | no empty English source value in `locales/en/common.json`; every static `t("…")` key in… | `pre-commit` + CI `pnpm-build` |
| `check-i18n-coverage.mjs` | what the row above leaves out by design, which is why it is a second script rather than a… | `pre-commit` + CI `i18n-coverage` |
| `check-copy-budget.mjs` | two one-way ratchets over the catalogue: a key outside `common.*` may not carry a value `common.*` already owns unless `scripts/copy-budget.json` records it with a reason, and a settings surface may not render more English copy than its recorded total… | `pre-commit` + CI `pnpm-build` |
| `check-npm-licenses.mjs` | the npm analogue of `cargo-deny`: every transitive npm license is on an allowlist… | CI `npm-licenses` |
| `gen-third-party-licenses.mjs` | the ship notice rather than the allowlist: `public/THIRD-PARTY-LICENSES.txt` is generated… | CI `pnpm-build` |
| `check-private-path-refs.mjs` | ratchet: the set of files under `agent-tooling/docs/`, `src/` or `mobile/src/` that name a path into a… | `pre-commit` + CI `pnpm-build` |
| `check-server-env-roster.mjs` | the sync server's environment-variable roster: every variable `myne-server` reads must be… | `pre-commit` (local only) |
| `check-selfhost-bundle-drift.mjs` | the self-host bundle's three files must agree about what a self-hoster can set: the… | `pre-commit` (local only) |
| `check-web-image-tag-drift.mjs` | the web client's image tag names ONE release across the three places that carry it: the… | `pre-commit` (local only) |
| `check-clipper-wire.mjs` | the clipper's WIRE VOCABULARY, which is written in two repositories and was read by… | `pre-commit` + CI `pnpm-build` |
| `check-stream-timeout-drift.mjs` | the sync stream's DEADLINE, written once per repository (audit Aşama 6 B1+B2): the… | `pre-commit` (local only) |
| `check-branding-parity.mjs` | the app token sheet is the source for its THREE companion projections (audit Aşama 6… | `pre-commit` (local only) |
| `check-referenced-digests.mjs` | the one guard here that needs the NETWORK, and that is why it is pre-commit and not CI (a… | `pre-commit` (local only) |
| `check-cli-sidecar.mjs` | the `myne` CLI's duplicated-by-design contract with the desktop: bundle identifier +… | `pre-commit` + CI `pnpm-build` |
| `check-mcp-tool-surface.mjs` | the compiled MCP tool list stays a constant expression over string literals and names no capability outside the vault (no fetch, HTTP, URL, mail, shell, clipboard, attachment); it reads `mcp/src/tool_list.rs` rather than prose | `pre-commit` + CI `pnpm-build` |
| `check-clipper-identifiers.mjs` | the browser clipper's three load-bearing identifiers, across four files and two… | `pre-commit` |
| `check-npm-license-mirror.mjs` | the npm allowlist in `check-npm-licenses.mjs` claims, in a comment, to mirror… | `pre-commit` |
| `check-adversary-coverage.mjs` | the internal-service epic's anti-rot binding (myne-md/myne#553), in THIS repo so it cannot go… | `pre-commit` + CI `pnpm-build` |
| `check-ornament-vocabulary.mjs` | the ornament vocabulary agrees across all THREE sources… | `pre-commit` + CI `pnpm-build` |
| `check-token-parity.mjs` | the opposite question from `check-token-adoption.mjs` below, and the two together are the… | `pre-commit` + CI `pnpm-build` |
| `check-comment-density.mjs` | ratchet: the recorded per-file comment count may shrink, never grow, so AGENTS.md rule 3 has a mechanism instead of an intention | `pre-commit` + CI `pnpm-build` |
| `check-token-adoption.mjs` | ratchet: the per-file count of hardcoded visual values (colour literals, numeric… | `pre-commit` + CI `pnpm-build` |
| `check-primitive-adoption.mjs` | ratchet: a raw `<button>`, `<input>`, `<select>` or `<textarea>` outside… | `pre-commit` + CI `pnpm-build` |
| `check-hex-helpers.mjs` | ratchet, two halves. The ENCODER half: the lowercase-hex encoder and its predicate are… | `pre-commit` + CI `pnpm-build` |
| `check-token-consumers.mjs` | a motion or type token is READ somewhere | `pre-commit` + CI `pnpm-build` |
| `check-desktop-payload-budget.mjs` | ratchet: the desktop bundle's *declared* payload, every path in `bundle.resources` (plus… | CI `pnpm-build` |
| `check-preview-freshness.mjs` | warns when the captured theme-preview snapshot (`preview/src/`) no longer depicts the… | `pre-commit` + CI `pnpm-build` |
| `check-story-coverage.mjs` | ratchet: every component and screen in the shared tree has a story in the catalogue, and… | `pre-commit` + CI `pnpm-build` |
| `check-story-catalogue.mjs` | every story carries a `description` and at least one `tag` (search matches against them… | `pre-commit` + CI `pnpm-build` |
| `check-foundations-coverage.mjs` | ratchet: every token in `client-core/src/tokens.css` is classified by a specimen group… | `pre-commit` + CI `pnpm-build` |
| `tests/stories/a11yLevels.test.tsx` | the catalogue's accessibility GATE | `pnpm stories:test` / CI `vitest` |
| `check-woodpecker-substitution.mjs` | no single-dollar brace-substitution token in ANY Woodpecker workflow file, comments… | `pre-commit` |
| `check-woodpecker-split.mjs` | the ONE contract the two workflow files duplicate by design: the desktop release build's… | `pre-commit` + CI `pnpm-build` |
| `scripts/lib/woodpecker-configs.mjs` (the roster behind both, plus `check-playwright-image.mjs`) | the one place that knows the CI config is `.woodpecker/`, imported rather than copied… | `pre-commit` |
| `check-ignored-tests.mjs` | an `#[ignore]` in `core/` whose reason claims a defect is outstanding is a DEFERRAL, and… | `pre-commit` + CI `ignored-tests` |
| `check-test-typecheck.mjs` | ratchet: the per-file count of type errors in the trees `tsconfig.json` deliberately… | CI `pnpm-build` (no local hook) |
| `hooks-parity-check.sh` | CI backstop for the pre-commit checks that are otherwise `--no-verify`-bypassable: SPDX… | CI `hooks-parity` |
| `check-bundle-record.mjs` | the published-bundle-hash record is append-only (`--append-only`), and a deploy may only… | CI `bundle-record`; `--has` by hand |
| `wasm-csprng-check.sh` | `protocol` builds for `wasm32-unknown-unknown` and its `getrandom` hook stays *undefined*… | CI `wasm-protocol` |
| `wasm-core-graph-check.sh` | `myne-core`'s dependency graph resolves for wasm32 (the walls are in the graph, before… | CI `wasm-protocol` |
| `wasm-repro-check.sh` | the wasm artefact rebuilds byte-identically (double build, `wasm-bindgen-cli` version… | CI `wasm-protocol` |
| `check-web-third-party.mjs` | zero third-party origins in the web bundle | CI `web-build` |
| `check-web-no-test-hooks.mjs` | no production test hooks in the served bundle (a hook a scenario can call is a hook any… | CI `web-build` |
| `check-web-bundle-budget.mjs` | first-load size ratchet, measured from a real build rather than invented | CI `web-build` |
| `check-web-screens.mjs` / `check-web-surfaces.mjs` | every screen, and every `src/components/settings/`, `src/lib/`, `src/hooks/` module… | CI `web-build` |
| `check-web-testids.mjs` | every web-only rendering module has a testid, named `<screen>.<element>`, and no `data-*`… | CI `web-build` |
| `check-web-container-headers.sh` | the container actually *serves* its security headers and operational endpoints (config… | CI `web-container-check` |
| `check-web-wasm-freshness.mjs` | the browser lane's wasm artefact was built from the Rust that is on disk now, not from an older tree: `pnpm web:build` BUNDLES `web/wasm/pkg` and does not produce it, so a `cargo` change is invisible to the lane and a green run describes an older binary | the web E2E runners (`scripts/e2e-web-local.sh`, `scripts/e2e-web-one.sh`) |
| `web-smoke.sh` | post-deploy, against the public TLS origin: the right commit shipped and the right sync… | by hand (deploy runbook) |
| `check-icons.mjs` | icon variants exist at the right dimensions, `bundle.icon` is coherent, no Tauri-default… | CI `pnpm-build` |
| `check-macos-dmg.mjs` | a built `.dmg` really carries its install chrome, `Applications` drop target, background… | by hand (release, macOS) |
| `src-tauri/scripts/ai-no-network-check.sh` | the AI egress gate, and the file name is a misnomer it keeps on purpose (read its header… | CI `ai-no-network` |

**Verifying a guard means breaking it, not running it.** Every guard in that table claims to catch something, and a guard that has never failed is a guard nobody has tested. Three consecutive reviews of one feature found a check that passed while the thing it checked was wrong — a matrix compared in one direction while the success line claimed two, a roster compared against a second copy of itself, a filter named in a test title and never exercised. In each case the check had just been *fixed*, and the fix was "verified" by the check passing afterwards, which proves nothing. **Inject the exact defect the guard now claims to catch, watch it name that defect, then restore.** It costs a minute and it is the only evidence that means anything.

**And an anti-drift assertion has to be scoped to the artifact it names.** The failure this catches is one step past the paragraph above, and injection is the only thing that finds it: a test written to hold two copies of a value together, over a file that contains that value TWICE, cannot fail on the drift it exists for. `expect(css).toContain(NEUTRAL_PRESS_BG)` was green while the button's own copy was edited, because an unrelated rule further down the sheet still carried the old string. The fix is to slice the sheet to the rule's own section and assert the value appears there exactly once, and the way to know it is the fix is to inject the drift and watch the test go red: myne-md/myne#732's 2026-10-15 review found this by injection, in the change whose stated thesis was removing one-value-two-places.

**An `#[ignore]` that names a defect is a deferral, and a deferral with no issue is a note.**
`agent-tooling/design-notes/security/0614-unfixed-security-findings-ship-as-ignored-invariant-tests.md` states
the convention: when a verification pass establishes a security defect whose fix is not available in
the same change, the test asserts the **invariant** and carries `#[ignore = "unfixed: … see
<issue>"]`. `cargo test` stays green; `cargo test -- --ignored` is the standing record of what is
not fixed, and the day the fix lands the test is un-ignored and goes green. Three things follow
that the convention does not state on its own, and all three have been got wrong here:

- **Do not ship a test that asserts the DEFECT and passes.** It certifies the defect as intended
  behaviour, so every fix is gated on rewriting the test that documents it, and the first person
  to fix it concludes they broke something. That shape is a regression to the *previous* state of
  this file, and review caught it.
- **The reason must name an issue that is still OPEN.** Pointed at the issue the change closes, it
  reads on merge as an oversight rather than a deferral. `scripts/check-ignored-tests.mjs` holds
  that, and the roster, and the "says what is missing" half.
- **A right direction is not a working fixture.** A test whose fixture cannot reach the defective
  state passes with the defect present, which reads as rigor. The Tag-block carve-out in
  `core/src/plugins/memory/commands.rs` shipped that way twice: the fixtures spelled England's flag
  as `gb` and Wales' as `wls`, and the "smuggled payload" case put its payload in plain ASCII so a
  different arm caught it. Only injection tells the two apart.

**A guard that WRITES its own record has a second half nobody verifies: the seeding path.**
`--record` and `--emit` exist so a ratchet can be re-baselined, and the entry they write has to be
rejected by the same guard until a human replaces it. `check-ipc-binding-callers.mjs` seeded every
fresh entry with the string `REASON REQUIRED`, and its reason check rejected anything under twelve
characters. That string is fifteen. So the tool's own placeholder passed the tool's own gate, seven
entries sat in the record saying in words that their reason was missing, and the tree was green.
Nothing catches this: injecting the defect the guard checks FOR still passes, because the defect is
in the half that writes rather than the half that reads. Ask the other question instead: run
`--record` on a dirty tree and check that the guard then FAILS. A re-baseline that comes back green
is a re-baseline that licensed everything it found.

**Editing a guard is one of those changes, and the exemption logic is where it bites.** A guard fix
verified by "the tree is still green afterwards" is the same non-evidence as any other, because a
guard that has stopped checking is green by definition. myne-md/myne#411 corrected
`check-core-io-seam.mjs`'s `#[cfg(test)]` tracker, ran the tree, saw green, and shipped a version
that reported nothing for a production `std::fs::read` the pre-fix guard caught: closing one blind
spot opened another, one line away. Both directions have to be injected, and the second one is the
one nobody thinks to try: prove the guard still catches what it caught BEFORE, not only what it
missed.

- **`cargo check --no-default-features` never compiles test code, so the AI-free gate is blind to a
  dead-code break in a test-only helper.** `cargo check` without `--all-targets` skips `#[cfg(test)]`
  entirely, so a helper gated `#[cfg(test)]` whose only caller sits behind a feature is dead when that
  feature is off, and only a `--all-targets` clippy sees it. myne-md/myne#510 shipped exactly that for
  one review round, because the `--no-default-features` gate in `.woodpecker/main.yml` was a bare
  `cargo check`. The same change closed it: that step now also runs
  `cargo clippy -p myne-desktop --all-targets --no-default-features -- -D warnings`, so CI covers this
  and there is nothing left to run by hand. The paragraph is kept rather than deleted because the
  REASON is what generalises: any gate spelled `check` rather than `clippy --all-targets` is blind to
  the test tree, and this repository has more than one.
  Gate such a helper on the FEATURE its caller needs rather than on `cfg(test)`, and run that clippy
  line by hand when a change adds one. Gating on the feature has a second payoff: the caller can then
  leave the test module, so a `const _: () = assert!(...)` comparing two duplicated constants runs on
  every build rather than only under `cargo test`.

- **A signature change in `core/` is a two-client change, and `clippy -p myne-core` is not the gate
  that sees it.** `myne-mobile` compiles the same crate (`mobile/src-tauri/Cargo.toml` enables
  `remote-ai` itself), so an added parameter on a `core/` method breaks the mobile crate while the
  core crate, the desktop crate and every JS test stay green. myne-md/myne#970 shipped exactly that:
  `ProviderTransport::get_json` grew an `extra_headers` argument, only
  `src-tauri/src/plugins/local_inference/commands.rs` was updated, and
  `cargo clippy --workspace --all-targets -- -D warnings` exited 101 on `myne-mobile` (E0061) while
  the branch's own test suites passed. Run the workspace-wide clippy, not `-p`, whenever a `core/`
  or `protocol/` signature moves, and treat "the mobile crate is a separate tree" as the reason it
  is easy to miss rather than as a reason it is safe to skip.

- **`check-prefs-nonce.mjs` matches the IPC LITERAL, so a doc comment that quotes one turns the
  guard red.** The rule is textual (`plugin:prefs|<command>` outside `PREFS_MODULES`), which is what
  makes it work on a tree it has never seen; the cost is that prose is scanned as if it were code. A
  comment explaining why a component refuses to write a pref, quoting the command name to be
  precise, reports as "invokes a prefs write from outside a prefs module" and fails
  `tests/lib/prefsNonce.test.ts`. Describe the write in words ("the prefs write command for this
  field") instead of pasting the literal, and if the guard fires on a file you only documented, the
  fix is the comment rather than the guard.

**A fixture that cannot hold the defective state is not a test, and injection alone does not
catch that.** The rule above says to inject the defect and watch the guard name it. That leaves one
way for a test to be vacuous and still look rigorous: the injection lands, the test passes anyway,
and the reason is that the fixture never reached the state the defect needs. myne-md/myne#613 shipped
it twice in one afternoon, in tests written for the same finding. The first built its fixture by
running the FIXED code, so the over-cap blob the defect requires was never constructed. The second
asserted the invariant directly, but on a view that starts EMPTY, where the term the injection
removes is zero by definition, so the injected line was never consulted. Both passed with the fix
reverted. The question to ask of a fixture is not "does this exercise the code" but "could this
input be wrong in the way the code is meant to prevent", and only the injection answers it: a
revert-and-run that STILL passes is the finding, not a formality to tick.
- **`Cargo.lock` is single-shared at workspace root** (TB9 audit anchor). Do not split into per-crate locks.
- **Vite `strictPort: 1420`** — `pnpm dev` fails fast if port taken; this is intentional (Tauri expects exact port).
- **Vite `clearScreen: false`** — keep it; otherwise Rust errors get hidden during `pnpm tauri dev`.
- **`web/vite.config.ts` is in no `tsconfig`, so `tsc` never sees it.** `tsconfig.node.json` includes
  only the ROOT `vite.config.ts`, and `web/tsconfig.json` includes `["src", "../src"]`, so an edit to
  the web build config that does not typecheck is caught by nothing: `tsc -p web/tsconfig.json`
  neither includes nor builds it, and Vite loads it through esbuild, which transpiles without
  checking. An `@ts-expect-error` in that file is therefore inert in both directions.
  `tests/web/dev-deployment.test.ts` is the only thing holding its dev deployment facts.
- **A Vite dev server binds `localhost`, which on macOS resolves to `[::1]` alone, so a port probe on
  `127.0.0.1` reports CLOSED for a server that is up.** `scripts/dev-web.sh` probes its own client on
  `localhost`, and the Go sync server on `127.0.0.1` because that one really is bound there. The
  failure this produces is a check that silently never fires, which reads exactly like a check that
  passed (myne-md/myne#873).
- **AGENTS.md HTML comments are stripped** before injection. Block comments (`<!-- ... -->`) outside code blocks vanish silently. Use code blocks if you need a literal comment.
- **`String.replace`'s replacement STRING expands `$1`, `$&`, `` $` `` and `$$` — which defeats a quote sanitizer placed before it.** A theme value of `$1 onload=…` filtered clean of `["'<>]` still expanded to the captured group, whose own quote closed the attribute it was being interpolated into and landed a live event handler. `$` cannot be filtered (a legitimate CSS value may contain one), so the fix is a replacer **function**, to which no `$` sequence means anything. Any `replace(re, `…${untrusted}…`)` has this shape; `myne-themes/tools/render-preview.mjs` carries the worked example.
- **`git add -N` to widen a diff leaves a zero-byte index entry behind, and deleting the file does not clear it.** Intent-to-add is how you get new files into `git diff HEAD` so a review or a guard can see them, and it is the right tool for that. What it also does is stage an empty blob (`e69de29`) for each path. Delete or rename such a file afterwards and the entry survives in the index while `git status` shows only ` D`, so a plain `git commit` lands an empty file named after work that moved elsewhere, and `git diff HEAD` shows neither the path nor the problem. The mirror-image failure costs more: a file created AFTER the `add -N` is untracked, so it is absent from that same diff, and a commit lands the imports that reference it without the module itself, with `pre-commit`'s `tsc` green because it reads the working copy rather than the index. Both shapes landed together on one branch. `git ls-files --stage | grep e69de29` finds the first, `git status --porcelain | grep '^??'` the second, and both are worth a look before any commit that followed an `add -N`.
- **A cancelled subagent leaves the tree exactly as dirty as its last command, and a reviewer that ran an injection leaves it reverted.** `/pr-review` reviewers are told to prove a finding by injecting the defect and restoring it, and a reviewer that is cancelled mid-experiment (the batch was killed to save wall clock on a long review) never gets to the restore. What is left is a file reverted to the pre-fix state, with every test that measured the fix still green in the report because they were measured before the cancel, and nothing in the working tree saying so: `git status` shows the file as modified, which is what it looked like when the reviewer started. The dimension reviewers caught it here (both `mountZoom` call sites reading as still on the old wheel mode, against a source file the session had edited an hour earlier), but only because the tree happened to be read fresh rather than trusted. Two cheap habits close the class: after any cancelled or interrupted subagent, `git diff` the files that reviewer was pointed at before believing any green result, and let `/done` Gate 2's read of the staged diff be the last word on what the commit contains. The lesson generalises past reviewers: any subagent permitted to edit the shared tree is permitted to be interrupted mid-write, and "the tests passed" is a claim about a moment, not about the bytes that get committed.
- **A listener added to a container the CALLER owns outlives the component that added it, and the
  second copy of it is the one that bites.** `editor/src/task-field-editor.ts` binds its Enter
  handler in the docked (split) shape to the element the controls live in, which for a sheet is the
  caller's body: the editor's own `close()` removes the controls and the actions row, never that
  listener, and the task-field wizard reuses ONE body across its steps. So every open/Back/open cycle
  left a handler closing over a dead body and a dead commit, and one Enter wrote the ABANDONED
  field's seeded value as well as the live one (`- [ ] call mum [priority:: medium]` appearing from a
  step the user had backed out of). Nothing sees it: it compiles, the specs that exercise the sheet
  never press Enter, jsdom computes no layout, and no lane renders the docked host but a phone, so
  the corruption is silent. Bind to a node the component created and removes (`body.root` here) and
  let the caller's own controls own their own Enter. The general shape is wider than dialogs: any
  listener, observer or timer attached to something you do not own needs an explicit teardown, and
  the deletion of the component is not it.
- **A shared stylesheet may not scope a surface's chrome on an element that one of its shapes never
  mounts.** `editor/src/task-surfaces.css` scopes every field control's skin through
  `.cm-task-field-editor` (the calendar days and their selected state, the time spinbox, the select
  trigger, the shared input skin and the focus ring) and `editor/src/floating-styles.ts` adds the
  docked reset with the same prefix. In the docked split shape that element is deliberately NOT
  appended, because the caller supplies the card, so every one of those rules was dead inside the
  sheet: the controls rendered unstyled and the chosen calendar day showed no selection. The
  failure is invisible to the whole tree in the same way the listener above is, since a value bound
  by an ancestor that is never mounted is as unreachable as a hardcoded literal but reads as
  ordinary CSS. When a component gains a second mount shape, mount the scoping element in it too (a
  plain wrapper) or re-scope the rules onto a class the new shape does carry, and assert the wrapper
  where a unit test can see it.
- **A sink that resolves on a refused write makes the surface above it lie, and the lie compounds.**
  The desktop field binding deliberately caught a `TaskWriteRefused`, warned, and returned (the
  behaviour the review then removed), which is right
  for a checkbox (a box that does not move is self evident) and wrong for a field editor: the
  surface above it holds its own copy of the line so that a second edit in the same session can pass
  the writer a line that still matches disk, and the swallowed refusal made that copy advance to
  bytes that were never written. The menu then showed "Edit due date" for a field the note did not
  carry, and every later edit in it was refused `line-changed` and swallowed in turn. Two rules
  follow. A refusal is not an error to be silenced at the boundary; if the surface needs to know, the
  boundary must let it through (the wizard's own commit handler catches it, so nothing escapes as an
  unhandled rejection). And a surface that keeps a local copy of remote state owes it a way to learn
  that the write did not land, or it will report a value nobody can find on disk.

- **`lefthook run pre-commit` must be run on a FULLY staged tree, because it builds a patch with `git diff --output <file> --` and that invocation fails on the git shipped by this Mac's CLT.** With a partially staged tree the command exits 128 with `Not a git repository`, lefthook reports it as a hook failure, and the message names neither git nor the staging state, so it reads as a lint bug in whichever hook happened to print last (myne-md/myne#945 spent a turn on it). Stage everything first (`git add -A`, then unstage anything that must not be committed) or run the individual guards by hand. The commit itself is unaffected: `pre-commit` runs against the index, so a partial commit still checks the right files.
- **`vitest run --root mobile` is not the mobile test lane.** `mobile/` is a pnpm workspace member with its own `vitest.config.ts`, and `--root` makes Vitest resolve the ROOT config instead, so environment, setup files and aliases all come from the wrong place: five suites fail on `document is not defined` and on unresolvable `@myne/*` imports, which reads as broken tests rather than a broken invocation. Use `pnpm --filter myne-mobile test` (the `mobile:test` script does the same thing) and treat any `--root` spelling as the bug.

- **Tauri lib must keep `_lib` suffix** (`myne_desktop_lib`) to avoid Windows lib-vs-bin collision (rust-lang/cargo#8519). See `src-tauri/AGENTS.md`.

## Cryptographically load-bearing identifiers

> Restored in the merge of myne-md/myne#577. This section was dropped when this
> file was restructured, and two references to it survived in `agent-tooling/docs/AGENTS.md`,
> which still calls the table here **normative** and points `protocol.md` editors
> at it. Nothing else in the tree publishes these values, and
> `scripts/check-clipper-identifiers.mjs` (myne-md/myne#558) gates the last three
> rows against it: an extension ID that drifts from the table fails no build on
> either side, and the user sees "clipping does nothing" with no error anywhere.

**The Phase 3 web client adds nothing to this table and removes nothing from it** — it runs the same `protocol/` crate compiled to wasm, reads and writes byte-identical blobs, and introduces no magic, AAD prefix, HKDF context or subkey role of its own. Its only on-disk divergence is the *container layout* around those blobs in OPFS (`decisions.md` 2026-07-26), which is not an identifier.

Identifiers and constants whose change is a major-version event. Most are bound into AEAD tags or magic-byte checks; some (e.g. the account-number display prefix, the Damm-32 table) are load-bearing through account identity or presentation rather than an AEAD/magic boundary — the mechanism is noted per row.

**Read the table as a pointer, not as a registry.** The two per-role registries — subkey context strings (`protocol.md` §3.4, mirrored in code by `SubkeyRole::ALL`) and AAD role strings (§5.2) — are complete and normative *there*, and every registered role in them is a major-version-event constant. They get **one** row below instead of one row per role, so shipping a new role never owes this table an edit. That is deliberate: the per-role rows this table used to carry had fallen behind the registries while still reading as exhaustive — `itemsKey-wrap`, the KEK at the root of every note's key lineage, had no row at all — which is the failure mode a partial copy always has. Every other row below is an identifier that belongs to no registry and so has nowhere else to live:

| Use site | Value |
|---|---|
| AAD prefix (every AEAD tag) | `"myne.v0.1\|"` (10 ASCII bytes; `protocol.md` §5.2) |
| HKDF context-string prefix | `"myne.v0.1 "` (note trailing space; §3.2) |
| Subkey context strings + AAD role strings (**all of them**) | Frozen registries, complete and normative in `protocol.md` §3.4 (subkey roles — `SubkeyRole::ALL` is the machine-readable mirror, and the companion vectors iterate it) and §5.2 (AAD role strings). Changing a registered role silently derives a different key or computes a different tag on every existing vault. Do not restate individual roles here. |
| Salt domain prefix (password) | `"myne.v0.1 argon2id-password\|"` |
| Salt domain prefix (recovery) | `"myne.v0.1 argon2id-recovery\|"` |
| Salt domain prefix (quick-unlock PIN) | `"myne.v0.1 argon2id-quickunlock-pin\|"` (§9.14.2; PIN-derived quick-unlock wrap key) |
| Salt domain prefix (device-key PIN, **v0.2**) | `"myne.v0.2 argon2id-device-key-pin\|"` (`protocol/src/kdf.rs`; `decisions/protocol/0759`). Seals the **device signing key** in the rung-3 `0600` file on a platform with no OS store, and is bound to **no** `account_number_hash` on purpose: the key is device-scoped and outlives every vault on the machine, so a vault component in the salt would make forgetting a vault destroy a key that was never the vault's. Distinct from the quick-unlock PIN domain above, so one PIN cannot derive one key for two purposes. `protocol.md` §3.1 carries the derivation and §5.2 the `AAD_device_key_pin_store` that binds the envelope version and the whole KDF parameter block. |
| Salt domain prefix (device-key PIN rung) | `"myne.v0.2 argon2id-device-key-pin\|"` (`protocol/src/kdf.rs::SALT_PREFIX_DEVICE_KEY_PIN`; `decisions/protocol/0759`). Seals the **device signing key** in the rung-3 `0600` file on a platform with no OS store. Device-scoped and vault-agnostic, so it is bound to **no** `account_number_hash`: the key outlives the vault that bound it. Deliberately not the quick-unlock domain, which would make one PIN derive one key for two purposes. |
| Salt domain prefix (password, **v0.2**) | `"myne.v0.2 argon2id-password\|"` (`protocol/src/kdf.rs`). **Shipping, not reserved**: a vault created today is v0.2 throughout, and this is the salt domain its password wrap is derived under. |
| Salt domain prefix (recovery, **v0.2**) | `"myne.v0.2 argon2id-recovery\|"` (`protocol/src/kdf.rs`). Same: shipping, and distinct from the password domain by the same rule the v0.1 pair follows. |
| Salt domain prefix (person keypair, **v0.2**) | `"myne.v0.2 argon2id-person-keypair\|"` (`protocol/src/kdf.rs`; the B2B identity substrate, `decisions/protocol/0592`). **Shipping, not reserved**: the person's own recovery phrase derives their person-keypair wrap key under this domain; vault-independent by design (one person, many vaults), so no vault credential can unwrap it. |
| Person-id hash domain (B2B identity, **v0.2**) | `"myne.person-id\|"` (`protocol/src/kdf.rs::PERSON_ID_PREFIX`; `decisions/protocol/0592`). The person-id hash is `SHA-256("myne.person-id\|" \|\| phrase_normalized)[:16]` (`protocol.md` §3.1); a pure function of the phrase, so it binds rather than separates. |
| Person fingerprint domain (B2B identity) | `"myne.person-fingerprint v1\|"` (`protocol/src/person_key.rs::FINGERPRINT_PREFIX`; `decisions/protocol/0592`). The SAS fingerprint is `SHA-256(prefix \|\| kem_ek \|\| ed_pk \|\| mldsa_vk)` (`protocol.md` §3.1); changing it re-derives every fingerprint, so no invite SAS ever matches. |
| Person hybrid-wrap combiner salt (B2B identity) | `"myne.person-wrap-ss v1\|"` (`protocol/src/person_key.rs::HYBRID_WRAP_PREFIX`; `decisions/protocol/0592`). The HKDF-Extract salt of the classical||pq combiner (`protocol.md` §3.1); changing it re-derives every per-recipient wrap key, so no invite opens. |
| Vault-invite signature class (B2B identity) | `"myne.vault-invite v1\|"` (`protocol/src/person_invite.rs::INVITE_PREFIX`; `decisions/protocol/0592`). The double-signature message-class prefix (`protocol.md` §3.1); changing it moves every invite into a different signature class. |
| Presence-assertion signature class (live-collab) | `"myne.awareness-presence v1\|"` (`protocol/src/awareness_frame.rs::PRESENCE_ASSERTION_PREFIX`; `decisions/protocol/0656`). The double-signature message-class prefix that binds a live-collaboration peer's Automerge device actor to its person id (`protocol.md` §5.2/§10.7); changing it moves every presence assertion into a different signature class. **Shipped as a codec but not yet wired**: nothing signs or verifies one on the production path yet. |
| Person identity seed domain (B2B identity, **v0.2**) | `"myne.v0.2 argon2id-person-identity\|"` (`decisions/protocol/0604`, absorbing myne-md/myne#713). The deterministic person keypair is derived from the normalized phrase under this domain, distinct from the person-keypair wrap domain above so the key seed and the at-rest wrap key are never the same value; a change re-derives every person keypair and fingerprint. |
| Member-vault-unlock salt domain prefix (B2B identity, **v0.2**) | `"myne.v0.2 argon2id-person-vault-member-unlock\|"` (`protocol/src/kdf.rs`; `decisions/protocol/0653`). Seals a member's `group_key`+`items_key`+person keypair in the device-local `vault.member-unlock` store under a member-chosen password, so a member vault re-unlocks without retyping the recovery phrase every session. A per-device random salt (in the envelope) plus the `account_number_hash` in the domain scope; no `DeriveSubkey` role (person plane). **The only member credential since myne-md/myne#938 task 12**: the phrase-sealed sibling domain `"myne.v0.2 argon2id-person-vault-member\|"` and its `vault.member-key` store are retired (`decisions/protocol/0763`), so this row is the one a member vault's keys are sealed under and there is no second. |
| Person key-type HKDF contexts (B2B identity) | `"myne.person-kem v1\|"`, `"myne.person-ed25519 v1\|"`, `"myne.person-mldsa v1\|"` (`decisions/protocol/0604`). The per-key-type expansion contexts for the deterministic identity; changing one re-derives that key type for every person. |
| Device head signature class (B2B wire) | `"myne.head-signature v2\|"` (`protocol/src/vault_head.rs::DEVICE_HEAD_SIGNATURE_PREFIX`; `decisions/protocol/0733`). The message-class prefix a **device-signed** head (`0x03`) covers: `prefix \|\| device_id (16) \|\| canonical_head_input`. Distinct from the person class as well as length-different, so a person signature can never be read as a device one; changing it invalidates every `0x03` head signature. |
| Head signature class (B2B wire) | `"myne.head-signature v1\|"` (`decisions/protocol/0603`). The double-signature message-class prefix for a signed head (`sync-protocol.md` §3); changing it invalidates every head signature verification. |
| Head author id hash domain (B2B wire) | `"myne.head-author v1\|"` (`decisions/protocol/0603`). The vault-scoped pseudonymous author id a signed head carries, so a peer resolves the signing key without the server learning a cross-vault identifier; a change re-derives every author id. |
| Person key-transition signature class (B2B identity) | `"myne.person-key-transition v1\|"` (`protocol/src/person_invite.rs::PERSON_KEY_TRANSITION_PREFIX`; `decisions/protocol/0604`). The double-signature message-class prefix for the record that publishes a person's deterministic-identity key change into a roster (`protocol.md` §3.1); changing it moves every transition into a different signature class. |
| Signed head format version | `0x02` (`sync-protocol.md` §3.6; `decisions/protocol/0603`) for a person-key signature, and `0x03` (`decisions/protocol/0731` + `0733`) for a device-key one, whose record is the same length with `device_id` in the author slot. A signed vault MUST accept BOTH. The wire-only `head_format_version` at which a head is person-key signed rather than HMAC'd; no on-disk magic, AAD prefix or content blob moves. |
| Awareness frame wire-format version | `0x01` (`protocol.md` §5.2/§10.7; `decisions/sync/0655`, epic `live-collab`). The cleartext header byte of a live-collaboration awareness frame, after the `room_id (16)` and `nonce (24)`; distinct from the v0.2 AAD `protocol_version` `0x02` inside the seal. A wire-only, magic-less envelope (never at rest); changing it moves every awareness frame into a different format generation. The two new subkey roles it uses (`awareness-room-id`, `awareness-key`) are registered in `protocol.md` §3.4 and get one registry row, not a row each. |
| B2B relay and membership routes | `POST /b2b/invites`, `GET /b2b/invites`, `POST /b2b/invites/{invite_id}/claim`, `DELETE /b2b/invites/{invite_id}` (the recipient's real refusal: the sealed payload is dropped and the owner's list reports `declined`, `decisions/protocol/0732`), `POST /b2b/vaults/{account_hash}/members`, `DELETE /b2b/vaults/{account_hash}/members/{person_id}`, `POST /b2b/vaults/{account_hash}/retire` (`decisions/protocol/0603`), `GET /b2b/vaults/{account_hash}/invites` (`decisions/protocol/0605`), `PUT\|GET /b2b/vaults/{account_hash}/profiles/{profile_id}` (`decisions/protocol/0608`), `PUT\|GET /b2b/vaults/{account_hash}/group-packages/{person_id}` (`collab-b2b-sessions`, extending `decisions/protocol/0603` + `0607`), `GET /b2b/vaults` (the calling account's bindings, myne-md/myne#911 task 7), and the person session's vault selector `?account=<account_number_hash>` on `/sync/*` and `PUT /vault.meta` (`decisions/sync/0720`, the one place an account hash reaches a request line: `threat-model.md` §7). Wire route names, not magics; changing one breaks the server contract the client and operator docs depend on. |
| Device admission code (out-of-band join material) | `MYNE-DEVICE-1:` whole-string prefix, then `<person_id_hex>:<device_id_hex>:<ed_pk_hex>:<mldsa_vk_hex>:<salt_hex>:<iterations>:<stored_key_hex>:<server_key_hex>` all lowercase hex, with the two public halves EMPTY on a platform with no device-key rung (`decisions/protocol/0735`). **Not** an AEAD/magic value and not a vault credential, but it is CREDENTIAL-EQUIVALENT: the two SCRAM halves let whoever holds it complete a handshake as that device, which is why the exchange is bound to a SAS and the code is never logged. Written whole so it can be grepped; changing it invalidates codes already shown to a user. |
| Device admission SAS class | `"myne.device-admission-sas v1\|"` (`protocol/src/device_key.rs::DEVICE_ADMISSION_SAS_PREFIX`; `decisions/protocol/0735`). The message-class prefix whose SHA-256 the eight displayed hex characters come from, computed over the WHOLE admission code so a substituted device id, signing half or verifier each move it. Changing it changes every SAS, which silently breaks the human comparison the exchange rests on. **Shipped as a codec, not a surface**: `0764` withdrew the two-screen ceremony and `0784` does not reinstate it. The join installs the verifier from the device that owns it, so no code and no SAS travels, and the one human comparison in that flow is the vault-head fingerprint eye-compare (`threat-model.md` §7). |
| Device-credential SCRAM username | `dev:<device_id_hex>` (`protocol/src/device_key.rs` encode side, `myne-server` `deviceUsername`/`parseDeviceUsername`; `decisions/protocol/0735`). The `dev:` prefix is load-bearing: an account id and a device id are both 16 bytes and both encode to 32 lowercase hex characters, so without it the handshake cannot tell which namespace a username came from. The server refuses any username that is not this canonical form. |
| Per-device account credential route | `POST /auth/devices/credential` (`decisions/protocol/0735`). A wire route name, not a magic. Authed, account taken from the session; installs the verifier AND approves the device in one act; `409 already_installed` for a different verifier on an installed device; `POST /auth/devices/revoke` deletes the verifier it installed. Since `decisions/protocol/0784` the JOINING device is the caller, after an existing device approved its row; it holds no token while pending, so this reaches around no gate. |
| Person identity code (out-of-band invite material) | `MYNE-PERSON-1:` whole-string prefix, then `<person_id_hex>:<kem_ek_hex>:<ed_pk_hex>:<mldsa_vk_hex>` all lowercase hex (`decisions/protocol/0605`). **Not** an AEAD/magic value: it carries public material only. Since `decisions/protocol/0675` a member's device pins the OWNER's code inside that person's own sealed `MYY5` profile (§9.28.4), so it does reach the sync server, as ciphertext in a blob keyed from the person's own phrase, which the server can neither read nor serve; the invite relay itself still never carries it (`0603` Q10). Written whole so it can be grepped; changing it invalidates codes already shared. |
| Per-note blob magic | `MY01` (extension `.myn`) |
| Vault metadata magic | `MYV1` (file `vault.meta`) |
| Vault prefs blob magic | `MYP1` (file `vault.prefs`; §9.5) |
| Search-index blob magic | `MYS1` (file `vault.search`; §9.6) |
| Workspace-state blob magic | `MYW1` (file `vault.workspace`; §9.7) |
| Vault-indices blob magic | `MYI1` (file `vault.indices`; §9.8) |
| Attachment blob magic | `MYA1` (files `attachments/<attachment-id-hex>`; §9.9) |
| Attachments catalog magic | `MYC1` (file `vault.attachments`; §9.10) |
| Vault backup container magic | `MYB1` (files `*.myne-backup`; §9.11) |
| Personal-dictionary blob magic | `MYD1` (file `vault.dictionary`; §9.13) |
| Quick-unlock credential blob magic | `MYQ1` (file `vault.quickunlock`; §9.14; device-local, wraps a third `root_key` copy) |
| Extracted-attachment-text blob magic | `MYE1` (files `attachments-text/<attachment-id-hex>`; §9.15; per-attachment search-extraction cache) |
| Device-local sync-baseline magic | `MYH1` (file `vault.head-state`; §9.16; MYND-416 — the last vault head this device accepted. **The one §10.3 family that is not AEAD-encrypted**: it wraps the sync-wire head record verbatim behind a 6-byte header, and integrity is that head's own HMAC-SHA-256 under `vault-head-mac`, re-verified on load. The wire head itself has **no magic** — it is sync-wire-only, versioned by its `head_format_version` byte, not a §10.3 family.) |
| Custom-themes blob magic | `MYT1` (file `vault.themes`; §9.21; the singleton `{theme_name → palette}` map promoted from device-local plaintext to vault content — encrypted, synced, backed up; `decisions.md` 2026-07-16 supersedes the 2026-06-16 storage-split clause) |
| Pending-capture blob magic | `MYK1` (files `captures/<capture-id-hex>`; §9.18; device-local encrypted queue holding a watch-dictated note until the phone unlocks and drains it into the vault; sealed under a device-local keychain `wrap_key`, NOT `root_key`-derived; vault-agnostic — binds the per-entry `capture_id`, not `account_number_hash`; never synced/backed up) |
| Graph-layout cache magic | `MYG1` (file `vault.graph`; §9.19; knowledge-graph layout cache — node positions + a schema-version marker; `root_key`-derived KEK, frontend-driven opaque payload like `vault.workspace`; rebuildable cache, never synced/backed up) |
| Share-import staging queue magic | `MYF1` (MYND-507; `F` = file, a free §10.3 letter — implementer-allocated like every family magic; files `pending-shares/sealed/<share-id-hex>`; §9.20; device-local encrypted queue holding a file shared via the OS share sheet until the vault unlocks and drains it into the attachment library; sealed under a device-local keychain/Keystore `wrap_key` (service `md.myne.shareimport`), NOT `root_key`-derived; vault-agnostic — binds the per-entry `share_id`; 64 MiB cap; never synced/backed up) |
| Conversations catalog magic | `MYM1` (file `vault.chats`; §9.23; the `{conversation-id → row}` roster: per-conversation title/version/timestamps plus tombstones, encrypted, synced Class-1, backed up; myne-md/myne#675) |
| Conversation file magic | `MYJ1` (files `chats/<32-hex conversation id>`; §9.24; one sealed turn list per conversation, `title_derived_from` snapshot included, encrypted, synced Class-1, backed up; myne-md/myne#675) |
| Agent-memory catalog magic | `MYN1` (file `vault.agent-memory`; §9.25; the `{memory-id → row}` roster: per-entry timestamps plus causal version plus tombstones, encrypted, synced Class-1, backed up; myne-md/myne#697) |
| Agent-memory entry magic | `MYX1` (files `memories/<32-hex entry id>`; §9.26; one sealed distilled text per entry, encrypted, synced Class-1, backed up; myne-md/myne#697) |
| Agent-personality magic | `MYZ1` (file `vault.personality`; §9.27; the whole-value voice-directive singleton, user-authored only, encrypted, synced Class-1, backed up; myne-md/myne#697) |
| Member-names magic | `MYO5` (file `vault.member-names`; §9.29; the `{person_id_hash → {name, version, tombstone}}` map of member display names, sealed under the GROUP tier so every member reads and writes it, one entry per member signed by the person it names; encrypted, synced Class-1, backed up; **group tier only**, which both tail generations carry since `NTV7` keeps the `NTV6` tail byte for byte (it was `NTV6`-only until `decisions/protocol/0730` taught the resolver `parse_b2b_tail_any`), no v0.1 form and no `SubkeyRole` counterpart; `MYU5` is its device-binding sibling, allocated in the same act and shipping its own family (the rows below); myne-md/myne#851) |
| Member-name signature class | `"myne.member-name v1\|"` (`protocol/src/member_names_blob.rs::MEMBER_NAME_PREFIX`; `decisions/protocol/0667`). The message-class prefix a member display-name row's double signature (Ed25519 + ML-DSA-65) covers, ahead of the 16-byte `person_id`, the 8-byte big-endian version, the tombstone byte and the name bytes, run to the end of the message. Verified against the public half of the person the ROW names, so a member cannot claim another member's row; an owner signature is additionally accepted on a tombstone, which is how a removal clears a row. Changing it re-derives every existing signature, so it is a major-version event. |
| Device-binding magic | `MYU5` (file `vault.device-bindings`; `format_version` `0x02` since `decisions/protocol/0733`, whose rows may carry the device public halves while `0x01` rows stay readable; §9.30; the `{device_id → {person_fingerprint, version, tombstone, signature_hex}}` map of device-to-person bindings, sealed under the GROUP tier so every member reads and writes it, one row per device signed by the person the row claims; encrypted, synced Class-1, backed up; addressed by the group-derived `device-binding-sync-id`, so it rotates with the group key on member removal; **group tier only**, the same correction as `MYO5` above (`decisions/protocol/0730`), no v0.1 form and no `SubkeyRole` counterpart; myne-md/myne#852) |
| Group roster signature class (`v2`, device-signed) | `"myne.group-roster v2\|"` (`protocol/src/person_invite.rs::GROUP_ROSTER_PREFIX_V2`; `decisions/protocol/0731` stage 2 + `0733`). The class an owner's roster signs under once its device holds a key, so inviting and removing stop needing the phrase. The payload is unchanged (it still names people and the owner's person fingerprint); the frame is the same 64+3309-byte pair, which is why the class and not a byte in the payload carries the distinction. A reader MUST accept both classes and resolve the device from the pinned `owner_device` attestation, its own key, or a verified `vault.device-bindings` row. |
| Device-binding signature class (`v2`, carries the device halves) | `"myne.device-binding v2\|"` (`protocol/src/device_binding_blob.rs::DEVICE_BINDING_PREFIX_V2`; `decisions/protocol/0733` decision 3). The class a `MYU5` `format_version 0x02` row signs, over `prefix \|\| device_id \|\| person_fingerprint \|\| version \|\| tombstone \|\| device_ed_pk \|\| device_mldsa_vk` (2064 bytes). The halves are inside the signed bytes so a member cannot substitute a device's verifying key while keeping the row's fingerprint. `v1` rows stay readable and a device re-signs itself once. |
| Device-binding signature class | `"myne.device-binding v1\|"` (`protocol/src/device_binding_blob.rs::DEVICE_BINDING_PREFIX`; `decisions/protocol/0670`). The message-class prefix a device-binding row's double signature (Ed25519 + ML-DSA-65) covers, ahead of the 16-byte `device_id`, the 32-byte `person_fingerprint`, the 8-byte big-endian version and the tombstone byte, at fixed widths so the signed message is exactly 80 bytes. Verified against the public half of the person the ROW claims, and the claimed fingerprint must also equal that public half's own fingerprint, because the map key is the DEVICE and the claimed person lives inside the row: without that second check a member could sign a message carrying a co-member's fingerprint and have it verify against their own key. An owner signature is additionally accepted on a tombstone, which is how a member's removal clears their rows. Changing it re-derives every existing signature, so it is a major-version event. |
| Per-person private AI profile magic | `MYY5` (files `profiles/<profile-id>`; §9.28; one sealed profile per `(person, vault)`, keyed from the person's OWN phrase under the `person-vault-profile` salt domain, never from `group_key` or `root_key`; the id binds the person-id hash and the account hash into the AAD; carried by the vault-scoped profile plane `PUT|GET /b2b/vaults/{account_hash}/profiles/{profile_id}`, device-local cache at `vault.person-ai`; its inner schema is opaque to the codec layer and carries the member's **pinned owner identity code** as of `decisions/protocol/0675` (§9.28.4), which is how a member's second device gets an owner to verify a group package against; synced since `decisions/protocol/0608`; myne-md/myne#712) |
| B2B vault-metadata magic | `NTV6` (file `vault.meta`; §9.3.2; the v0.2 B2B generation: owner-wrapped group key, group-key epoch, owner-signed roster; a pre-B2B reader MUST reject it; myne-md/myne#712) |
| B2B person-wrapped vault-metadata magic | `NTV7` (file `vault.meta`; §9.3.5; the person generation: the `NTV6` tail byte for byte plus a fixed-width person wrap of `root_key` to the owner's person key and the recovery-phrase wrap required to be ALL ZERO in both writer and parser; the vault phrase is retired for a vault born this way; a pre-`NTV7` reader MUST reject the magic rather than parse the frame and ignore the tail; myne-md/myne#911) |
| B2B password-only vault-metadata magic | `NTV8` (file `vault.meta`; §9.3.6; the password-only generation: the `NTV7` frame minus its 1208-byte person wrap, so the frame is `445 + signed_roster_len` and `root_key` is sealed under the password wrap alone; the phrase-wrap fields stay present and MUST be ALL ZERO in both writer and parser; the absence is the LENGTH, so an `NTV7` frame is refused rather than read as one with a short tail; a pre-`NTV8` reader MUST reject the magic; myne-md/myne#938, `decisions/protocol/0758`) |
| Sealed label store magic | `MYL1` (myne-md/myne#411; `L` = label, a free §10.3 letter, implementer-allocated like every family magic; file `vault.label` at the vault root; §9.22; device-local cache of the vault's name so the LOCKED picker can show it, since the authoritative `label` is sealed inside `vault.prefs`; sealed under a **per-vault** keychain `wrap_key` (service `md.myne.vaultlabel`), NOT `root_key`-derived, because a derived subkey cannot be destroyed on its own, so it could not deliver the per-`VaultId` erase; binds the `VaultId` the READER expected, not `account_number_hash`; 4 KiB cap; never synced/backed up) |
| Protocol identifier string | `myne-protocol-v0.1` |
| Account-number display prefix | `MY-` + five dash-separated 4-char Crockford groups (27-char display form, `account-number.md` §2; the old `MY-XXXX-XXXX-XXXX-XXXX-X` sketch was illustrative shorthand — the last group is 4 chars, ending in the Damm-32 check char) |
| Damm-32 quasigroup table | frozen literal, `account-number.md` §4.2 — determines which 20-char strings are valid and which check char generation emits; changing it rejects already-distributed account numbers and breaks cross-impl validity agreement |
| Firefox Gecko extension ID (browser clipper) | `clipper@myne.md` (`src-tauri/src/clipper/manifest.rs::FIREFOX_EXTENSION_ID`) — **not** an AEAD/magic value; load-bearing through *pairing-token binding*: every clipper pairing token is bound to this exact extension ID and the native-messaging host manifest's `allowed_extensions` is generated from it, so changing it invalidates all distributed pairings (a forced re-pair). |
| Chrome/Edge extension ID (browser clipper) | `ebbbblnjddeockegombcnbiljefmlhbh` (`src-tauri/src/clipper/manifest.rs::CHROMIUM_EXTENSION_ID`) — **not** an AEAD/magic value; load-bearing the same way the Firefox id is: it is written into the Chromium native-messaging manifest's `allowed_origins` (`chrome-extension://<id>/`) and every clipper pairing token binds to it. **Deterministically derived** from the committed manifest `key` in the `myne-clipper` repo (base64-decode → SHA-256 → first 16 bytes → `[a-p]`); changing that `key` re-derives this and forces a re-pair. Installer wiring: `agent-tooling/design-notes.md` 2026-07-05. |
| Native-messaging host name (browser clipper) | `md.myne.clipper` (`src-tauri/src/clipper/manifest.rs::HOST_NAME`) — the host-manifest family name the browser launches and the desktop bundle id (`md.myne.desktop`) it is distinct from; changing it requires re-installing the host manifest. Not an AEAD/magic value. |

Next-major magic, split into what ships today and what is genuinely still reserved (myne-md/myne#470). **Shipping as v0.2, not reserved**: `NTV5` (vault-meta) and `NTV6` (B2B vault-meta, §9.3.2), `NTV7` (B2B person-wrapped vault-meta, §9.3.5), `NTV8` (B2B password-only vault-meta, §9.3.6, the birth generation since `decisions/protocol/0758`), `MYP5` (prefs), `MYA5` (attachment), `MYC5` (attachments-catalog), `MYD5` (personal-dictionary), `MYT5` (custom-themes), `MYM5` (conversations catalog, §9.23), `MYJ5` (conversation file, §9.24), `MYN5` (agent-memory catalog, §9.25), `MYX5` (agent-memory entry, §9.26), `MYZ5` (agent personality, §9.27), `MYY5` (per-person private AI profile, §9.28), `MYO5` (member display names, §9.29, the GROUP-tier-sealed family the `member-onboarding` feature added, readable on both tail generations since `decisions/protocol/0730`), `MYU5` (device-to-person bindings, §9.30, the same class one section over: GROUP-tier-sealed, the same two generations, and created by its first write rather than by the migration; the `member-devices` feature). These name bytes on disk today: `agent-tooling/docs/spec/protocol.md` §10.3.1 makes v0.2 the birth format and §10.4.1 has the migration write all of them except `MYO5`, `MYU5` and `NTV7` (the first two are the group-tier families, created by their first write rather than by that cut; `NTV7` is written by the creation path and by the §10.4.2 upgrade, and is no longer WRITTEN at all since `0758` made `NTV8` the birth frame) (an absent file reads as the empty map in both), so reading one as an unallocated placeholder is the mental model behind myne-md/myne#638, where a reader taught only `MYA1` returned `None` for every body on a migrated vault and stopped attachment sync in both directions. `NTV7` joins from the other direction: it is written by the creation path whenever a person identity is unlocked (§10.3.1's within-v0.2 paragraph) and by the explicit §10.4.2 upgrade, not by §10.4.1, and `NTV8` (§9.3.6, `decisions/protocol/0758`) takes over both of those roles: it is the frame a vault created today carries, and the target of the silent in-place §10.4.3 upgrade that retires the person wrap. **Genuinely still reserved**: `NT05` (per-note; what it now means beside `NC05` is deliberately unanswered, `protocol.md` §10.3) + `MYS5`/`MYW5`/`MYI5`/`MYB5`/`MYQ5`/`MYE5`/`MYH5`/`MYK5`/`MYG5`/`MYF5`/`MYL5` (search / workspace / vault-indices / backup-container / quick-unlock / attachment-text / sync-baseline / pending-capture / graph-layout / share-import / sealed-label-store): placeholder values the next major version finalizes. `MYR5` is no longer among them: the AI-embeddings family was retired (`agent-tooling/design-notes/ai/0703-*.md`), which returned `R` to the free `MY?5` letter pool. `MYL5` is reserved against a future revision of its own family's layout, not against a version cut: `vault.label` is generation-independent and stays `MYL1` inside a v0.2 vault (`protocol.md` §9.22, §10.3). The `MY?5` letter pool held exactly two free letters at the allocation that minted `MYO5` and `MYU5` (`O` and `U`), so a later family wanting one needed a human decision; the retirement of the AI-embeddings family has since returned `R` to the pool.

**One next-major family is no longer a placeholder: `NC05` is allocated as a v0.2 format** (the CRDT note-type, `automerge-sync-migration` #418; `agent-tooling/design-notes.md` 2026-08-09 format-commitment entry). It pins **three new load-bearing v0.2 identifiers** — AAD prefix `"myne.v0.2|"`, HKDF context prefix `"myne.v0.2 "`, header `protocol_version` byte `0x02` — plus the `NC05` per-note magic. Each is a major-version-event constant exactly like its v0.1 counterpart; the byte layout is normative in `agent-tooling/docs/spec/protocol.md` §10.7 (an `NC05` blob is the §9.2 envelope with magic/version/AAD-prefix swapped, opaque Automerge `save()` payload, no new `SubkeyRole`). Pulling these two prefixes forward is the one exception to "the next major's prefixes are not pre-allocated"; the rest of v0.2 (its KDF, other blob families) is still unallocated.

The next major's **AAD prefix and HKDF context prefix are otherwise not pre-allocated** in v0.1 (it defines its own; the v0.1 values `"myne.v0.1|"` / `"myne.v0.1 "` are untouched, and only the `"myne.v0.2 …"` note-type prefixes above are pinned) — see the normative magic-allocation table in `agent-tooling/docs/spec/protocol.md` §10.3 (which is the single source of truth for magic allocation; `MYI1`/§9.8 VaultIndices landed with MYND-271). v0.1 and a later major version are **forward-incompatible by design** — no extension points, no algorithm-agility headers; cross-major reads happen only via explicit user-initiated migration. (The next major was formerly drafted as "v005"; that codename is retired — see `agent-tooling/design-notes.md` 2026-08-01 and the glossary "next major version" entry. In prose, deferrals read as "later"; parked items as "icebox".)

## License

Multi-licensed by subtree — see [`LICENSING.md`](LICENSING.md) for the authoritative map. Application code (`src/`, `src-tauri/`, `web/`, `core/`, `protocol/`) is **AGPL-3.0** (not "or-later" — and `web/`'s AGPL is load-bearing: the network clause is what makes a served bundle self-hostable, the only mitigation A15/TB11 has); the `agent-tooling/docs/` subtree is **CC-BY-4.0** so the spec stays reusable for independent implementations as long as Myne is credited. Every `protocol/` source file carries `// SPDX-License-Identifier: AGPL-3.0`. Decision recorded in `agent-tooling/design-notes.md`.
